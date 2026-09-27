import { randomUUID } from "node:crypto";
import {
	changePilotAccess,
	pilotAccessHistory,
} from "@blankfolio/api/pilot-access";
import type { AppRouter } from "@blankfolio/api/routers/index";
import { createTRPCClient, httpLink } from "@trpc/client";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createTestWorkspace } from "./workspace-fixture";

let workspace: Awaited<ReturnType<typeof createTestWorkspace>>;
beforeAll(async () => {
	workspace = await createTestWorkspace();
});
afterAll(async () => {
	await workspace?.close();
});
const client = (cookie: string) =>
	createTRPCClient<AppRouter>({
		links: [
			httpLink({
				url: "http://localhost/trpc",
				headers: { cookie },
				fetch: async (url, init) =>
					workspace.app.request(new Request(url, init)),
			}),
		],
	});
const address = (name: string) => `${name}-${randomUUID()}@example.test`;

test("an invited researcher verifies email before any session can open Research Projects", async () => {
	const email = address("invited");
	await workspace.invite(email);
	const registered = await workspace.signUp(email);
	expect(registered.status).toBe(200);
	expect(registered.headers.get("set-cookie")).toBeNull();
	const early = await workspace.signInWith(email);
	expect(early.status).toBe(403);
	expect(await early.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
	const verified = await workspace.followLatestMail(email, "verification");
	expect(verified.status).toBe(302);
	expect(verified.headers.get("location")).toBe(
		"http://localhost/email-verified",
	);
	const researcher = client(
		workspace.sessionCookie(await workspace.signInWith(email)),
	);
	expect(await researcher.account.access.query()).toEqual({
		status: "eligible",
	});
	const project = await researcher.projects.create.mutate({
		title: "Invited work",
	});
	expect(
		(await researcher.projects.list.query({})).items.map((p) => p.id),
	).toEqual([project.id]);
});

async function verifiedSession(email: string) {
	await workspace.signUp(email);
	await workspace.followLatestMail(email, "verification");
	return client(workspace.sessionCookie(await workspace.signInWith(email)));
}
async function denial(operation: () => Promise<unknown>) {
	try {
		await operation();
	} catch (error) {
		const e = error as { message: string; data?: { code: string } };
		return { message: e.message, code: e.data?.code };
	}
	throw new Error("Research operation was allowed");
}
async function expectResearchDenied(
	researcher: ReturnType<typeof client>,
	projectId: string,
	message: string,
) {
	const guessed = "00000000-0000-4000-8000-000000000000";
	for (const operation of [
		() => researcher.projects.list.query({}),
		() => researcher.projects.create.mutate({ title: "Blocked" }),
		() => researcher.projects.get.query({ id: projectId }),
		() => researcher.projects.get.query({ id: guessed }),
		() => researcher.projects.history.query({ id: guessed }),
		() =>
			researcher.projects.saveBrief.mutate({
				id: projectId,
				expectedRevision: 1,
				brief: {
					title: "Blocked",
					topic: "",
					experienceLevel: "",
					timeAvailability: "",
					computeDescription: "",
					desiredContribution: "",
				},
			}),
		() => researcher.projects.archive.mutate({ id: guessed }),
		() => researcher.projects.unarchive.mutate({ id: projectId }),
		() => researcher.projects.delete.mutate({ id: projectId }),
	])
		expect(await denial(operation)).toEqual({ code: "FORBIDDEN", message });
}

test("a verified account without an invitation waits for eligibility and cannot reach research data", async () => {
	const owner = client(await workspace.signIn("uninvited-target"));
	const project = await owner.projects.create.mutate({ title: "Private" });
	const email = address("uninvited");
	const waiting = await verifiedSession(email);
	expect(await waiting.account.access.query()).toEqual({
		status: "pending-invitation",
	});
	await expectResearchDenied(
		waiting,
		project.id,
		"This pilot is invite-only. Your account is waiting for an invitation.",
	);
	await workspace.invite(email);
	expect(await waiting.account.access.query()).toEqual({ status: "eligible" });
	expect((await waiting.projects.list.query({})).items).toEqual([]);
});

test("revocation immediately denies research operations and preserves the account's projects", async () => {
	const email = address("revoked");
	await workspace.invite(email);
	const researcher = await verifiedSession(email);
	const project = await researcher.projects.create.mutate({
		title: "Kept through revocation",
	});
	await changePilotAccess(workspace.db, {
		action: "revoke",
		email,
		actor: "fixture-operator",
		reason: "Pilot participation ended",
	});
	expect(await researcher.account.access.query()).toEqual({
		status: "revoked",
	});
	await expectResearchDenied(
		researcher,
		project.id,
		"Pilot access for this account has been withdrawn. Your private projects are kept.",
	);
	await workspace.invite(email);
	expect((await researcher.projects.get.query({ id: project.id })).title).toBe(
		"Kept through revocation",
	);
});

test("a session whose email is not verified cannot use research operations", async () => {
	const email = address("unverified");
	await workspace.invite(email);
	const researcher = await verifiedSession(email);
	const project = await researcher.projects.create.mutate({});
	// Starter-era accounts can hold sessions without having verified their address.
	await workspace.db.$client.query(
		`UPDATE "user" SET email_verified = false WHERE email = $1`,
		[email],
	);
	expect(await researcher.account.access.query()).toEqual({
		status: "verification-required",
	});
	await expectResearchDenied(
		researcher,
		project.id,
		"Verify your email address before opening Research Projects.",
	);
});

test("operators change eligibility for a normalized email with an actor, time and reason audit record", async () => {
	const local = `Mixed.Case-${randomUUID()}`;
	const email = `${local}@example.test`.toLowerCase();
	const before = new Date();
	await changePilotAccess(workspace.db, {
		action: "invite",
		email: `  ${local}@Example.TEST `,
		actor: "operator@lab.example",
		reason: "Pilot cohort A",
	});
	const researcher = await verifiedSession(email);
	expect(await researcher.account.access.query()).toEqual({
		status: "eligible",
	});
	await changePilotAccess(workspace.db, {
		action: "revoke",
		email: email.toUpperCase(),
		actor: "second-operator@lab.example",
		reason: "Left the pilot",
	});
	const history = await pilotAccessHistory(workspace.db, ` ${email} `);
	expect(history).toMatchObject([
		{
			action: "revoke",
			email,
			actor: "second-operator@lab.example",
			reason: "Left the pilot",
		},
		{
			action: "invite",
			email,
			actor: "operator@lab.example",
			reason: "Pilot cohort A",
		},
	]);
	for (const event of history)
		expect(event.createdAt.getTime()).toBeGreaterThanOrEqual(
			before.getTime() - 60_000,
		);
	for (const incomplete of [
		{ actor: "operator@lab.example", reason: "  " },
		{ actor: "", reason: "Missing operator" },
	])
		await expect(
			changePilotAccess(workspace.db, {
				action: "invite",
				email,
				...incomplete,
			}),
		).rejects.toThrow();
	expect(await pilotAccessHistory(workspace.db, email)).toHaveLength(2);
	expect(await researcher.account.access.query()).toEqual({
		status: "revoked",
	});
});

test("registration and recovery responses do not reveal whether an account exists", async () => {
	const known = address("known");
	await verifiedSession(known);
	const pending = address("pending");
	await workspace.signUp(pending);
	const unknown = address("unknown");
	const respond = async (path: string, email: string) => {
		const response = await workspace.post(path, {
			email,
			redirectTo: "http://localhost/reset-password",
			callbackURL: "http://localhost/email-verified",
		});
		return { status: response.status, body: await response.json() };
	};
	const sent = workspace.mail.length;
	expect(await respond("/api/auth/request-password-reset", known)).toEqual(
		await respond("/api/auth/request-password-reset", unknown),
	);
	expect(await respond("/api/auth/send-verification-email", pending)).toEqual(
		await respond("/api/auth/send-verification-email", unknown),
	);
	expect(await respond("/api/auth/send-verification-email", known)).toEqual(
		await respond("/api/auth/send-verification-email", unknown),
	);
	expect(
		workspace.mail.slice(sent).map(({ kind, to }) => ({ kind, to })),
	).toEqual([
		{ kind: "password-reset", to: known },
		{ kind: "verification", to: pending },
	]);
	const duplicate = await workspace.signUp(known);
	expect(duplicate.status).toBe(200);
	expect(duplicate.headers.get("set-cookie")).toBeNull();
	expect(workspace.mail.slice(sent)).toHaveLength(2);
});

test("a researcher recovers access with a single-use reset link that ends earlier sessions", async () => {
	const email = address("recovering");
	await workspace.invite(email);
	const earlier = await verifiedSession(email);
	await workspace.post("/api/auth/request-password-reset", {
		email,
		redirectTo: "http://localhost/reset-password",
	});
	const link = await workspace.followLatestMail(email, "password-reset");
	expect(link.status).toBe(302);
	const landing = new URL(link.headers.get("location") ?? "");
	expect(`${landing.origin}${landing.pathname}`).toBe(
		"http://localhost/reset-password",
	);
	const token = landing.searchParams.get("token");
	const reset = () =>
		workspace.post("/api/auth/reset-password", {
			token,
			newPassword: "Recovered-disposable-Password-456!",
		});
	expect((await reset()).status).toBe(200);
	await expect(earlier.account.access.query()).rejects.toMatchObject({
		data: { code: "UNAUTHORIZED" },
	});
	expect((await workspace.signInWith(email)).status).toBe(401);
	const recovered = client(
		workspace.sessionCookie(
			await workspace.signInWith(email, "Recovered-disposable-Password-456!"),
		),
	);
	expect((await recovered.projects.list.query({})).items).toEqual([]);
	expect(await (await reset()).json()).toMatchObject({
		code: "INVALID_TOKEN",
	});
});

test("expired verification and recovery links return to a state that can request a new link", async () => {
	const email = address("expired");
	await workspace.signUp(email);
	await workspace.post("/api/auth/request-password-reset", {
		email,
		redirectTo: "http://localhost/reset-password",
	});
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
		const verification = await workspace.followLatestMail(
			email,
			"verification",
		);
		expect(verification.headers.get("location")).toBe(
			"http://localhost/email-verified?error=TOKEN_EXPIRED",
		);
		const recovery = await workspace.followLatestMail(email, "password-reset");
		expect(recovery.headers.get("location")).toBe(
			"http://localhost/reset-password?error=INVALID_TOKEN",
		);
	} finally {
		vi.useRealTimers();
	}
	expect((await workspace.signInWith(email)).status).toBe(403);
});
