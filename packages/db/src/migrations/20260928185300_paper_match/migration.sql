CREATE TABLE "paper_match" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"paper_id" text NOT NULL,
	"other_paper_id" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"decision" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_match_order_check" CHECK ("paper_id" < "other_paper_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "paper_match_pair_idx" ON "paper_match" ("project_id","paper_id","other_paper_id");--> statement-breakpoint
ALTER TABLE "paper_match" ADD CONSTRAINT "paper_match_project_id_research_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "research_project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "paper_match" ADD CONSTRAINT "paper_match_paper_id_paper_id_fkey" FOREIGN KEY ("paper_id") REFERENCES "paper"("id");--> statement-breakpoint
ALTER TABLE "paper_match" ADD CONSTRAINT "paper_match_other_paper_id_paper_id_fkey" FOREIGN KEY ("other_paper_id") REFERENCES "paper"("id");