CREATE TABLE "publication_status" (
	"id" text PRIMARY KEY,
	"doi" text NOT NULL,
	"revision" integer NOT NULL,
	"registered" boolean NOT NULL,
	"updates" jsonb NOT NULL,
	"related_versions" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "literature_snapshot" ADD COLUMN "status_check" jsonb;--> statement-breakpoint
ALTER TABLE "snapshot_paper" ADD COLUMN "status_check" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "publication_status_doi_revision_idx" ON "publication_status" ("doi","revision");