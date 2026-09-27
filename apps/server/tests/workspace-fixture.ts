import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createAuth } from "@blankfolio/auth";
import { createDb } from "@blankfolio/db";
import { createApp } from "../src/app";

/** No sockets, production environment files, or fallback to DATABASE_URL. */
export async function createTestWorkspace() {
	const url = process.env.TEST_DATABASE_URL;
	if (!url)
		throw new Error(
			"Set TEST_DATABASE_URL to a disposable direct Neon PostgreSQL database in root .env.test.local; production DATABASE_URL is never used.",
		);
	const parsed = new URL(url);
	if (
		!["postgres:", "postgresql:"].includes(parsed.protocol) ||
		parsed.hostname.includes("-pooler.")
	)
		throw new Error(
			"TEST_DATABASE_URL must be a direct/non-pooler PostgreSQL connection.",
		);
	const schema = `test_projects_${randomUUID().replaceAll("-", "")}`;
	const admin = createDb({ DATABASE_URL: url });
	const db = createDb({ DATABASE_URL: url }, { schema });
	let schemaCreated = false;
	const close = async () => {
		await db.$client.end();
		try {
			if (schemaCreated)
				await admin.$client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		} finally {
			await admin.$client.end();
		}
	};
	try {
		await admin.$client.query(`CREATE SCHEMA "${schema}"`);
		schemaCreated = true;
		const migrationsDirectory = new URL(
			"../../../packages/db/src/migrations/",
			import.meta.url,
		);
		const migrations = (
			await readdir(migrationsDirectory, { withFileTypes: true })
		)
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		for (const directory of migrations) {
			await db.$client.query(
				await readFile(
					new URL(`${directory}/migration.sql`, migrationsDirectory),
					"utf8",
				),
			);
		}
		const auth = createAuth(
			{
				BETTER_AUTH_URL: "http://localhost/api/auth",
				BETTER_AUTH_SECRET: "disposable-test-only-secret-000000000000",
				CORS_ORIGIN: "http://localhost",
			},
			db,
		);
		const app = createApp({ db, auth, corsOrigin: "http://localhost" });
		return {
			db,
			app,
			close,
			async signIn(name: string) {
				const response = await app.request("/api/auth/sign-up/email", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "http://localhost",
					},
					body: JSON.stringify({
						email: `${name}-${randomUUID()}@example.test`,
						name,
						password: "Disposable-only-Password-123!",
					}),
				});
				if (!response.ok)
					throw new Error(`Fixture sign-up failed: HTTP ${response.status}`);
				const cookie = response.headers.get("set-cookie");
				if (!cookie)
					throw new Error("Fixture sign-up returned no session cookie");
				return cookie.split(";")[0] ?? "";
			},
		};
	} catch (error) {
		await close().catch(() => undefined);
		throw error;
	}
}
