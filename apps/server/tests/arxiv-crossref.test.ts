import { randomUUID } from "node:crypto";
import { createArxivSource } from "@blankfolio/api/arxiv";
import {
	literatureSources,
	type SourceSettings,
} from "@blankfolio/api/literature-sources";
import type { LiteratureWorkerOptions } from "@blankfolio/api/literature-worker";
import { createOpenAlexSource } from "@blankfolio/api/openalex";
import type { AppRouter } from "@blankfolio/api/routers/index";
import { createTRPCClient, httpLink } from "@trpc/client";
import { expect, test } from "vitest";
import { arxivEntry, arxivFeed, atom } from "./arxiv-fixture";
import {
	json,
	openAlexFetch,
	openAlexPage,
	openAlexWork,
} from "./openalex-fixture";
import { createTestWorkspace, fixturePrices } from "./workspace-fixture";

type Workspace = Awaited<ReturnType<typeof createTestWorkspace>>;
const scenario = (name: string, run: (workspace: Workspace) => Promise<void>) =>
	test.concurrent(name, async () => {
		const workspace = await createTestWorkspace();
		try {
			await run(workspace);
		} finally {
			await workspace.close();
		}
	}, 240_000);

const settings: SourceSettings = {
	prices: {
		...fixturePrices,
		"openalex-search": 1_000,
		"openalex-filter": 100,
	},
	quotas: { openalex: 1_000_000 },
	fixtureSources: true,
};

function researcherFor(workspace: Workspace, cookie: string) {
	const app = workspace.createAuthApp({}, settings);
	return createTRPCClient<AppRouter>({
		links: [
			httpLink({
				url: "http://localhost/trpc",
				headers: { cookie },
				fetch: async (url, init) => app.request(new Request(url, init)),
			}),
		],
	});
}
type Researcher = ReturnType<typeof researcherFor>;

async function projectWithScope(
	researcher: Researcher,
	scope: { queries: string[]; sources: string[] },
) {
	const project = await researcher.projects.create.mutate({
		title: "arXiv freshness",
	});
	await researcher.projects.saveBrief.mutate({
		id: project.id,
		expectedRevision: 1,
		brief: { ...project.brief, topic: "Tabular transfer learning" },
	});
	const current = await researcher.literature.scope.query({
		projectId: project.id,
	});
	await researcher.literature.saveScope.mutate({
		projectId: project.id,
		expectedRevision: current.revision,
		scope: {
			...current.scope,
			dateFrom: "2021-01-01",
			dateTo: "2026-06-30",
			includeFoundations: false,
			...scope,
		},
	});
	return project.id;
}
async function saveSources(
	researcher: Researcher,
	projectId: string,
	sources: string[],
) {
	const current = await researcher.literature.scope.query({ projectId });
	await researcher.literature.saveScope.mutate({
		projectId,
		expectedRevision: current.revision,
		scope: { ...current.scope, sources },
	});
}
async function search(researcher: Researcher, projectId: string) {
	const scope = await researcher.literature.scope.query({ projectId });
	const job = await researcher.literature.submitSearch.mutate({
		projectId,
		scopeRevision: scope.revision,
		idempotencyKey: randomUUID(),
		queries: scope.scope.queries,
	});
	return job.id;
}
async function outcome(
	researcher: Researcher,
	projectId: string,
	jobId: string,
) {
	const job = await researcher.literature.job.query({ projectId, jobId });
	const snapshot = job.snapshotId
		? await researcher.literature.snapshot.query({
				projectId,
				snapshotId: job.snapshotId,
			})
		: null;
	return {
		job,
		snapshot,
		source: (id: string) => job.sources.find((s) => s.source === id),
	};
}

