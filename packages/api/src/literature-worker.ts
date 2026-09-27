import { randomUUID } from "node:crypto";
import type { Database, Transaction } from "@blankfolio/db";
import {
	literatureSnapshot,
	paper,
	researchJob,
	type SourceOutcome,
	type SourceRecord,
	snapshotPaper,
	sourceExecution,
	usageReservation,
} from "@blankfolio/db/schema/literature";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { type JobWithMetadata, PgBoss } from "pg-boss";
import {
	type LiteratureSource,
	literatureSources,
	type SourcePrices,
	type SourceResult,
	TransientSourceError,
	UncertainSourceOutcome,
} from "./literature-sources";
import { pilotAccessStatus } from "./pilot-access";
import { requireProject } from "./project-lifecycle";
import {
	type CancelReason,
	literatureSearchQueue,
	literatureWorkOptions,
} from "./research-jobs";
import { holdUsage, reserveUsage, settleUsage } from "./usage-budget";

export const recordCap = 200;
export const maxSourceAttempts = 3;
const finished: SourceOutcome[] = ["succeeded", "empty", "partial", "failed"];

export type LiteratureWorkerOptions = {
	db: Database;
	prices: SourcePrices;
	sources?: Record<string, LiteratureSource>;
	now?: () => Date;
	sleep?: (milliseconds: number) => Promise<void>;
};
type Job = typeof researchJob.$inferSelect;
type Execution = typeof sourceExecution.$inferSelect;
type Failure = { outcome: "failed"; errorClass: string };

/** Project tombstone/archive and account eligibility, re-checked before every stage. */
async function guard(tx: Transaction, job: Job): Promise<CancelReason | null> {
	try {
		await requireProject(tx, job.ownerId, job.projectId, "write");
	} catch (error) {
		if (!(error instanceof TRPCError)) throw error;
		return error.code === "CONFLICT" ? "archived" : "deleted";
	}
	return (await pilotAccessStatus(tx, job.ownerId)) === "eligible"
		? null
		: "access-withdrawn";
}

