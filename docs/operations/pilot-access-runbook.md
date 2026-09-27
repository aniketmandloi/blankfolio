# Pilot access runbook

Research Projects are invite-only. An account can use research operations only when its email is **verified** and the latest eligibility event for its **normalized email** (trimmed, lower-case) is an invitation. The API enforces this on every research operation before any project lookup, so an ineligible session receives the same `FORBIDDEN` response for real and guessed project IDs. Web pages only present the state; they are not the enforcement point.

| Status (`account.access`) | Meaning | Web state |
| --- | --- | --- |
| `eligible` | Verified and currently invited | Projects open |
| `verification-required` | Session exists but the email is unverified (for example a starter-era account) | Request a new verification link |
| `pending-invitation` | Verified, never invited | Waiting for an invitation |
| `revoked` | Latest event is a revocation | Access withdrawn; projects kept |

Background work must call `pilotAccessStatus(db, ownerId)` from `@blankfolio/api/pilot-access` before each stage and cancel that account's work unless it returns `eligible`. Job slices implement that cancellation; this slice has no jobs.

## Before pilot enablement

1. Apply migration `20260927110603_pilot_access` with `pnpm db:migrate` against the intended database only. Existing starter databases need the reconciliation described in `docs/testing/issue-7-api-and-database.md` first.
2. Configure and verify live mail delivery (below). Until then the pilot is **not** live-ready: nobody can verify an address or recover access.
3. Exercise, with an operator-owned address in the deployed environment: register, verify, sign in, open a project, request recovery, reset, sign in again, revoke, confirm the withdrawn state, re-invite, and confirm the project is still there. Record the date, environment and outcome.
4. Run `docs/testing/issue-8-manual-browser-checks.md` against the deployed environment.

## Changing eligibility

There is no API route or UI for eligibility. The operator command authenticates by requiring the target environment's server configuration: run it only where the API's own `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `CORS_ORIGIN` are loaded (for example `apps/server/.env`, or variables pulled from the deployment and never committed).

```bash
pnpm --filter server pilot:access invite researcher@example.org --actor you@your-lab.org --reason "Pilot cohort 1"
pnpm --filter server pilot:access revoke researcher@example.org --actor you@your-lab.org --reason "Left the pilot"
pnpm --filter server pilot:access history researcher@example.org
```

- `--actor` names the person making the change; use a stable identity. `--reason` is required. Blank values and invalid emails are rejected before anything is written.
- Every change appends a row to the private `pilot_access_event` table (email, action, actor, reason, UTC time). Rows are never edited; the newest row per email is the current eligibility. `history` prints the trail newest first.
- An invitation can be recorded before the person registers. Registering or verifying never grants eligibility by itself.
- **Revocation** takes effect on the next research request. The person stays signed in but every research operation is refused and the web shows the withdrawn state. Private projects are preserved; deleting them is a separate action. Re-inviting restores access to the same projects.

## Verification and recovery delivery

Links are produced by Better Auth and handed to a `MailDelivery` adapter (`packages/auth`), composed in `apps/server/src/mail.ts`:

- **Disabled (default).** Logs `auth_mail_delivery_disabled <kind>` without the address or link. Registration succeeds but the person cannot verify or recover.
- **Local outbox.** Set `AUTH_MAIL_OUTBOX=/absolute/path/mail.jsonl` for local fixture runs. Each message becomes a JSON line (`kind`, `to`, `url`, `sentAt`). The file holds live sign-in tokens: keep it outside the repository, readable only by you, and delete it afterwards. The server refuses to start with an outbox in production, and `pnpm env:preview`/`env:production` do not sync it.
- **Resend (live).** Set `RESEND_API_KEY` (and optionally `AUTH_MAIL_FROM`, e.g. `Blankfolio <no-reply@your-domain>`) in the Vercel Preview/Production environments with `vercel env add`. Messages are plain text sent through Resend's HTTP API. The adapter never throws and never behaves differently for a known address (either would reveal account existence), and failures log only `auth_mail_delivery_failed <kind> <status>`. The default sender `onboarding@resend.dev` only delivers to the Resend account owner's address: use it to verify the flow end to end with your own account, then verify a sending domain in Resend and set `AUTH_MAIL_FROM` before inviting anyone else. A configured outbox takes precedence, so local fixture runs never send real mail.

Link behavior: verification links expire after one hour and redirect to `/email-verified` (with `?error=TOKEN_EXPIRED` or `INVALID_TOKEN` when unusable). Verification does not sign the person in. Recovery links work once, expire after one hour, redirect to `/reset-password?token=…` (or `?error=INVALID_TOKEN`), and a successful reset ends every session on the account. Registration, recovery and resend responses are identical whether or not an account exists; only an existing account that needs the message receives one.

## Cookies, origins and CSRF

The auth instance no longer forces `SameSite=None; Secure`. It uses Better Auth's defaults, covered by API tests for both configurations:

- **Direct local access** (`BETTER_AUTH_URL=http://localhost:3000/api/auth`, `CORS_ORIGIN=http://localhost:3001`, web `NEXT_PUBLIC_SERVER_URL=http://localhost:3000`): `better-auth.session_token`, `HttpOnly; SameSite=Lax`, not `Secure`. Both ports are the same site, so every browser (including Safari) keeps the cookie over plain HTTP.
- **Deployed same origin** (`/api` routed to the Hono service; `BETTER_AUTH_URL=https://<origin>/api/auth`): `__Secure-better-auth.session_token`, `HttpOnly; SameSite=Lax; Secure`.
- **Origin checks** are explicitly enabled (Better Auth otherwise skips them under test runners). Auth requests carrying cookies or browser fetch metadata from an origin other than `CORS_ORIGIN` or the native schemes are rejected with `403`. `SameSite=Lax` keeps cookies off cross-site tRPC mutations, and tRPC form-type posts (which browsers send without a preflight, including from same-site sibling origins) are refused unless they come from `CORS_ORIGIN`.
- **SSR** pages forward the incoming request headers to `/api/auth/get-session`; this works with host-only cookies because the forwarded `Cookie` header is sent explicitly.
- **Native** clients keep the Expo plugin and trusted `blankfolio://`, `exp://` and `http://localhost:8081` origins. Native sign-up now also requires email verification; the native scaffold has no verification screen yet.

Unsupported: serving web and API from different sites (Lax cookies will not be sent), and opening a Vercel preview through a branch alias whose host differs from `VERCEL_URL` (the origin check rejects it; use the deployment URL).
