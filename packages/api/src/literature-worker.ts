import { createHash, randomUUID } from "node:crypto";
import type { Database, Transaction } from "@blankfolio/db";
import {
	type AcquisitionReason,
	literatureSnapshot,
	paper,
	paperAlias,
	researchJob,
	type SourceObservation,
	type SourceOutcome,
	type SourceRecord,
	snapshotPaper,
	sourceExecution,
	sourceResponseCache,
	sourceThrottle,
	usageReservation,
} from "@blankfolio/db/schema/literature";
import { researchProject } from "@blankfolio/db/schema/projects";
import { TRPCError } from "@trpc/server";
import { and, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import { type JobWithMetadata, PgBoss } from "pg-boss";
import {
	type LiteratureSource,
	literatureSources,
	maxChargeMicros,
	maxRetryAfterSeconds,
	recordAliases,
	recordCap,
	responseCacheRetentionSeconds,
	type SourceCache,
	type SourcePrices,
	type SourceQuotas,
	type SourceResult,
	SourceUnavailableError,
	sourceAllocations,
	sourceAvailability,
	TransientSourceError,
	UncertainSourceOutcome,
	usageMicros,
} from "./literature-sources";
import { pilotAccessStatus } from "./pilot-access";
import { requireProject } from "./project-lifecycle";
import {
	type CancelReason,
	literatureSearchQueue,
	literatureWorkOptions,
	reconcileAbandonedSearches,
} from "./research-jobs";
import { holdUsage, reserveUsage, settleUsage } from "./usage-budget";

export const maxSourceAttempts = 3;
const finished: SourceOutcome[] = ["succeeded", "empty", "partial", "failed"];

export type LiteratureWorkerOptions = {
	db: Database;
	prices: SourcePrices;
	quotas?: SourceQuotas;
	/** Off unless explicitly enabled: a job naming a fixture source then fails that source. */
	fixtureSources?: boolean;
	sources?: Record<string, LiteratureSource>;
	now?: () => Date;
	sleep?: (milliseconds: number) => Promise<void>;
};
type Job = typeof researchJob.$inferSelect;
type Execution = typeof sourceExecution.$inferSelect;
type Failure = { outcome: "failed"; errorClass: string };

type Kept = {
	record: SourceRecord;
	source: string;
	aliases: string[];
	alsoObserved: SourceObservation[];
};
/**
 * Records are the same paper only when they share an exact identifier; titles never merge.
 * Executions arrive in scope order, so earlier sources keep the primary observation.
 */
function keepRecords(executions: Execution[]) {
	const kept: Kept[] = [];
	const byAlias = new Map<string, Kept>();
	for (const execution of executions)
		for (const record of execution.records ?? []) {
			const aliases = recordAliases(record);
			const same = aliases
				.map((alias) => byAlias.get(alias))
				.find((entry) => entry !== undefined);
			if (same) {
				for (const alias of aliases)
					if (!byAlias.has(alias)) {
						byAlias.set(alias, same);
						same.aliases.push(alias);
					}
				if (same.source !== execution.source)
					same.alsoObserved.push({ source: execution.source, record });
				continue;
			}
			if (kept.length >= recordCap) continue;
			const entry: Kept = {
				record,
				source: execution.source,
				aliases,
				alsoObserved: [],
			};
			kept.push(entry);
			for (const alias of aliases) byAlias.set(alias, entry);
		}
	return kept;
}

/** Project tombstone/archive and account eligibility, re-checked before every stage. */
async function guard(
	tx: Transaction,
	job: Pick<Job, "ownerId" | "projectId">,
): Promise<CancelReason | null> {
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

/**
 * Locks the project before the job, the order archive, deletion and cancellation use, so a
 * worker waiting on a project never holds its job's lock. Cancels a job its project or account
 * may no longer run; returns it only while it is still queued or running.
 */
async function lockActiveJob(tx: Transaction, jobId: string) {
	const [ref] = await tx
		.select({ ownerId: researchJob.ownerId, projectId: researchJob.projectId })
		.from(researchJob)
		.where(eq(researchJob.id, jobId));
	if (!ref) return null;
	const cancelled = await guard(tx, ref);
	const [job] = await tx
		.select()
		.from(researchJob)
		.where(eq(researchJob.id, jobId))
		.for("update");
	if (!job || (job.state !== "queued" && job.state !== "running")) return null;
	if (!cancelled) return job;
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

export function createLiteratureWorker({
	db,
	prices,
	quotas = {},
	fixtureSources = false,
	sources = literatureSources,
	now = () => new Date(),
	sleep = (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
}: LiteratureWorkerOptions) {
	/** Returns the job only while it may still run another stage. */
	async function claim(jobId: string) {
		return db.transaction(async (tx) => {
			const job = await lockActiveJob(tx, jobId);
			if (!job) return null;
			if (job.state === "queued") {
				const { scope } = job.input;
				const { allocation } = sourceAllocations(scope.sources);
				await tx
					.insert(sourceExecution)
					.values(
						scope.sources.map((id) => {
							const source = sources[id];
							const filters = source?.filters(
								scope,
								sourceAvailability(source, { prices, quotas, fixtureSources })
									.routes,
							) ?? { applied: [], unsupported: [] };
							return {
								id: randomUUID(),
								jobId,
								projectId: job.projectId,
								source: id,
								allocation: allocation(id),
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

	/** Provider pauses are shared through the database so every worker observes them. */
	async function pausedFor(sourceId: string) {
		const [throttle] = await db
			.select({ pausedUntil: sourceThrottle.pausedUntil })
			.from(sourceThrottle)
			.where(eq(sourceThrottle.source, sourceId));
		return Math.max(
			0,
			(throttle?.pausedUntil.getTime() ?? 0) - now().getTime(),
		);
	}
	async function pause(sourceId: string, seconds: number) {
		const pausedUntil = new Date(now().getTime() + seconds * 1000);
		await db
			.insert(sourceThrottle)
			.values({ source: sourceId, pausedUntil })
			.onConflictDoUpdate({
				target: sourceThrottle.source,
				set: {
					pausedUntil: sql`greatest(${sourceThrottle.pausedUntil}, excluded.paused_until)`,
				},
			});
	}

	/**
	 * Serialises a source's requests across every worker with a transaction-scoped advisory lock,
	 * starting each no sooner than `minIntervalSeconds` after the previous one finished.
	 */
	function pacer(source: LiteratureSource) {
		const interval = source.minIntervalSeconds;
		return <T>(request: () => Promise<T>): Promise<T> =>
			interval
				? db.transaction(async (tx) => {
						await tx.execute(
							sql`select pg_advisory_xact_lock(hashtext(${`source-pace:${source.id}`}))`,
						);
						const [throttle] = await tx
							.select({ pausedUntil: sourceThrottle.pausedUntil })
							.from(sourceThrottle)
							.where(eq(sourceThrottle.source, source.id));
						const wait =
							(throttle?.pausedUntil.getTime() ?? 0) - now().getTime();
						if (wait > 0) await sleep(wait);
						try {
							return await request();
						} finally {
							const pausedUntil = new Date(now().getTime() + interval * 1000);
							await tx
								.insert(sourceThrottle)
								.values({ source: source.id, pausedUntil })
								.onConflictDoUpdate({
									target: sourceThrottle.source,
									set: {
										pausedUntil: sql`greatest(${sourceThrottle.pausedUntil}, excluded.paused_until)`,
									},
								});
						}
					})
				: request();
	}

	function responseCache(projectId: string, sourceId: string): SourceCache {
		const keyOf = (key: string) =>
			createHash("sha256").update(`${sourceId}\n${key}`).digest("hex");
		return {
			async get(key) {
				const [hit] = await db
					.select({
						body: sourceResponseCache.body,
						fetchedAt: sourceResponseCache.fetchedAt,
					})
					.from(sourceResponseCache)
					.where(
						and(
							eq(sourceResponseCache.projectId, projectId),
							eq(sourceResponseCache.key, keyOf(key)),
							gte(
								sourceResponseCache.fetchedAt,
								new Date(
									now().getTime() - responseCacheRetentionSeconds * 1000,
								),
							),
						),
					);
				return hit ?? null;
			},
			async set(key, body) {
				const fetchedAt = now();
				await db.transaction(async (tx) => {
					// Waits for a concurrent deletion, whose cleanup would otherwise miss this row.
					const [project] = await tx
						.select({ state: researchProject.state })
						.from(researchProject)
						.where(eq(researchProject.id, projectId))
						.for("share");
					if (!project || project.state === "deleting") return;
					await tx
						.insert(sourceResponseCache)
						.values({
							projectId,
							key: keyOf(key),
							source: sourceId,
							body,
							fetchedAt,
						})
						.onConflictDoUpdate({
							target: [sourceResponseCache.projectId, sourceResponseCache.key],
							set: { body, fetchedAt },
						});
					await tx
						.delete(sourceResponseCache)
						.where(
							and(
								eq(sourceResponseCache.projectId, projectId),
								lt(
									sourceResponseCache.fetchedAt,
									new Date(
										fetchedAt.getTime() - responseCacheRetentionSeconds * 1000,
									),
								),
							),
						);
				});
			},
		};
	}

	async function retrieve(
		job: Job,
		execution: Execution,
	): Promise<SourceResult | Failure | null> {
		const source = sources[execution.source];
		if (!source) return { outcome: "failed", errorClass: "source-disabled" };
		const metered = source.routes.length > 0;
		if (metered && execution.status === "running") {
			// A metered attempt was in flight when a worker stopped; it may have been billed.
			const inFlight = await db
				.select({ id: usageReservation.id })
				.from(usageReservation)
				.where(
					and(
						eq(usageReservation.sourceExecutionId, execution.id),
						eq(usageReservation.attempt, execution.attempts),
					),
				);
			for (const reservation of inFlight) await holdUsage(db, reservation.id);
			return { outcome: "failed", errorClass: "uncertain-outcome" };
		}
		const { blockedBy, routes } = sourceAvailability(source, {
			prices,
			quotas,
			fixtureSources,
		});
		if (blockedBy) return { outcome: "failed", errorClass: blockedBy };
		const { scope } = job.input;
		for (
			let attempt = execution.attempts + 1;
			attempt <= maxSourceAttempts;
			attempt++
		) {
			if (!(await claim(job.id))) return null;
			const paused = await pausedFor(source.id);
			if (paused > maxRetryAfterSeconds * 1000)
				return { outcome: "failed", errorClass: "rate-limited" };
			if (paused) await sleep(paused);
			const request = {
				queries: execution.effectiveQueries,
				dateFrom: scope.dateFrom,
				dateTo: scope.dateTo,
				includeFoundations: scope.includeFoundations,
				limit: execution.allocation,
				attempt,
				finalAttempt: attempt === maxSourceAttempts,
				routes,
				cache: responseCache(job.projectId, source.id),
				pace: pacer(source),
			};
			let reservation: string | undefined;
			if (metered) {
				const reserved = await reserveUsage(db, {
					projectId: job.projectId,
					jobId: job.id,
					sourceExecutionId: execution.id,
					attempt,
					route: source.id,
					amountMicros: maxChargeMicros(source, request, prices),
					now: now(),
					dailyQuotaMicros: quotas[source.id],
				});
				if (!reserved.reserved)
					return {
						outcome: "failed",
						errorClass:
							reserved.exceeded === "providerDay"
								? "quota-exhausted"
								: "budget-exceeded",
					};
				reservation = reserved.id;
			}
			await startAttempt(execution, attempt);
			try {
				const result = await source.search(request);
				if (reservation)
					await settleUsage(db, reservation, usageMicros(result.usage, prices));
				if (result.pauseSeconds) await pause(source.id, result.pauseSeconds);
				return result;
			} catch (error) {
				if (error instanceof UncertainSourceOutcome) {
					if (reservation) {
						await holdUsage(db, reservation);
						return { outcome: "failed", errorClass: "uncertain-outcome" };
					}
				} else if (error instanceof SourceUnavailableError) {
					if (reservation)
						await settleUsage(
							db,
							reservation,
							usageMicros(error.usage, prices),
						);
					return { outcome: "failed", errorClass: error.errorClass };
				} else if (error instanceof TransientSourceError) {
					if (reservation) await settleUsage(db, reservation, 0);
					if (error.retryAfterSeconds > maxRetryAfterSeconds) {
						await pause(source.id, error.retryAfterSeconds);
						return { outcome: "failed", errorClass: "rate-limited" };
					}
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
			const job = await lockActiveJob(tx, jobId);
			if (job?.state !== "running") return;
			const executions = await tx
				.select()
				.from(sourceExecution)
				.where(eq(sourceExecution.jobId, jobId));
			const answered = executions.filter(
				(execution) => execution.status !== "failed",
			);
			const done = { finishedAt: new Date(), updatedAt: new Date() };
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
			executions.sort(
				(a, b) => order.indexOf(a.source) - order.indexOf(b.source),
			);
			const kept = keepRecords(executions);
			const owners = kept.length
				? new Map(
						(
							await tx
								.select()
								.from(paperAlias)
								.where(
									inArray(
										paperAlias.alias,
										kept.flatMap((entry) => entry.aliases),
									),
								)
						).map((row) => [row.alias, row.paperId]),
					)
				: new Map<string, string>();
			const paperIds = new Map<Kept, string>();
			const fresh: Kept[] = [];
			for (const entry of kept) {
				const owner = entry.aliases
					.map((alias) => owners.get(alias))
					.find((id) => id !== undefined);
				if (owner) paperIds.set(entry, owner);
				else fresh.push(entry);
			}
			if (fresh.length) {
				await tx
					.insert(paper)
					.values(
						fresh.map(({ record }) => ({
							id: randomUUID(),
							key: record.key,
							title: record.title,
							authors: record.authors,
							year: record.year,
							doi: record.doi,
							url: record.url,
						})),
					)
					.onConflictDoNothing({ target: paper.key });
				const created = new Map(
					(
						await tx
							.select({ id: paper.id, key: paper.key })
							.from(paper)
							.where(
								inArray(
									paper.key,
									fresh.map(({ record }) => record.key),
								),
							)
					).map((row) => [row.key, row.id]),
				);
				for (const entry of fresh)
					paperIds.set(entry, created.get(entry.record.key) ?? "");
			}
			if (kept.length)
				await tx
					.insert(paperAlias)
					.values(
						kept.flatMap((entry) =>
							entry.aliases.map((alias) => ({
								alias,
								paperId: paperIds.get(entry) ?? "",
							})),
						),
					)
					.onConflictDoNothing();
			// Two records can resolve to one earlier paper through different identifiers.
			const first = new Map<string, Kept>();
			const members = kept.filter((entry) => {
				const id = paperIds.get(entry) ?? "";
				const earlier = first.get(id);
				if (!earlier) {
					first.set(id, entry);
					return true;
				}
				earlier.alsoObserved.push(
					{ source: entry.source, record: entry.record },
					...entry.alsoObserved,
				);
				return false;
			});
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
				paperCount: members.length,
				allocations: {
					reserved: sourceAllocations(job.input.scope.sources).reserved,
					sources: executions.map((execution) => {
						const counts: Partial<Record<AcquisitionReason, number>> = {};
						for (const { record, source } of members)
							if (source === execution.source)
								counts[record.acquisitionReason] =
									(counts[record.acquisitionReason] ?? 0) + 1;
						return {
							source: execution.source,
							allocation: execution.allocation,
							kept: counts,
						};
					}),
				},
			});
			if (members.length)
				await tx.insert(snapshotPaper).values(
					members.map((entry, rank) => ({
						snapshotId,
						paperId: paperIds.get(entry) ?? "",
						projectId: job.projectId,
						source: entry.source,
						rank,
						acquisitionReason: entry.record.acquisitionReason,
						observation: entry.record,
						alsoObserved: entry.alsoObserved,
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
	pollingIntervalSeconds: number,
) {
	return boss.work(
		literatureSearchQueue,
		{ ...literatureWorkOptions, pollingIntervalSeconds },
		createLiteratureJobHandler(options),
	);
}

/** Persistent worker process: owns its queue pool, polls, and supervises pg-boss maintenance. */
export async function runLiteratureWorker(
	connectionString: string,
	options: LiteratureWorkerOptions,
	pollingIntervalSeconds: number,
) {
	const boss = new PgBoss({
		connectionString,
		max: 3,
		migrate: false,
		// No cron schedules or job flows exist, yet their pollers would query every five seconds.
		schedule: false,
		flowIntervalSeconds: 60 * 60,
	});
	boss.on("error", (error) => console.error("job_queue_error", error.message));
	await boss.start();
	const reconcile = async () => {
		const abandoned = await reconcileAbandonedSearches(options.db, boss);
		if (abandoned.length)
			console.error("literature_jobs_abandoned", abandoned.join(","));
	};
	await reconcile();
	const reconciling = setInterval(() => {
		reconcile().catch((error) =>
			console.error(
				"literature_reconcile_failed",
				error instanceof Error ? error.name : "unknown",
			),
		);
	}, 5 * 60_000);
	await startLiteratureWorker(boss, options, pollingIntervalSeconds);
	return () => {
		clearInterval(reconciling);
		return boss.stop({ graceful: true, timeout: 30_000 });
	};
}
