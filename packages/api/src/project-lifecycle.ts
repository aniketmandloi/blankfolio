import type { Database, Transaction } from "@blankfolio/db";
import {
	literatureScopeRevision,
	literatureSnapshot,
	researchJob,
	usageReservation,
} from "@blankfolio/db/schema/literature";
import { briefRevision, researchProject } from "@blankfolio/db/schema/projects";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";

export type ProjectOperation = "read" | "write" | "unarchive";
export async function requireProject(
	db: Database | Transaction,
	ownerId: string,
	id: string,
	operation: ProjectOperation = "read",
) {
	const query = db
		.select()
		.from(researchProject)
		.where(
			and(eq(researchProject.id, id), eq(researchProject.ownerId, ownerId)),
		);
	const [project] =
		operation === "read" ? await query : await query.for("update");
	if (!project || project.state === "deleting")
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Research Project not found",
		});
	if (project.state === "archived" && operation === "write")
		throw new TRPCError({
			code: "CONFLICT",
			message: "Unarchive this Research Project before making changes",
		});
	return project;
}
export type ProjectCleanup = {
	name: string;
	cleanup: (tx: Transaction, projectId: string) => Promise<void>;
};
/** Later artifacts register cleanup here; hooks share a transaction and must be idempotent. */
export function createProjectCleanupRegistry(
	additional: readonly ProjectCleanup[] = [],
) {
	const hooks: readonly ProjectCleanup[] = [
		{
			name: "brief revisions",
			cleanup: async (tx, id) => {
				await tx.delete(briefRevision).where(eq(briefRevision.projectId, id));
			},
		},
		{
			name: "literature searches",
			cleanup: async (tx, id) => {
				// Reservations keep their amounts so spend already incurred still counts.
				await tx
					.update(usageReservation)
					.set({ jobId: null, sourceExecutionId: null })
					.where(eq(usageReservation.projectId, id));
				await tx
					.delete(literatureSnapshot)
					.where(eq(literatureSnapshot.projectId, id));
				await tx.delete(researchJob).where(eq(researchJob.projectId, id));
				await tx
					.delete(literatureScopeRevision)
					.where(eq(literatureScopeRevision.projectId, id));
			},
		},
		...additional,
	];
	return {
		async run(db: Database, id: string) {
			await db.transaction(async (tx) => {
				const [project] = await tx
					.select()
					.from(researchProject)
					.where(eq(researchProject.id, id))
					.for("update");
				if (project?.state !== "deleting" || project.cleanupCompletedAt) return;
				for (const hook of hooks) await hook.cleanup(tx, id);
				await tx
					.update(researchProject)
					.set({ title: "", cleanupCompletedAt: new Date() })
					.where(eq(researchProject.id, id));
			});
		},
	};
}
export async function retryProjectCleanup(
	db: Database,
	registry = createProjectCleanupRegistry(),
) {
	const pending = await db
		.select({ id: researchProject.id })
		.from(researchProject)
		.where(
			and(
				eq(researchProject.state, "deleting"),
				isNull(researchProject.cleanupCompletedAt),
			),
		);
	for (const project of pending) await registry.run(db, project.id);
}

export type ProjectCleanupRegistry = ReturnType<
	typeof createProjectCleanupRegistry
>;
