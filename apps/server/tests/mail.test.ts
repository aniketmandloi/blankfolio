import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createMailDelivery } from "../src/mail";

test("a local outbox records verification and recovery links instead of sending mail", async () => {
	const directory = await mkdtemp(join(tmpdir(), "blankfolio-outbox-"));
	try {
		const outbox = join(directory, "mail.jsonl");
		const deliver = createMailDelivery({
			NODE_ENV: "development",
			AUTH_MAIL_OUTBOX: outbox,
		});
		await deliver({
			kind: "verification",
			to: "a@example.test",
			url: "http://localhost:3000/api/auth/verify-email?token=one",
		});
		await deliver({
			kind: "password-reset",
			to: "a@example.test",
			url: "http://localhost:3000/api/auth/reset-password/two",
		});
		const lines = (await readFile(outbox, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines).toMatchObject([
			{ kind: "verification", to: "a@example.test" },
			{ kind: "password-reset", to: "a@example.test" },
		]);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("production cannot write authentication links to a local outbox", () => {
	expect(() =>
		createMailDelivery({
			NODE_ENV: "production",
			AUTH_MAIL_OUTBOX: "/tmp/mail.jsonl",
		}),
	).toThrow("AUTH_MAIL_OUTBOX");
});
