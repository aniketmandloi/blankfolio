import { randomUUID } from "node:crypto";
import {
	literatureSources,
	type SourceSettings,
} from "@blankfolio/api/literature-sources";
import type { LiteratureWorkerOptions } from "@blankfolio/api/literature-worker";
import { createOpenAlexSource } from "@blankfolio/api/openalex";
import type { AppRouter } from "@blankfolio/api/routers/index";
import { createTRPCClient, httpLink } from "@trpc/client";
import { expect, test } from "vitest";
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

/** OpenAlex's published list prices: $1 per 1,000 searches and $0.10 per 1,000 list/filter calls. */
const openAlexSettings: SourceSettings = {
	prices: {
		...fixturePrices,
		"openalex-search": 1_000,
		"openalex-filter": 100,
	},
	quotas: { openalex: 1_000_000 },
};
const apiKey = "test-openalex-key";

function researcherFor(
	workspace: Workspace,
	cookie: string,
	settings = openAlexSettings,
) {
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
	scope: {
		queries: string[];
		sources?: string[];
		includeFoundations?: boolean;
	},
) {
	const project = await researcher.projects.create.mutate({
		title: "OpenAlex discovery",
	});
	await researcher.projects.saveBrief.mutate({
		id: project.id,
		expectedRevision: 1,
		brief: { ...project.brief, topic: "Tabular transfer learning" },
	});
	await saveScope(researcher, project.id, scope);
	return project.id;
}
async function saveScope(
	researcher: Researcher,
	projectId: string,
	scope: {
		queries: string[];
		sources?: string[];
		includeFoundations?: boolean;
	},
) {
	const current = await researcher.literature.scope.query({ projectId });
	return researcher.literature.saveScope.mutate({
		projectId,
		expectedRevision: current.revision,
		scope: {
			...current.scope,
			dateFrom: "2021-01-01",
			dateTo: "2026-06-30",
			sources: ["openalex"],
			includeFoundations: false,
			...scope,
		},
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
		openalex: job.sources.find((s) => s.source === "openalex"),
	};
}
const spent = async (researcher: Researcher, projectId: string) =>
	(await researcher.literature.budget.query({ projectId }))
		.projectCommittedMicros;

/** Worker options with an OpenAlex adapter over a recording fetch and a movable clock. */
function openAlexWorker(
	handler: Parameters<typeof openAlexFetch>[0],
	settings = openAlexSettings,
) {
	const recorder = openAlexFetch(handler);
	const clock = { now: new Date() };
	const now = () => clock.now;
	const options: Partial<LiteratureWorkerOptions> = {
		...settings,
		now,
		sources: {
			...literatureSources,
			openalex: createOpenAlexSource({ apiKey, fetch: recorder.fetch, now }),
		},
	};
	return {
		options,
		calls: recorder.calls,
		advance: (seconds: number) => {
			clock.now = new Date(clock.now.getTime() + seconds * 1000);
		},
	};
}

scenario(
	"an OpenAlex search keeps provenance, identifiers, dates, preprint status and evidence availability, adds cited older work and direct lookups, and reuses allowed cache",
	async (workspace) => {
		const researcher = researcherFor(
			workspace,
			await workspace.signIn("openalex-journey"),
		);
		const arxivDoi = "https://doi.org/10.48550/arXiv.1706.03762";
		const projectId = await projectWithScope(researcher, {
			queries: ["tabular transfer learning", arxivDoi],
			includeFoundations: true,
		});
		let doiForW3: string | null = null;
		const discovery = (from: number, to: number) =>
			Array.from({ length: to - from + 1 }, (_, i) => {
				const n = from + i;
				if (n === 1)
					return openAlexWork(1, {
						referenced_works: [
							"https://openalex.org/W8001",
							"https://openalex.org/W8002",
						],
					});
				if (n === 2)
					return openAlexWork(2, {
						referenced_works: [
							"https://openalex.org/W8001",
							"https://openalex.org/W8003",
							"https://openalex.org/W5",
						],
					});
				if (n === 3)
					return openAlexWork(3, {
						doi: doiForW3,
						ids: { openalex: "https://openalex.org/W3" },
						type: "preprint",
						primary_location: {
							landing_page_url: "javascript:alert(1)",
							pdf_url: null,
							version: "submittedVersion",
							is_oa: true,
							source: { display_name: "SSRN", type: "repository" },
						},
					});
				if (n === 4 || n === 5)
					return openAlexWork(n, {
						doi: null,
						ids: { openalex: `https://openalex.org/W${n}` },
						display_name: "A shared title for two distinct works",
						title: "A shared title for two distinct works",
					});
				if (n === 6)
					return openAlexWork(6, {
						abstract_inverted_index: null,
						type: null,
						primary_location: null,
					});
				return openAlexWork(n);
			});
		const worker = openAlexWorker((url) => {
			const filter = url.searchParams.get("filter") ?? "";
			if (filter.startsWith("doi:"))
				return json(
					openAlexPage([
						openAlexWork(9001, {
							doi: arxivDoi,
							ids: { openalex: "https://openalex.org/W9001", doi: arxivDoi },
							display_name: "Attention Is All You Need",
							title: "Attention Is All You Need",
							publication_year: 2017,
							publication_date: "2017-06-12",
							type: "preprint",
							primary_location: {
								landing_page_url: "https://arxiv.org/abs/1706.03762",
								pdf_url: "https://arxiv.org/pdf/1706.03762",
								version: "submittedVersion",
								is_oa: true,
								source: { display_name: "arXiv", type: "repository" },
							},
							abstract_inverted_index: null,
							referenced_works: ["https://openalex.org/W8001"],
						}),
					]),
				);
			if (filter.startsWith("openalex:"))
				return json(
					openAlexPage([
						openAlexWork(8003, { publication_year: 2012 }),
						openAlexWork(8001, { publication_year: 1998 }),
						openAlexWork(8002, { publication_year: 2005 }),
					]),
				);
			if (url.searchParams.get("cursor") === "*")
				return json(openAlexPage(discovery(1, 100), 250, "cursor-2"));
			if (url.searchParams.get("cursor") === "cursor-2")
				return json(openAlexPage(discovery(101, 119), 250, "cursor-3"));
			return new Response("unexpected", { status: 500 });
		});

		const first = await search(researcher, projectId);
		await workspace.runQueuedJobs(worker.options);
		const run1 = await outcome(researcher, projectId, first);
		expect(run1.job).toMatchObject({ state: "succeeded" });
		expect(run1.openalex).toMatchObject({
			label: "OpenAlex",
			status: "succeeded",
			attempts: 1,
			allocation: 160,
			effectiveQueries: ["tabular transfer learning", arxivDoi],
			reportedCount: 254,
			receivedCount: 123,
			truncated: true,
			cursor: JSON.stringify(["cursor-3"]),
			cacheAgeSeconds: null,
			errorClass: null,
			unsupportedFilters: [],
		});
		expect(run1.openalex?.appliedFilters).toEqual([
			"from_publication_date:2021-01-01,to_publication_date:2026-06-30 on search queries",
			"identifier queries looked up directly (doi: or openalex: filter) without the date filter",
			"older foundational work: works cited by the top 25 results, to_publication_date:2020-12-31",
		]);

		// The key travels only in the Authorization header, never in a URL that could be logged.
		expect(worker.calls).toHaveLength(4);
		for (const call of worker.calls) {
			expect(call.authorization).toBe(`Bearer ${apiKey}`);
			expect(call.url.href).not.toContain(apiKey);
			expect(call.url.origin + call.url.pathname).toBe(
				"https://api.openalex.org/works",
			);
		}
		const [lookup, page1, page2, citations] = worker.calls.map((c) => c.url);
		expect(lookup?.searchParams.get("filter")).toBe(
			"doi:10.48550/arxiv.1706.03762",
		);
		expect(
			[page1, page2].map((url) => [
				url?.searchParams.get("search"),
				url?.searchParams.get("filter"),
				url?.searchParams.get("per_page"),
				url?.searchParams.get("cursor"),
			]),
		).toEqual([
			[
				"tabular transfer learning",
				"from_publication_date:2021-01-01,to_publication_date:2026-06-30",
				"100",
				"*",
			],
			[
				"tabular transfer learning",
				"from_publication_date:2021-01-01,to_publication_date:2026-06-30",
				"19",
				"cursor-2",
			],
		]);
		expect(citations?.searchParams.get("filter")).toBe(
			"openalex:W8001|W8002|W8003,to_publication_date:2020-12-31",
		);
		// Two search pages at $0.001 and two filter calls at $0.0001.
		expect(await spent(researcher, projectId)).toBe(2_200);

		const snapshot = run1.snapshot;
		expect(snapshot?.paperCount).toBe(123);
		expect(snapshot?.allocations).toEqual({
			reserved: 40,
			sources: [
				{
					source: "openalex",
					allocation: 160,
					kept: { "direct-lookup": 1, discovery: 119, citation: 3 },
				},
			],
		});
		const byTitle = (title: string) =>
			snapshot?.papers.filter((p) => p.title === title) ?? [];
		expect(byTitle("Attention Is All You Need")).toEqual([
			expect.objectContaining({
				year: 2017,
				publicationDate: "2017-06-12",
				doi: "10.48550/arxiv.1706.03762",
				identifiers: [
					"doi:10.48550/arxiv.1706.03762",
					"openalex:W9001",
					"arxiv:1706.03762",
				],
				url: "https://arxiv.org/abs/1706.03762",
				preprint: true,
				workType: "preprint",
				abstractAvailable: false,
				acquisitionReason: "direct-lookup",
				source: "openalex",
			}),
		]);
		expect(byTitle("Recorded work W1")).toEqual([
			expect.objectContaining({
				authors: ["Ada Record", "Ben Sample"],
				doi: "10.1234/recorded.1",
				identifiers: ["doi:10.1234/recorded.1", "openalex:W1"],
				url: "https://publisher.example/articles/1",
				preprint: false,
				abstractAvailable: true,
				sourceUpdatedAt: "2026-09-20T04:11:52.123456",
				acquisitionReason: "discovery",
			}),
		]);
		expect(byTitle("Recorded work W3")).toEqual([
			expect.objectContaining({
				doi: null,
				identifiers: ["openalex:W3"],
				url: "https://openalex.org/W3",
				preprint: true,
			}),
		]);
		expect(byTitle("Recorded work W6")).toEqual([
			expect.objectContaining({
				preprint: null,
				workType: null,
				abstractAvailable: false,
				url: "https://doi.org/10.1234/recorded.6",
			}),
		]);
		// Identical titles without a shared identifier stay separate papers.
		expect(byTitle("A shared title for two distinct works")).toHaveLength(2);
		expect(
			snapshot?.papers
				.filter((p) => p.acquisitionReason === "citation")
				.map((p) => [p.title, p.year]),
		).toEqual([
			["Recorded work W8001", 1998],
			["Recorded work W8003", 2012],
			["Recorded work W8002", 2005],
		]);

		// Within a day the same requests are answered from the project's cache at no cost.
		worker.advance(2 * 60 * 60);
		const cachedRun = await outcome(
			researcher,
			projectId,
			await search(researcher, projectId).then(async (id) => {
				await workspace.runQueuedJobs(worker.options);
				return id;
			}),
		);
		expect(worker.calls).toHaveLength(4);
		expect(cachedRun.openalex).toMatchObject({
			status: "succeeded",
			receivedCount: 123,
			cacheAgeSeconds: 7_200,
		});
		expect(await spent(researcher, projectId)).toBe(2_200);

		// A later observation adds a DOI; the paper is matched by its OpenAlex ID, and the
		// earlier snapshot keeps what it observed.
		doiForW3 = "https://doi.org/10.1234/Published.3";
		worker.advance(30 * 60 * 60);
		const refreshed = await outcome(
			researcher,
			projectId,
			await search(researcher, projectId).then(async (id) => {
				await workspace.runQueuedJobs(worker.options);
				return id;
			}),
		);
		expect(worker.calls).toHaveLength(8);
		expect(refreshed.openalex?.cacheAgeSeconds).toBeNull();
		const w3 = (s: typeof snapshot) =>
			s?.papers.find((p) => p.title === "Recorded work W3");
		expect(w3(refreshed.snapshot)).toMatchObject({
			id: w3(snapshot)?.id,
			doi: "10.1234/published.3",
			identifiers: ["doi:10.1234/published.3", "openalex:W3"],
		});
		expect(
			w3(
				await researcher.literature.snapshot.query({
					projectId,
					snapshotId: snapshot?.id ?? "",
				}),
			),
		).toMatchObject({ doi: null, identifiers: ["openalex:W3"] });
		expect(refreshed.snapshot?.papers.map((p) => p.id).sort()).toEqual(
			snapshot?.papers.map((p) => p.id).sort(),
		);
	},
);
