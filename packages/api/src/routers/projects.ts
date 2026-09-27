import { randomUUID } from "node:crypto";
import type { Database, Transaction } from "@blankfolio/db";
import { briefRevision, researchProject } from "@blankfolio/db/schema/projects";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, lt, ne } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../index";
import {
	createProjectCleanupRegistry,
	requireProject,
} from "../project-lifecycle";

const constraintField = z
	.string()
	.max(10_000)
	.transform((value) => (value.trim() ? value : "unknown"));
export const briefSchema = z
	.object({
		title: z.string().max(120, "Title must be 120 characters or fewer"),
		topic: z.string().max(2_000, "Topic must be 2,000 characters or fewer"),
		experienceLevel: constraintField,
		timeAvailability: constraintField,
		computeDescription: constraintField,
		desiredContribution: constraintField,
	})
	.refine(
		(brief) =>
			Object.values(brief).reduce(
				(length, field) => length + field.length,
				0,
			) <= 10_000,
		{ message: "Research brief must be 10,000 characters or fewer" },
	);
export function assertDiscoveryBrief(brief: z.infer<typeof briefSchema>) {
	if (!brief.title.trim() || !brief.topic.trim())
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Save a title and topic before starting discovery",
		});
}
const projectId = z.object({ id: z.string().uuid() });
async function detail(db: Database | Transaction, ownerId: string, id: string) {
	const project = await requireProject(db, ownerId, id);
	const page = await historyPage(db, id, 20);
	const history = page.items;
	const current = history[0];
	if (!current)
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Research brief missing",
		});
	return {
		...project,
		brief: current.brief,
		history,
		historyNextCursor: page.nextCursor,
	};
}
async function historyPage(
	db: Database | Transaction,
	id: string,
	limit: number,
	cursor?: number,
) {
	const items = await db
		.select({
			revision: briefRevision.revision,
			brief: briefRevision.brief,
			createdAt: briefRevision.createdAt,
		})
		.from(briefRevision)
		.where(
			and(
				eq(briefRevision.projectId, id),
				cursor ? lt(briefRevision.revision, cursor) : undefined,
			),
		)
		.orderBy(desc(briefRevision.revision))
		.limit(limit + 1);
	const hasMore = items.length > limit;
	if (hasMore) items.pop();
	return { items, nextCursor: hasMore ? items.at(-1)?.revision : undefined };
}
export const projectsRouter = router({
	history: protectedProcedure
		.input(
			projectId.extend({
				limit: z.number().int().min(1).max(100).default(20),
				cursor: z.number().int().positive().optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			await requireProject(ctx.db, ctx.session.user.id, input.id);
			return historyPage(ctx.db, input.id, input.limit, input.cursor);
		}),
	list: protectedProcedure
		.input(
			z.object({
				state: z.enum(["active", "archived"]).optional(),
				limit: z.number().int().min(1).max(100).default(30),
				cursor: z.string().uuid().optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const items = await ctx.db
				.select({
					id: researchProject.id,
					title: researchProject.title,
					state: researchProject.state,
					revision: researchProject.revision,
					createdAt: researchProject.createdAt,
					updatedAt: researchProject.updatedAt,
				})
				.from(researchProject)
				.where(
					and(
						eq(researchProject.ownerId, ctx.session.user.id),
						ne(researchProject.state, "deleting"),
						input.state ? eq(researchProject.state, input.state) : undefined,
						input.cursor ? gt(researchProject.id, input.cursor) : undefined,
					),
				)
				.orderBy(asc(researchProject.id))
				.limit(input.limit + 1);
			const hasMore = items.length > input.limit;
			if (hasMore) items.pop();
			return { items, nextCursor: hasMore ? items.at(-1)?.id : undefined };
		}),
	create: protectedProcedure
		.input(z.object({ title: z.string().max(120).default("") }))
		.mutation(async ({ ctx, input }) =>
			ctx.db.transaction(async (tx) => {
				const id = randomUUID();
				const brief = {
					title: input.title,
					topic: "",
					experienceLevel: "unknown",
					timeAvailability: "unknown",
					computeDescription: "unknown",
					desiredContribution: "unknown",
				};
				await tx
					.insert(researchProject)
					.values({ id, ownerId: ctx.session.user.id, title: input.title });
				await tx
					.insert(briefRevision)
					.values({ id: randomUUID(), projectId: id, revision: 1, brief });
				return detail(tx, ctx.session.user.id, id);
			}),
		),
	get: protectedProcedure
		.input(projectId)
		.query(({ ctx, input }) => detail(ctx.db, ctx.session.user.id, input.id)),
	saveBrief: protectedProcedure
		.input(
			projectId.extend({
				expectedRevision: z.number().int().positive(),
				brief: briefSchema,
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.db.transaction(async (tx) => {
				const project = await requireProject(
					tx,
					ctx.session.user.id,
					input.id,
					"write",
				);
				if (project.revision !== input.expectedRevision)
					throw new TRPCError({
						code: "CONFLICT",
						message:
							"Another tab saved this brief. Keep your edits and reload the saved revision before trying again.",
					});
				const brief = { ...input.brief };
				const revision = project.revision + 1;
				await tx
					.insert(briefRevision)
					.values({ id: randomUUID(), projectId: input.id, revision, brief });
				await tx
					.update(researchProject)
					.set({ title: brief.title, revision, updatedAt: new Date() })
					.where(eq(researchProject.id, input.id));
				return detail(tx, ctx.session.user.id, input.id);
			}),
		),
	archive: protectedProcedure.input(projectId).mutation(({ ctx, input }) =>
		ctx.db.transaction(async (tx) => {
			await requireProject(tx, ctx.session.user.id, input.id, "write");
			await tx
				.update(researchProject)
				.set({ state: "archived", updatedAt: new Date() })
				.where(eq(researchProject.id, input.id));
			return detail(tx, ctx.session.user.id, input.id);
		}),
	),
	unarchive: protectedProcedure.input(projectId).mutation(({ ctx, input }) =>
		ctx.db.transaction(async (tx) => {
			await requireProject(tx, ctx.session.user.id, input.id, "unarchive");
			await tx
				.update(researchProject)
				.set({ state: "active", updatedAt: new Date() })
				.where(eq(researchProject.id, input.id));
			return detail(tx, ctx.session.user.id, input.id);
		}),
	),
	delete: protectedProcedure
		.input(projectId)
		.mutation(async ({ ctx, input }) => {
			await ctx.db.transaction(async (tx) => {
				await requireProject(tx, ctx.session.user.id, input.id, "write");
				await tx
					.update(researchProject)
					.set({
						state: "deleting",
						title: "",
						deletedAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(researchProject.id, input.id));
			});
			try {
				await createProjectCleanupRegistry().run(ctx.db, input.id);
				return { deleted: true as const, cleanupPending: false };
			} catch {
				// Tombstone is already committed. Operators retry cleanup without exposing content.
				console.error("project_cleanup_failed");
				return { deleted: true as const, cleanupPending: true };
			}
		}),
});
