# Python server with a Cloudflare Quick Tunnel

A manually triggered GitHub Actions workflow serves a generated demo page with Python's standard-library HTTP server and exposes it through a temporary HTTPS URL. The Quick Tunnel itself needs no Cloudflare account or domain; automatic Worker registration requires the `REGISTRATION_TOKEN` repository secret matching the deployed Worker.

## Run

1. Configure two Actions repository secrets: `REGISTRATION_TOKEN` matching the Worker secret, and `TUNNEL_VARIABLE_TOKEN`, a dedicated user-provided fine-grained PAT scoped to this repository with **Variables: read and write**. The built-in `GITHUB_TOKEN` cannot write repository Actions variables; workflow `permissions` cannot grant this capability. Then push `.github/workflows/quick-tunnel.yml` to your GitHub repository's default branch.
2. Open **Actions → Python server with Cloudflare Quick Tunnel → Run workflow**.
3. Open the running **Serve demo and open Quick Tunnel** step. Its `Public demo:` notice contains the URL. The URL is also written to the job summary.

## Lifetime and access

- After 15 minutes without logged HTTP requests, the workflow stops both processes and finishes successfully. The idle check runs every five seconds.
- Each request logged by Python resets the timer, including errors, bots, and the initial readiness checks. No recurring HTTP health check keeps it awake.
- The entire job has a 70-minute hard limit, even if requests continue. Cancel the workflow to stop it earlier. Running time consumes GitHub Actions minutes where applicable.
- This is shutdown, not resumable sleep. Requests cannot wake a stopped runner; rerun the workflow for a new URL.
- **The URL is public and unauthenticated.** Only a generated demo directory is served, never repository files, credentials, or runner files.
- Python's HTTP server and Quick Tunnels are for development/testing, not production. Quick Tunnels have no uptime guarantee and do not support SSE.

The workflow pins `cloudflared` to version `2026.10.1` and verifies its release SHA-256 checksum. Update both together when upgrading.

