import { createHash, randomUUID } from "node:crypto";
import type { Database, Transaction } from "@blankfolio/db";
import { user } from "@blankfolio/db/schema/auth";
import {
	type LiteratureScope,
	literatureScopeRevision,
	literatureSnapshot,
	paper,
	researchJob,
	snapshotPaper,
	sourceExecution,
} from "@blankfolio/db/schema/literature";
import type { ResearchBrief } from "@blankfolio/db/schema/projects";
import { briefRevision } from "@blankfolio/db/schema/projects";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { researchProcedure, router } from "../index";
import {
	literatureSources,
	maxChargeMicros,
	recordAliases,
	type SourceSettings,
	sourceAllocation,
	sourceAvailability,
} from "../literature-sources";
import { requireProject } from "../project-lifecycle";
import { activeRunsPerAccount } from "../research-jobs";
import { budgetStatus } from "../usage-budget";
import { assertDiscoveryBrief, briefSchema } from "./projects";

const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date")
	.refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), {
		message: "Use a real calendar date",
	});
const sourceIds = Object.keys(literatureSources) as [string, ...string[]];
export const scopeSchema = z
	.object({
		queries: z
			.array(
				z
					.string()
					.trim()
					.min(1, "Queries cannot be blank")
					.max(2_000, "Each query must be 2,000 characters or fewer"),
			)
			.min(1, "Add at least one query")
			.max(3, "Use at most three queries"),
		sources: z
			.array(z.enum(sourceIds))
			.min(1, "Choose at least one source")
			.refine((ids) => new Set(ids).size === ids.length, {
				message: "Choose each source once",
			}),
		dateFrom: isoDate,
		dateTo: isoDate,
		inclusionCriteria: z.string().max(2_000).default(""),
		exclusionCriteria: z.string().max(2_000).default(""),
		includeFoundations: z.boolean().default(false),
	})
	.refine(({ dateFrom, dateTo }) => dateFrom <= dateTo, {
		message: "The start date must be on or before the end date",
	});

/** Deterministic templates from the brief's topic and title only; no other brief field. */
export function proposeScope(brief: ResearchBrief, now: Date): LiteratureScope {
	const from = new Date(now);
	from.setUTCFullYear(from.getUTCFullYear() - 5);
	return {
		queries: [
			...new Set([brief.topic.trim(), brief.title.trim()].filter(Boolean)),
		].map((query) => query.slice(0, 2_000)),
		sources: ["fixture-catalog"],
		dateFrom: from.toISOString().slice(0, 10),
		dateTo: now.toISOString().slice(0, 10),
		inclusionCriteria: "",
		exclusionCriteria: "",
		includeFoundations: false,
	};
}

function sourceCatalog(settings: SourceSettings) {
	return Object.values(literatureSources).map((source) => ({
		id: source.id,
		label: source.label,
		metered: source.routes.length > 0,
		routes: source.routes.map((route) => ({
			id: route,
			priceMicros: settings.prices[route] ?? null,
		})),
		dailyQuotaMicros: settings.quotas[source.id] ?? null,
		unavailable: sourceAvailability(source, settings).blockedBy,
	}));
}
const unavailableText = {
	"pricing-unknown": "its pricing is not configured",
	"quota-unknown": "its daily quota is not configured",
};

async function latestScope(db: Database | Transaction, projectId: string) {
	const [saved] = await db
		.select()
		.from(literatureScopeRevision)
		.where(eq(literatureScopeRevision.projectId, projectId))
		.orderBy(desc(literatureScopeRevision.revision))
		.limit(1);
	return saved;
}
async function latestBrief(db: Database | Transaction, projectId: string) {
	const [brief] = await db
		.select()
		.from(briefRevision)
		.where(eq(briefRevision.projectId, projectId))
		.orderBy(desc(briefRevision.revision))
		.limit(1);
	if (!brief)
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Research brief missing",
		});
	return brief;
}
async function scopeView(
	db: Database | Transaction,
	projectId: string,
	settings: SourceSettings,
) {
	const saved = await latestScope(db, projectId);
	const brief = await latestBrief(db, projectId);
	return {
		revision: saved?.revision ?? 0,
		briefRevision: saved?.briefRevision ?? brief.revision,
		proposed: !saved,
		scope: saved?.scope ?? proposeScope(brief.brief, new Date()),
		sources: sourceCatalog(settings),
	};
}

