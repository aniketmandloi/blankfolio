import { appendFile } from "node:fs/promises";
import type { AuthMail, MailDelivery } from "@blankfolio/auth";

const messages = {
	verification: {
		subject: "Verify your Blankfolio email",
		text: (url: string) =>
			`Open this link to verify your email address for Blankfolio:\n\n${url}\n\nThe link expires in one hour. If you did not create a Blankfolio account, you can ignore this email.`,
	},
	"password-reset": {
		subject: "Reset your Blankfolio password",
		text: (url: string) =>
			`Open this link to choose a new Blankfolio password:\n\n${url}\n\nThe link works once and expires in one hour. If you did not ask to reset your password, you can ignore this email.`,
	},
} satisfies Record<AuthMail["kind"], unknown>;

export function createMailDelivery(
	env: {
		NODE_ENV: string;
		AUTH_MAIL_OUTBOX?: string;
		RESEND_API_KEY?: string;
		AUTH_MAIL_FROM?: string;
	},
	send: typeof fetch = fetch,
): MailDelivery {
	const outbox = env.AUTH_MAIL_OUTBOX;
	if (outbox) {
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
	const apiKey = env.RESEND_API_KEY;
	if (!apiKey)
		return async (mail) => {
			console.error("auth_mail_delivery_disabled", mail.kind);
		};
	const from = env.AUTH_MAIL_FROM ?? "Blankfolio <onboarding@resend.dev>";
	// Never throws or logs the address/link: either would reveal account existence.
	return async (mail) => {
		const message = messages[mail.kind];
		try {
			const response = await send("https://api.resend.com/emails", {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					from,
					to: mail.to,
					subject: message.subject,
					text: message.text(mail.url),
				}),
			});
			if (!response.ok)
				console.error("auth_mail_delivery_failed", mail.kind, response.status);
		} catch {
			console.error("auth_mail_delivery_failed", mail.kind, "network");
		}
	};
}
