import { randomUUID } from "node:crypto";
import {
	type LiteratureSource,
	literatureSources,
	type SourceRequest,
} from "@blankfolio/api/literature-sources";
import { changePilotAccess } from "@blankfolio/api/pilot-access";
import {
	createJobQueue,
	literatureSearchQueue,
	literatureWorkOptions,
} from "@blankfolio/api/research-jobs";
import type { AppRouter } from "@blankfolio/api/routers/index";
import {
	budgetLimits,
	budgetStatus,
	reserveUsage,
} from "@blankfolio/api/usage-budget";
import { createTRPCClient, httpLink } from "@trpc/client";
import { PgBoss } from "pg-boss";
import { expect, test, vi } from "vitest";
import { createTestWorkspace } from "./workspace-fixture";

type Workspace = Awaited<ReturnType<typeof createTestWorkspace>>;
/**
 * Each scenario owns a disposable schema and queue, so scenarios run concurrently without
 * one worker run claiming another scenario's jobs. Every stage re-checks its guards in its own
 * transaction against a remote branch, hence the long timeout.
 */
const scenario = (name: string, run: (workspace: Workspace) => Promise<void>) =>
	test.concurrent(name, async () => {
		const workspace = await createTestWorkspace();
		try {
			await run(workspace);
		} finally {
			await workspace.close();
		}
	}, 240_000);
const client = (workspace: Workspace, cookie: string, app = workspace.app) =>
	createTRPCClient<AppRouter>({
		links: [
			httpLink({
				url: "http://localhost/trpc",
				headers: { cookie },
				fetch: async (url, init) => app.request(new Request(url, init)),
			}),
		],
	});
type Researcher = ReturnType<typeof client>;

async function readyProject(researcher: Researcher, topic: string) {
	const project = await researcher.projects.create.mutate({
		title: "Tabular transfer",
	});
	await researcher.projects.saveBrief.mutate({
		id: project.id,
		expectedRevision: 1,
		brief: {
			...project.brief,
			topic,
			computeDescription: "Private lab cluster notes",
		},
	});
	return project.id;
}
async function saveScope(
	researcher: Researcher,
	projectId: string,
	changes: Partial<{
		queries: string[];
		sources: string[];
		includeFoundations: boolean;
	}> = {},
) {
	const current = await researcher.literature.scope.query({ projectId });
	return researcher.literature.saveScope.mutate({
		projectId,
		expectedRevision: current.revision,
		scope: { ...current.scope, ...changes },
	});
}
async function submit(
	researcher: Researcher,
	projectId: string,
	key = randomUUID(),
) {
	const scope = await researcher.literature.scope.query({ projectId });
	return researcher.literature.submitSearch.mutate({
		projectId,
		scopeRevision: scope.revision,
		idempotencyKey: key,
		queries: scope.scope.queries,
	});
}

