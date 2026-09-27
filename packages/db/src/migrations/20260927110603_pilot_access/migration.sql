CREATE TABLE "pilot_access_event" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pilot_access_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"email" text NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pilot_access_event_action_check" CHECK ("action" in ('invite', 'revoke')),
	CONSTRAINT "pilot_access_event_email_check" CHECK ("email" = lower(btrim("email"))),
	CONSTRAINT "pilot_access_event_audit_check" CHECK (btrim("actor") <> '' and btrim("reason") <> '')
);
--> statement-breakpoint
CREATE INDEX "pilot_access_event_email_idx" ON "pilot_access_event" ("email","id");