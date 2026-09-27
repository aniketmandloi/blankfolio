import { randomUUID } from "node:crypto";
import type { Database, Transaction } from "@blankfolio/db";
import { usageReservation } from "@blankfolio/db/schema/literature";
import { and, eq, gte, sql } from "drizzle-orm";

/** Pilot policy in micro-dollars, not a price estimate; changing it is a reviewed code change. */
export const budgetLimits = {
	run: 1_000_000,
	projectMonth: 5_000_000,
	globalMonth: 50_000_000,
};
export type BudgetLimit = keyof typeof budgetLimits;

export const usagePeriod = (now: Date) => now.toISOString().slice(0, 7);

/** Settled rows count their measured charge; pending and held rows their full reservation. */
const committed = (filter = sql`true`) =>
	sql<number>`coalesce(sum(case when ${usageReservation.state} = 'settled' then ${usageReservation.actualMicros} else ${usageReservation.reservedMicros} end) filter (where ${filter}), 0)::int`;

async function committedTotals(
	db: Database | Transaction,
	period: string,
	projectId: string,
	jobId = "",
): Promise<Record<BudgetLimit, number>> {
	const [totals] = await db
		.select({
			run: committed(eq(usageReservation.jobId, jobId)),
			projectMonth: committed(
				and(
					eq(usageReservation.period, period),
					eq(usageReservation.projectId, projectId),
				),
			),
			globalMonth: committed(eq(usageReservation.period, period)),
		})
		.from(usageReservation)
		.where(
			sql`${usageReservation.period} = ${period} or ${usageReservation.jobId} = ${jobId}`,
		);
	return totals ?? { run: 0, projectMonth: 0, globalMonth: 0 };
}

function exceededLimit(
	totals: Record<BudgetLimit, number>,
	amount: number,
): BudgetLimit | null {
	if (totals.run + amount > budgetLimits.run) return "run";
	if (totals.projectMonth + amount > budgetLimits.projectMonth)
		return "projectMonth";
	if (totals.globalMonth + amount > budgetLimits.globalMonth)
		return "globalMonth";
	return null;
}

/** The route's committed spend since the start of the UTC day, across the deployment. */
async function committedToday(tx: Transaction, route: string, now: Date) {
	const dayStart = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
	const [total] = await tx
		.select({ micros: committed() })
		.from(usageReservation)
		.where(
			and(
				eq(usageReservation.period, usagePeriod(now)),
				eq(usageReservation.route, route),
				gte(usageReservation.createdAt, dayStart),
			),
		);
	return total?.micros ?? 0;
}

/**
 * Reserves a conservative maximum charge against run, project-month and global-month limits,
 * and optionally the route's daily provider quota. Serialised by an advisory lock so concurrent
 * reservations, pending or held, cannot overspend.
 */
export async function reserveUsage(
	db: Database,
	request: {
		projectId: string;
		jobId: string;
		sourceExecutionId?: string;
		attempt: number;
		route: string;
		amountMicros: number;
		now: Date;
		dailyQuotaMicros?: number;
	},
) {
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext('usage_reservation'))`,
		);
		const period = usagePeriod(request.now);
		const exceeded: BudgetLimit | "providerDay" | null =
			exceededLimit(
				await committedTotals(tx, period, request.projectId, request.jobId),
				request.amountMicros,
			) ??
			(request.dailyQuotaMicros !== undefined &&
			(await committedToday(tx, request.route, request.now)) +
				request.amountMicros >
				request.dailyQuotaMicros
				? "providerDay"
				: null);
		if (exceeded) return { reserved: false as const, exceeded };
		const id = randomUUID();
		await tx.insert(usageReservation).values({
			id,
			projectId: request.projectId,
			jobId: request.jobId,
			sourceExecutionId: request.sourceExecutionId,
			attempt: request.attempt,
			route: request.route,
			period,
			reservedMicros: request.amountMicros,
			createdAt: request.now,
		});
		return { reserved: true as const, id };
	});
}

/** Records measured usage; any unused part of the reservation is released. */
export async function settleUsage(
	db: Database,
	id: string,
	actualMicros: number,
) {
	await db
		.update(usageReservation)
		.set({ state: "settled", actualMicros, settledAt: new Date() })
		.where(
			and(eq(usageReservation.id, id), eq(usageReservation.state, "pending")),
		);
}

/** An unknown outcome keeps the whole reservation counted until an operator reconciles it. */
export async function holdUsage(db: Database, id: string) {
	await db
		.update(usageReservation)
		.set({ state: "held" })
		.where(
			and(eq(usageReservation.id, id), eq(usageReservation.state, "pending")),
		);
}

export async function budgetStatus(
	db: Database | Transaction,
	projectId: string,
	now: Date,
) {
	const period = usagePeriod(now);
	const totals = await committedTotals(db, period, projectId);
	return {
		period,
		limits: budgetLimits,
		projectCommittedMicros: totals.projectMonth,
		/** The limit a fresh run's reservation of this size would exceed now, if any. */
		exceeds: (amountMicros: number) =>
			exceededLimit({ ...totals, run: 0 }, amountMicros),
	};
}