scenario(
	"a researcher edits a proposed Literature Scope, confirms the exact queries and returns to a dated snapshot",
	async (workspace) => {
		const researcher = client(workspace, await workspace.signIn("scope"));
		const projectId = await readyProject(
			researcher,
			"Which tabular representations transfer across hospitals?",
		);
		const proposed = await researcher.literature.scope.query({ projectId });
		const today = new Date().toISOString().slice(0, 10);
		expect(proposed).toMatchObject({
			revision: 0,
			proposed: true,
			briefRevision: 2,
			scope: {
				queries: [
					"Which tabular representations transfer across hospitals?",
					"Tabular transfer",
				],
				sources: ["fixture-catalog"],
				dateTo: today,
				includeFoundations: false,
			},
		});
		expect(proposed.scope.dateFrom).toBe(
			`${Number(today.slice(0, 4)) - 5}${today.slice(4)}`,
		);
		expect(JSON.stringify(proposed.scope)).not.toContain("Private lab cluster");

		const saved = await saveScope(researcher, projectId, {
			queries: ["tabular transfer learning", "hospital domain shift"],
			sources: ["fixture-catalog", "fixture-metered"],
			includeFoundations: true,
		});
		expect(saved).toMatchObject({ revision: 1, proposed: false });
		const job = await submit(researcher, projectId);
		expect(job).toMatchObject({
			state: "queued",
			scopeRevision: 1,
			sourceCount: 2,
			finishedSources: 0,
			snapshotId: null,
		});

		await workspace.runQueuedJobs();

		const finished = await researcher.literature.job.query({
			projectId,
			jobId: job.id,
		});
		expect(finished).toMatchObject({
			state: "succeeded",
			stage: "done",
			finishedSources: 2,
		});
		const snapshot = await researcher.literature.snapshot.query({
			projectId,
			snapshotId: finished.snapshotId ?? "",
		});
		expect(snapshot).toMatchObject({
			scopeRevision: 1,
			briefRevision: 2,
			coverage: "all-sources",
			recordCap: 200,
			scope: { includeFoundations: true },
		});
		expect(snapshot.sources).toEqual([
			expect.objectContaining({
				source: "fixture-catalog",
				status: "succeeded",
				attempts: 1,
				allocation: 80,
				effectiveQueries: [
					"tabular transfer learning",
					"hospital domain shift",
				],
				unsupportedFilters: [],
				reportedCount: 30,
				receivedCount: 30,
				truncated: false,
			}),
			expect.objectContaining({
				source: "fixture-metered",
				status: "succeeded",
				unsupportedFilters: ["older foundational work"],
				reportedCount: 24,
				receivedCount: 24,
			}),
		]);
		// Both sources return the same 24 discovery papers; only the catalog adds foundations.
		expect(snapshot.paperCount).toBe(30);
		expect(snapshot.papers).toHaveLength(30);
		expect(
			snapshot.papers.filter((p) => p.acquisitionReason === "foundation"),
		).toHaveLength(6);
		expect(
			(await researcher.literature.snapshots.query({ projectId })).map(
				(s) => s.id,
			),
		).toEqual([snapshot.id]);
	},
);

/** Fixture sources that run a hook before each search, e.g. to count calls or interrupt. */
function hookedSources(
	hooks: Partial<Record<string, (request: SourceRequest) => unknown>>,
): Record<string, LiteratureSource> {
	return Object.fromEntries(
		Object.entries(literatureSources).map(([id, source]) => [
			id,
			{
				...source,
				search: async (request: SourceRequest) => {
					await hooks[id]?.(request);
					return source.search(request);
				},
			},
		]),
	);
}
const queuedMessages = async (workspace: Workspace) =>
	(await workspace.boss.findJobs(literatureSearchQueue)).length;

scenario(
	"repeated submissions return one job, a reused key with changed input conflicts, and a failed write leaves no queue entry",
	async (workspace) => {
		const researcher = client(workspace, await workspace.signIn("idempotent"));
		const projectId = await readyProject(researcher, "Calibration under shift");
		await saveScope(researcher, projectId);
		const key = randomUUID();
		const before = await queuedMessages(workspace);
		const [first, second] = await Promise.all([
			submit(researcher, projectId, key),
			submit(researcher, projectId, key),
		]);
		expect(second.id).toBe(first.id);
		expect(await submit(researcher, projectId, key)).toMatchObject({
			id: first.id,
		});
		expect(await queuedMessages(workspace)).toBe(before + 1);

		await saveScope(researcher, projectId, { queries: ["recalibration"] });
		await expect(submit(researcher, projectId, key)).rejects.toMatchObject({
			data: { code: "CONFLICT" },
		});
		await expect(
			researcher.literature.submitSearch.mutate({
				projectId,
				scopeRevision: 2,
				idempotencyKey: randomUUID(),
				queries: ["a query the researcher never confirmed"],
			}),
		).rejects.toMatchObject({ data: { code: "CONFLICT" } });
		await expect(
			researcher.literature.submitSearch.mutate({
				projectId,
				scopeRevision: 1,
				idempotencyKey: randomUUID(),
				queries: ["recalibration"],
			}),
		).rejects.toMatchObject({ data: { code: "CONFLICT" } });

		const rejectedKey = "00000000-0000-4000-8000-00000000dead";
		await workspace.db.$client.query(
			`ALTER TABLE research_job ADD CONSTRAINT test_reject_job CHECK (idempotency_key <> '${rejectedKey}')`,
		);
		try {
			await expect(
				submit(researcher, projectId, rejectedKey),
			).rejects.toMatchObject({ data: { code: "INTERNAL_SERVER_ERROR" } });
		} finally {
			await workspace.db.$client.query(
				"ALTER TABLE research_job DROP CONSTRAINT test_reject_job",
			);
		}
		expect(await queuedMessages(workspace)).toBe(before + 1);
		expect(
			(await researcher.literature.jobs.query({ projectId })).items.map(
				(job) => job.id,
			),
		).toEqual([first.id]);
		await workspace.runQueuedJobs();
	},
);

