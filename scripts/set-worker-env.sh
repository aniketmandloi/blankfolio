#!/usr/bin/env bash
#
# Writes the literature worker's environment to /etc/blankfolio-worker.env on the
# Google Cloud VM (root-owned, mode 600) and restarts the worker if it is running.
# Run from your Mac after scripts/setup-gcp-worker.sh. Every run replaces the whole
# file, so have all values ready; a blank optional value is left out.
#
# Values are typed at hidden prompts and sent over ssh's stdin, so they never
# appear in shell history, process arguments or this terminal.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env.gcp.local ]]; then
	echo "Missing .env.gcp.local: run scripts/setup-gcp-worker.sh first." >&2
	exit 1
fi
gcp_value() { grep -E "^$1=" .env.gcp.local | tail -n1 | cut -d= -f2-; }
project=$(gcp_value GCP_PROJECT_ID)
zone=$(gcp_value GCP_ZONE)
vm=$(gcp_value GCP_VM_NAME)

entries=""
add_entry() {
	local key="$1" value="$2"
	[[ -z "$value" ]] && return 0
	# systemd and sh both read single-quoted values literally, which keeps JSON quotes intact.
	if [[ "$value" == *"'"* || "$value" == *$'\n'* ]]; then
		echo "$key must not contain a single quote or a newline." >&2
		exit 1
	fi
	entries+="$key='$value'"$'\n'
}
ask_hidden() {
	local value
	read -rsp "$1: " value
	printf '\n' >&2
	printf '%s' "$value"
}
ask_visible() {
	local value
	read -rp "$1: " value
	printf '%s' "$value"
}

echo "Worker environment for $vm ($project, $zone)."
echo "See apps/worker/.env.schema and docs/operations/worker-gcp-runbook.md for each value."
echo

database_url=$(ask_hidden "DATABASE_URL (worker role, direct non-pooler Neon URL, required)")
if [[ -z "$database_url" ]]; then
	echo "DATABASE_URL is required." >&2
	exit 1
fi
if [[ "$database_url" == *-pooler.* ]]; then
	echo "DATABASE_URL must be the direct connection, not the -pooler host." >&2
	exit 1
fi
add_entry DATABASE_URL "$database_url"
add_entry OPENALEX_API_KEY "$(ask_hidden "OPENALEX_API_KEY (optional)")"
add_entry LITERATURE_SOURCE_PRICES "$(ask_visible "LITERATURE_SOURCE_PRICES JSON, same as the API (optional)")"
add_entry LITERATURE_SOURCE_QUOTAS "$(ask_visible "LITERATURE_SOURCE_QUOTAS JSON, same as the API (optional)")"
add_entry WORKER_POLL_INTERVAL_SECONDS "$(ask_visible "WORKER_POLL_INTERVAL_SECONDS (optional, default 30)")"
add_entry DATABASE_MIGRATION_URL "$(ask_hidden "DATABASE_MIGRATION_URL, only for deploy-worker.sh --migrate (optional)")"

echo
read -rp "Replace /etc/blankfolio-worker.env on $vm? [y/N] " reply
[[ "$reply" =~ ^[Yy] ]] || exit 1

printf '%s' "$entries" | gcloud compute ssh "$vm" --project="$project" --zone="$zone" --command='
set -e
sudo sh -c "umask 077 && cat > /etc/blankfolio-worker.env.new && chown root:root /etc/blankfolio-worker.env.new && mv /etc/blankfolio-worker.env.new /etc/blankfolio-worker.env"
echo "Saved /etc/blankfolio-worker.env"
if systemctl is-active --quiet blankfolio-worker; then
	sudo systemctl restart blankfolio-worker
	echo "Restarted blankfolio-worker"
fi
'