/** Worker options whose provider adapters answer through one recording fetch and record waits. */
function providerWorker(handler: Parameters<typeof openAlexFetch>[0]) {
	const recorder = openAlexFetch(handler);
	const sleeps: number[] = [];
	const clock = { now: new Date() };
	const now = () => clock.now;
	const options: Partial<LiteratureWorkerOptions> = {
		...settings,
		now,
		sleep: async (milliseconds) => {
			sleeps.push(milliseconds);
		},
		sources: {
			...literatureSources,
			openalex: createOpenAlexSource({
				apiKey: "test-openalex-key",
				fetch: recorder.fetch,
				now,
			}),
			arxiv: createArxivSource({ fetch: recorder.fetch, now }),
		},
	};
	return {
		options,
		calls: recorder.calls,
		sleeps,
		advance: (seconds: number) => {
			clock.now = new Date(clock.now.getTime() + seconds * 1000);
		},
	};
}

scenario(
	"an arXiv search keeps effective queries, versions, dates, DOI links and abstract availability, one paced request at a time",
	async (workspace) => {
		const researcher = researcherFor(
			workspace,
			await workspace.signIn("arxiv-journey"),
		);
		const projectId = await projectWithScope(researcher, {
			queries: ["tabular transfer (learning)", "arXiv:2206.15306"],
			sources: ["arxiv"],
		});
		const page = (from: number, count: number) =>
			Array.from({ length: count }, (_, i) =>
				arxivEntry(`2401.${String(from + i).padStart(5, "0")}`),
			);
		const worker = providerWorker((url) => {
			if (url.searchParams.get("id_list"))
				return atom(
					arxivFeed([
						arxivEntry("2206.15306", {
							version: 2,
							title: "Transfer Learning with Deep\n      Tabular Models",
							published: "2022-06-30T14:24:32Z",
							updated: "2023-08-07T04:07:06Z",
							journalRef:
								"International Conference on Learning Representations (ICLR), 2023",
							doi: "10.1234/Published.15306",
						}),
					]),
				);
			const start = Number(url.searchParams.get("start"));
			const count = Number(url.searchParams.get("max_results"));
			return atom(arxivFeed(page(start, count), 420, start));
		});

		const jobId = await search(researcher, projectId);
		await workspace.runQueuedJobs(worker.options);
		const run = await outcome(researcher, projectId, jobId);
		expect(run.job.state).toBe("succeeded");
		expect(run.source("arxiv")).toMatchObject({
			label: "arXiv",
			status: "succeeded",
			attempts: 1,
			allocation: 160,
			reportedCount: 421,
			receivedCount: 160,
			truncated: true,
			cursor: JSON.stringify([159]),
			errorClass: null,
			unsupportedFilters: [],
			appliedFilters: [
				"all:tabular AND all:transfer AND all:learning AND submittedDate:[202101010000 TO 202606302359]",
				"arXiv identifiers looked up directly (id_list) without the date filter",
			],
		});

		expect(
			worker.calls.map(({ url }) => [
				url.origin + url.pathname,
				url.searchParams.get("search_query"),
				url.searchParams.get("id_list"),
				url.searchParams.get("start"),
				url.searchParams.get("max_results"),
			]),
		).toEqual([
			["https://export.arxiv.org/api/query", null, "2206.15306", null, "1"],
			[
				"https://export.arxiv.org/api/query",
				"all:tabular AND all:transfer AND all:learning AND submittedDate:[202101010000 TO 202606302359]",
				null,
				"0",
				"100",
			],
			[
				"https://export.arxiv.org/api/query",
				"all:tabular AND all:transfer AND all:learning AND submittedDate:[202101010000 TO 202606302359]",
				null,
				"100",
				"59",
			],
		]);
		// arXiv allows one request every three seconds across the deployment.
		expect(worker.sleeps.filter((ms) => ms === 3_000)).toHaveLength(2);

		const snapshot = run.snapshot;
		expect(snapshot?.paperCount).toBe(160);
		expect(
			snapshot?.papers.find((p) => p.acquisitionReason === "direct-lookup"),
		).toEqual(
			expect.objectContaining({
				title: "Transfer Learning with Deep Tabular Models",
				authors: ["Ada Record", "Ben Sample"],
				year: 2022,
				publicationDate: "2022-06-30",
				doi: "10.48550/arxiv.2206.15306",
				identifiers: ["doi:10.48550/arxiv.2206.15306", "arxiv:2206.15306"],
				url: "https://arxiv.org/abs/2206.15306v2",
				preprint: true,
				workType: "preprint",
				abstractAvailable: true,
				version: "v2",
				versionDate: "2023-08-07",
				relatedVersions: [
					{
						identifier: "doi:10.1234/published.15306",
						relation: "published-version",
						note: "International Conference on Learning Representations (ICLR), 2023",
						paperId: null,
					},
				],
				source: "arxiv",
			}),
		);
		expect(
			snapshot?.papers.find((p) => p.title === "Recorded preprint 2401.00000"),
		).toEqual(
			expect.objectContaining({
				version: "v1",
				relatedVersions: [],
				acquisitionReason: "discovery",
			}),
		);
	},
);

