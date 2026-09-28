# Literature searches, worker and spending limits

A researcher saves a **Literature Scope** revision (one to three queries, sources, publication dates, inclusion/exclusion criteria, older-foundation intent), confirms the exact queries, and submits a search. The API writes the `research_job` row and enqueues its pg-boss message in the **same PostgreSQL transaction**; a separate Node worker runs it and publishes an immutable **Literature Snapshot**. Nothing here is a live provider: both sources are deterministic fixtures and no paid or network call is made. OpenAlex, priced routes, daily provider quotas and the 40-record reserve for later stages arrived with issue #10 (`issue-10-openalex.md`).

## What is stored

| Table | Contents |
| --- | --- |
| `literature_scope_revision` | Append-only scope revisions with the brief revision they were saved against. Proposals are derived from the brief's topic and title only. |
| `research_job` | State (`queued`, `running`, `succeeded`, `failed`, `cancelled`), stage, cancel reason, error class, idempotency key, input hash and the frozen scope. Unique per project/kind/key. |
| `source_execution` | One checkpoint per source: status (`succeeded`, `empty`, `partial`, `failed`), attempts, allocation, effective queries and filters, unsupported filters, reported vs received counts, cursor, cache age, truncation, error class and retrieved records. Finished checkpoints are never re-executed. |
| `literature_snapshot`, `snapshot_paper` | Published once per job (unique `job_id`), with scope/brief revisions, coverage (`all-sources` or `partial`), record cap and membership. |
| `paper` | Public bibliographic facts, deduplicated by key; they may outlive the projects that found them. |
| `usage_reservation` | Integer micro-dollars per metered attempt: `pending`, `settled` (measured) or `held` (outcome unknown). |

A wholly failed search fails its job and publishes **no** snapshot, so it cannot look like an empty corpus. Coverage `all-sources` only means every selected source answered within the 200-record cap; nothing claims an exhaustive search.

## Fixture sources

Fixture sources fabricate papers, so they exist only where `LITERATURE_FIXTURE_SOURCES=true` is set on both the API and the worker: the test workspace and local development. Never set it in a deployment. Without it they are not listed, a scope naming them cannot be saved or searched, and a worker without the flag fails such a source as `fixtures-disabled` instead of running it; the proposed scope then uses OpenAlex.

- `fixture-catalog` (free; supports older foundational work).
- `fixture-metered` (simulated cost per query request; reports older foundational work as unsupported). Its price comes from `LITERATURE_SOURCE_PRICES`; without one the route is disabled and free sources keep working.

A query containing `fixture:<behavior>` changes both sources; `fixture:catalog-<behavior>` or `fixture:metered-<behavior>` changes one. Behaviors: `empty`, `partial` (last query fails), `broad` (500 results per query, so truncation), `cached` (six-hour cache age), `flaky` (first attempt refused, second succeeds), `outage` (every attempt refused) and `uncertain` (a metered answer is lost after dispatch).

## Limits and recovery

- Two queued/running searches per account (checked under a row lock on the account) and two executing runs globally (pg-boss `groupConcurrency` shared by every worker).
- Each source gets at most three total attempts, with backoff that honours a provider's retry-after. Attempts are persisted before the call, so a restart cannot exceed the limit.
- pg-boss redelivers a job whose worker died or expired (15 minutes, up to two redeliveries). The worker resumes from checkpoints; a duplicate delivery of a finished job does nothing. After the last redelivery fails, the job is marked `failed` with `worker-error`.
- Every stage, attempt and the publication re-check the project guard (`requireProject(..., "write")`: archived or deleting stops the job) and `pilotAccessStatus`. Cancel, archive, delete and operator revocation also cancel queued/running jobs directly. Late checkpoints and publications are rejected once a job is not `running`.
- Budgets: $1 per run, $5 per project per UTC month, $50 globally per UTC month (`packages/api/src/usage-budget.ts`; changing them is a reviewed code change). Each metered attempt reserves its maximum (`price × queries`) under an advisory lock that counts pending and held reservations. A refused attempt settles at $0; a completed one settles at its measured requests; an uncertain one stays held at the full amount and is **not** retried automatically. Submission refuses a metered source with unknown pricing or no room under a limit.
- Project deletion cancels jobs, then the cleanup registry removes scope revisions, jobs, checkpoints, snapshots and memberships. Usage reservations keep their amounts (detached from the deleted job) so spend already incurred still counts.
- Redaction: queue messages carry only the job ID; `literature.jobs` returns no queries; worker logs and stored queue errors contain only the job ID and an error class. Effective queries appear only in the owner's job and snapshot detail.