// Correlated subqueries name their tables explicitly; drizzle leaves single-table columns unqualified.
const finishedSources = sql<number>`(select count(*)::int from source_execution where source_execution.job_id = research_job.id and source_execution.status in ('succeeded', 'empty', 'partial', 'failed'))`;
const jobSummary = {
	id: researchJob.id,
	state: researchJob.state,
	stage: researchJob.stage,
	cancelReason: researchJob.cancelReason,
	errorClass: researchJob.errorClass,
	scopeRevision: sql<number>`(${researchJob.input}->>'scopeRevision')::int`,
	sourceCount: sql<number>`jsonb_array_length(${researchJob.input}->'scope'->'sources')`,
	finishedSources,
	snapshotId: sql<
		string | null
	>`(select literature_snapshot.id from literature_snapshot where literature_snapshot.job_id = research_job.id)`,
	createdAt: researchJob.createdAt,
	startedAt: researchJob.startedAt,
	finishedAt: researchJob.finishedAt,
};
async function jobById(
	db: Database | Transaction,
	projectId: string,
	jobId: string,
) {
	const [job] = await db
		.select(jobSummary)
		.from(researchJob)
		.where(
			and(eq(researchJob.id, jobId), eq(researchJob.projectId, projectId)),
		);
	if (!job)
		throw new TRPCError({ code: "NOT_FOUND", message: "Search job not found" });
	return job;
}
async function sourceOutcomes(db: Database | Transaction, jobId: string) {
	const rows = await db
		.select({
			source: sourceExecution.source,
			status: sourceExecution.status,
			attempts: sourceExecution.attempts,
			allocation: sourceExecution.allocation,
			effectiveQueries: sourceExecution.effectiveQueries,
			appliedFilters: sourceExecution.appliedFilters,
			unsupportedFilters: sourceExecution.unsupportedFilters,
			reportedCount: sourceExecution.reportedCount,
			receivedCount: sourceExecution.receivedCount,
			cursor: sourceExecution.cursor,
			cacheAgeSeconds: sourceExecution.cacheAgeSeconds,
			truncated: sourceExecution.truncated,
			errorClass: sourceExecution.errorClass,
			completedAt: sourceExecution.completedAt,
		})
		.from(sourceExecution)
		.where(eq(sourceExecution.jobId, jobId))
		.orderBy(asc(sourceExecution.source));
	return rows.map((row) => ({
		...row,
		label: literatureSources[row.source]?.label ?? row.source,
	}));
}
const readOnly = {
	isolationLevel: "repeatable read",
	accessMode: "read only",
} as const;
const projectRef = z.object({ projectId: z.string().uuid() });

