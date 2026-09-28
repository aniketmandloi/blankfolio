#!/usr/bin/env bash
#
# Deploys the literature worker to the Google Cloud VM from your Mac.
#
#   scripts/deploy-worker.sh [--migrate] [ref]
#
# ref is a branch, tag or commit of https://github.com/aniketmandloi/blankfolio
# (default: main). --migrate also installs or upgrades the pg-boss schema with
# DATABASE_MIGRATION_URL before the restart. Safe to re-run.

set -euo pipefail

cd "$(dirname "$0")/.."

migrate=0
ref=main
for arg in "$@"; do
	case "$arg" in
	--migrate) migrate=1 ;;
	-*)
		echo "Usage: scripts/deploy-worker.sh [--migrate] [ref]" >&2
		exit 1
		;;
	*) ref="$arg" ;;
	esac
done
if [[ ! "$ref" =~ ^[A-Za-z0-9._/-]+$ ]]; then
	echo "Invalid ref: $ref" >&2
	exit 1
fi

if [[ ! -f .env.gcp.local ]]; then
	echo "Missing .env.gcp.local: run scripts/setup-gcp-worker.sh first." >&2
	exit 1
fi
gcp_value() { grep -E "^$1=" .env.gcp.local | tail -n1 | cut -d= -f2-; }
project=$(gcp_value GCP_PROJECT_ID)
zone=$(gcp_value GCP_ZONE)
vm=$(gcp_value GCP_VM_NAME)
on_vm() { gcloud compute ssh "$vm" --project="$project" --zone="$zone" --command="$1"; }

checkout=$(on_vm 'if [ -d /opt/blankfolio/.git ]; then echo present; else echo absent; fi')
if [[ "$checkout" == *absent* ]]; then
	echo "First deploy to $vm: this creates the blankfolio user, clones the public repo"
	echo "to /opt/blankfolio, installs the worker and enables the blankfolio-worker service."
	read -rp "Continue? [y/N] " reply
	[[ "$reply" =~ ^[Yy] ]] || exit 1
elif [[ "$checkout" != *present* ]]; then
	echo "Could not reach $vm." >&2
	exit 1
fi

# The remote script travels as the ssh command rather than on stdin, because pnpm, git
# and systemd-run may read stdin and would swallow the rest of it.
read -r -d '' remote <<'REMOTE' || true
set -euo pipefail
ref="$1"
migrate="$2"
app=/opt/blankfolio
user=blankfolio
env_file=/etc/blankfolio-worker.env
cd /

if ! sudo test -f "$env_file"; then
	echo "Missing $env_file: run scripts/set-worker-env.sh first." >&2
	exit 1
fi
as_user() { sudo -u "$user" -H env CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"; }

if ! id -u "$user" >/dev/null 2>&1; then
	sudo useradd --system --create-home --home-dir /var/lib/blankfolio --shell /usr/sbin/nologin "$user"
fi
if [ ! -d "$app/.git" ]; then
	sudo install -d -o "$user" -g "$user" "$app"
	as_user git clone --quiet https://github.com/aniketmandloi/blankfolio.git "$app"
fi

as_user git -C "$app" fetch --quiet --prune --tags origin
commit=$(as_user git -C "$app" rev-parse --verify --quiet "origin/$ref^{commit}" ||
	as_user git -C "$app" rev-parse --verify "$ref^{commit}")
as_user git -C "$app" checkout --quiet --detach "$commit"
echo "Deploying $ref: $(as_user git -C "$app" log -1 --format='%h %s')"

# Corepack picks the pnpm version from the package.json in the working directory, not --dir.
cd "$app"
as_user pnpm install --frozen-lockfile --filter 'worker...'
as_user pnpm --filter worker build
cd /

if [ "$migrate" = 1 ]; then
	echo "Installing or upgrading the pg-boss schema"
	sudo systemd-run --quiet --wait --pipe --collect \
		--uid="$user" --gid="$user" \
		--working-directory="$app/apps/worker" \
		--property=EnvironmentFile="$env_file" \
		--setenv=NODE_ENV=production --setenv=VARLOCK_TELEMETRY_DISABLED=1 \
		/usr/bin/node dist/migrate.mjs </dev/null
fi

sudo install -m 644 "$app/deploy/gcp/blankfolio-worker.service" /etc/systemd/system/blankfolio-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --quiet blankfolio-worker
sudo systemctl restart blankfolio-worker
sleep 10
sudo systemctl status blankfolio-worker --no-pager --lines=0 || true
sudo journalctl -u blankfolio-worker -n 20 --no-pager
systemctl is-active --quiet blankfolio-worker
REMOTE

on_vm "bash -c $(printf '%q' "$remote") deploy-worker $ref $migrate"