scenario(
	"each source's outcome, coverage limits and effective filters stay visible, and a wholly failed search publishes no corpus",
	async (workspace) => {
		const researcher = client(workspace, await workspace.signIn("coverage"));
		const projectId = await readyProject(researcher, "Coverage limits");
		await saveScope(researcher, projectId, {
			queries: [
				"fixture:broad fixture:cached tabular",
				"fixture:metered-partial calibration",
			],
			sources: ["fixture-catalog", "fixture-metered"],
			includeFoundations: true,
		});
		const limited = await submit(researcher, projectId);
		await workspace.runQueuedJobs();
		const limitedJob = await researcher.literature.job.query({
			projectId,
			jobId: limited.id,
		});
		const snapshot = await researcher.literature.snapshot.query({
			projectId,
			snapshotId: limitedJob.snapshotId ?? "",
		});
		expect(snapshot.coverage).toBe("partial");
		expect(snapshot.sources).toEqual([
			expect.objectContaining({
				source: "fixture-catalog",
				status: "succeeded",
				appliedFilters: [
					`publication date ${snapshot.scope.dateFrom} to ${snapshot.scope.dateTo}`,
					"older foundational work",
				],
				reportedCount: 1006,
				receivedCount: 80,
				truncated: true,
				cursor: "offset:80",
				cacheAgeSeconds: 21_600,
			}),
			expect.objectContaining({
				source: "fixture-metered",
				status: "partial",
				errorClass: "query-failed",
				unsupportedFilters: ["older foundational work"],
				reportedCount: 500,
				receivedCount: 80,
				truncated: true,
			}),
		]);
		expect(snapshot.paperCount).toBeLessThanOrEqual(200);
		expect(snapshot.papers).toHaveLength(snapshot.paperCount);

		const sleeps: number[] = [];
		await saveScope(researcher, projectId, {
			queries: ["fixture:flaky fixture:empty nothing indexed"],
			sources: ["fixture-catalog"],
			includeFoundations: false,
		});
		const empty = await submit(researcher, projectId);
		await workspace.runQueuedJobs({
			sleep: async (milliseconds) => {
				sleeps.push(milliseconds);
			},
		});
		const emptyJob = await researcher.literature.job.query({
			projectId,
			jobId: empty.id,
		});
		expect(emptyJob).toMatchObject({ state: "succeeded" });
		expect(emptyJob.sources).toEqual([
			expect.objectContaining({
				status: "empty",
				attempts: 2,
				receivedCount: 0,
			}),
		]);
		expect(sleeps).toEqual([1_000]);
		expect(
			await researcher.literature.snapshot.query({
				projectId,
				snapshotId: emptyJob.snapshotId ?? "",
			}),
		).toMatchObject({ coverage: "all-sources", paperCount: 0, papers: [] });

		const spent = (await researcher.literature.budget.query({ projectId }))
			.projectCommittedMicros;
		await saveScope(researcher, projectId, {
			queries: ["fixture:outage everything down"],
			sources: ["fixture-catalog", "fixture-metered"],
		});
		const failed = await submit(researcher, projectId);
		await workspace.runQueuedJobs();
		const failedJob = await researcher.literature.job.query({
			projectId,
			jobId: failed.id,
		});
		expect(failedJob).toMatchObject({
			state: "failed",
			errorClass: "all-sources-failed",
			snapshotId: null,
		});
		expect(
			failedJob.sources.map((s) => [s.status, s.attempts, s.errorClass]),
		).toEqual([
			["failed", 3, "source-unavailable"],
			["failed", 3, "source-unavailable"],
		]);
		// Refused metered attempts were never billed, so their reservations were released.
		expect(
			(await researcher.literature.budget.query({ projectId }))
				.projectCommittedMicros,
		).toBe(spent);
		expect(
			(await researcher.literature.snapshots.query({ projectId })).map(
				(s) => s.id,
			),
		).toEqual([emptyJob.snapshotId, limitedJob.snapshotId]);
	},
);

