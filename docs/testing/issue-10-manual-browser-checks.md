# Ticket #10 manual browser checks

These checks are for the user to run by hand. They have **not** been executed by the implementation agent. Starting the web app, API or worker requires permission under `AGENTS.md`; nothing here starts one.

## Setup

Follow `issue-9-manual-browser-checks.md` against a disposable database, then `pnpm db:migrate` (adds `20260927190055_openalex_sources`). Checks 1–4 use fixtures only. Checks 5–8 use live OpenAlex and spend a fraction of a cent from the key's daily allowance; skip them until `docs/operations/openalex-runbook.md` steps 1–3 pass.

Repeat at **1280px** and **360px**. Nothing should need horizontal page scrolling; long identifiers wrap.

## Fixture checks (no OpenAlex configuration)

Set `LITERATURE_FIXTURE_SOURCES=true` on the local API and worker for these; without it the fixture sources are not offered.

1. **Disabled route, preserved work.** Without `LITERATURE_SOURCE_QUOTAS`, the Sources list shows OpenAlex as *Disabled: the daily provider quota is not configured.* and the budget panel says the same. Selecting it and searching shows the precise message; unticking it and searching with the fixture catalog works. Earlier snapshots still open.
2. **Paper provenance.** Search `tabular transfer` with the fixture catalog. Each paper shows authors and a publication date, the source, a status line (*Preprint*, *Published version* or *Publication status not supplied*, then *Abstract available at the source (not stored)* or *Metadata only*) and a `doi:` link opening `https://doi.org/…`. No PDF is downloaded.
3. **Allocations.** The snapshot summary says how many records each source contributed of its allocation and that 40 records are reserved for later arXiv and status checks. With both fixture sources the allocation is 80 each.
4. **Truncation, cache, failure, older work.** Repeat #9 check 5 (`fixture:metered-partial fixture:broad fixture:cached`): the catalog shows *truncated · cached*, *More results* explains the saved cursor, and older foundational papers read *Older foundational work*. `fixture:outage` still fails the search with no snapshot.

## Live OpenAlex checks (configured per the runbook)

5. **Default proposal and pricing.** A new project's proposed scope selects OpenAlex. The source line lists the price per search page and per citation or identifier lookup, reserved before each attempt.
6. **Discovery and provenance.** Search one narrow query with OpenAlex, older work ticked. The source details show the query sent, the `from_publication_date…to_publication_date` filter, the older-work filter, received vs reported counts, and *More results* when OpenAlex had more. Papers show `doi:`/`openalex:` (and `arxiv:` for arXiv DOIs) links, a *Source page* link, dates, preprint status where OpenAlex supplies it, and *Older work cited by the top results* on pre-window papers.
7. **Direct lookup.** Add a query that is exactly a DOI of an older paper (e.g. `10.48550/arXiv.1706.03762`). It appears labelled *Looked up by identifier* even though it predates the window.
8. **Cache and spend.** Run the same search again within a day: the source reads *cached* with its age and the budget panel does not increase. Compare the month's spend with the OpenAlex usage dashboard.

Record each check as pass/fail with browser/version, viewport and the visible failure.

## Optional automation

`apps/web/tests/literature.spec.ts` now also checks the reserve note, a preprint status line, *Metadata only* and a DOI link in the fixture snapshot. It was not run during implementation.
