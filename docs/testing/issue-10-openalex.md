# OpenAlex discovery

Issue #10 adds OpenAlex as a real **Literature Scope** source on top of the #9 source contract (`docs/testing/issue-9-literature-search.md`). The API, queue, checkpoints, budgets and snapshots are unchanged in shape; a source now declares priced routes, reports usage per route, and may need a deployment-wide daily quota.

## What OpenAlex's documentation says (checked 28 September 2026)

From [help.openalex.org](https://help.openalex.org/) (docs.openalex.org and developers.openalex.org now redirect there). Provider terms change; re-check before enabling the pilot.

- **Authentication.** An API key from `openalex.org/settings/api`, sent as `?api_key=` or `Authorization: Bearer`. The `mailto` polite pool ended in February 2026: "The `mailto` parameter is ignored" and "All users need an API key" ([deprecations](https://help.openalex.org/api/deprecations/), [authentication](https://help.openalex.org/api/authentication/)).
- **Pricing.** Keyless use gets $0.10/day, a free key $1/day, then prepaid pay-as-you-go; budgets reset at midnight UTC. Get single entity: free. List + filter: $0.10 per 1,000 calls. Search: $1 per 1,000 calls. Content (PDF) download: $10 per 1,000 ([pricing](https://help.openalex.org/access/pricing/), [example costs](https://help.openalex.org/access/example-costs/)).
- **Limits and errors.** More than 100 requests/second or an exhausted daily budget returns `429`. Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Credits-Used` and `X-RateLimit-Reset` (seconds until reset); no `Retry-After` is documented. Retry 429/5xx with backoff, not other 4xx; use 30-second timeouts ([errors](https://help.openalex.org/api/errors/)).
- **Paging and filters.** `per_page` max 100; cursor paging starts at `cursor=*` and ends when `meta.next_cursor` is null. Filters combine with `,` (AND) and `|` (OR, up to 100 values); `from_publication_date`, `to_publication_date`, `doi:`, `openalex:`, `cites:` and `cited_by:` exist; the whole URL is limited to about 4 KB. `select` takes top-level fields only.
- **Data.** Work objects carry `id`, `doi`, `ids`, `display_name`, `publication_date`/`year`, `type` (including `preprint`), `primary_location.version` (`submittedVersion`/`acceptedVersion`/`publishedVersion`), `authorships`, `abstract_inverted_index`, `referenced_works` (OpenAlex IDs the work cites) and `updated_date`. OpenAlex data are CC0, so responses may be cached; text fields pass through from sources unsanitised.

Not documented, therefore assumed and conservative: whether a `429`/`5xx`/timed-out request is billed. The adapter treats refusals (`429`, `5xx`, other `4xx`) as unbilled and a timeout or network failure as billed.

## Behaviour

- **Routes and prices.** `openalex-search` (search pages, required) and `openalex-filter` (direct identifier lookups and the older-work expansion, optional). `LITERATURE_SOURCE_PRICES` holds USD per request per route, e.g. `{"openalex-search":0.001,"openalex-filter":0.0001}`. Without a search price or without a quota OpenAlex is disabled with a precise message and other sources keep working; without a filter price only lookups and older work are skipped and listed as unsupported.
- **Deployment-wide quota.** `LITERATURE_SOURCE_QUOTAS`, e.g. `{"openalex":1}`, in USD per UTC day. Each attempt reserves its maximum charge in `usage_reservation` under the existing advisory lock; the reservation is refused when the monthly budgets **or** OpenAlex's committed spend since midnight UTC (every project, every worker) would exceed it. A refused reservation fails the source as `quota-exhausted` without a request.
- **Throttling.** A `429` whose reset is longer than 60 seconds, or a successful answer with `X-RateLimit-Remaining: 0`, writes `source_throttle.paused_until`. Every worker checks it before each attempt: a long pause fails the source as `rate-limited` with no request and no reservation. Shorter waits back off in-process. Two global runs with sequential requests stay far below 100 requests/second.
- **Search plan per attempt.** Allocation: 200 records minus 40 held for later arXiv/status stages, split across selected sources (OpenAlex alone: 160). With older work requested, a quarter of that goes to citation expansion. Queries that are exactly a DOI or OpenAlex work ID are looked up with a `doi:`/`openalex:` filter outside the date window (`direct-lookup`); other queries are searched with `from_publication_date`/`to_publication_date`, up to 100 per page, following cursors until the query's share is filled. The references of the top 25 results are counted, the most-cited up to 100 IDs are fetched with `to_publication_date` the day before the window (`citation`). The key is only ever a bearer header.
- **Provenance.** `source_execution` records the effective queries, the exact filter expressions, unsupported steps, reported vs received counts, per-query cursors (JSON) where results remain, cache age, truncation and the error class. `literature_snapshot.allocations` records the reserve and each source's allocation and kept records by acquisition reason. `snapshot_paper.observation` keeps each record exactly as observed, so a later correction never changes an older snapshot.
- **Caching.** Compacted answers (no abstract text, only whether one exists) are cached per project in `source_response_cache`, keyed by a hash of the request URL, deleted with project cleanup and after seven days. Answers under a day old are reused at no cost and reported as cache age.
- **Failures.** A refusal before any answer throws back to the worker, which retries up to three attempts. After an answer, a failure stops further requests and returns `partial` with the cursor where it stopped. A timeout before any answer is an uncertain outcome: its reservation stays held and it is not retried. On the final attempt, or when a pause is long, a cached answer up to seven days old is used and labelled `stale-cache`. An empty answer is `empty`; any failure is visible and never looks like an empty corpus.
- **Identity.** Papers reconcile only through exact identifiers held in `paper_alias` (`doi:`, `openalex:W…`, `arxiv:` from arXiv DOIs, `pmid:`, fixture keys). A conflicting identifier never moves or merges papers, and identical titles stay separate. Nothing downloads PDFs; abstracts are not stored.

## Environments

| Process | Added variables |
| --- | --- |
| API (`apps/server/.env.schema` and `deployedEnvSchema`) | `LITERATURE_SOURCE_QUOTAS` (optional JSON). No OpenAlex key: the API never calls OpenAlex. |
| Worker (`apps/worker/.env.schema`) | `LITERATURE_SOURCE_QUOTAS` (must match the API), `OPENALEX_API_KEY` (sensitive). Without the key OpenAlex fails as `credentials-missing`. |

Migration `20260927190055_openalex_sources` adds `paper_alias` (backfilled from existing paper keys and DOIs), `source_throttle`, `source_response_cache`, `literature_snapshot.allocations` and `snapshot_paper.observation`. Apply with `pnpm db:migrate` before deploying the worker and API.

## Tests

`apps/server/tests/openalex-search.test.ts` drives the real API and worker with the OpenAlex adapter over an injected recording `fetch` that answers with responses shaped like OpenAlex's documented `/works` answers (`apps/server/tests/openalex-fixture.ts`). No test reaches the network. Scenarios: the discovery journey (provenance, headers, cursors, lookups, older cited work, identifiers, preprint status, evidence availability, allocations, measured usage, cache reuse and exact reconciliation across snapshots); rate limiting with a shared pause; timeouts, partial cursors, empty answers, uncertain spend and stale cache; missing quota/price/credentials and a quota shared across projects; and the smoke check helper. The #9 suite now expects the 40-record reserve.

## Live smoke check

See `docs/operations/openalex-runbook.md`. It is never part of `pnpm test` and was not run during implementation.