scenario(
	"a restarted worker resumes from checkpoints without repeating completed sources or duplicating papers",
	async (workspace) => {
		const researcher = client(workspace, await workspace.signIn("restart"));
		const projectId = await readyProject(researcher, "Resumable search");
		await saveScope(researcher, projectId, {
			sources: ["fixture-metered", "fixture-catalog"],
		});
		const job = await submit(researcher, projectId);
		const calls = { "fixture-catalog": 0, "fixture-metered": 0 };
		const count = (id: keyof typeof calls) => () => {
			calls[id] += 1;
		};
		expect(
			await workspace.runNextJob({
				sources: hookedSources({
					"fixture-metered": count("fixture-metered"),
					"fixture-catalog": () => {
						calls["fixture-catalog"] += 1;
						throw new Error("worker process stopped");
					},
				}),
			}),
		).toBe(true);
		expect(
			await researcher.literature.job.query({ projectId, jobId: job.id }),
		).toMatchObject({ state: "running", finishedSources: 1 });

		const healthy = hookedSources({
			"fixture-metered": count("fixture-metered"),
			"fixture-catalog": count("fixture-catalog"),
		});
		await workspace.runQueuedJobs({ sources: healthy });
		expect(calls).toEqual({ "fixture-catalog": 2, "fixture-metered": 1 });
		const finished = await researcher.literature.job.query({
			projectId,
			jobId: job.id,
		});
		expect(finished).toMatchObject({ state: "succeeded" });
		expect(finished.sources.map((s) => [s.source, s.attempts])).toEqual([
			["fixture-catalog", 2],
			["fixture-metered", 1],
		]);

		await workspace.boss.send(literatureSearchQueue, { jobId: job.id });
		await workspace.runQueuedJobs({ sources: healthy });
		expect(calls).toEqual({ "fixture-catalog": 2, "fixture-metered": 1 });
		const snapshots = await researcher.literature.snapshots.query({
			projectId,
		});
		expect(snapshots.map((s) => s.id)).toEqual([finished.snapshotId]);
		expect(
			(
				await researcher.literature.snapshot.query({
					projectId,
					snapshotId: finished.snapshotId ?? "",
				})
			).papers,
		).toHaveLength(snapshots[0]?.paperCount ?? -1);
		expect(
			(await researcher.literature.budget.query({ projectId }))
				.projectCommittedMicros,
		).toBe(40_000);
	},
);

scenario(
	"an uncertain metered outcome keeps its reservation held and is never retried automatically",
	async (workspace) => {
		const researcher = client(workspace, await workspace.signIn("uncertain"));
		const projectId = await readyProject(researcher, "Uncertain billing");
		await saveScope(researcher, projectId, {
			queries: ["fixture:metered-uncertain audit"],
			sources: ["fixture-metered", "fixture-catalog"],
		});
		const lost = await submit(researcher, projectId);
		await workspace.runQueuedJobs();
		const lostJob = await researcher.literature.job.query({
			projectId,
			jobId: lost.id,
		});
		expect(lostJob).toMatchObject({ state: "succeeded" });
		expect(lostJob.sources).toContainEqual(
			expect.objectContaining({
				source: "fixture-metered",
				status: "failed",
				attempts: 1,
				errorClass: "uncertain-outcome",
			}),
		);
		expect(
			(
				await researcher.literature.snapshot.query({
					projectId,
					snapshotId: lostJob.snapshotId ?? "",
				})
			).coverage,
		).toBe("partial");
		expect(
			(await researcher.literature.budget.query({ projectId }))
				.projectCommittedMicros,
		).toBe(20_000);

		await saveScope(researcher, projectId, {
			queries: ["billing interrupted"],
			sources: ["fixture-metered"],
		});
		const interrupted = await submit(researcher, projectId);
		let meteredCalls = 0;
		await workspace.runNextJob({
			sources: hookedSources({
				"fixture-metered": () => {
					meteredCalls += 1;
					throw new Error("worker process stopped after dispatch");
				},
			}),
		});
		await workspace.runQueuedJobs({
			sources: hookedSources({
				"fixture-metered": () => {
					meteredCalls += 1;
				},
			}),
		});
		expect(meteredCalls).toBe(1);
		const interruptedJob = await researcher.literature.job.query({
			projectId,
			jobId: interrupted.id,
		});
		expect(interruptedJob).toMatchObject({
			state: "failed",
			errorClass: "all-sources-failed",
			snapshotId: null,
		});
		expect(interruptedJob.sources).toEqual([
			expect.objectContaining({
				status: "failed",
				attempts: 1,
				errorClass: "uncertain-outcome",
			}),
		]);
		expect(
			(await researcher.literature.budget.query({ projectId }))
				.projectCommittedMicros,
		).toBe(40_000);
	},
);

