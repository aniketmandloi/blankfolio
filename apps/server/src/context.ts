import type { Context as ApiContext } from "@blankfolio/api/context";
import { createProjectCleanupRegistry } from "@blankfolio/api/project-lifecycle";
import type { Context as HonoContext } from "hono";
import type { ApplicationServices } from "./app";
export type CreateContextOptions = {
	context: HonoContext;
	services: ApplicationServices;
};
export async function createContext({
	context,
	services,
}: CreateContextOptions): Promise<ApiContext> {
	return {
		db: services.db,
		projectCleanup: services.projectCleanup ?? createProjectCleanupRegistry(),
		session: await services.auth.api.getSession({
			headers: context.req.raw.headers,
		}),
	};
}
export type Context = Awaited<ReturnType<typeof createContext>>;
