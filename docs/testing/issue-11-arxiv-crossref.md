# arXiv freshness and Crossref status reconciliation

Issue #11 adds arXiv as a **Literature Scope** source and a Crossref publication-status stage on top of the #10 OpenAlex contract (`docs/testing/issue-10-openalex.md`). Semantic Scholar stays disabled.

## What the providers document (checked 28 September 2026)

- **arXiv API** ([user manual](https://info.arxiv.org/help/api/user-manual.html), [terms](https://info.arxiv.org/help/api/tou.html)). `GET https://export.arxiv.org/api/query` with `search_query` (field prefixes such as `all:`, `submittedDate:[YYYYMMDDTTTT TO YYYYMMDDTTTT]`) or `id_list`, `start` and `max_results`. Answers are Atom feeds: entry `id` carries the version (`…/abs/2206.15306v2`), `published` is version 1, `updated` is this version, and optional `arxiv:doi`, `arxiv:journal_ref` and `arxiv:comment`. Terms: "no more than one request every three seconds, and limit requests to a single connection at a time", across every machine a deployment controls. Metadata is CC0; e-prints are not redistributable. A malformed query still answers 200 with an empty feed.
- **Crossref REST API** ([access and authentication](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/), [Retraction Watch](https://www.crossref.org/documentation/retrieve-metadata/retraction-watch/)). `GET https://api.crossref.org/works/{doi}` is free. Since 21 July 2026 single-record requests allow 5/s in the public pool and 10/s in the polite pool (join with `mailto`); a live answer carried `x-rate-limit-limit: 10`, `x-rate-limit-interval: 1s`, `x-concurrency-limit: 3`, `x-api-pool: polite-single`. Corrections and retractions appear on the original work as `updated-by` entries with `type`, `label`, `source` (`publisher` or `retraction-watch`), notice `DOI` and `updated`. arXiv's DataCite DOIs (`10.48550/…`) answer 404. Too many requests answer 429.

Not documented, therefore assumed: that arXiv signals throttling with 429/503 and `Retry-After`, and that a withdrawn arXiv version says "withdrawn" in its comment (arXiv has no status field).

## Behaviour

- **arXiv source.** Free (`routes: []`), no quota. A query that is exactly an arXiv identifier, abstract URL or arXiv DOI is looked up with `id_list` outside the date window (`direct-lookup`); other queries become `all:word AND … AND submittedDate:[… TO …]`, words lowercased so none is read as an operator, sorted by relevance, 100 per page until the query's share is filled. The effective expression is listed under *Filters applied*. Records key on `arxiv:<id>`, alias `doi:10.48550/arxiv.<id>` (which is how OpenAlex's arXiv records reconcile), keep `version`/`versionDate`, and a published-version DOI from `arxiv:doi` as a **related version**, never an alias. A "withdrawn" comment becomes a withdrawal update. Abstracts are not stored; answers are cached like OpenAlex's.
- **Pacing.** A source with `minIntervalSeconds` (arXiv: 3) makes each request inside a transaction holding an advisory lock, after waiting until `source_throttle.paused_until`, which it then pushes three seconds past the request. So one arXiv connection is open at a time across every worker. Long `Retry-After` pauses use the same row, as with OpenAlex.
- **Allocation.** With other sources, arXiv takes the 40-record reserve and the others split 160; arXiv alone gets 160 and the 40 stay unallocated. `allocations.reserved` reports what is unallocated.
- **Provenance.** When records reconcile by exact identifier, the later sources' observations are kept in `snapshot_paper.also_observed`. Related versions resolve to a paper ID only within the same snapshot.
- **Crossref stage.** After retrieval the job enters `reconciling`. Each kept DOI Crossref registers is looked up unless a status confirmed in the last 24 hours exists. Lookups are 0.2 s apart and stop at the first failure; a 429 writes a shared pause. Answers become revisions in `publication_status` (keyed by DOI, public): a changed answer adds a revision, the same answer moves `checked_at`. The worker's `CROSSREF_MAILTO` joins the polite pool.
- **Snapshots.** `snapshot_paper.status_check` freezes what was known at publish; `literature_snapshot.status_check` summarises checked, not registered and unknown DOIs with the error class. The view derives `publicationStatus`: retracted/withdrawn/removed → `positiveSupport: "disallowed"`; concern/corrected/other notices → `"review"`; no DOI, not covered, not registered, not run or failed → `unknown`, never clearance. `newerStatusKnown` says a later revision exists without rewriting the snapshot. Crossref `has-preprint`/`is-preprint-of` relations join the related versions.
- **Possible matches.** Papers without a shared identifier whose normalised titles match, years differ by at most one and which share an author family name are stored in `paper_match` for the project. `literature.decideMatch` records *same work* or *different works* with an expected revision; it never merges, re-aliases or changes snapshot membership. Project cleanup deletes them.

## Environments

| Process | Added variables |
| --- | --- |
| Worker (`apps/worker/.env.schema`) | `CROSSREF_MAILTO` (optional email). Without it lookups use Crossref's public pool. |

Migrations `20260928181920_arxiv_versions`, `20260928184706_publication_status` and `20260928185300_paper_match` add `snapshot_paper.also_observed`, `publication_status`, the two `status_check` columns and `paper_match`. Apply with `pnpm db:migrate` before deploying the worker and API.

## Tests

`apps/server/tests/arxiv-crossref.test.ts` drives the real API, queue and worker with arXiv, OpenAlex and Crossref adapters over one injected recording `fetch` (`arxiv-fixture.ts`, `crossref-fixture.ts`, `openalex-fixture.ts`). No test reaches the network. Scenarios: an arXiv search with lookups, paging, versions and pacing; OpenAlex with arXiv sharing the cap, reconciling by DOI and linking a published version; a newer arXiv version leaving an earlier snapshot unchanged; concurrent workers never overlapping arXiv requests, with a shared long pause; Crossref retractions, corrections, withdrawals, not-registered and no-DOI papers, 24-hour reuse and a later status change; Crossref outages, rate limits and a worker without a status source; possible matches and the researcher's decision, including isolation and conflicts. The OpenAlex and #9 suites now also list arXiv in the catalogue.

## Live checks

See `docs/operations/arxiv-crossref-runbook.md`. They are never part of `pnpm test`.