## Environments

Three distinct schemas, each loaded by Varlock from its own directory:

| Process | Schema | Variables |
| --- | --- | --- |
| API (`apps/server`) | `apps/server/.env.schema` | Existing auth/database variables plus optional `LITERATURE_SOURCE_PRICES` (JSON, USD per request per route, e.g. `{"fixture-metered":0.02}`) and, since #10, `LITERATURE_SOURCE_QUOTAS`. The API enqueues through its request pool and never polls for jobs; after its first enqueue pg-boss refreshes its queue cache every 60 seconds, logging `job_queue_error` if that fails. |
| Worker (`apps/worker`) | `apps/worker/.env.schema` | `DATABASE_URL` for the worker role (direct, non-pooler Neon connection), `LITERATURE_SOURCE_PRICES` and `LITERATURE_SOURCE_QUOTAS` (must match the API), `OPENALEX_API_KEY` (#10), `WORKER_POLL_INTERVAL_SECONDS` (idle queue poll; 30 in production, 2 otherwise), and `DATABASE_MIGRATION_URL` only for `queue:migrate`. No auth secrets. |
| Migrations | `packages/db/.env.schema` and the worker's `DATABASE_MIGRATION_URL` | `pnpm db:migrate` applies `20260927114150_literature_search`; `pnpm --filter worker queue:migrate` installs or upgrades the pg-boss schema (`pgboss`) and creates the `literature-search` queue. Both need a role that can run DDL. |

The worker role needs read/write on the application tables and on the `pgboss` schema; it does not need DDL. It holds two pools: the application pool from `createDb(config, { persistent: true })` (up to five connections) and pg-boss's own pool (up to three). Both are closed on `SIGINT`/`SIGTERM` after in-flight handlers finish (30-second grace).

## Worker packaging

The worker is a persistent Node 22.12+ process and is **not** a Vercel service; nothing in `vercel.json` changes. Polling never happens inside a request handler.

- Local: `pnpm dev:worker` (runs `tsx watch` with `apps/worker/.env`). Starting it requires permission, like any server.
- Build: `pnpm --filter worker build` produces `apps/worker/dist/start.mjs` and `dist/migrate.mjs`, bundling the workspace packages and their dependencies; only `varlock` stays external, and `.env.schema` must sit in the working directory.
- Run: `pnpm --filter worker start` (or `node dist/start.mjs` from `apps/worker`) on any host that keeps a long-running process, for example a container or VM, reaching the same PostgreSQL database as the API. The production worker runs on a free Google Cloud VM: `docs/operations/worker-gcp-runbook.md`.

Deployment order: `pnpm db:migrate`, then `pnpm --filter worker queue:migrate`, then the worker, then the API. Until the queue is installed, submissions fail with the generic error and nothing is saved.

## Tests

`apps/server/tests/literature-search.test.ts` drives the real API and the production pg-boss handler in-process: each scenario owns a disposable application schema **and** a disposable pg-boss schema, claims jobs with the production work options, and fails a job back to the queue when the handler throws, as a worker would. No daemon is started and nothing is left running. Scenarios cover the scope-to-snapshot journey, duplicate submissions and key conflicts, rollback with no orphaned queue message, source outcomes/truncation/cache/foundations, bounded retries, restart and duplicate delivery, uncertain metered outcomes, account and global concurrency, cancellation/archive/deletion/revocation, concurrent reservations and UTC month rollover, unknown pricing, redaction and deletion cleanup. They run concurrently because every guarded stage costs several round trips to the remote branch.

Browser checks: `docs/testing/issue-9-manual-browser-checks.md` and the optional `apps/web/tests/literature.spec.ts`. None were run during implementation.
