import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { DatabaseConfig } from "./config";
import { relations } from "./relations";

/** API pools expire idle sockets; persistent workers explicitly own and close their pool. */
export function createDb(
	env: DatabaseConfig,
	options: { persistent?: boolean; schema?: string } = {},
) {
	const pool = new Pool({
		connectionString: env.DATABASE_URL,
		max: options.persistent ? 5 : 2,
		idleTimeoutMillis: options.persistent ? 30_000 : 1_000,
		connectionTimeoutMillis: 10_000,
		maxLifetimeSeconds: options.persistent ? 300 : 30,
		allowExitOnIdle: !options.persistent,
		...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
	});
	return drizzle({ client: pool, relations });
}
export type Database = ReturnType<typeof createDb>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
