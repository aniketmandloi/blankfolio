import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const researchProject = pgTable(
	"research_project",
	{
		id: text("id").primaryKey(),
		ownerId: text("owner_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		title: text("title").notNull().default(""),
		state: text("state")
			.$type<"active" | "archived" | "deleting">()
			.notNull()
			.default("active"),
		revision: integer("revision").notNull().default(1),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
		cleanupCompletedAt: timestamp("cleanup_completed_at", {
			withTimezone: true,
		}),
	},
	(table) => [
		index("research_project_owner_idx").on(table.ownerId),
		check(
			"research_project_state_check",
			sql`${table.state} in ('active', 'archived', 'deleting')`,
		),
	],
);

export type ResearchBrief = {
	evaluationTrack?: "unknown" | "tabular-classification" | "outside-track";
	title: string;
	topic: string;
	experienceLevel: string;
	timeAvailability: string;
	computeDescription: string;
	desiredContribution: string;
};
export const briefRevision = pgTable(
	"brief_revision",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => researchProject.id, { onDelete: "cascade" }),
		revision: integer("revision").notNull(),
		brief: jsonb("brief").$type<ResearchBrief>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("brief_project_revision_idx").on(
			table.projectId,
			table.revision,
		),
	],
);
