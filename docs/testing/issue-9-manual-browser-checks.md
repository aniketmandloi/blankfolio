# Ticket #9 manual browser checks

These checks are for the user to run by hand. They have **not** been executed by the implementation agent. Starting the web app, API or worker requires permission under `AGENTS.md`; nothing here starts one.

## Setup

Use a disposable database, never production data. Set up the pilot account as in `issue-8-manual-browser-checks.md`, then:

1. `pnpm db:migrate` against the disposable database (adds `20260927114150_literature_search`).
2. Create `apps/worker/.env` with the disposable `DATABASE_URL`, `DATABASE_MIGRATION_URL` (may be the same direct connection locally) and `LITERATURE_SOURCE_PRICES={"fixture-metered":0.02}`; add the same `LITERATURE_SOURCE_PRICES` to `apps/server/.env`.
3. `pnpm --filter worker queue:migrate` once.
4. With permission, start the API, the web app and `pnpm dev:worker`.

Queries containing `fixture:<behavior>` choose deterministic outcomes (see `issue-9-literature-search.md`). Repeat at **1280px** and **360px**, with keyboard only where noted. Nothing should need horizontal page scrolling.

## Checks

1. **Proposal and edits.** Save a brief with a title, topic and a distinctive compute description. *Review literature scope* opens the Literature page with the topic and title as queries, the free fixture catalog selected and a five-year window ending today. The compute description appears nowhere on the page. Add a third query, remove one, choose both sources, tick older foundational work, save: *Saved as scope revision 1.*
2. **Confirmation shows exactly what is sent.** *Review and search* lists the saved queries and the selected sources, and says nothing else from the brief is sent. Editing the form hides the button until the scope is saved again.
3. **Durable progress.** Send the queries. The search shows *Queued* then *Searching* with *n of 2 sources finished*. Navigate to the dashboard, wait, come back (and try another tab or a reload): the state is restored without resubmitting. While the tab is hidden, the network panel shows no polling; refocusing refetches at once. With a job active, requests repeat about every five seconds and stop after it ends.
4. **Dated snapshot.** *View snapshot* shows the search time, scope revision, date window, coverage, and per source: queries sent, filters applied, unsupported filters (the metered source reports older foundational work as unsupported), received vs reported counts and attempts. Foundational papers are labelled.
5. **Partial, truncated, cached, empty.** Search `x fixture:metered-partial fixture:broad fixture:cached`: coverage reads *Partial coverage*, the catalog shows *truncated · cached*, the metered source *Partial answer* with its limitation. Search `fixture:empty nothing`: the snapshot explains that an empty search is not evidence of a gap.
6. **Total failure.** Search `fixture:outage` with both sources: after the retries the search reads *Failed* with the explanation that no snapshot was created; no new snapshot appears.
7. **Cancellation.** Stop the worker, submit a search, and choose *Cancel search*: it reads *Cancelled* / *You cancelled this search.* Restart the worker: the search stays cancelled and no snapshot appears.
8. **Limits.** With the worker stopped, submit searches in two projects; a third submission shows the two-active-searches message and the form keeps its values. Archive one project from its brief page: its search reads *Cancelled when the project was archived.*
9. **Budget status.** The side panel shows this month's project spend against $5, the $1 per-search limit and metered availability. After a metered search it increases by $0.02 per query. Remove `LITERATURE_SOURCE_PRICES` from the API and restart it: the metered source reads *Disabled: pricing is not configured*, a scope including it cannot be submitted, and a free-only search still works.
10. **Uncertain metered outcome.** Search `fixture:metered-uncertain` with both sources: the metered source explains its cost stays counted and it was not retried; the catalog results are still published as partial coverage.
11. **Conflicts and revocation.** Save the scope in two tabs: the second shows the conflict and *Check latest and keep my draft* keeps its edits. Revoke the account while a search is queued: it reads *Cancelled because pilot access was withdrawn.* after re-inviting.
12. **Accessibility.** Every field has a visible label; Tab reaches queries, remove/add buttons, source checkboxes, dates, criteria, save, search, confirm and cancel with a visible focus ring; status changes are announced (live regions on the job list and confirmation).

Record each check as pass/fail with browser/version, viewport and the visible failure.

## Optional automation

`apps/web/tests/literature.spec.ts` automates checks 1–5 at both viewports once the API, web app and worker are running against a disposable database with the saved browser state described in `issue-7-api-and-database.md`: `pnpm --filter web exec playwright test literature`. It was not run during implementation.