scenario(
	"an account keeps at most two active searches and workers execute at most two runs globally",
	async (workspace) => {
		const first = client(workspace, await workspace.signIn("busy"));
		const projects = [];
		for (const topic of ["One", "Two", "Three"]) {
			const projectId = await readyProject(first, topic);
			await saveScope(first, projectId);
			projects.push(projectId);
		}
		const [one, two, three] = projects as [string, string, string];
		await submit(first, one);
		await submit(first, two);
		await expect(submit(first, three)).rejects.toMatchObject({
			data: { code: "TOO_MANY_REQUESTS" },
		});
		const second = client(workspace, await workspace.signIn("other-account"));
		const otherProject = await readyProject(second, "Elsewhere");
		await saveScope(second, otherProject);
		await submit(second, otherProject);

		const claimed = [];
		for (let i = 0; i < 3; i++)
			claimed.push(
				...(await workspace.boss.fetch(
					literatureSearchQueue,
					literatureWorkOptions,
				)),
			);
		expect(claimed).toHaveLength(2);
		await workspace.boss.fail(
			literatureSearchQueue,
			claimed.map((job) => job.id),
		);
		await workspace.runQueuedJobs();
		expect(await submit(first, three)).toMatchObject({ state: "queued" });
		await workspace.runQueuedJobs();
	},
);

scenario(
	"a worker blocked on an archiving project's lock holds no job lock, so the two cannot deadlock",
	async (workspace) => {
		const researcher = client(workspace, await workspace.signIn("lock-order"));
		const projectId = await readyProject(researcher, "Lock order");
		await saveScope(researcher, projectId);
		const job = await submit(researcher, projectId);
		// Archive's own order: the project row first, then its active jobs.
		const archiving = await workspace.db.$client.connect();
		try {
			await archiving.query("BEGIN");
			await archiving.query(
				"SELECT id FROM research_project WHERE id = $1 FOR UPDATE",
				[projectId],
			);
			const worker = workspace.runNextJob();
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			await archiving.query(
				"UPDATE research_job SET state = 'cancelled', cancel_reason = 'archived' WHERE project_id = $1 AND state IN ('queued', 'running')",
				[projectId],
			);
			await archiving.query(
				"UPDATE research_project SET state = 'archived' WHERE id = $1",
				[projectId],
			);
			await archiving.query("COMMIT");
			await worker;
		} finally {
			archiving.release();
		}
		const delivered = (
			await workspace.boss.findJobs<{ jobId: string }>(literatureSearchQueue)
		).filter((queued) => queued.data.jobId === job.id);
		expect(delivered.map((queued) => queued.state)).toEqual(["completed"]);
		expect(
			await researcher.literature.job.query({ projectId, jobId: job.id }),
		).toMatchObject({ state: "cancelled", cancelReason: "archived" });
	},
);

async function eligibleResearcher(workspace: Workspace, name: string) {
	const email = `${name}-${randomUUID()}@example.test`;
	await workspace.invite(email);
	await workspace.signUp(email);
	await workspace.followLatestMail(email, "verification");
	return {
		email,
		researcher: client(
			workspace,
			workspace.sessionCookie(await workspace.signInWith(email)),
		),
	};
}

