import type { MailDelivery } from "@blankfolio/auth";

/** Live delivery stays disabled until a provider is configured and verified. */
export function createMailDelivery(): MailDelivery {
	return async (mail) => {
		console.error("auth_mail_delivery_disabled", mail.kind);
	};
}
