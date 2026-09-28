CREATE TABLE "paper_alias" (
	"alias" text PRIMARY KEY,
	"paper_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_response_cache" (
	"project_id" text,
	"key" text,
	"source" text NOT NULL,
	"body" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "source_response_cache_pkey" PRIMARY KEY("project_id","key")
);
--> statement-breakpoint
CREATE TABLE "source_throttle" (
	"source" text PRIMARY KEY,
	"paused_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "literature_snapshot" ADD COLUMN "allocations" jsonb;--> statement-breakpoint
ALTER TABLE "snapshot_paper" ADD COLUMN "observation" jsonb;--> statement-breakpoint
CREATE INDEX "paper_alias_paper_idx" ON "paper_alias" ("paper_id");--> statement-breakpoint
ALTER TABLE "paper_alias" ADD CONSTRAINT "paper_alias_paper_id_paper_id_fkey" FOREIGN KEY ("paper_id") REFERENCES "paper"("id");--> statement-breakpoint
ALTER TABLE "source_response_cache" ADD CONSTRAINT "source_response_cache_project_id_research_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "research_project"("id") ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO "paper_alias" ("alias", "paper_id") SELECT "key", "id" FROM "paper" ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "paper_alias" ("alias", "paper_id") SELECT 'doi:' || lower("doi"), "id" FROM "paper" WHERE "doi" IS NOT NULL ON CONFLICT DO NOTHING;