scenario(
	"cancelled and archived work cannot publish or resurrect results",
	async (workspace) => {
		const researcher = client(workspace, await workspace.signIn("stopping"));
		const outcome = async (projectId: string, jobId: string) => {
			const job = await researcher.literature.job.query({ projectId, jobId });
			return [job.state, job.cancelReason, job.snapshotId, job.finishedSources];
		};
		let searched = 0;
		const counted = hookedSources({
			"fixture-catalog": () => {
				searched += 1;
			},
		});

		const early = await readyProject(researcher, "Cancelled before dispatch");
		await saveScope(researcher, early);
		const earlyJob = await submit(researcher, early);
		await researcher.literature.cancel.mutate({
			projectId: early,
			jobId: earlyJob.id,
		});
		await workspace.runQueuedJobs({ sources: counted });
		expect(await outcome(early, earlyJob.id)).toEqual([
			"cancelled",
			"researcher",
			null,
			0,
		]);
		expect(searched).toBe(0);

		const midway = await readyProject(researcher, "Cancelled while searching");
		await saveScope(researcher, midway);
		const midwayJob = await submit(researcher, midway);
		await workspace.runQueuedJobs({
			sources: hookedSources({
				"fixture-catalog": () =>
					researcher.literature.cancel.mutate({
						projectId: midway,
						jobId: midwayJob.id,
					}),
			}),
		});
		expect(await outcome(midway, midwayJob.id)).toEqual([
			"cancelled",
			"researcher",
			null,
			0,
		]);

		const archived = await readyProject(researcher, "Archived while searching");
		await saveScope(researcher, archived);
		const archivedJob = await submit(researcher, archived);
		await workspace.runQueuedJobs({
			sources: hookedSources({
				"fixture-catalog": () =>
					researcher.projects.archive.mutate({ id: archived }),
			}),
		});
		await researcher.projects.unarchive.mutate({ id: archived });
		await workspace.boss.send(literatureSearchQueue, { jobId: archivedJob.id });
		await workspace.runQueuedJobs();
		expect(await outcome(archived, archivedJob.id)).toEqual([
			"cancelled",
			"archived",
			null,
			0,
		]);
	},
);

scenario(
	"deleted and revoked work cannot publish or resurrect results",
	async (workspace) => {
		const { email, researcher } = await eligibleResearcher(
			workspace,
			"removed",
		);
		const outcome = async (projectId: string, jobId: string) => {
			const job = await researcher.literature.job.query({ projectId, jobId });
			return [job.state, job.cancelReason, job.snapshotId, job.finishedSources];
		};
		let searched = 0;
		const counted = hookedSources({
			"fixture-catalog": () => {
				searched += 1;
			},
		});

		const deleted = await readyProject(researcher, "Deleted while searching");
		await saveScope(researcher, deleted);
		const deletedJob = await submit(researcher, deleted);
		await workspace.runQueuedJobs({
			sources: hookedSources({
				"fixture-catalog": () =>
					researcher.projects.delete.mutate({ id: deleted }),
			}),
		});
		await expect(
			researcher.literature.job.query({
				projectId: deleted,
				jobId: deletedJob.id,
			}),
		).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
		const leftovers = await workspace.db.$client.query(
			"SELECT (SELECT count(*)::int FROM research_job WHERE project_id = $1) AS jobs, (SELECT count(*)::int FROM literature_snapshot WHERE project_id = $1) AS snapshots",
			[deleted],
		);
		expect(leftovers.rows[0]).toEqual({ jobs: 0, snapshots: 0 });

		const revoked = await readyProject(researcher, "Revoked while queued");
		await saveScope(researcher, revoked);
		const revokedJob = await submit(researcher, revoked);
		await changePilotAccess(workspace.db, {
			action: "revoke",
			email,
			actor: "fixture-operator",
			reason: "Pilot participation ended",
		});
		await workspace.runQueuedJobs({ sources: counted });
		await workspace.invite(email);
		expect(await outcome(revoked, revokedJob.id)).toEqual([
			"cancelled",
			"access-withdrawn",
			null,
			0,
		]);

		// Eligibility lost without an operator revocation is caught when the worker dispatches.
		const unverified = await submit(researcher, revoked);
		await workspace.db.$client.query(
			`UPDATE "user" SET email_verified = false WHERE email = $1`,
			[email],
		);
		await workspace.runQueuedJobs({ sources: counted });
		await workspace.db.$client.query(
			`UPDATE "user" SET email_verified = true WHERE email = $1`,
			[email],
		);
		expect(await outcome(revoked, unverified.id)).toEqual([
			"cancelled",
			"access-withdrawn",
			null,
			0,
		]);
		expect(searched).toBe(0);
	},
);

