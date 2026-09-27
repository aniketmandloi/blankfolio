import type { Session } from "@blankfolio/auth";
import type { Database } from "@blankfolio/db";

export type Context = {
	session: Session | null;
	db: Database;
};
