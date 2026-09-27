# Ticket #8 manual browser checks

These checks are for the user to run by hand. They have **not** been executed by the implementation agent, and passing API tests do not verify browser cookie handling or layout. Starting servers requires permission under `AGENTS.md`; nothing here starts one.

## Setup

Use a disposable database with migrations applied (including `20260927110603_pilot_access`), never production data or real people's addresses. Use `example.test` addresses.

- API (`apps/server/.env`): `BETTER_AUTH_URL=http://localhost:3000/api/auth`, `CORS_ORIGIN=http://localhost:3001`, the disposable `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `AUTH_MAIL_OUTBOX=/absolute/path/outside/the/repo/mail.jsonl`.
- Web (`apps/web/.env`): `NEXT_PUBLIC_SERVER_URL=http://localhost:3000`, `SERVER_URL=http://localhost:3000`.
- Links arrive as JSON lines in the outbox (`kind`, `to`, `url`). Open the newest `url` for the address. Delete the file afterwards; it contains live tokens.
- Invite with `pnpm --filter server pilot:access invite <email> --actor <you> --reason "Manual browser check"` (see `docs/operations/pilot-access-runbook.md`).

Repeat the journeys at **1280px** and **360px**, in Chrome and Safari (Safari rejects `Secure` cookies over plain HTTP, which the previous defaults relied on). Every page should be readable without horizontal scrolling, usable with Tab/Shift+Tab/Enter/Space, with visible focus and labelled fields.

## Checks

1. **Sign-up waits for verification.** Invite A, then sign up as A on `/login` (Sign Up). The page should show *Check your inbox.* and stay on `/login`; it must not open the dashboard. Visiting `/dashboard` should return to `/login`.
2. **Unverified sign-in.** Choose *Back to sign in* and sign in as A. *Verify your email first.* should appear. *Send a new verification link* should show the neutral "If this address still needs verification…" status and add a new outbox line.
3. **Verification.** Open A's newest verification link. `/email-verified` should say *Your address is confirmed.* without signing you in. Sign in: the Projects desk opens. Create a project, reload, sign out, sign back in and reopen it by URL.
4. **Expired and reused links.** Open an older verification link after the one-hour expiry (or edit the token): *This link has expired.* / *This link cannot be used.* with a working request form. Opening an already-used recovery link should show *This recovery link cannot be used.*
5. **Recovery without disclosure.** Signed out, choose *Forgot your password?* and request links for A and for an address that was never registered. Both should show the same message; only A should get an outbox line. Open A's link, enter mismatched passwords (error shown, nothing saved), then a new password. You should land on sign-in with the "password was updated" notice. A second browser profile that was signed in as A must be signed out on its next action. The old password must fail and the new one must work.
6. **Pending invitation.** Sign up and verify B without inviting B. After sign-in, `/dashboard` and any `/projects/<uuid>` (including A's real project ID) should show *Your account is waiting for an invitation.* with B's address and a Sign out button, and no project data. Invite B and refocus/reload: the empty desk should appear.
7. **Revocation.** While A is signed in on a project page, revoke A with the command. On the next action, focus or reload, A should see *Pilot access has been withdrawn.*; saving the brief must fail. Re-invite A: the project and its revisions should still be there.
8. **Starter-era unverified session** (optional, disposable DB only). With A signed in, set A's `email_verified` to false in the database. Reloading should show *Confirm your address to continue.* with a resend form for A's address; verifying through the new link and reloading should reopen the desk.
9. **Sign-out.** From the user menu and from the pending/withdrawn states, Sign out should return to `/login` and later visits to `/dashboard` should require sign-in again. No previous account's project titles should flash after signing in as another account.
10. **Cookies.** In developer tools, the local session cookie should be `better-auth.session_token`, `HttpOnly`, `SameSite=Lax`, not `Secure`. On an HTTPS deployment (same-origin `/api`), it should be `__Secure-better-auth.session_token` with `Secure`. Opening a Vercel preview through a branch alias is expected to fail sign-in; use the deployment URL.

Record each check as pass/fail with browser/version, viewport and the visible failure.

## Optional automation

`apps/web/tests/pilot-access.spec.ts` automates checks 1, 3, 4 (request forms), 5 and 6 with the same outbox. With permitted servers running as above, run `PLAYWRIGHT_MAIL_OUTBOX=<same path> pnpm --filter web exec playwright test pilot-access`. It invites its synthetic addresses through the operator command, so `apps/server/.env` must point at the same disposable database as the running API. The older `projects.spec.ts` now needs its saved browser state to belong to an invited, verified account. None of these specs were run during implementation.