scenario(
	"usage reservations cannot exceed run, project or global limits under concurrency and reset with the UTC month",
	async (workspace) => {
		const researcher = client(workspace, await workspace.signIn("budget"));
		const projectId = await readyProject(researcher, "Budgeted search");
		await saveScope(researcher, projectId);
		const job = await submit(researcher, projectId);
		const reserve = (
			amountMicros: number,
			now: Date,
			target = { projectId, jobId: job.id },
		) =>
			reserveUsage(workspace.db, {
				...target,
				attempt: 1,
				route: "fixture-metered",
				amountMicros,
				now,
			});

		// A future month keeps this arrangement away from other tests' current spending.
		const september = new Date("2031-09-30T23:59:59Z");
		const runAttempts = await Promise.all(
			Array.from({ length: 8 }, () => reserve(300_000, september)),
		);
		expect(runAttempts.filter((r) => r.reserved)).toHaveLength(3);
		expect(
			runAttempts.flatMap((r) => (r.reserved ? [] : [r.exceeded])),
		).toEqual(Array(5).fill("run"));

		const elsewhere = await readyProject(researcher, "Other accounts' spend");
		await workspace.db.$client.query(
			`INSERT INTO usage_reservation (id, project_id, attempt, route, period, reserved_micros, actual_micros, state)
		 VALUES ($1, $2, 1, 'fixture-metered', '2031-09', 4200000, 4000000, 'settled'),
		        ($3, $4, 1, 'fixture-metered', '2031-09', 45000000, NULL, 'held')`,
			[randomUUID(), projectId, randomUUID(), elsewhere],
		);
		const secondJob = await submit(researcher, projectId);
		const projectAttempts = await Promise.all(
			Array.from({ length: 4 }, () =>
				reserve(50_000, september, { projectId, jobId: secondJob.id }),
			),
		);
		expect(projectAttempts.filter((r) => r.reserved)).toHaveLength(2);
		expect(
			await reserve(1, september, { projectId, jobId: secondJob.id }),
		).toEqual({ reserved: false, exceeded: "projectMonth" });

		await researcher.literature.cancel.mutate({ projectId, jobId: job.id });
		const other = await readyProject(researcher, "Global limit");
		await saveScope(researcher, other);
		const otherJob = await submit(researcher, other);
		expect(
			await reserve(100_000, september, {
				projectId: other,
				jobId: otherJob.id,
			}),
		).toEqual({ reserved: false, exceeded: "globalMonth" });

		const october = new Date("2031-10-01T00:00:00Z");
		expect(await reserve(300_000, october)).toMatchObject({ reserved: false });
		expect(
			await reserve(900_000, october, { projectId: other, jobId: otherJob.id }),
		).toMatchObject({ reserved: true });
		expect(
			(await budgetStatus(workspace.db, projectId, september))
				.projectCommittedMicros,
		).toBe(budgetLimits.projectMonth);
		expect(
			(await budgetStatus(workspace.db, projectId, october))
				.projectCommittedMicros,
		).toBe(0);
		await workspace.runQueuedJobs();
	},
);

scenario(
	"unknown pricing disables only metered sources while free searches and the budget status stay available",
	async (workspace) => {
		const cookie = await workspace.signIn("unpriced");
		const unpriced = client(
			workspace,
			cookie,
			workspace.createAuthApp({}, { prices: {}, quotas: {} }),
		);
		const projectId = await readyProject(unpriced, "Unpriced sources");
		const budget = await unpriced.literature.budget.query({ projectId });
		expect(budget.sources.map((s) => [s.id, s.blockedBy])).toEqual([
			["fixture-catalog", null],
			["fixture-metered", "pricing-unknown"],
		]);
		expect(budget).toMatchObject({
			period: new Date().toISOString().slice(0, 7),
			projectCommittedMicros: 0,
		});
		await saveScope(unpriced, projectId, {
			sources: ["fixture-catalog", "fixture-metered"],
		});
		await expect(submit(unpriced, projectId)).rejects.toMatchObject({
			data: { code: "PRECONDITION_FAILED" },
		});

		// Pricing removed from the worker after submission also stops the metered attempt.
		const priced = client(workspace, cookie);
		const job = await submit(priced, projectId);
		await workspace.runQueuedJobs({ prices: {} });
		const finished = await priced.literature.job.query({
			projectId,
			jobId: job.id,
		});
		expect(finished).toMatchObject({ state: "succeeded" });
		expect(
			finished.sources.map((s) => [s.source, s.status, s.errorClass]),
		).toEqual([
			["fixture-catalog", "succeeded", null],
			["fixture-metered", "failed", "pricing-unknown"],
		]);
		await saveScope(unpriced, projectId, { sources: ["fixture-catalog"] });
		expect(await submit(unpriced, projectId)).toMatchObject({
			state: "queued",
		});
		await workspace.runQueuedJobs({ prices: {} });
	},
);

