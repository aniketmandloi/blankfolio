import { serve } from "@hono/node-server";
import app from "./index";
import { db } from "./services";

const server = serve({ fetch: app.fetch, port: 3000 }, (info) =>
	console.log(`Server is running on http://localhost:${info.port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () =>
		server.close(() => {
			void db.$client.end().then(() => process.exit(0));
		}),
	);
}
