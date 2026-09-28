import type { Context as ApiContext } from "@blankfolio/api/context";
import type { Context as HonoContext } from "hono";
import type { ApplicationServices } from "./app";
export type CreateContextOptions = {
	context: HonoContext;
	services: Required<ApplicationServices>;
};
export async function createContext({
	context,
	services,
}: CreateContextOptions): Promise<ApiContext> {
	return {
		db: services.db,
		projectCleanup: services.projectCleanup,
		jobQueue: services.jobQueue,
		sourceSettings: services.sourceSettings,
		session: await services.auth.api.getSession({
			headers: context.req.raw.headers,
		}),
	};
}
export type Context = Awaited<ReturnType<typeof createContext>>;
