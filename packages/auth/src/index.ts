import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { expo } from "@better-auth/expo";
import type { Database } from "@blankfolio/db";
import * as schema from "@blankfolio/db/schema/auth";
import { betterAuth } from "better-auth";

export type AuthConfig = {
	BETTER_AUTH_URL: string;
	BETTER_AUTH_SECRET: string;
	CORS_ORIGIN: string;
};
export type AuthMail = {
	kind: "verification" | "password-reset";
	to: string;
	url: string;
};
/** Must not throw for a known address: a failure would reveal account existence. */
export type MailDelivery = (mail: AuthMail) => Promise<void>;

export function createAuth(
	env: AuthConfig,
	database: Database,
	deliverMail: MailDelivery,
	desktopOrigins: readonly string[] = [],
) {
	return betterAuth({
		database: drizzleAdapter(database, {
			provider: "pg",
			schema,
		}),
		trustedOrigins: [
			env.CORS_ORIGIN,
			...desktopOrigins,
			"blankfolio://",
			"exp://",
			"http://localhost:8081",
		],
		emailAndPassword: {
			enabled: true,
			requireEmailVerification: true,
			revokeSessionsOnPasswordReset: true,
			sendResetPassword: ({ user, url }) =>
				deliverMail({ kind: "password-reset", to: user.email, url }),
		},
		emailVerification: {
			sendVerificationEmail: ({ user, url }) =>
				deliverMail({ kind: "verification", to: user.email, url }),
		},
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.BETTER_AUTH_URL,
		// Web and API share a site (same origin when deployed, localhost ports locally), so the
		// default Lax cookies suffice; Secure and the __Secure- prefix follow an https base URL.
		// Better Auth skips origin checks under test runners unless this is explicit.
		advanced: { disableOriginCheck: false },
		plugins: [expo()],
	});
}

export type Session = ReturnType<typeof createAuth>["$Infer"]["Session"];