[Cloudflare Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## Worker proxy

`src/worker.js` provides a stable Worker endpoint in front of a registered Quick Tunnel. Deploying the Worker requires a Cloudflare account.

### Deploy when ready

Replace the placeholder `REGISTRATION_TOKEN` in `.env` with your strong random token. Set the GitHub Actions repository secret `REGISTRATION_TOKEN` to that same value. `.env` is ignored by Git; do not commit or share it.

Run `bash deploy.sh` in your own interactive terminal with Node.js 22 or later and npm installed. The script:

1. Installs locked dependencies, runs runtime tests, and validates the deployment bundle.
2. Opens Cloudflare's browser OAuth login and shows the selected account.
3. Deploys `quick-tunnel-proxy` using `wrangler.jsonc`.
4. Reads `REGISTRATION_TOKEN` from `.env` without executing shell code, then uploads it through stdin to Wrangler. Each deployment replaces the Worker's existing token with this value; keep GitHub's secret in sync. Missing, empty, multiline, or placeholder values are rejected before login or deployment.

The script ignores inherited Cloudflare API token/key environment variables to use browser login. If your account has multiple Cloudflare accounts, set `CLOUDFLARE_ACCOUNT_ID` to the intended account before running. Wrangler prints the deployed URL. OAuth credentials are stored by Wrangler locally; no login or deployment happens merely by adding this script.

Run `bash deploy.sh --check` for validation without login or deployment. Run `npm run dev` for local development; put `REGISTRATION_TOKEN` in an ignored `.dev.vars` file for local registration.

### Register a tunnel

Send an HTTP `POST` to `https://<worker-host>/__tunnel` with:

- `Authorization: Bearer <REGISTRATION_TOKEN>`
- `Content-Type: application/json`
- JSON body: `{"host":"<tunnel-name>.trycloudflare.com"}`

Supply only the hostname, not a URL, port, or path. Registration accepts at most 1024 bytes and allows only direct `trycloudflare.com` subdomains. Registration automatically writes the repository Actions variable `TUNNEL_HOST` as JSON `{"host":"<tunnel-name>.trycloudflare.com","expiresAt":<unix-milliseconds>}` with a 70-minute lifetime. It updates the variable with PATCH, creates it with POST on 404, and retries PATCH if creation returns 422 due to a race. Repository persistence must succeed before either local cache is published. The response includes the host, expiry timestamp in Unix milliseconds, `scope: "repository"`, and `variable: "TUNNEL_HOST"`.

As soon as Cloudflare issues a hostname, the workflow first writes `TUNNEL_HOST` directly in `$GITHUB_REPOSITORY`, using `GH_TOKEN` from the `TUNNEL_VARIABLE_TOKEN` Actions secret. Its value is JSON `{host, expiresAt}`, with expiry set to now plus 70 minutes in Unix milliseconds. It PATCHes first, creates only on 404, and retries PATCH only on a 422 create race. Other HTTP failures and transport failures stop the job before registration; authenticated calls have bounded timeouts and do not follow redirects.

Only after that write succeeds does the workflow POST the hostname to `https://quick-tunnel-proxy.open-webui-cloudflare.workers.dev/__tunnel`, using `REGISTRATION_TOKEN` matching the Worker secret. The Worker still performs its own repository write with a fresh expiry before warming its local caches. Configure the Worker for the same repository; its separate `GITHUB_TOKEN` still needs the permissions described below. Missing credentials or failed persistence/registration fail the job; cleanup stops the tunnel. A failed registration does not roll back the direct variable write. No checkout or manual `TUNNEL_HOST` creation is needed. Direct persistence does not bypass existing cache staleness or GitHub visibility delays, and does not provide strong consistency.

All paths except `/__tunnel`, `/init`, and `/status` proxy to the registered HTTPS host, preserving method, path, query, application headers, and streamed bodies. Redirects pass through without being followed. HTML, absolute links, cookie domains, and redirect locations are not rewritten. Proxy access is public; registration alone requires authentication. Only register tunnels you control: the upstream receives callers' application credentials and cookies.

### Initialize or wake the tunnel

Send `POST https://quick-tunnel-proxy.open-webui-cloudflare.workers.dev/init`. No authentication or body is required. Successful responses are HTTP 200 JSON with exactly one status:

- `{"status":"ready"}`: the registered tunnel's `/` responds to an uncached `HEAD` request with a 2xx status within five seconds.
- `{"status":"loading"}`: the tunnel is unavailable, but GitHub reports a workflow run as `in_progress`, `queued`, `requested`, `waiting`, or `pending`.
- `{"status":"start"}`: no active workflow run was found, and GitHub accepted a workflow dispatch. This does not mean the tunnel is ready yet.

Configure before deployment:

1. Set `GITHUB_OWNER` and `GITHUB_REPO` in `.env`; optionally set `GITHUB_REF` to the branch or tag to run (default `main`) and `GITHUB_WORKFLOW` (default `quick-tunnel.yml`). `deploy.sh` reads these values and passes them as Worker variables for both dry runs and deployment. Missing owner/repository values stop deployment before login. Use `deploy.sh`, not bare `npm run deploy`, to include these variables.
2. Add `GITHUB_TOKEN` to your ignored `.env`. Use a fine-grained GitHub token scoped to this repository with **Actions: read and write** for workflow lookup/dispatch and **Variables: read and write** for repository registration storage. These are separate repository permissions; both are required. `deploy.sh` uploads it as a Worker secret when present; otherwise it preserves any existing Worker secret. Never put it in `wrangler.jsonc` or browser code.
3. Ensure the workflow is on the repository's default branch with `workflow_dispatch` enabled, and GitHub's `REGISTRATION_TOKEN` secret matches the Worker's registration token.
4. Redeploy with `bash deploy.sh`. Existing `.env` contents are not changed automatically.

Startup and status are public: anyone with the URL can start a workflow and consume GitHub Actions minutes. Only `/__tunnel` registration requires `REGISTRATION_TOKEN`. No secrets are embedded in the UI. Calls probe the tunnel without forwarding client cookies or credentials. GitHub credentials are sent only to `api.github.com`, with redirects disabled.

Wrong method returns `405`, missing required configuration returns `503`, and GitHub failures (including rate limits, network errors, and malformed variable data) return `502` with an error rather than a misleading status. Repository read failures fail closed: no proxying or workflow dispatch. Cache failures fall back to repository storage; cache writes are best-effort. Invalid registration credentials still return `401`. GitHub requests each time out after ten seconds. No failed dispatch is automatically retried because GitHub may have accepted it before a network failure.

Open `/status` for a public progress UI. It automatically calls `/init`, displays an indeterminate progress bar while starting, polls every five seconds, and shows an **Open application** link once ready. Errors and a ten-minute monitoring timeout show a retry button. No login is required.

The UI polls with `POST /status?format=json`. Programmatic monitoring uses the same endpoint (GET remains supported for compatibility): HTTP 200 with `{"status":"ready"}` when the tunnel is reachable, `{"status":"loading"}` when a workflow is active, or `{"status":"idle"}` otherwise. This JSON endpoint never dispatches workflows. Responses use `Cache-Control: no-store`.

When no tunnel registration exists, ordinary browser GET requests receive the same automatic startup UI instead of the old error. API requests run the `/init` logic and return `start` or `loading`; clients should retry their original request only after `ready`. Request bodies are not saved or automatically replayed. A cached but dead tunnel can still return an upstream error; open `/status` to restart it.

Stop polling once ready: successful probes reach Python and reset its 15-minute idle timer. Cold isolates and other data centers can discover the registration through the shared repository variable.

Checking runs and dispatching is not atomic. Concurrent calls or GitHub visibility delays can enqueue duplicate runs. Workflow concurrency prevents simultaneous tunnel jobs without cancelling the active job, but a queued duplicate can run later. Strict global deduplication requires a shared coordinator such as a Durable Object.

### Three-tier registration storage and consistency

Reads use these tiers in order:

1. **Isolate memory:** global registration copy for at most five seconds, bounded by record expiry.
2. **Cache API:** named cache `tunnel-registration-v2`, with a 30-second TTL (shortened near record expiry). Entries may be evicted sooner. Cache keys are per Worker origin and contents remain local to a data center.
3. **Repository Actions variable:** `TUNNEL_HOST` stores JSON `{host, expiresAt}` with a 70-minute logical lifetime from registration. The repository is the shared source of truth across isolates, data centers, and Worker origins configured for the same repository. Expiry does not delete the GitHub variable; expired records are treated as absent.

A cache miss, expired record, or malformed local cache entry triggers a repository GET. A valid repository record populates both local tiers. Missing (404) or expired repository records are not negatively cached, so later requests can discover a new registration immediately. Invalid repository records and GitHub errors return `502`, not an absent registration or a workflow dispatch.

Registration persists to GitHub before updating local memory and Cache API. Other isolates can retain the prior host for up to approximately **35 seconds** (30 seconds at the edge plus five seconds in memory), bounded by record expiry. This is a cache staleness window, not a strong consistency guarantee: concurrent writes and GitHub visibility delays are not globally coordinated. Strong consistency would require a coordinator such as a Durable Object.

Missing or expired registrations enter the startup flow; upstream network failures return `502`. A stopped tunnel whose registration has not expired may return Cloudflare's own error response. Public `POST /init` and requests with no registered tunnel can dispatch a new run. Proxied requests and successful readiness probes reach Python and reset its idle timer.

Tests run in the local Workers runtime using Miniflare, with independent isolates and shared mock repository state. They verify storage and failure behavior but cannot establish live GitHub consistency or cross-region availability.
