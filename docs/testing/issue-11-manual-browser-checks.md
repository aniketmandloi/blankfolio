# Ticket #11 manual browser checks

These checks are for the user to run by hand. They have **not** been executed by the implementation agent. Starting the web app, API or worker requires permission under `AGENTS.md`; nothing here starts one.

## Setup

Follow `issue-10-manual-browser-checks.md` against a disposable database, then `pnpm db:migrate` (adds the three #11 migrations). arXiv and Crossref are free and need no key, so these checks make real requests to both; run each search once.

Repeat at **1280px** and **360px**. Nothing should need horizontal page scrolling; long identifiers, related versions and possible-match titles wrap.

## Checks

1. **arXiv listed and proposed.** The Sources list shows arXiv as free. A new project with OpenAlex configured proposes OpenAlex and arXiv together; with only fixture sources it still proposes the fixture catalog.
2. **arXiv search.** Search `tabular transfer learning` with arXiv only. The source details show the `all:… AND submittedDate:[…]` expression under *Filters applied* and received vs reported counts. Papers show `arxiv:` and `doi:10.48550/…` links, *Version vN of DATE*, and for published preprints a *Published version: doi:…* line.
3. **Direct lookup.** Add the query `1706.03762`. It appears labelled *Looked up by identifier* although it predates the window.
4. **Shared cap.** Search with OpenAlex and arXiv. The summary shows OpenAlex's allocation 160 and arXiv's 40, with no unallocated note; arXiv alone shows 160 and says 40 stay unallocated. A preprint both return appears once, with *Also returned by arXiv (vN)*.
5. **Status lines.** Every paper shows a status line: *No correction or retraction known · Crossref checked DATE*, *Not registered with Crossref; checked DATE*, *Crossref does not register this DOI…* (arXiv DOIs) or *No DOI…*. The snapshot summary says how many DOIs were checked and that no notice is not a clean record.
6. **Retraction flag.** Add a direct lookup of a known retracted DOI (for example `10.1016/S0140-6736(97)11096-0`, via OpenAlex). Its status line reads *Retracted · … (Retraction Watch)* and *It cannot count as ordinary supporting evidence*, visibly emphasised.
7. **Possible matches.** When a snapshot lists *Possible matches to review*, the explanation names the shared family names. *Same work* and *Different works* are keyboard reachable, `aria-pressed` follows the choice, and both papers stay listed. Deciding in a second tab, then in the first, shows the conflict message without losing the page.

Record each check as pass/fail with browser/version, viewport and the visible failure.

## Optional automation

`apps/web/tests/literature.spec.ts` now expects the *arXiv's share when it runs beside other sources* note in the fixture snapshot. It was not run during implementation.
