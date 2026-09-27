import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
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

test("Resend delivers verification and recovery links from the configured sender", async () => {
	const requests: { url: string; init: RequestInit }[] = [];
	const deliver = createMailDelivery(
		{
			NODE_ENV: "production",
			RESEND_API_KEY: "re_test_key",
			AUTH_MAIL_FROM: "Blankfolio <no-reply@example.test>",
		},
		async (url, init) => {
			requests.push({ url: String(url), init: init ?? {} });
			return Response.json({ id: "email-id" });
		},
	);
	await deliver({
		kind: "verification",
		to: "a@example.test",
		url: "https://blankfolio.example/api/auth/verify-email?token=one",
	});
	await deliver({
		kind: "password-reset",
		to: "a@example.test",
		url: "https://blankfolio.example/api/auth/reset-password/two",
	});
	expect(requests.map((request) => request.url)).toEqual([
		"https://api.resend.com/emails",
		"https://api.resend.com/emails",
	]);
	expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe(
		"Bearer re_test_key",
	);
	const [verification, recovery] = requests.map((request) =>
		JSON.parse(String(request.init.body)),
	);
	expect(verification).toMatchObject({
		from: "Blankfolio <no-reply@example.test>",
		to: "a@example.test",
		subject: "Verify your Blankfolio email",
	});
	expect(verification.text).toContain("verify-email?token=one");
	expect(recovery.subject).toBe("Reset your Blankfolio password");
	expect(recovery.text).toContain("reset-password/two");
});

test("a failed Resend delivery neither throws nor logs the address or link", async () => {
	const logged: unknown[][] = [];
	const error = vi
		.spyOn(console, "error")
		.mockImplementation((...args) => void logged.push(args));
	try {
		for (const send of [
			async () => new Response("rate limited", { status: 429 }),
			async () => {
				throw new TypeError("fetch failed");
			},
		]) {
			const deliver = createMailDelivery(
				{ NODE_ENV: "production", RESEND_API_KEY: "re_test_key" },
				send,
			);
			await expect(
				deliver({
					kind: "verification",
					to: "a@example.test",
					url: "https://blankfolio.example/api/auth/verify-email?token=one",
				}),
			).resolves.toBeUndefined();
		}
		expect(logged).toHaveLength(2);
		expect(JSON.stringify(logged)).not.toMatch(/a@example\.test|token=one/);
	} finally {
		error.mockRestore();
	}
});
