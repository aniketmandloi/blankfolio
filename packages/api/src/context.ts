import type { Session } from "@blankfolio/auth";
import type { Database } from "@blankfolio/db";
import type { ProjectCleanupRegistry } from "./project-lifecycle";

export type Context = {
	session: Session | null;
	db: Database;
	projectCleanup: ProjectCleanupRegistry;
};
