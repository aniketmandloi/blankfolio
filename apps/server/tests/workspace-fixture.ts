import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { changePilotAccess } from "@blankfolio/api/pilot-access";
import { type AuthConfig, type AuthMail, createAuth } from "@blankfolio/auth";
import { createDb } from "@blankfolio/db";
import { createApp } from "../src/app";

const password = "Disposable-only-Password-123!";
const origin = "http://localhost";

/** No sockets, production environment files, real mail, or fallback to DATABASE_URL. */
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
		const mail: AuthMail[] = [];
		const createAuthApp = (env: Partial<AuthConfig> = {}) =>
			createApp({
				db,
				auth: createAuth(
					{
						BETTER_AUTH_URL: `${origin}/api/auth`,
						BETTER_AUTH_SECRET: "disposable-test-only-secret-000000000000",
						CORS_ORIGIN: origin,
						...env,
					},
					db,
					async (message) => {
						mail.push(message);
					},
				),
				corsOrigin: env.CORS_ORIGIN ?? origin,
			});
		const app = createAuthApp();
		const post = (path: string, body: unknown) =>
			app.request(path, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify(body),
			});
		const invite = (email: string) =>
			changePilotAccess(db, {
				action: "invite",
				email,
				actor: "fixture-operator",
				reason: "Synthetic pilot account",
			});
		const signUp = (email: string) =>
			post("/api/auth/sign-up/email", {
				email,
				name: email.split("@")[0],
				password,
				callbackURL: `${origin}/email-verified`,
			});
		const signInWith = (email: string, secret = password) =>
			post("/api/auth/sign-in/email", { email, password: secret });
		const followLatestMail = (email: string, kind: AuthMail["kind"]) => {
			const message = mail.findLast((m) => m.to === email && m.kind === kind);
			if (!message) throw new Error(`No ${kind} mail for ${email}`);
			return app.request(message.url);
		};
		const sessionCookie = (response: Response) => {
			const cookie = response.headers.get("set-cookie");
			if (!response.ok || !cookie)
				throw new Error(`Fixture sign-in failed: HTTP ${response.status}`);
			return cookie.split(";")[0] ?? "";
		};
		return {
			db,
			app,
			mail,
			close,
			createAuthApp,
			post,
			invite,
			signUp,
			signInWith,
			followLatestMail,
			sessionCookie,
			/** An invited researcher with a verified email and a live session. */
			async signIn(name: string) {
				const email = `${name}-${randomUUID()}@example.test`;
				await invite(email);
				await signUp(email);
				await followLatestMail(email, "verification");
				return sessionCookie(await signInWith(email));
			},
		};
	} catch (error) {
		await close().catch(() => undefined);
		throw error;
	}
}