scenario(
	"job lists, queue messages and other accounts never see private queries, and deletion keeps only incurred usage",
	async (workspace) => {
		const researcher = client(
			workspace,
			await workspace.signIn("private-queries"),
		);
		const projectId = await readyProject(researcher, "Private queries");
		const secret = `unpublished-idea-${randomUUID()}`;
		await saveScope(researcher, projectId, {
			queries: [secret],
			sources: ["fixture-catalog", "fixture-metered"],
		});
		const job = await submit(researcher, projectId);
		await workspace.runQueuedJobs();
		expect(
			JSON.stringify(await researcher.literature.jobs.query({ projectId })),
		).not.toContain(secret);
		expect(
			JSON.stringify(await workspace.boss.findJobs(literatureSearchQueue)),
		).not.toContain(secret);
		const { snapshotId } = await researcher.literature.job.query({
			projectId,
			jobId: job.id,
		});

		const stranger = client(
			workspace,
			await workspace.signIn("query-stranger"),
		);
		const guessed = "00000000-0000-4000-8000-000000000000";
		for (const operation of [
			() => stranger.literature.scope.query({ projectId }),
			() => stranger.literature.jobs.query({ projectId }),
			() => stranger.literature.job.query({ projectId, jobId: job.id }),
			() => stranger.literature.cancel.mutate({ projectId, jobId: job.id }),
			() =>
				stranger.literature.snapshot.query({
					projectId,
					snapshotId: snapshotId ?? guessed,
				}),
			() => stranger.literature.budget.query({ projectId }),
			() => stranger.literature.snapshots.query({ projectId: guessed }),
		])
			await expect(operation()).rejects.toMatchObject({
				data: { code: "NOT_FOUND" },
			});

		await researcher.projects.delete.mutate({ id: projectId });
		const remaining = await workspace.db.$client.query(
			`SELECT
			(SELECT count(*)::int FROM literature_scope_revision WHERE project_id = $1) AS scopes,
			(SELECT count(*)::int FROM research_job WHERE project_id = $1) AS jobs,
			(SELECT count(*)::int FROM source_execution WHERE project_id = $1) AS executions,
			(SELECT count(*)::int FROM literature_snapshot WHERE project_id = $1) AS snapshots,
			(SELECT count(*)::int FROM snapshot_paper WHERE project_id = $1) AS memberships,
			(SELECT coalesce(sum(actual_micros), 0)::int FROM usage_reservation WHERE project_id = $1 AND job_id IS NULL) AS usage`,
			[projectId],
		);
		expect(remaining.rows[0]).toEqual({
			scopes: 0,
			jobs: 0,
			executions: 0,
			snapshots: 0,
			memberships: 0,
			usage: 20_000,
		});
		const sharedPapers = await workspace.db.$client.query(
			"SELECT count(*)::int AS papers FROM paper WHERE strpos(title || coalesce(doi, '') || coalesce(url, ''), $1) > 0",
			[secret],
		);
		expect(sharedPapers.rows[0]).toEqual({ papers: 0 });
	},
);

test("a failed queue refresh in the API process is logged instead of crashing it", () => {
	const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
	try {
		const boss = new PgBoss({
			connectionString: "postgres://127.0.0.1:1/unreachable",
			supervise: false,
			schedule: false,
		});
		createJobQueue(boss);
		expect(() =>
			boss.emit("error", new Error("Connection terminated unexpectedly")),
		).not.toThrow();
		expect(logged).toHaveBeenCalledWith(
			"job_queue_error",
			"Connection terminated unexpectedly",
		);
	} finally {
		logged.mockRestore();
	}
});
