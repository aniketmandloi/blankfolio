import { checkOpenAlexWork } from "@blankfolio/api/openalex";

import { ENV } from "./env.server";

// Run by an operator only: `pnpm --filter worker openalex:smoke`. It makes one request to
// OpenAlex's singleton endpoint, which OpenAlex lists as free, and never searches.
const workId = process.argv[2] ?? "W2741809807";

if (!ENV.OPENALEX_API_KEY) {
	console.error("Set OPENALEX_API_KEY in apps/worker/.env first.");
	process.exitCode = 1;
} else {
	const { status, rateLimit, record, references } = await checkOpenAlexWork({
		apiKey: ENV.OPENALEX_API_KEY,
		id: workId,
	});
	console.log(
		JSON.stringify(
			{
				status,
				rateLimit,
				record: record && {
					title: record.title,
					identifiers: record.identifiers,
					publicationDate: record.publicationDate,
					workType: record.workType,
					preprint: record.preprint,
					abstractAvailable: record.abstractAvailable,
					sourceUpdatedAt: record.sourceUpdatedAt,
					url: record.url,
					authors: record.authors.length,
					references,
				},
			},
			null,
			2,
		),
	);
	const ok =
		status === 200 &&
		record !== null &&
		Object.values(rateLimit).some((value) => value !== null);
	console.log(ok ? "openalex_smoke_passed" : "openalex_smoke_failed");
	if (!ok) process.exitCode = 1;
}
