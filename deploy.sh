#!/usr/bin/env bash
# Never expose secrets if invoked with bash -x.
set +x
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

case "${1:-}" in
  ""|--check) ;;
  -h|--help)
    echo "Usage: bash deploy.sh [--check]"
    echo "Validate, log in through a browser, deploy, and upload REGISTRATION_TOKEN from .env."
    echo "--check runs local checks only; no login or deployment."
    exit 0
    ;;
  *) echo "Unknown argument: $1" >&2; exit 2 ;;
esac
if (( $# > 1 )); then
  echo "Only one argument is supported." >&2
  exit 2
fi

command -v node >/dev/null || { echo "Install Node.js 22 or later." >&2; exit 1; }
command -v npm >/dev/null || { echo "Install npm." >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22 or later is required."); process.exit(1); }'

# Force OAuth for this script only; do not modify the caller's shell or files.
unset CLOUDFLARE_API_TOKEN CF_API_TOKEN CLOUDFLARE_API_KEY CF_API_KEY
unset CLOUDFLARE_EMAIL CF_EMAIL

# Read only supported nonsecret Worker variables; never execute .env as shell code.
worker_vars="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { parseEnv } from "node:util";
  let values;
  try { values = parseEnv(readFileSync(".env", "utf8")); }
  catch { console.error("Create .env with the deployment variables."); process.exit(1); }
  for (const [key, fallback] of Object.entries({
    GITHUB_OWNER: "", GITHUB_REPO: "", GITHUB_REF: "main", GITHUB_WORKFLOW: "quick-tunnel.yml"
  })) {
    const value = values[key] || fallback;
    if (!value || /[\r\n\0]/.test(value)) {
      console.error(`Set ${key} in .env to a nonempty single-line value.`);
      process.exit(1);
    }
    console.log(`${key}:${value}`);
  }
')"
deploy_args=()
while IFS= read -r binding; do
  deploy_args+=(--var "$binding")
done <<< "$worker_vars"
unset worker_vars

npm ci
npm test
./node_modules/.bin/wrangler deploy --dry-run "${deploy_args[@]}"
if [[ "${1:-}" == "--check" ]]; then
  echo "Checks passed. No login or deployment performed."
  exit 0
fi

# Parse dotenv as data, never source it as executable shell code.
registration_token="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { parseEnv } from "node:util";
  try {
    const token = parseEnv(readFileSync(".env", "utf8")).REGISTRATION_TOKEN;
    if (!token || token === "replace-with-your-registration-token" || /[\r\n\0]/.test(token)) {
      throw new Error("Invalid token");
    }
    process.stdout.write(token);
  } catch {
    console.error("Set REGISTRATION_TOKEN in .env to a nonempty, single-line secret (not the placeholder).");
    process.exit(1);
  }
')"

github_token="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { parseEnv } from "node:util";
  const token = parseEnv(readFileSync(".env", "utf8")).GITHUB_TOKEN ?? "";
  if (/[\r\n\0]/.test(token)) {
    console.error("GITHUB_TOKEN must be a single-line secret.");
    process.exit(1);
  }
  process.stdout.write(token);
')"

if [[ ! -t 0 ]]; then
  echo "Run this script in an interactive terminal for browser login." >&2
  exit 1
fi

wrangler=./node_modules/.bin/wrangler
"$wrangler" login --browser=true
"$wrangler" whoami
"$wrangler" deploy "${deploy_args[@]}"

# Upload on every deployment so the Worker matches .env. Never use a CLI argument.
printf '%s' "$registration_token" | "$wrangler" secret put REGISTRATION_TOKEN
unset registration_token
if [[ -n "$github_token" ]]; then
  printf '%s' "$github_token" | "$wrangler" secret put GITHUB_TOKEN
else
  echo "GITHUB_TOKEN absent from .env; existing Worker secret unchanged. /init needs it to start workflows."
fi
unset github_token

echo "Deployment complete. Keep the GitHub REGISTRATION_TOKEN secret in sync with .env."
