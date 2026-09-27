import { appendFile } from "node:fs/promises";
import type { MailDelivery } from "@blankfolio/auth";

/** Live delivery stays disabled until a provider is configured and verified. */
export function createMailDelivery(env: {
	NODE_ENV: string;
	AUTH_MAIL_OUTBOX?: string;
}): MailDelivery {
	const outbox = env.AUTH_MAIL_OUTBOX;
	if (!outbox)
		return async (mail) => {
			console.error("auth_mail_delivery_disabled", mail.kind);
		};
	if (env.NODE_ENV === "production")
		throw new Error(
			"AUTH_MAIL_OUTBOX is a local fixture and cannot be used in production",
		);
	return async (mail) => {
		await appendFile(
			outbox,
			`${JSON.stringify({ ...mail, sentAt: new Date().toISOString() })}\n`,
			{ mode: 0o600 },
		);
	};
}
