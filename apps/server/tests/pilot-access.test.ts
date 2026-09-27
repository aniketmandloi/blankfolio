import { randomUUID } from "node:crypto";
import { changePilotAccess } from "@blankfolio/api/pilot-access";
import type { AppRouter } from "@blankfolio/api/routers/index";
import { createTRPCClient, httpLink } from "@trpc/client";
import { afterAll, beforeAll, expect, test } from "vitest";
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
