# Supplied starter review for ticket decomposition

Reviewed 27 September 2026 against [Spec: evidence-backed AI/ML research question discovery](https://github.com/aniketmandloi/blankfolio/issues/6). This is a read-only baseline assessment; application implementation is the next skill step.

## Reuse

- pnpm workspace, Turborepo, TypeScript and Biome are configured. Varlock owns application environment schemas/generated types. Preserve this tooling instead of regenerating the template.
- Next.js web and Expo/native apps exist, with Hono, tRPC/TanStack Query, Better Auth email/password/Expo integration, Drizzle/PostgreSQL and shared web UI primitives.
- The backend creates the database/auth services and resolves sessions from HTTP headers; tRPC has a session-only protected procedure. Web SSR forwards request headers for the dashboard session check and browser requests include credentials.
- Vercel service routing maps browser `/api` traffic to the server while retaining auth routing and rewriting other API paths. The native scaffold is already present; no mobile product work is needed in this decomposition.

## Concrete changes the tickets must carry

- Only demo health/private-data routes and login/dashboard pages exist. Projects, private ownership, literature/evidence, candidates, reviews, questions, durable jobs, model/storage adapters and tests are absent.
- The current application connection uses Drizzle Neon HTTP. Choose the Node PostgreSQL driver/pool for shared transactional application, reservation and queue writes, retaining Neon hosting and the existing auth schema. HTTP and session/interactive transaction requirements differ; verify the selected installed Drizzle/pg-boss integration on disposable PostgreSQL. [Drizzle Neon connection guidance](https://orm.drizzle.team/docs/connect-neon), [pg-boss transactional enqueue support](https://github.com/timgit/pg-boss)
- The server entry point starts a listener outside Vercel on import. Separate its app factory from startup for request-level tests and service injection; preserve deployed routing.
- Vercel request functions have bounded duration. Keep request handling short and place the polling pg-boss worker in a separately hosted persistent Node process. Add an explicit deployable worker/config contract during queued discovery; live hosting and enablement are later operator gates. [Vercel function limits](https://vercel.com/docs/functions/limitations)
- Auth checks a session but not invited/verified/revoked eligibility. There is no verification/recovery delivery or operator allowlist audit. Cookie/origin defaults are Secure/SameSite=None and need local/deployed validation. Auth and tRPC duplicate URL resolution; consolidate only where the integration tests justify it, within the account ticket.
- Root `check` is mutating (`biome check --write`), so it was not used for inspection. Introduce API integration and a small browser suite in the first project slice; lockfile transitive test-tool references are not an installed/configured project test suite.
- Ownership, tombstones, cleanup hooks, quotas and spending reservations enter with the first affected workflow. The final lifecycle/pilot tickets verify all pipelines rather than deferring those safeguards.

## Checks actually run

- `pnpm run check-types`: passed, seven successful task executions across the workspace. No servers were started.
- Non-mutating Biome check on four representative files (server entry, database factory, auth factory, dashboard page): failed with four formatting differences, principally spaces versus the configured tab indentation. No fixes were applied and this is not a claim about the rest of the repository. Baseline formatter reconciliation belongs in a separate mechanical commit in the first ticket.
- No dependency installs, migrations, deployment, provider calls, mail delivery, paid jobs or app runtime checks were performed. Node and pnpm were available; generated environment types were sufficient for static typechecking. Private env values were not read.

## Scope handoff

The starter import prerequisite is satisfied. The spec's historical statement that no application starter existed describes its authoring-time baseline; child tickets use this reviewed starter without changing the published parent. Product scope and provider choices are retained. Implementation can begin with the private Research Project ticket. Native scaffold, later research plans/experiments/manuscripts, live provisioning and expert review do not become hidden assumptions or completed outcomes.
