import type { Database, Transaction } from "@blankfolio/db";
import {
	researchJob,
	usageReservation,
} from "@blankfolio/db/schema/literature";
import { and, eq, inArray, sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";

export const literatureSearchQueue = "literature-search";
export const activeRunsPerAccount = 2;
/** Every literature job shares one group, so pg-boss caps executing runs across all workers. */
export const literatureWorkOptions = {
	groupConcurrency: 2,
	includeMetadata: true,
} as const;

export type JobQueue = {
	/** Must run inside the transaction that saves the job, so neither commits alone. */
	enqueue: (tx: Transaction, jobId: string) => Promise<void>;
};
export function createJobQueue(boss: PgBoss): JobQueue {
	// A started boss refreshes its queue cache on a timer; an unheard "error" would crash the API.
	boss.on("error", (error) => console.error("job_queue_error", error.message));
	let started: Promise<unknown> | undefined;
	return {
		async enqueue(tx, jobId) {
			started ??= boss.start().catch((error) => {
				started = undefined;
				throw error;
			});
			await started;
			await boss.send(
				literatureSearchQueue,
				{ jobId },
				{
					group: { id: literatureSearchQueue },
					// Whole-job redelivery after a crash or expiry; each source bounds its own attempts.
					retryLimit: 2,
					retryDelay: 10,
					retryBackoff: true,
					expireInSeconds: 15 * 60,
					db: fromDrizzle(tx, sql),
				},
			);
		},
	};
}

/** API processes enqueue through their request pool and never poll or maintain the queue. */
export function createDatabaseJobQueue(db: Database) {
	return createJobQueue(
		new PgBoss({
			db: fromDrizzle(db, sql),
			migrate: false,
			supervise: false,
			schedule: false,
		}),
	);
}

/** Idempotent; needs a role that can create the queue schema. */
export async function installJobQueues(boss: PgBoss) {
	if (!(await boss.getQueue(literatureSearchQueue)))
		await boss.createQueue(literatureSearchQueue);
}
export async function migrateJobQueues(connectionString: string) {
	const boss = new PgBoss({
		connectionString,
		max: 1,
		migrate: true,
		supervise: false,
		schedule: false,
	});
	await boss.start();
	try {
		await installJobQueues(boss);
	} finally {
		await boss.stop({ graceful: false });
	}
}

export type CancelReason = NonNullable<
	(typeof researchJob.$inferSelect)["cancelReason"]
>;
export async function cancelActiveJobs(
	tx: Transaction,
	where: { projectId: string } | { ownerIds: string[] },
	reason: CancelReason,
) {
	await tx
		.update(researchJob)
		.set({
			state: "cancelled",
			cancelReason: reason,
			finishedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(
			and(
				"projectId" in where
					? eq(researchJob.projectId, where.projectId)
					: inArray(researchJob.ownerId, where.ownerIds),
				inArray(researchJob.state, ["queued", "running"]),
			),
		);
}

const liveQueueStates = ["created", "retry", "active"];
/**
 * Fails searches the queue gave up on (exhausted, expired or deleted entries) without the handler
 * finishing them, freeing their account slots. A job with a live queue entry is never touched.
 * Pending reservations are held, since an abandoned attempt may have been billed.
 */
export async function reconcileAbandonedSearches(db: Database, boss: PgBoss) {
	// Jobs first: a job commits with its queue entry, so a job seen here has an entry to find.
	const active = await db
		.select({ id: researchJob.id })
		.from(researchJob)
		.where(inArray(researchJob.state, ["queued", "running"]));
	const abandoned: string[] = [];
	for (const { id } of active) {
		const entries = await boss.findJobs(literatureSearchQueue, {
			data: { jobId: id },
		});
		if (!entries.some((entry) => liveQueueStates.includes(entry.state)))
			abandoned.push(id);
	}
	if (!abandoned.length) return [];
	return db.transaction(async (tx) => {
		const failed = (
			await tx
				.update(researchJob)
				.set({
					state: "failed",
					stage: "done",
					errorClass: "abandoned",
					finishedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(
					and(
						inArray(researchJob.id, abandoned),
						inArray(researchJob.state, ["queued", "running"]),
					),
				)
				.returning({ id: researchJob.id })
		).map((job) => job.id);
		if (failed.length)
			await tx
				.update(usageReservation)
				.set({ state: "held" })
				.where(
					and(
						inArray(usageReservation.jobId, failed),
						eq(usageReservation.state, "pending"),
					),
				);
		return failed;
	});
}
