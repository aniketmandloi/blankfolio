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
			.$type<"waiting" | "retrieving" | "reconciling" | "publishing" | "done">()
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
/** Older work arrives as `foundation` (fixtures), `citation` (cited by discovery results) or `direct-lookup`. */
export type AcquisitionReason =
	| "discovery"
	| "foundation"
	| "citation"
	| "direct-lookup";
export type SourceRecord = {
	key: string;
	title: string;
	authors: string[];
	year: number;
	doi: string | null;
	url: string | null;
	acquisitionReason: AcquisitionReason;
	/** Exact stable identifiers (`doi:…`, `openalex:W…`, `arxiv:…`, `pmid:…`) that reconcile papers. */
	identifiers?: string[];
	publicationDate?: string | null;
	/** `null` when the source does not say whether this copy is a preprint. */
	preprint?: boolean | null;
	workType?: string | null;
	abstractAvailable?: boolean;
	/** When the provider last changed its record. */
	sourceUpdatedAt?: string | null;
	/** The provider's version of this copy, e.g. arXiv `v2`, and the date that version appeared. */
	version?: string | null;
	versionDate?: string | null;
	/** Other manifestations of the work the provider names; they stay separate papers. */
	relatedVersions?: RelatedVersion[];
	/** Updates the provider itself reports, such as an arXiv withdrawal comment. */
	updates?: PublicationUpdate[];
};
/** A correction, retraction, withdrawal or similar notice about a work. */
export type PublicationUpdate = {
	type: string;
	label: string;
	/** Who reported it, e.g. `publisher`, `retraction-watch` or `arxiv`. */
	source: string;
	/** The notice itself, e.g. `doi:…`. */
	notice: string | null;
	date: string | null;
};
export type SourceObservation = { source: string; record: SourceRecord };
export type RelatedVersion = {
	identifier: string;
	relation: "published-version" | "preprint";
	note?: string | null;
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

export type SnapshotAllocations = {
	/** Records held back from the cap for the later arXiv and status stages. */
	reserved: number;
	sources: {
		source: string;
		allocation: number;
		kept: Partial<Record<AcquisitionReason, number>>;
	}[];
};
/** How far publication-status reconciliation got for this snapshot's DOIs. */
export type SnapshotStatusCheck = {
	source: string;
	outcome: "complete" | "partial" | "failed" | "not-run";
	checked: number;
	notRegistered: number;
	/** DOIs the source covers whose status could not be checked. */
	unknown: number;
	errorClass: string | null;
	checkedAt: string;
};
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
		allocations: jsonb("allocations").$type<SnapshotAllocations>(),
		statusCheck: jsonb("status_check").$type<SnapshotStatusCheck>(),
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

/** Exact identifiers owned by one paper; a conflicting identifier never moves or merges papers. */
export const paperAlias = pgTable(
	"paper_alias",
	{
		alias: text("alias").primaryKey(),
		paperId: text("paper_id")
			.notNull()
			.references(() => paper.id),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [index("paper_alias_paper_idx").on(table.paperId)],
);

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
			.$type<AcquisitionReason>()
			.notNull(),
		/** The record exactly as this source returned it; later observations never rewrite it. */
		observation: jsonb("observation").$type<SourceRecord>(),
		/** The same paper as other sources in this run returned it, reconciled by exact identifier. */
		alsoObserved: jsonb("also_observed")
			.$type<SourceObservation[]>()
			.notNull()
			.default([]),
		/** The publication status known when this snapshot was published; never rewritten. */
		statusCheck: jsonb("status_check").$type<PaperStatusCheck>(),
	},
	(table) => [primaryKey({ columns: [table.snapshotId, table.paperId] })],
);

export type MatchEvidence = {
	title: string;
	years: [number, number];
	sharedAuthors: string[];
};
/**
 * Two papers sharing no identifier but alike in normalised title, year and an author's family
 * name. A decision is the project's own and never merges, moves or rewrites either paper.
 */
export const paperMatch = pgTable(
	"paper_match",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => researchProject.id, { onDelete: "cascade" }),
		/** Ordered so each pair is stored once per project. */
		paperId: text("paper_id")
			.notNull()
			.references(() => paper.id),
		otherPaperId: text("other_paper_id")
			.notNull()
			.references(() => paper.id),
		evidence: jsonb("evidence").$type<MatchEvidence>().notNull(),
		decision: text("decision").$type<"same-work" | "different-works">(),
		revision: integer("revision").notNull().default(0),
		decidedAt: timestamp("decided_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("paper_match_pair_idx").on(
			table.projectId,
			table.paperId,
			table.otherPaperId,
		),
		check(
			"paper_match_order_check",
			sql`${table.paperId} < ${table.otherPaperId}`,
		),
	],
);

export type PaperStatusCheck =
	| {
			check: "checked" | "not-registered";
			doi: string;
			revision: number;
			checkedAt: string;
			updates: PublicationUpdate[];
			relatedVersions: RelatedVersion[];
	  }
	| { check: "failed"; doi: string }
	| { check: "not-covered" | "no-doi" | "not-run" };

/**
 * A DOI's publication status as a public fact. A changed answer adds a revision, so earlier
 * snapshots keep theirs and later reviews can observe the change; `checkedAt` moves forward
 * each time the same answer is confirmed.
 */
export const publicationStatus = pgTable(
	"publication_status",
	{
		id: text("id").primaryKey(),
		doi: text("doi").notNull(),
		revision: integer("revision").notNull(),
		registered: boolean("registered").notNull(),
		updates: jsonb("updates").$type<PublicationUpdate[]>().notNull(),
		relatedVersions: jsonb("related_versions")
			.$type<RelatedVersion[]>()
			.notNull(),
		observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
		checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		uniqueIndex("publication_status_doi_revision_idx").on(
			table.doi,
			table.revision,
		),
	],
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

/** Provider-directed pauses shared by every worker, e.g. after a rate-limit answer. */
export const sourceThrottle = pgTable("source_throttle", {
	source: text("source").primaryKey(),
	pausedUntil: timestamp("paused_until", { withTimezone: true }).notNull(),
});

/**
 * Provider responses whose terms allow caching, scoped to a project because their keys derive
 * from private queries; project cleanup removes them.
 */
export const sourceResponseCache = pgTable(
	"source_response_cache",
	{
		projectId: text("project_id")
			.notNull()
			.references(() => researchProject.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		source: text("source").notNull(),
		body: jsonb("body").notNull(),
		fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.projectId, table.key] })],
);
