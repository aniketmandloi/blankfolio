# arXiv and Crossref operator runbook

Both services are free and need no key. Every step here is performed by the operator.

## 1. Terms

Re-read the arXiv API terms (<https://info.arxiv.org/help/api/tou.html>) and Crossref's access limits (<https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/>). If arXiv's one-request-per-three-seconds rule changed, update `minIntervalSeconds` in `packages/api/src/arxiv.ts`; if Crossref's public-pool rate changed, update `minIntervalSeconds` in `packages/api/src/crossref.ts`.

## 2. Configuration

On the **worker only**, optionally set a monitored contact address so Crossref can reach you and serves the polite pool:

```
CROSSREF_MAILTO=operations@your-domain.example
```

Deploy in order: `pnpm db:migrate`, then the worker, then the API. arXiv appears in every deployment's source list; OpenAlex-backed proposals now include it.

## 3. Live smoke checks

```
pnpm --filter worker arxiv:smoke               # 1706.03762 by default
pnpm --filter worker crossref:smoke            # a DOI whose record lists a retraction
pnpm --filter worker crossref:smoke 10.1234/x  # any DOI
```

Each makes **one** request through the worker's adapter. Pass criteria: `arxiv_smoke_passed` with a versioned record and `doi:10.48550/arxiv.…` identifier; `crossref_smoke_passed` with a `retraction` update from `retraction-watch` or `publisher` for the default DOI. Record the date, results and which Crossref pool answered in the pilot's live integration gate. Run them once; repeated arXiv calls must stay three seconds apart.

## 4. Coverage checks before relying on status

Status coverage is limited to what Crossref and Retraction Watch hold. Before enabling the pilot, look up a handful of known retracted, corrected and withdrawn AI/ML papers (journal and arXiv) in a disposable project and record which statuses appear, which are missing, and how long a newly announced retraction took to appear.

## Incidents

- **arXiv `rate-limited`:** arXiv asked for a pause longer than a minute; `source_throttle` (source `arxiv`) holds it for every worker. It clears itself.
- **Crossref status `rate-limited`:** a 429 wrote a pause for source `crossref`; snapshots published during it say statuses are unknown. Later searches re-check automatically.
- **Status `not-configured`:** the worker was started without a publication-status source; check `apps/worker/src/start.ts`.
