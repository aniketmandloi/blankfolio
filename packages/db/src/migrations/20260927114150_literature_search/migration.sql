CREATE TABLE "literature_scope_revision" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"revision" integer NOT NULL,
	"brief_revision" integer NOT NULL,
	"scope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "literature_snapshot" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"job_id" text NOT NULL UNIQUE,
	"scope_revision" integer NOT NULL,
	"brief_revision" integer NOT NULL,
	"coverage" text NOT NULL,
	"record_cap" integer NOT NULL,
	"paper_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper" (
	"id" text PRIMARY KEY,
	"key" text NOT NULL UNIQUE,
	"title" text NOT NULL,
	"authors" jsonb NOT NULL,
	"year" integer NOT NULL,
	"doi" text,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_job" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"input" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'waiting' NOT NULL,
	"cancel_reason" text,
	"error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_job_state_check" CHECK ("state" in ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "snapshot_paper" (
	"snapshot_id" text,
	"paper_id" text,
	"project_id" text NOT NULL,
	"source" text NOT NULL,
	"rank" integer NOT NULL,
	"acquisition_reason" text NOT NULL,
	CONSTRAINT "snapshot_paper_pkey" PRIMARY KEY("snapshot_id","paper_id")
);
--> statement-breakpoint
CREATE TABLE "source_execution" (
	"id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"project_id" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"allocation" integer NOT NULL,
	"effective_queries" jsonb NOT NULL,
	"applied_filters" jsonb NOT NULL,
	"unsupported_filters" jsonb NOT NULL,
	"reported_count" integer,
	"received_count" integer,
	"cursor" text,
	"cache_age_seconds" integer,
	"truncated" boolean DEFAULT false NOT NULL,
	"error_class" text,
	"records" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "usage_reservation" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"job_id" text,
	"source_execution_id" text,
	"attempt" integer NOT NULL,
	"route" text NOT NULL,
	"period" text NOT NULL,
	"reserved_micros" integer NOT NULL,
	"actual_micros" integer,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "usage_reservation_state_check" CHECK ("state" in ('pending', 'settled', 'held'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "literature_scope_project_revision_idx" ON "literature_scope_revision" ("project_id","revision");--> statement-breakpoint
CREATE INDEX "literature_snapshot_project_idx" ON "literature_snapshot" ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "research_job_idempotency_idx" ON "research_job" ("project_id","kind","idempotency_key");--> statement-breakpoint
CREATE INDEX "research_job_owner_state_idx" ON "research_job" ("owner_id","state");--> statement-breakpoint
CREATE INDEX "research_job_project_idx" ON "research_job" ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_execution_job_source_idx" ON "source_execution" ("job_id","source");--> statement-breakpoint
CREATE INDEX "usage_reservation_period_idx" ON "usage_reservation" ("period","project_id");--> statement-breakpoint
CREATE INDEX "usage_reservation_job_idx" ON "usage_reservation" ("job_id");--> statement-breakpoint
ALTER TABLE "literature_scope_revision" ADD CONSTRAINT "literature_scope_revision_project_id_research_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "research_project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "literature_snapshot" ADD CONSTRAINT "literature_snapshot_project_id_research_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "research_project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "literature_snapshot" ADD CONSTRAINT "literature_snapshot_job_id_research_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "research_job"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "research_job" ADD CONSTRAINT "research_job_project_id_research_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "research_project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "research_job" ADD CONSTRAINT "research_job_owner_id_user_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "snapshot_paper" ADD CONSTRAINT "snapshot_paper_snapshot_id_literature_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "literature_snapshot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "snapshot_paper" ADD CONSTRAINT "snapshot_paper_paper_id_paper_id_fkey" FOREIGN KEY ("paper_id") REFERENCES "paper"("id");--> statement-breakpoint
ALTER TABLE "snapshot_paper" ADD CONSTRAINT "snapshot_paper_project_id_research_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "research_project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "source_execution" ADD CONSTRAINT "source_execution_job_id_research_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "research_job"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "source_execution" ADD CONSTRAINT "source_execution_project_id_research_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "research_project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "usage_reservation" ADD CONSTRAINT "usage_reservation_project_id_research_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "research_project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "usage_reservation" ADD CONSTRAINT "usage_reservation_job_id_research_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "research_job"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "usage_reservation" ADD CONSTRAINT "usage_reservation_source_execution_id_source_execution_id_fkey" FOREIGN KEY ("source_execution_id") REFERENCES "source_execution"("id") ON DELETE SET NULL;