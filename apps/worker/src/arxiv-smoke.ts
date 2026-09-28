import { createArxivSource } from "@blankfolio/api/arxiv";

// Run by an operator only: `pnpm --filter worker arxiv:smoke`. It makes one free identifier
// lookup through the worker's adapter, parsing and mapping; run it once, not in a loop, since
// arXiv allows one request every three seconds for the whole deployment.
const id = process.argv[2] ?? "1706.03762";
const today = new Date().toISOString().slice(0, 10);

const result = await createArxivSource({}).search({
	queries: [id],
	dateFrom: today,
	dateTo: today,
	includeFoundations: false,
	limit: 1,
	attempt: 1,
	finalAttempt: true,
	routes: [],
	cache: { get: async () => null, set: async () => undefined },
	pace: (request) => request(),
});
const [record] = result.records;
console.log(
	JSON.stringify(
		{
			outcome: result.outcome,
			reportedCount: result.reportedCount,
			errorClass: result.errorClass,
			record: record && {
				title: record.title,
				identifiers: record.identifiers,
				version: record.version,
				versionDate: record.versionDate,
				publicationDate: record.publicationDate,
				relatedVersions: record.relatedVersions,
				updates: record.updates,
				abstractAvailable: record.abstractAvailable,
				url: record.url,
				authors: record.authors.length,
			},
		},
		null,
		2,
	),
);
const ok =
	result.outcome === "succeeded" &&
	record?.identifiers?.includes(`arxiv:${id.toLowerCase()}`) === true &&
	record.version !== null;
console.log(ok ? "arxiv_smoke_passed" : "arxiv_smoke_failed");
if (!ok) process.exitCode = 1;
