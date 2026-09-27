import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { researchProject } from "./projects";

export type LiteratureScope = {
	queries: string[];
	sources: string[];
	dateFrom: string;
	dateTo: string;
	inclusionCriteria: string;
	exclusionCriteria: string;
	includeFoundations: boolean;
};
export const literatureScopeRevision = pgTable(
	"literature_scope_revision",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => researchProject.id, { onDelete: "cascade" }),
		revision: integer("revision").notNull(),
		briefRevision: integer("brief_revision").notNull(),
		scope: jsonb("scope").$type<LiteratureScope>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("literature_scope_project_revision_idx").on(
			table.projectId,
			table.revision,
		),
	],
);

export type ResearchJobState =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled";
export type LiteratureSearchInput = {
	scopeRevision: number;
	briefRevision: number;
	scope: LiteratureScope;
};
export const researchJob = pgTable(
	"research_job",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => researchProject.id, { onDelete: "cascade" }),
		ownerId: text("owner_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		kind: text("kind").$type<"literature-search">().notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		inputHash: text("input_hash").notNull(),
		input: jsonb("input").$type<LiteratureSearchInput>().notNull(),
		state: text("state").$type<ResearchJobState>().notNull().default("queued"),
		stage: text("stage")
			.$type<"waiting" | "retrieving" | "publishing" | "done">()
			.notNull()
			.default("waiting"),
		cancelReason: text("cancel_reason").$type<
			"researcher" | "archived" | "deleted" | "access-withdrawn"
		>(),
		errorClass: text("error_class"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		startedAt: timestamp("started_at", { withTimezone: true }),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("research_job_idempotency_idx").on(
			table.projectId,
			table.kind,
			table.idempotencyKey,
		),
		index("research_job_owner_state_idx").on(table.ownerId, table.state),
		index("research_job_project_idx").on(table.projectId, table.createdAt),
		check(
			"research_job_state_check",
			sql`${table.state} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
		),
	],
);

export type SourceOutcome = "succeeded" | "empty" | "partial" | "failed";
export type SourceRecord = {
	key: string;
	title: string;
	authors: string[];
	year: number;
	doi: string | null;
	url: string | null;
	acquisitionReason: "discovery" | "foundation";
};
/** One source's checkpoint within a job; completed rows are never re-executed. */
export const sourceExecution = pgTable(
	"source_execution",
	{
		id: text("id").primaryKey(),
		jobId: text("job_id")
			.notNull()
			.references(() => researchJob.id, { onDelete: "cascade" }),
		projectId: text("project_id")
			.notNull()
			.references(() => researchProject.id, { onDelete: "cascade" }),
		source: text("source").notNull(),
		status: text("status")
			.$type<"pending" | "running" | SourceOutcome>()
			.notNull()
			.default("pending"),
		attempts: integer("attempts").notNull().default(0),
		allocation: integer("allocation").notNull(),
		effectiveQueries: jsonb("effective_queries").$type<string[]>().notNull(),
		appliedFilters: jsonb("applied_filters").$type<string[]>().notNull(),
		unsupportedFilters: jsonb("unsupported_filters")
			.$type<string[]>()
			.notNull(),
		reportedCount: integer("reported_count"),
		receivedCount: integer("received_count"),
		cursor: text("cursor"),
		cacheAgeSeconds: integer("cache_age_seconds"),
		truncated: boolean("truncated").notNull().default(false),
		errorClass: text("error_class"),
		records: jsonb("records").$type<SourceRecord[]>(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("source_execution_job_source_idx").on(
			table.jobId,
			table.source,
		),
	],
);

/** Immutable once published; a further search creates another snapshot. */
export const literatureSnapshot = pgTable(
	"literature_snapshot",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => researchProject.id, { onDelete: "cascade" }),
		jobId: text("job_id")
			.notNull()
			.unique()
			.references(() => researchJob.id, { onDelete: "cascade" }),
		scopeRevision: integer("scope_revision").notNull(),
		briefRevision: integer("brief_revision").notNull(),
		coverage: text("coverage").$type<"all-sources" | "partial">().notNull(),
		recordCap: integer("record_cap").notNull(),
		paperCount: integer("paper_count").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("literature_snapshot_project_idx").on(
			table.projectId,
			table.createdAt,
		),
	],
);

/** Public bibliographic facts; they may outlive the private projects that found them. */
export const paper = pgTable("paper", {
	id: text("id").primaryKey(),
	key: text("key").notNull().unique(),
	title: text("title").notNull(),
	authors: jsonb("authors").$type<string[]>().notNull(),
	year: integer("year").notNull(),
	doi: text("doi"),
	url: text("url"),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const snapshotPaper = pgTable(
	"snapshot_paper",
	{
		snapshotId: text("snapshot_id")
			.notNull()
			.references(() => literatureSnapshot.id, { onDelete: "cascade" }),
		paperId: text("paper_id")
			.notNull()
			.references(() => paper.id),
		projectId: text("project_id")
			.notNull()
			.references(() => researchProject.id, { onDelete: "cascade" }),
		source: text("source").notNull(),
		rank: integer("rank").notNull(),
		acquisitionReason: text("acquisition_reason")
			.$type<"discovery" | "foundation">()
			.notNull(),
	},
	(table) => [primaryKey({ columns: [table.snapshotId, table.paperId] })],
);

/**
 * Amounts are integer micro-dollars. Reservations outlive deleted research content so spend
 * already incurred still counts against monthly limits.
 */
export const usageReservation = pgTable(
	"usage_reservation",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => researchProject.id, { onDelete: "cascade" }),
		jobId: text("job_id").references(() => researchJob.id, {
			onDelete: "set null",
		}),
		sourceExecutionId: text("source_execution_id").references(
			() => sourceExecution.id,
			{ onDelete: "set null" },
		),
		attempt: integer("attempt").notNull(),
		route: text("route").notNull(),
		period: text("period").notNull(),
		reservedMicros: integer("reserved_micros").notNull(),
		actualMicros: integer("actual_micros"),
		state: text("state")
			.$type<"pending" | "settled" | "held">()
			.notNull()
			.default("pending"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		settledAt: timestamp("settled_at", { withTimezone: true }),
	},
	(table) => [
		index("usage_reservation_period_idx").on(table.period, table.projectId),
		index("usage_reservation_job_idx").on(table.jobId),
		check(
			"usage_reservation_state_check",
			sql`${table.state} in ('pending', 'settled', 'held')`,
		),
	],
);