scenario(
	"OpenAlex and arXiv share the record cap, reconcile exact identifiers with every source's observation, and link preprints to published versions without merging them",
	async (workspace) => {
		const researcher = researcherFor(
			workspace,
			await workspace.signIn("arxiv-openalex"),
		);
		const projectId = await projectWithScope(researcher, {
			queries: ["tabular transfer learning"],
			sources: ["openalex", "arxiv"],
		});
		const worker = providerWorker((url) =>
			url.hostname === "api.openalex.org"
				? json(
						openAlexPage([
							openAlexWork(1),
							openAlexWork(2, {
								doi: "https://doi.org/10.48550/arXiv.2401.00001",
								ids: { openalex: "https://openalex.org/W2" },
								type: "preprint",
								display_name: "OpenAlex's title for the preprint",
							}),
						]),
					)
				: atom(
						arxivFeed([
							arxivEntry("2401.00001", { version: 3 }),
							arxivEntry("2401.00002", { doi: "10.1234/Recorded.1" }),
						]),
					),
		);
		const jobId = await search(researcher, projectId);
		await workspace.runQueuedJobs(worker.options);
		const { snapshot, source } = await outcome(researcher, projectId, jobId);
		expect(source("openalex")?.allocation).toBe(160);
		expect(source("arxiv")?.allocation).toBe(40);
		expect(snapshot?.allocations).toEqual({
			reserved: 0,
			sources: [
				{ source: "openalex", allocation: 160, kept: { discovery: 2 } },
				{ source: "arxiv", allocation: 40, kept: { discovery: 1 } },
			],
		});
		expect(snapshot?.paperCount).toBe(3);

		const preprint = snapshot?.papers.find((p) =>
			p.identifiers.includes("arxiv:2401.00001"),
		);
		expect(preprint).toMatchObject({
			source: "openalex",
			title: "OpenAlex's title for the preprint",
			alsoObserved: [
				{
					source: "arxiv",
					title: "Recorded preprint 2401.00001",
					version: "v3",
					url: "https://arxiv.org/abs/2401.00001v3",
					identifiers: ["doi:10.48550/arxiv.2401.00001", "arxiv:2401.00001"],
				},
			],
		});
		const journal = snapshot?.papers.find(
			(p) => p.title === "Recorded work W1",
		);
		const laterPreprint = snapshot?.papers.find((p) =>
			p.identifiers.includes("arxiv:2401.00002"),
		);
		expect(laterPreprint?.id).not.toBe(journal?.id);
		expect(laterPreprint?.relatedVersions).toEqual([
			{
				identifier: "doi:10.1234/recorded.1",
				relation: "published-version",
				note: null,
				paperId: journal?.id,
			},
		]);
	},
);