export const literatureRouter = router({
	scope: researchProcedure.input(projectRef).query(({ ctx, input }) =>
		ctx.db.transaction(async (tx) => {
			await requireProject(tx, ctx.session.user.id, input.projectId);
			return scopeView(tx, input.projectId, ctx.sourceSettings);
		}, readOnly),
	),
	saveScope: researchProcedure
		.input(
			projectRef.extend({
				expectedRevision: z.number().int().min(0),
				scope: scopeSchema,
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.db.transaction(async (tx) => {
				const project = await requireProject(
					tx,
					ctx.session.user.id,
					input.projectId,
					"write",
				);
				const revision =
					(await latestScope(tx, input.projectId))?.revision ?? 0;
				if (revision !== input.expectedRevision)
					throw new TRPCError({
						code: "CONFLICT",
						message:
							"Another tab saved this Literature Scope. Keep your edits and reload the saved scope before trying again.",
					});
				await tx.insert(literatureScopeRevision).values({
					id: randomUUID(),
					projectId: input.projectId,
					revision: revision + 1,
					briefRevision: project.revision,
					scope: input.scope,
				});
				return scopeView(tx, input.projectId, ctx.sourceSettings);
			}),
		),
	submitSearch: researchProcedure
		.input(
			projectRef.extend({
				scopeRevision: z.number().int().positive(),
				idempotencyKey: z.string().uuid(),
				queries: z.array(z.string()).min(1).max(3),
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.db.transaction(async (tx) => {
				const ownerId = ctx.session.user.id;
				await requireProject(tx, ownerId, input.projectId, "write");
				const inputHash = createHash("sha256")
					.update(
						JSON.stringify({
							scopeRevision: input.scopeRevision,
							queries: input.queries,
						}),
					)
					.digest("hex");
				const [existing] = await tx
					.select({ id: researchJob.id, inputHash: researchJob.inputHash })
					.from(researchJob)
					.where(
						and(
							eq(researchJob.projectId, input.projectId),
							eq(researchJob.kind, "literature-search"),
							eq(researchJob.idempotencyKey, input.idempotencyKey),
						),
					);
				if (existing) {
					if (existing.inputHash !== inputHash)
						throw new TRPCError({
							code: "CONFLICT",
							message:
								"This submission was already used for a different search. Review the scope and submit again.",
						});
					return jobById(tx, input.projectId, existing.id);
				}
				const saved = await latestScope(tx, input.projectId);
				if (!saved || saved.revision !== input.scopeRevision)
					throw new TRPCError({
						code: "CONFLICT",
						message:
							"The Literature Scope changed. Review the latest saved queries before searching.",
					});
				if (
					JSON.stringify(saved.scope.queries) !== JSON.stringify(input.queries)
				)
					throw new TRPCError({
						code: "CONFLICT",
						message:
							"The confirmed queries do not match the saved scope. Review the queries before searching.",
					});
				const brief = await latestBrief(tx, input.projectId);
				assertDiscoveryBrief(briefSchema.parse(brief.brief));
				const budget = await budgetStatus(tx, input.projectId, new Date());
				for (const id of saved.scope.sources) {
					const source = literatureSources[id];
					if (!source) continue;
					const { blockedBy, routes } = sourceAvailability(
						source,
						ctx.sourceSettings,
					);
					if (blockedBy)
						throw new TRPCError({
							code: "PRECONDITION_FAILED",
							message: `${source.label} is disabled because ${unavailableText[blockedBy]}. Remove it from the scope or use other sources.`,
						});
					const charge = maxChargeMicros(
						source,
						{
							queries: saved.scope.queries,
							limit: sourceAllocation(saved.scope.sources.length),
							includeFoundations: saved.scope.includeFoundations,
							routes,
						},
						ctx.sourceSettings.prices,
					);
					if (charge && budget.exceeds(charge))
						throw new TRPCError({
							code: "PRECONDITION_FAILED",
							message: `The spending limit does not allow ${source.label} now. Remove it from the scope or use free sources.`,
						});
				}
				await tx
					.select({ id: user.id })
					.from(user)
					.where(eq(user.id, ownerId))
					.for("update");
				const [active] = await tx
					.select({ count: count() })
					.from(researchJob)
					.where(
						and(
							eq(researchJob.ownerId, ownerId),
							inArray(researchJob.state, ["queued", "running"]),
						),
					);
				if ((active?.count ?? 0) >= activeRunsPerAccount)
					throw new TRPCError({
						code: "TOO_MANY_REQUESTS",
						message: `You already have ${activeRunsPerAccount} active searches. Wait for one to finish or cancel it.`,
					});
				const id = randomUUID();
				await ctx.jobQueue.enqueue(tx, id);
				await tx.insert(researchJob).values({
					id,
					projectId: input.projectId,
					ownerId,
					kind: "literature-search",
					idempotencyKey: input.idempotencyKey,
					inputHash,
					input: {
						scopeRevision: saved.revision,
						briefRevision: brief.revision,
						scope: saved.scope,
					},
				});
				return jobById(tx, input.projectId, id);
			}),
		),
	jobs: researchProcedure
		.input(
			projectRef.extend({
				limit: z.number().int().min(1).max(50).default(10),
				cursor: z.string().uuid().optional(),
			}),
		)
		.query(({ ctx, input }) =>
			ctx.db.transaction(async (tx) => {
				await requireProject(tx, ctx.session.user.id, input.projectId);
				const items = await tx
					.select(jobSummary)
					.from(researchJob)
					.where(
						and(
							eq(researchJob.projectId, input.projectId),
							input.cursor
								? sql`(${researchJob.createdAt}, ${researchJob.id}) < (select created_at, id from research_job where id = ${input.cursor})`
								: undefined,
						),
					)
					.orderBy(desc(researchJob.createdAt), desc(researchJob.id))
					.limit(input.limit + 1);
				const hasMore = items.length > input.limit;
				if (hasMore) items.pop();
				return { items, nextCursor: hasMore ? items.at(-1)?.id : undefined };
			}, readOnly),
		),
	job: researchProcedure
		.input(projectRef.extend({ jobId: z.string().uuid() }))
		.query(({ ctx, input }) =>
			ctx.db.transaction(async (tx) => {
				await requireProject(tx, ctx.session.user.id, input.projectId);
				const job = await jobById(tx, input.projectId, input.jobId);
				return { ...job, sources: await sourceOutcomes(tx, job.id) };
			}, readOnly),
		),
	cancel: researchProcedure
		.input(projectRef.extend({ jobId: z.string().uuid() }))
		.mutation(({ ctx, input }) =>
			ctx.db.transaction(async (tx) => {
				await requireProject(tx, ctx.session.user.id, input.projectId, "write");
				await jobById(tx, input.projectId, input.jobId);
				await tx
					.update(researchJob)
					.set({
						state: "cancelled",
						cancelReason: "researcher",
						finishedAt: new Date(),
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(researchJob.id, input.jobId),
							inArray(researchJob.state, ["queued", "running"]),
						),
					);
				return jobById(tx, input.projectId, input.jobId);
			}),
		),
	snapshots: researchProcedure.input(projectRef).query(({ ctx, input }) =>
		ctx.db.transaction(async (tx) => {
			await requireProject(tx, ctx.session.user.id, input.projectId);
			return tx
				.select({
					id: literatureSnapshot.id,
					jobId: literatureSnapshot.jobId,
					scopeRevision: literatureSnapshot.scopeRevision,
					coverage: literatureSnapshot.coverage,
					paperCount: literatureSnapshot.paperCount,
					createdAt: literatureSnapshot.createdAt,
				})
				.from(literatureSnapshot)
				.where(eq(literatureSnapshot.projectId, input.projectId))
				.orderBy(desc(literatureSnapshot.createdAt))
				.limit(50);
		}, readOnly),
	),
	snapshot: researchProcedure
		.input(projectRef.extend({ snapshotId: z.string().uuid() }))
		.query(({ ctx, input }) =>
			ctx.db.transaction(async (tx) => {
				await requireProject(tx, ctx.session.user.id, input.projectId);
				const [snapshot] = await tx
					.select({
						snapshot: literatureSnapshot,
						scope: literatureScopeRevision.scope,
					})
					.from(literatureSnapshot)
					.innerJoin(
						literatureScopeRevision,
						and(
							eq(
								literatureScopeRevision.projectId,
								literatureSnapshot.projectId,
							),
							eq(
								literatureScopeRevision.revision,
								literatureSnapshot.scopeRevision,
							),
						),
					)
					.where(
						and(
							eq(literatureSnapshot.id, input.snapshotId),
							eq(literatureSnapshot.projectId, input.projectId),
						),
					);
				if (!snapshot)
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Literature Snapshot not found",
					});
				const rows = await tx
					.select({
						id: paper.id,
						title: paper.title,
						authors: paper.authors,
						year: paper.year,
						doi: paper.doi,
						url: paper.url,
						source: snapshotPaper.source,
						acquisitionReason: snapshotPaper.acquisitionReason,
						observation: snapshotPaper.observation,
					})
					.from(snapshotPaper)
					.innerJoin(paper, eq(paper.id, snapshotPaper.paperId))
					.where(eq(snapshotPaper.snapshotId, input.snapshotId))
					.orderBy(asc(snapshotPaper.rank));
				// A snapshot shows what its source observed, not later corrections to the paper.
				const papers = rows.map(({ observation, ...row }) => {
					const seen = observation ?? { ...row, key: "" };
					return {
						id: row.id,
						source: row.source,
						acquisitionReason: row.acquisitionReason,
						title: seen.title,
						authors: seen.authors,
						year: seen.year,
						doi: seen.doi,
						url: seen.url,
						identifiers: observation
							? recordAliases(observation).filter(
									(alias) => !alias.startsWith("fixture:"),
								)
							: row.doi
								? [`doi:${row.doi.toLowerCase()}`]
								: [],
						publicationDate: observation?.publicationDate ?? null,
						preprint: observation?.preprint ?? null,
						workType: observation?.workType ?? null,
						abstractAvailable: observation?.abstractAvailable ?? false,
						sourceUpdatedAt: observation?.sourceUpdatedAt ?? null,
					};
				});
				return {
					...snapshot.snapshot,
					scope: snapshot.scope,
					sources: await sourceOutcomes(tx, snapshot.snapshot.jobId),
					papers,
				};
			}, readOnly),
		),
	budget: researchProcedure.input(projectRef).query(({ ctx, input }) =>
		ctx.db.transaction(async (tx) => {
			await requireProject(tx, ctx.session.user.id, input.projectId);
			const budget = await budgetStatus(tx, input.projectId, new Date());
			return {
				period: budget.period,
				limits: budget.limits,
				projectCommittedMicros: budget.projectCommittedMicros,
				sources: sourceCatalog(ctx.sourceSettings).map((entry) => {
					const source = literatureSources[entry.id];
					const charge = source
						? maxChargeMicros(
								source,
								{
									queries: ["one query"],
									limit: sourceAllocation(1),
									includeFoundations: true,
									routes: sourceAvailability(source, ctx.sourceSettings).routes,
								},
								ctx.sourceSettings.prices,
							)
						: 0;
					return {
						...entry,
						/** Whether a one-query search on this source alone is blocked now. */
						blockedBy:
							entry.unavailable ?? (charge ? budget.exceeds(charge) : null),
					};
				}),
			};
		}, readOnly),
	),
});
