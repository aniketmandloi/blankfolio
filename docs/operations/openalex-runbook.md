# OpenAlex operator runbook

For enabling OpenAlex discovery in a deployment. Every step here is performed by the operator; the implementation agent ran none of them.

## 1. Key and terms

1. Create an OpenAlex account and copy the API key from <https://openalex.org/settings/api>. A free key currently gives $1 of usage per UTC day; heavier use needs prepaid usage (<https://help.openalex.org/access/pricing/>).
2. Re-read the pricing, authentication and error pages; if prices changed, update the price table below before enabling.

## 2. Configuration

Set the same price and quota tables on the API (Vercel environment and `apps/server/.env`) and the worker (`apps/worker/.env`):

```
LITERATURE_SOURCE_PRICES={"openalex-search":0.001,"openalex-filter":0.0001}
LITERATURE_SOURCE_QUOTAS={"openalex":1}
```

Add fixture prices only in fixture environments. Set `OPENALEX_API_KEY` on the **worker only**; the API does not need it. The quota should not exceed the key's daily allowance you are willing to spend, because OpenAlex's budget is shared by everything using that key.

Deploy in order: `pnpm db:migrate`, then the worker, then the API.

## 3. Live smoke check

```
pnpm --filter worker openalex:smoke            # W2741809807 by default
pnpm --filter worker openalex:smoke W123456789 # any work ID
```

It makes **one** request to `GET /works/{id}`, which OpenAlex lists as free, using the worker's key, field selection and mapping. It never searches or lists, and it needs no database access beyond loading the worker's environment. Pass criteria: `status` 200, a `record` with a title, identifiers including `openalex:W…`, a publication date and work type, and at least one `x-ratelimit-*` header. It prints `openalex_smoke_passed` or `openalex_smoke_failed` (non-zero exit). A `401`/`403` means the key is wrong; a `429` means the key's daily budget is exhausted.

Record the date, the printed rate-limit headers and whether the fields matched in the pilot's live integration gate. Exact latency and spend are measured in a supervised pilot search, not here.

## 4. First supervised search

With permission, start the API, web app and worker. In a disposable project, search one narrow query with OpenAlex only and older work ticked. Check the snapshot's filters, cursor note, cited older works and the budget panel (a one-query search should settle at most a few tenths of a cent). Then check the OpenAlex usage dashboard (<https://openalex.org/settings/usage>) agrees in order of magnitude.

## Incidents

- **`rate-limited` on every search:** OpenAlex returned a long reset; `source_throttle` holds the pause until then. It clears itself; to lift it early after raising the budget, delete that row.
- **`quota-exhausted`:** the deployment's daily quota is used; it resets at midnight UTC. Raise `LITERATURE_SOURCE_QUOTAS` on both processes if intended.
- **`credentials-missing`:** the worker has no `OPENALEX_API_KEY`.
- **`uncertain-outcome`:** a request timed out; its reservation stays held and counts until reconciled against the OpenAlex usage dashboard.
