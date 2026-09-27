import type { Database, Transaction } from "@blankfolio/db";
import { researchJob } from "@blankfolio/db/schema/literature";
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