scenario(
	"a newer arXiv version is a new observation of the same paper and never rewrites the version an earlier snapshot recorded",
	async (workspace) => {
		const researcher = researcherFor(
			workspace,
			await workspace.signIn("arxiv-versions"),
		);
		const projectId = await projectWithScope(researcher, {
			queries: ["2402.00001"],
			sources: ["arxiv"],
		});
		let latest = arxivEntry("2402.00001", { title: "First title" });
		const worker = providerWorker(() => atom(arxivFeed([latest])));
		const run = async () => {
			const jobId = await search(researcher, projectId);
			await workspace.runQueuedJobs(worker.options);
			return (await outcome(researcher, projectId, jobId)).snapshot;
		};
		const first = await run();

		latest = arxivEntry("2402.00001", {
			version: 2,
			title: "Revised title",
			updated: "2026-09-01T09:00:00Z",
			doi: "10.1234/Journal.2402",
		});
		worker.advance(2 * 24 * 60 * 60);
		const second = await run();
		expect(worker.calls).toHaveLength(2);
		expect(second?.papers).toEqual([
			expect.objectContaining({
				id: first?.papers[0]?.id,
				title: "Revised title",
				version: "v2",
				versionDate: "2026-09-01",
				relatedVersions: [
					expect.objectContaining({ identifier: "doi:10.1234/journal.2402" }),
				],
			}),
		]);
		const reread = await researcher.literature.snapshot.query({
			projectId,
			snapshotId: first?.id ?? "",
		});
		expect(reread.papers).toEqual([
			expect.objectContaining({
				title: "First title",
				version: "v1",
				url: "https://arxiv.org/abs/2402.00001v1",
				relatedVersions: [],
			}),
		]);
	},
);

scenario(
	"arXiv requests from concurrent workers never overlap, and a long provider pause stops every project's arXiv search without a request",
	async (workspace) => {
		const researcher = researcherFor(
			workspace,
			await workspace.signIn("arxiv-throttle"),
		);
		let inFlight = 0;
		let mostInFlight = 0;
		let busy = false;
		const worker = providerWorker(async () => {
			inFlight++;
			mostInFlight = Math.max(mostInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 150));
			inFlight--;
			return busy
				? new Response("Rate exceeded.", {
						status: 503,
						headers: { "retry-after": "600" },
					})
				: atom(arxivFeed([arxivEntry("2403.00001")]));
		});
		const first = await projectWithScope(researcher, {
			queries: ["calibration shift", "label noise"],
			sources: ["arxiv"],
		});
		const second = await projectWithScope(researcher, {
			queries: ["domain adaptation", "tabular benchmarks"],
			sources: ["arxiv"],
		});
		await search(researcher, first);
		await search(researcher, second);
		await Promise.all([
			workspace.runNextJob(worker.options),
			workspace.runNextJob(worker.options),
		]);
		expect(worker.calls).toHaveLength(4);
		expect(mostInFlight).toBe(1);

		busy = true;
		worker.advance(2 * 24 * 60 * 60);
		const refused = await search(researcher, first);
		await workspace.runQueuedJobs(worker.options);
		// A cached answer from two days ago is labelled stale rather than waiting ten minutes.
		expect(
			(await outcome(researcher, first, refused)).source("arxiv"),
		).toMatchObject({
			status: "partial",
			attempts: 1,
			errorClass: "stale-cache",
			cacheAgeSeconds: 2 * 24 * 60 * 60,
		});
		expect(worker.calls).toHaveLength(5);

		await saveSources(researcher, second, ["arxiv", "fixture-catalog"]);
		const paused = await search(researcher, second);
		await workspace.runQueuedJobs(worker.options);
		const during = await outcome(researcher, second, paused);
		expect(during.job.state).toBe("succeeded");
		expect(during.source("arxiv")).toMatchObject({
			status: "failed",
			attempts: 0,
			errorClass: "rate-limited",
		});
		expect(during.snapshot?.coverage).toBe("partial");
		expect(worker.calls).toHaveLength(5);
	},
);
