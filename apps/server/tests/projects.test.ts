import { retryProjectCleanup } from "@blankfolio/api/project-lifecycle";
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

test("a researcher saves an incomplete private Research Project and returns to it", async () => {
	const owner = client(await workspace.signIn("owner"));
	const project = await owner.projects.create.mutate({
		title: "Representation learning",
	});
	expect(project.brief.topic).toBe("");
	expect(project.brief.computeDescription).toBe("unknown");
	expect((await owner.projects.get.query({ id: project.id })).brief.title).toBe(
		"Representation learning",
	);
	expect(
		(await owner.projects.list.query({})).items.map((p) => p.id),
	).toContain(project.id);
});

test("a researcher records whether the topic is outside the initial evaluation track", async () => {
	const owner = client(await workspace.signIn("topic-track"));
	const project = await owner.projects.create.mutate({});
	expect(project.brief.evaluationTrack).toBe("unknown");
	const saved = await owner.projects.saveBrief.mutate({
		id: project.id,
		expectedRevision: 1,
		brief: { ...project.brief, evaluationTrack: "outside-track" },
	});
	expect(saved.brief.evaluationTrack).toBe("outside-track");
	const reopened = await owner.projects.get.query({ id: project.id });
	expect(reopened.brief.evaluationTrack).toBe("outside-track");
	expect(reopened.history.at(-1)?.brief.evaluationTrack).toBe("unknown");
});

test("brief revisions survive reopening and a stale tab cannot overwrite a saved brief", async () => {
	const owner = client(await workspace.signIn("revisions"));
	const project = await owner.projects.create.mutate({
		title: "Original title",
	});
	const saved = await owner.projects.saveBrief.mutate({
		id: project.id,
		expectedRevision: 1,
		brief: {
			...project.brief,
			title: "Revised title",
			topic: "Which representations transfer?",
			timeAvailability: "",
		},
	});
	expect(saved.revision).toBe(2);
	expect(saved.brief.timeAvailability).toBe("unknown");
	await expect(
		owner.projects.saveBrief.mutate({
			id: project.id,
			expectedRevision: 1,
			brief: { ...project.brief, title: "Stale edit" },
		}),
	).rejects.toMatchObject({ data: { code: "CONFLICT" } });
	const reopened = await owner.projects.get.query({ id: project.id });
	expect(reopened.brief.title).toBe("Revised title");
	expect(reopened.history.map((revision) => revision.brief.title)).toEqual([
		"Revised title",
		"Original title",
	]);
});

test("another account cannot enumerate, read, change, unarchive, or delete a Research Project", async () => {
	const owner = client(await workspace.signIn("private-owner"));
	const stranger = client(await workspace.signIn("stranger"));
	const project = await owner.projects.create.mutate({
		title: "Private investigation",
	});
	expect((await stranger.projects.list.query({})).items).toEqual([]);
	const missing = "00000000-0000-4000-8000-000000000000";
	const capture = async (id: string) => {
		try {
			await stranger.projects.get.query({ id });
		} catch (error) {
			const e = error as {
				message: string;
				data?: { code: string; httpStatus: number };
			};
			return {
				message: e.message,
				code: e.data?.code,
				httpStatus: e.data?.httpStatus,
			};
		}
		throw new Error("Private access was allowed");
	};
	expect(await capture(project.id)).toEqual(await capture(missing));
	await Promise.all(
		[
			stranger.projects.saveBrief.mutate({
				id: project.id,
				expectedRevision: 1,
				brief: project.brief,
			}),
			stranger.projects.history.query({ id: project.id }),
			stranger.projects.archive.mutate({ id: project.id }),
			stranger.projects.unarchive.mutate({ id: project.id }),
			stranger.projects.delete.mutate({ id: project.id }),
		].map((operation) =>
			expect(operation).rejects.toMatchObject({ data: { code: "NOT_FOUND" } }),
		),
	);
	expect((await owner.projects.get.query({ id: project.id })).state).toBe(
		"active",
	);
	await owner.projects.archive.mutate({ id: project.id });
	await expect(
		stranger.projects.unarchive.mutate({ id: project.id }),
	).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
	expect((await owner.projects.get.query({ id: project.id })).state).toBe(
		"archived",
	);
});

