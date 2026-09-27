import type { SourcePrices } from "@blankfolio/api/literature-sources";
import {
	createProjectCleanupRegistry,
	type ProjectCleanupRegistry,
} from "@blankfolio/api/project-lifecycle";
import type { JobQueue } from "@blankfolio/api/research-jobs";
import { appRouter } from "@blankfolio/api/routers/index";
import type { Session } from "@blankfolio/auth";
import type { Database } from "@blankfolio/db";
import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { createContext } from "./context";

export type ApplicationServices = {
	db: Database;
	auth: {
		handler: (request: Request) => Promise<Response>;
		api: {
			getSession: (options: { headers: Headers }) => Promise<Session | null>;
		};
	};
	corsOrigin: string;
	jobQueue: JobQueue;
	sourcePrices: SourcePrices;
	projectCleanup?: ProjectCleanupRegistry;
};
/** Importable request application: no sockets, environment loading, or global services. */
export function createApp(services: ApplicationServices) {
	const requestServices = {
		...services,
		projectCleanup: services.projectCleanup ?? createProjectCleanupRegistry(),
	};
	const app = new Hono();
	app.use(
		"/*",
		cors({
			origin: services.corsOrigin,
			allowMethods: ["GET", "POST", "OPTIONS"],
			allowHeaders: ["Content-Type", "Authorization"],
			credentials: true,
		}),
	);
	app.on(["POST", "GET"], "/api/auth/*", (c) =>
		services.auth.handler(c.req.raw),
	);
	// tRPC accepts multipart bodies, which browsers post cross-origin without a preflight.
	app.use("/trpc/*", csrf({ origin: services.corsOrigin }));
	app.use(
		"/trpc/*",
		trpcServer({
			router: appRouter,
			createContext: (_opts, context) =>
				createContext({ context, services: requestServices }),
		}),
	);
	app.get("/", (c) => c.text("OK"));
	return app;
}
