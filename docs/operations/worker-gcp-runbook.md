# Literature worker on a Google Cloud free VM

The literature worker (`apps/worker`) is a persistent Node process, so it runs on an always-free Compute Engine `e2-micro` VM rather than on Vercel. It reaches the same Neon PostgreSQL database as the API. Every step here is run by the operator from the repository root on their Mac; the scripts use `gcloud compute ssh` for everything on the VM.

| Piece | Where |
| --- | --- |
| VM | `blankfolio-worker`, `us-east1-b`, Debian 12, e2-micro (1 GB memory + 2 GB swap), Node.js 24 from NodeSource, pnpm via corepack |
| Local settings | `.env.gcp.local` (git-ignored): `GCP_BILLING_ACCOUNT`, `GCP_PROJECT_ID`, `GCP_ZONE`, `GCP_VM_NAME` |
| Code | `/opt/blankfolio`, a clone of the public GitHub repository owned by the `blankfolio` system user |
| Secrets | `/etc/blankfolio-worker.env`, root-owned, mode 600 |
| Service | `blankfolio-worker` (`deploy/gcp/blankfolio-worker.service`): runs `node dist/start.mjs` from `apps/worker` as `blankfolio`, restarts on failure, stops gracefully on `SIGTERM` |

## 1. Provision the VM (once)

```bash
scripts/setup-gcp-worker.sh
```

An interactive wizard: it signs you in to Google Cloud in the browser, asks for the billing account ID, creates the project, a $1 budget alert and the VM, and installs Node.js, pnpm, git and swap on it. Re-running it is safe and reuses what exists.

## 2. Migrate the database

Apply application migrations as for any deployment, from your Mac against the target database: `pnpm db:migrate`.

## 3. Set the worker's environment

```bash
scripts/set-worker-env.sh
```

It prompts for each value (secrets with hidden input), then replaces `/etc/blankfolio-worker.env` and restarts the worker if it is running. Every run rewrites the whole file, so have all values ready; a blank optional value is left out.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | The worker role's **direct** Neon connection string (not the `-pooler` host): pg-boss holds long-lived connections. Required. |
| `OPENALEX_API_KEY` | Worker only; see `openalex-runbook.md`. |
| `LITERATURE_SOURCE_PRICES`, `LITERATURE_SOURCE_QUOTAS` | Exactly the API's values. |
| `WORKER_POLL_INTERVAL_SECONDS` | Blank for the production default of 30 seconds (see cost guardrails). |
| `DATABASE_MIGRATION_URL` | A role that can create the pg-boss schema; only needed for a `--migrate` deploy. |

`NODE_ENV=production` is set by the service itself. Production leaves `LITERATURE_FIXTURE_SOURCES` unset so fixture sources stay off; the script never writes it.

## 4. First deploy

```bash
scripts/deploy-worker.sh --migrate            # deploys main
scripts/deploy-worker.sh --migrate some-branch  # or any pushed branch, tag or commit
```

It asks for confirmation, creates the `blankfolio` user, clones the repository, installs only the worker and its workspace packages (`pnpm install --frozen-lockfile --filter 'worker...'`), builds it, installs the pg-boss schema and `literature-search` queue with `DATABASE_MIGRATION_URL`, installs and enables the service, restarts it, and prints its status and last log lines. It exits non-zero if the service is not running. A healthy start logs `literature_worker_started`.

The ref is fetched from GitHub, so it must be pushed and must contain `deploy/gcp/blankfolio-worker.service`.

Afterwards, re-run `scripts/set-worker-env.sh` with `DATABASE_MIGRATION_URL` blank so the VM no longer holds a DDL-capable credential. Then deploy the API.

## Routine deploys

```bash
scripts/deploy-worker.sh           # latest main
scripts/deploy-worker.sh v1.2.3    # a branch, tag or commit
```

Add `--migrate` (with `DATABASE_MIGRATION_URL` set) when a change upgrades pg-boss. The service is restarted after the build; in-flight searches get 30 seconds to finish, and a search interrupted beyond that is redelivered by pg-boss and resumes from its checkpoints.

## Operating

```bash
gcloud compute ssh blankfolio-worker --zone=us-east1-b   # then, on the VM:
journalctl -u blankfolio-worker -f                        # follow logs
systemctl status blankfolio-worker
sudo systemctl restart blankfolio-worker
sudo systemctl stop blankfolio-worker                     # stays stopped until start or the next deploy
sudo systemctl start blankfolio-worker
```

Logs contain only job IDs and error classes (`literature_job_failed`, `job_queue_error`). If the service keeps restarting, the first lines after each start usually show a Varlock validation error for a missing or malformed variable.

## Updating Node.js and the OS

```bash
sudo apt-get update && sudo apt-get upgrade        # OS and Node.js 24.x patches
sudo systemctl restart blankfolio-worker
```

For a new Node major, run NodeSource's `setup_<major>.x` script as in the wizard, `sudo apt-get install -y nodejs`, run `sudo corepack enable` again (and install corepack with `sudo npm install -g corepack` if the new major no longer ships it), then run `scripts/deploy-worker.sh` so dependencies are reinstalled and the worker rebuilt. The worker needs Node 22.12 or newer.

## Cost guardrails

- **Free tier** (checked September 2026, <https://docs.cloud.google.com/free/docs/free-cloud-features>): one non-preemptible e2-micro per month in `us-west1`, `us-central1` or `us-east1`, 30 GB-months of standard persistent disk, and 1 GB of outbound data transfer from North America per month. Keep exactly one such VM and the wizard's 30 GB `pd-standard` disk; snapshots, extra disks, static IPs and other regions are billed.
- **Budget alert**: the wizard creates a $1 monthly budget named `blankfolio worker` with emails at 50% and 100%. A budget alerts; it does not stop spending.
- **Egress**: every idle queue check sends about 3 KB to Neon, which is outside Google Cloud and so counts as internet egress. At the default 30-second poll that is roughly 0.26 GB a month, plus pg-boss's once-a-minute maintenance queries and the search traffic itself. A 10-second poll alone would use about 0.8 GB. Do not lower `WORKER_POLL_INTERVAL_SECONDS` without checking **Billing → Reports** (group by SKU, look for network egress) or the VM's **Observability → Network traffic** after a few days.
- Deploys download dependencies (ingress, free) and push nothing.

## Teardown

```bash
source .env.gcp.local
gcloud compute instances delete "$GCP_VM_NAME" --zone="$GCP_ZONE" --project="$GCP_PROJECT_ID"
gcloud projects delete "$GCP_PROJECT_ID"      # optional: removes the project and anything left in it
```

Deleting the VM also deletes its boot disk and the secrets on it. The budget belongs to the billing account; delete it under **Billing → Budgets & alerts** if the account has no other use. Stop the worker (or delete the VM) only after another worker is running, or queued searches wait until one is.