test("archived Research Projects remain readable but reject changes and deletion until unarchived", async () => {
	const owner = client(await workspace.signIn("archive"));
	const project = await owner.projects.create.mutate({
		title: "Archived brief",
	});
	await owner.projects.archive.mutate({ id: project.id });
	expect((await owner.projects.get.query({ id: project.id })).state).toBe(
		"archived",
	);
	await Promise.all(
		[
			owner.projects.saveBrief.mutate({
				id: project.id,
				expectedRevision: 1,
				brief: { ...project.brief, topic: "Blocked change" },
			}),
			owner.projects.delete.mutate({ id: project.id }),
		].map((operation) =>
			expect(operation).rejects.toMatchObject({ data: { code: "CONFLICT" } }),
		),
	);
	await owner.projects.unarchive.mutate({ id: project.id });
	expect(
		(
			await owner.projects.saveBrief.mutate({
				id: project.id,
				expectedRevision: 1,
				brief: { ...project.brief, topic: "Allowed change" },
			})
		).revision,
	).toBe(2);
});

test("deletion immediately denies read and publication through every project mutation", async () => {
	const owner = client(await workspace.signIn("delete"));
	const project = await owner.projects.create.mutate({
		title: "Delete my private brief",
	});
	expect(await owner.projects.delete.mutate({ id: project.id })).toEqual({
		deleted: true,
		cleanupPending: false,
	});
	expect((await owner.projects.list.query({})).items).toEqual([]);
	await Promise.all(
		[
			owner.projects.get.query({ id: project.id }),
			owner.projects.saveBrief.mutate({
				id: project.id,
				expectedRevision: 1,
				brief: project.brief,
			}),
			owner.projects.unarchive.mutate({ id: project.id }),
			owner.projects.archive.mutate({ id: project.id }),
			owner.projects.delete.mutate({ id: project.id }),
		].map((operation) =>
			expect(operation).rejects.toMatchObject({ data: { code: "NOT_FOUND" } }),
		),
	);
});

test("the persisted brief stays within input bounds after recording blank constraints as unknown", async () => {
	const owner = client(await workspace.signIn("bounds"));
	const project = await owner.projects.create.mutate({});
	await expect(
		owner.projects.create.mutate({ title: "t".repeat(121) }),
	).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
	await expect(
		owner.projects.saveBrief.mutate({
			id: project.id,
			expectedRevision: 1,
			brief: { ...project.brief, topic: "x".repeat(2001) },
		}),
	).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
	await expect(
		owner.projects.saveBrief.mutate({
			id: project.id,
			expectedRevision: 1,
			brief: {
				title: "",
				topic: "",
				experienceLevel: "",
				timeAvailability: "",
				computeDescription: "",
				desiredContribution: "x".repeat(9999),
			},
		}),
	).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
	expect((await owner.projects.get.query({ id: project.id })).revision).toBe(1);
	const atLimit = await owner.projects.saveBrief.mutate({
		id: project.id,
		expectedRevision: 1,
		brief: {
			evaluationTrack: "tabular-classification",
			title: "",
			topic: "",
			experienceLevel: "x".repeat(2500),
			timeAvailability: "x".repeat(2500),
			computeDescription: "x".repeat(2500),
			desiredContribution: "x".repeat(2500),
		},
	});
	expect(atLimit.revision).toBe(2);
});

test("a PostgreSQL failure rolls back the entire project creation without an orphan", async () => {
	const owner = client(await workspace.signIn("rollback"));
	await workspace.db.$client.query(
		`ALTER TABLE brief_revision ADD CONSTRAINT test_reject_failed_brief CHECK (brief->>'title' <> 'Rollback fixture')`,
	);
	try {
		await expect(
			owner.projects.create.mutate({ title: "Rollback fixture" }),
		).rejects.toMatchObject({
			message: "Research operation failed. Try again later.",
			data: { code: "INTERNAL_SERVER_ERROR" },
		});
		expect((await owner.projects.list.query({})).items).toEqual([]);
	} finally {
		await workspace.db.$client.query(
			"ALTER TABLE brief_revision DROP CONSTRAINT test_reject_failed_brief",
		);
	}
	expect(
		(await owner.projects.create.mutate({ title: "Retry succeeded" })).title,
	).toBe("Retry succeeded");
});

