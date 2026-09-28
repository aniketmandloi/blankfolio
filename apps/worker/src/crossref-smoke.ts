import { createCrossrefStatus } from "@blankfolio/api/crossref";

import { ENV } from "./env.server";

// Run by an operator only: `pnpm --filter worker crossref:smoke`. It makes one free lookup of a
// DOI whose record lists a retraction, through the worker's adapter and `CROSSREF_MAILTO`.
const doi = process.argv[2] ?? "10.1016/s0140-6736(97)11096-0";

const answer = await createCrossrefStatus({
	mailto: ENV.CROSSREF_MAILTO,
}).lookup(doi);
console.log(
	JSON.stringify(
		{ doi, pool: ENV.CROSSREF_MAILTO ? "polite" : "public", answer },
		null,
		2,
	),
);
const ok =
	answer.outcome === "checked" &&
	(process.argv[2] !== undefined ||
		answer.updates.some((update) => update.type === "retraction"));
console.log(ok ? "crossref_smoke_passed" : "crossref_smoke_failed");
if (!ok) process.exitCode = 1;
