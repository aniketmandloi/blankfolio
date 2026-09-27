import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

/** Append-only private audit trail; the latest event per email is its current eligibility. */
export const pilotAccessEvent = pgTable(
	"pilot_access_event",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		email: text("email").notNull(),
		action: text("action").$type<"invite" | "revoke">().notNull(),
		actor: text("actor").notNull(),
		reason: text("reason").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("pilot_access_event_email_idx").on(table.email, table.id),
		check(
			"pilot_access_event_action_check",
			sql`${table.action} in ('invite', 'revoke')`,
		),
		check(
			"pilot_access_event_email_check",
			sql`${table.email} = lower(btrim(${table.email}))`,
		),
		check(
			"pilot_access_event_audit_check",
			sql`btrim(${table.actor}) <> '' and btrim(${table.reason}) <> ''`,
		),
	],
);