test("concurrent tabs can publish only one next brief revision", async () => {
	const owner = client(await workspace.signIn("concurrency"));
	const project = await owner.projects.create.mutate({
		title: "Concurrent brief",
	});
	const outcomes = await Promise.allSettled(
		["First tab", "Second tab"].map((title) =>
			owner.projects.saveBrief.mutate({
				id: project.id,
				expectedRevision: 1,
				brief: { ...project.brief, title },
			}),
		),
	);
	expect(
		outcomes.filter((outcome) => outcome.status === "fulfilled"),
	).toHaveLength(1);
	const failed = outcomes.find((outcome) => outcome.status === "rejected");
	expect(
		failed?.status === "rejected" ? failed.reason.data.code : undefined,
	).toBe("CONFLICT");
	expect((await owner.projects.get.query({ id: project.id })).revision).toBe(2);
});

test("invalid or absent sessions cannot access research operations", async () => {
	await expect(client("").projects.list.query({})).rejects.toMatchObject({
		data: { code: "UNAUTHORIZED" },
	});
	await expect(
		client("better-auth.session_token=expired").projects.create.mutate({}),
	).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
});

test("the project list returns newest Research Projects first across pages", async () => {
	const owner = client(await workspace.signIn("newest-first"));
	const created = [];
	for (const title of ["Oldest", "Middle", "Newest"])
		created.push(await owner.projects.create.mutate({ title }));
	const firstPage = await owner.projects.list.query({ limit: 2 });
	const secondPage = await owner.projects.list.query({
		limit: 2,
		cursor: firstPage.nextCursor,
	});
	expect(
		[...firstPage.items, ...secondPage.items].map((project) => project.title),
	).toEqual(["Newest", "Middle", "Oldest"]);
	expect(secondPage.nextCursor).toBeUndefined();
});

test("project and brief history pages do not omit or repeat saved records", async () => {
	const owner = client(await workspace.signIn("pages"));
	const firstProject = await owner.projects.create.mutate({
		title: "Page one",
	});
	const secondProject = await owner.projects.create.mutate({
		title: "Page two",
	});
	const firstPage = await owner.projects.list.query({ limit: 1 });
	const secondPage = await owner.projects.list.query({
		limit: 1,
		cursor: firstPage.nextCursor,
	});
	expect(
		[...firstPage.items, ...secondPage.items]
			.map((project) => project.id)
			.sort(),
	).toEqual([firstProject.id, secondProject.id].sort());
	let project = firstProject;
	for (const title of ["Revision two", "Revision three", "Revision four"])
		project = await owner.projects.saveBrief.mutate({
			id: project.id,
			expectedRevision: project.revision,
			brief: { ...project.brief, title },
		});
	const firstHistory = await owner.projects.history.query({
		id: project.id,
		limit: 2,
	});
	const secondHistory = await owner.projects.history.query({
		id: project.id,
		limit: 2,
		cursor: firstHistory.nextCursor,
	});
	expect(
		[...firstHistory.items, ...secondHistory.items].map(
			(revision) => revision.revision,
		),
	).toEqual([4, 3, 2, 1]);
});

test("cleanup failure cannot reopen a deleted Research Project and a retry removes its private brief", async () => {
	const owner = client(await workspace.signIn("cleanup-failure"));
	const project = await owner.projects.create.mutate({
		title: "Private content being removed",
	});
	await workspace.db.$client.query(
		`CREATE FUNCTION test_block_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture cleanup unavailable'; END $$; CREATE TRIGGER test_block_cleanup BEFORE DELETE ON brief_revision FOR EACH ROW EXECUTE FUNCTION test_block_cleanup()`,
	);
	try {
		expect(
			await owner.projects.delete.mutate({ id: project.id }),
		).toMatchObject({ deleted: true, cleanupPending: true });
		await expect(
			owner.projects.get.query({ id: project.id }),
		).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
		await expect(
			owner.projects.unarchive.mutate({ id: project.id }),
		).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
	} finally {
		await workspace.db.$client.query(
			"DROP TRIGGER test_block_cleanup ON brief_revision; DROP FUNCTION test_block_cleanup()",
		);
	}
	await retryProjectCleanup(workspace.db);
	const remaining = await workspace.db.$client.query(
		"SELECT count(*)::int AS briefs, (SELECT cleanup_completed_at IS NOT NULL FROM research_project WHERE id = $1) AS cleaned FROM brief_revision WHERE project_id = $1",
		[project.id],
	);
	expect(remaining.rows[0]).toEqual({ briefs: 0, cleaned: true });
	await expect(
		owner.projects.get.query({ id: project.id }),
	).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
});
