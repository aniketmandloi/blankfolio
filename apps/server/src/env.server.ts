import { z } from "zod";

const deployedEnvSchema = z.object({
	NODE_ENV: z.enum(["development", "production", "test"]),
	BETTER_AUTH_SECRET: z.string().min(32),
	BETTER_AUTH_URL: z.url(),
	CORS_ORIGIN: z.url(),
	DATABASE_URL: z.string().min(1),
	AUTH_MAIL_OUTBOX: z.string().optional(),
	RESEND_API_KEY: z.string().startsWith("re_").optional(),
	AUTH_MAIL_FROM: z.string().min(3).optional(),
});

// Vercel functions ship without the Varlock CLI that auto-load executes, so
// deployments read Vercel's variables directly, deriving URLs as .env.schema does.
function deployedEnv(env: NodeJS.ProcessEnv) {
	const host =
		env.VERCEL_ENV === "production"
			? (env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL)
			: (env.VERCEL_URL ?? env.VERCEL_PROJECT_PRODUCTION_URL);
	const origin = `https://${host}`;
	return deployedEnvSchema.parse({
		...env,
		BETTER_AUTH_URL: env.BETTER_AUTH_URL || `${origin}/api/auth`,
		CORS_ORIGIN: env.CORS_ORIGIN || origin,
	});
}

async function varlockEnv() {
	await import("varlock/auto-load");
	return (await import("./env")).ENV;
}

export const ENV: z.infer<typeof deployedEnvSchema> =
	process.env.VERCEL_ENV === "production" ||
	process.env.VERCEL_ENV === "preview"
		? deployedEnv(process.env)
		: await varlockEnv();
