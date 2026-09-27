import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type {
	SourcePrices,
	SourceSettings,
} from "@blankfolio/api/literature-sources";
import {
	createLiteratureJobHandler,
	type LiteratureJobData,
	type LiteratureWorkerOptions,
} from "@blankfolio/api/literature-worker";
import { changePilotAccess } from "@blankfolio/api/pilot-access";
import {
	createJobQueue,
	installJobQueues,
	literatureSearchQueue,
	literatureWorkOptions,
} from "@blankfolio/api/research-jobs";
import { type AuthConfig, type AuthMail, createAuth } from "@blankfolio/auth";
import { createDb } from "@blankfolio/db";
import { PgBoss } from "pg-boss";
import { createApp } from "../src/app";

const password = "Disposable-only-Password-123!";
const origin = "http://localhost";
/** $0.02 per query request for the simulated metered source. */
export const fixturePrices: SourcePrices = { "fixture-metered": 20_000 };
export const fixtureSettings: SourceSettings = {
	prices: fixturePrices,
	quotas: {},
};

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
	const suffix = randomUUID().replaceAll("-", "");
	const schema = `test_projects_${suffix}`;
	const jobSchema = `test_jobs_${suffix}`;
	const admin = createDb({ DATABASE_URL: url });
	const db = createDb({ DATABASE_URL: url }, { schema });
	const boss = new PgBoss({
		connectionString: url,
		schema: jobSchema,
		max: 2,
		supervise: false,
		schedule: false,
	});
	let schemaCreated = false;
	const close = async () => {
		await boss.stop({ graceful: false }).catch(() => undefined);
		await db.$client.end();
		try {
			if (schemaCreated)
				await admin.$client.query(
					`DROP SCHEMA IF EXISTS "${schema}" CASCADE; DROP SCHEMA IF EXISTS "${jobSchema}" CASCADE`,
				);
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
		await boss.start();
		await installJobQueues(boss);
		const jobQueue = createJobQueue(boss);
		const mail: AuthMail[] = [];
		const createAuthApp = (
			env: Partial<AuthConfig> = {},
			sourceSettings = fixtureSettings,
		) =>
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
				jobQueue,
				sourceSettings,
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
		/**
		 * Claims one queued job through pg-boss and runs the production handler, failing it back to
		 * the queue when the handler throws, as a worker process would. Ignores retry delays.
		 */
		const runNextJob = async (
			options: Partial<LiteratureWorkerOptions> = {},
		) => {
			const jobs = await boss.fetch<LiteratureJobData>(literatureSearchQueue, {
				...literatureWorkOptions,
				ignoreStartAfter: true,
			});
			if (!jobs.length) return false;
			const ids = jobs.map((job) => job.id);
			try {
				await createLiteratureJobHandler({
					db,
					prices: fixturePrices,
					sleep: async () => undefined,
					...options,
				})(jobs);
				await boss.complete(literatureSearchQueue, ids);
			} catch {
				await boss.fail(literatureSearchQueue, ids);
			}
			return true;
		};
		return {
			db,
			app,
			boss,
			runNextJob,
			async runQueuedJobs(options: Partial<LiteratureWorkerOptions> = {}) {
				while (await runNextJob(options));
			},
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
