import type { Database, Transaction } from "@blankfolio/db";
import { user } from "@blankfolio/db/schema/auth";
import { pilotAccessEvent } from "@blankfolio/db/schema/pilot-access";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

export type PilotAccessStatus =
	| "eligible"
	| "verification-required"
	| "pending-invitation"
	| "revoked";
export const pilotAccessMessages: Record<
	Exclude<PilotAccessStatus, "eligible">,
	string
> = {
	"verification-required":
		"Verify your email address before opening Research Projects.",
	"pending-invitation":
		"This pilot is invite-only. Your account is waiting for an invitation.",
	revoked:
		"Pilot access for this account has been withdrawn. Your private projects are kept.",
};

export function normalizePilotEmail(email: string) {
	return email.trim().toLowerCase();
}

/**
 * Stable eligibility check for every research operation. Background work must call it
 * before each stage and cancel that account's work unless it returns "eligible".
 */
export async function pilotAccessStatus(
	db: Database | Transaction,
	userId: string,
): Promise<PilotAccessStatus> {
	const [row] = await db
		.select({
			emailVerified: user.emailVerified,
			action: sql<"invite" | "revoke" | null>`(${db
				.select({ action: pilotAccessEvent.action })
				.from(pilotAccessEvent)
				.where(eq(pilotAccessEvent.email, sql`lower(${user.email})`))
				.orderBy(desc(pilotAccessEvent.id))
				.limit(1)})`,
		})
		.from(user)
		.where(eq(user.id, userId));
	if (row?.action === "revoke") return "revoked";
	if (!row?.emailVerified) return "verification-required";
	if (row.action !== "invite") return "pending-invitation";
	return "eligible";
}

const pilotAccessChange = z.object({
	action: z.enum(["invite", "revoke"]),
	email: z.string().transform(normalizePilotEmail).pipe(z.email()),
	actor: z.string().trim().min(1, "Name the operator making this change"),
	reason: z.string().trim().min(1, "Record why eligibility is changing"),
});
/** Operator-only: no API route exposes this change. */
export async function changePilotAccess(
	db: Database,
	change: z.input<typeof pilotAccessChange>,
) {
	const [event] = await db
		.insert(pilotAccessEvent)
		.values(pilotAccessChange.parse(change))
		.returning();
	return event;
}
export async function pilotAccessHistory(db: Database, email: string) {
	return db
		.select()
		.from(pilotAccessEvent)
		.where(eq(pilotAccessEvent.email, normalizePilotEmail(email)))
		.orderBy(desc(pilotAccessEvent.id));
}