export function createLiteratureWorker({
	db,
	prices,
	sources = literatureSources,
	now = () => new Date(),
	sleep = (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
}: LiteratureWorkerOptions) {
	/** Returns the job only while it may still run another stage. */
	async function claim(jobId: string) {
		return db.transaction(async (tx) => {
			const [job] = await tx
				.select()
				.from(researchJob)
				.where(eq(researchJob.id, jobId))
				.for("update");
			if (!job || (job.state !== "queued" && job.state !== "running"))
				return null;
			const cancelled = await guard(tx, job);
			if (cancelled) {
				await tx
					.update(researchJob)
					.set({
						state: "cancelled",
						cancelReason: cancelled,
						finishedAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(researchJob.id, jobId));
				return null;
			}
			if (job.state === "queued") {
				const { scope } = job.input;
				const allocation = Math.floor(recordCap / scope.sources.length);
				await tx
					.insert(sourceExecution)
					.values(
						scope.sources.map((id) => {
							const filters = sources[id]?.filters(scope) ?? {
								applied: [],
								unsupported: [],
							};
							return {
								id: randomUUID(),
								jobId,
								projectId: job.projectId,
								source: id,
								allocation,
								effectiveQueries: scope.queries,
								appliedFilters: filters.applied,
								unsupportedFilters: filters.unsupported,
							};
						}),
					)
					.onConflictDoNothing();
				await tx
					.update(researchJob)
					.set({
						state: "running",
						stage: "retrieving",
						startedAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(researchJob.id, jobId));
			}
			return job;
		});
	}

	async function startAttempt(execution: Execution, attempt: number) {
		await db
			.update(sourceExecution)
			.set({ status: "running", attempts: attempt, updatedAt: new Date() })
			.where(eq(sourceExecution.id, execution.id));
	}

	async function retrieve(
		job: Job,
		execution: Execution,
	): Promise<SourceResult | Failure | null> {
		const source = sources[execution.source];
		if (!source) return { outcome: "failed", errorClass: "source-disabled" };
		const price = prices[source.id];
		if (source.metered && execution.status === "running") {
			// A metered attempt was in flight when a worker stopped; it may have been billed.
			const [inFlight] = await db
				.select({ id: usageReservation.id })
				.from(usageReservation)
				.where(
					and(
						eq(usageReservation.sourceExecutionId, execution.id),
						eq(usageReservation.attempt, execution.attempts),
					),
				);
			if (inFlight) await holdUsage(db, inFlight.id);
			return { outcome: "failed", errorClass: "uncertain-outcome" };
		}
		const { scope } = job.input;
		for (
			let attempt = execution.attempts + 1;
			attempt <= maxSourceAttempts;
			attempt++
		) {
			if (!(await claim(job.id))) return null;
			let reservation: string | undefined;
			if (source.metered) {
				if (price === undefined)
					return { outcome: "failed", errorClass: "pricing-unknown" };
				const reserved = await reserveUsage(db, {
					projectId: job.projectId,
					jobId: job.id,
					sourceExecutionId: execution.id,
					attempt,
					route: source.id,
					amountMicros: price * scope.queries.length,
					now: now(),
				});
				if (!reserved.reserved)
					return { outcome: "failed", errorClass: "budget-exceeded" };
				reservation = reserved.id;
			}
			await startAttempt(execution, attempt);
			try {
				const result = await source.search({
					queries: execution.effectiveQueries,
					dateFrom: scope.dateFrom,
					dateTo: scope.dateTo,
					includeFoundations: scope.includeFoundations,
					limit: execution.allocation,
					attempt,
				});
				if (reservation && price !== undefined)
					await settleUsage(db, reservation, price * result.requests);
				return result;
			} catch (error) {
				if (error instanceof UncertainSourceOutcome) {
					if (reservation) {
						await holdUsage(db, reservation);
						return { outcome: "failed", errorClass: "uncertain-outcome" };
					}
				} else if (error instanceof TransientSourceError) {
					if (reservation) await settleUsage(db, reservation, 0);
				} else throw error;
				if (attempt < maxSourceAttempts)
					await sleep(
						Math.max(
							(error instanceof TransientSourceError
								? error.retryAfterSeconds
								: 0) * 1000,
							1000 * 2 ** (attempt - 1),
						),
					);
			}
		}
		return { outcome: "failed", errorClass: "source-unavailable" };
	}

	async function checkpoint(
		execution: Execution,
		result: SourceResult | Failure,
	) {
		await db
			.update(sourceExecution)
			.set(
				result.outcome === "failed"
					? {
							status: "failed",
							errorClass: result.errorClass,
							completedAt: new Date(),
							updatedAt: new Date(),
						}
					: {
							status: result.outcome,
							records: result.records,
							reportedCount: result.reportedCount,
							receivedCount: result.records.length,
							cursor: result.cursor,
							cacheAgeSeconds: result.cacheAgeSeconds,
							truncated: result.truncated,
							errorClass: result.errorClass,
							completedAt: new Date(),
							updatedAt: new Date(),
						},
			)
			.where(
				and(
					eq(sourceExecution.id, execution.id),
					notInArray(sourceExecution.status, finished),
					sql`exists (select 1 from research_job where research_job.id = ${execution.jobId} and research_job.state = 'running')`,
				),
			);
	}

	async function publish(jobId: string) {
		await db.transaction(async (tx) => {
			const [job] = await tx
				.select()
				.from(researchJob)
				.where(eq(researchJob.id, jobId))
				.for("update");
			if (job?.state !== "running") return;
			const cancelled = await guard(tx, job);
			const executions = await tx
				.select()
				.from(sourceExecution)
				.where(eq(sourceExecution.jobId, jobId));
			const answered = executions.filter(
				(execution) => execution.status !== "failed",
			);
			const done = { finishedAt: new Date(), updatedAt: new Date() };
			if (cancelled) {
				await tx
					.update(researchJob)
					.set({ state: "cancelled", cancelReason: cancelled, ...done })
					.where(eq(researchJob.id, jobId));
				return;
			}
			if (answered.length === 0) {
				await tx
					.update(researchJob)
					.set({
						state: "failed",
						stage: "done",
						errorClass: "all-sources-failed",
						...done,
					})
					.where(eq(researchJob.id, jobId));
				return;
			}
			const order = job.input.scope.sources;
			const found = new Map<string, SourceRecord & { source: string }>();
			for (const execution of executions.sort(
				(a, b) => order.indexOf(a.source) - order.indexOf(b.source),
			))
				for (const record of execution.records ?? [])
					if (!found.has(record.key) && found.size < recordCap)
						found.set(record.key, { ...record, source: execution.source });
			const records = [...found.values()];
			if (records.length)
				await tx
					.insert(paper)
					.values(
						records.map(({ source: _, acquisitionReason: __, ...record }) => ({
							...record,
							id: randomUUID(),
						})),
					)
					.onConflictDoNothing({ target: paper.key });
			const papers = records.length
				? await tx
						.select({ id: paper.id, key: paper.key })
						.from(paper)
						.where(
							inArray(
								paper.key,
								records.map((record) => record.key),
							),
						)
				: [];
			const paperIds = new Map(papers.map((row) => [row.key, row.id]));
			const snapshotId = randomUUID();
			await tx.insert(literatureSnapshot).values({
				id: snapshotId,
				projectId: job.projectId,
				jobId,
				scopeRevision: job.input.scopeRevision,
				briefRevision: job.input.briefRevision,
				coverage:
					answered.length === executions.length &&
					executions.every(
						(execution) =>
							execution.status !== "partial" && !execution.truncated,
					)
						? "all-sources"
						: "partial",
				recordCap,
				paperCount: records.length,
			});
			if (records.length)
				await tx.insert(snapshotPaper).values(
					records.map((record, rank) => ({
						snapshotId,
						paperId: paperIds.get(record.key) ?? "",
						projectId: job.projectId,
						source: record.source,
						rank,
						acquisitionReason: record.acquisitionReason,
					})),
				);
			await tx
				.update(researchJob)
				.set({ state: "succeeded", stage: "done", ...done })
				.where(eq(researchJob.id, jobId));
		});
	}

	return async function runLiteratureSearch(jobId: string) {
		const job = await claim(jobId);
		if (!job) return;
		const order = job.input.scope.sources;
		const executions = (
			await db
				.select()
				.from(sourceExecution)
				.where(eq(sourceExecution.jobId, jobId))
		).sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
		for (const execution of executions) {
			if (finished.includes(execution.status as SourceOutcome)) continue;
			const result = await retrieve(job, execution);
			if (!result) return;
			await checkpoint(execution, result);
		}
		if (!(await claim(jobId))) return;
		await db
			.update(researchJob)
			.set({ stage: "publishing", updatedAt: new Date() })
			.where(eq(researchJob.id, jobId));
		await publish(jobId);
	};
}

export type LiteratureJobData = { jobId: string };
/**
 * pg-boss handler. Errors are replaced by their class so private queries or row values never
 * reach the queue's stored output or logs.
 */
export function createLiteratureJobHandler(options: LiteratureWorkerOptions) {
	const run = createLiteratureWorker(options);
	return async ([job]: JobWithMetadata<LiteratureJobData>[]) => {
		if (!job) return;
		try {
			await run(job.data.jobId);
		} catch (error) {
			const errorClass = error instanceof Error ? error.name : "unknown";
			if (job.retryCount >= job.retryLimit)
				await options.db
					.update(researchJob)
					.set({
						state: "failed",
						stage: "done",
						errorClass: "worker-error",
						finishedAt: new Date(),
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(researchJob.id, job.data.jobId),
							inArray(researchJob.state, ["queued", "running"]),
						),
					);
			console.error("literature_job_failed", job.data.jobId, errorClass);
			throw new Error(`literature_job_failed ${errorClass}`);
		}
	};
}

export function startLiteratureWorker(
	boss: PgBoss,
	options: LiteratureWorkerOptions,
) {
	return boss.work(
		literatureSearchQueue,
		literatureWorkOptions,
		createLiteratureJobHandler(options),
	);
}

/** Persistent worker process: owns its queue pool, polls, and supervises pg-boss maintenance. */
export async function runLiteratureWorker(
	connectionString: string,
	options: LiteratureWorkerOptions,
) {
	const boss = new PgBoss({ connectionString, max: 3, migrate: false });
	boss.on("error", (error) => console.error("job_queue_error", error.message));
	await boss.start();
	await startLiteratureWorker(boss, options);
	return () => boss.stop({ graceful: true, timeout: 30_000 });
}
