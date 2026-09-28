import type { Session } from "@blankfolio/auth";
import type { Database } from "@blankfolio/db";
import type { SourceSettings } from "./literature-sources";
import type { ProjectCleanupRegistry } from "./project-lifecycle";
import type { JobQueue } from "./research-jobs";

export type Context = {
	session: Session | null;
	db: Database;
	projectCleanup: ProjectCleanupRegistry;
	jobQueue: JobQueue;
	sourceSettings: SourceSettings;
};
