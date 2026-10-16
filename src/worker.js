import {
  createHash,
  timingSafeEqual
} from "node:crypto";

const REGISTER_PATH = "/__tunnel";
const CACHE_NAME = "tunnel-registration-v2";
const CACHE_SECONDS = 70 * 60;
const EDGE_SECONDS = 30;
const REPO_VARIABLE = "TUNNEL_HOST";
const MEMORY_MS = 5_000;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/;

// Shared configuration only: never retain Request/Response objects or I/O promises.
// Each isolate has its own copy; this is not globally consistent storage.
let cachedTunnel;
let revision = 0;

function json(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...headers
    },
  });
}

function authorized(request, secret) {
  const hash = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(
    hash(request.headers.get("Authorization") ?? ""),
    hash(`Bearer ${secret}`),
  );
}

async function readRegistration(request) {
  // Bound the actual stream size, not just an untrusted Content-Length header.
  if (!request.body) throw new Error("Missing body");
  const reader = request.body.getReader();
  const bytes = new Uint8Array(1024);
  let length = 0;
  try {
    while (true) {
      const {
        done,
        value
      } = await reader.read();
      if (done) break;
      if (length + value.byteLength > bytes.length) {
        await reader.cancel();
        throw new Error("Body too large");
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const data = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
  const host = typeof data?.host === "string" ? data.host.toLowerCase() : "";
  if (!HOST_PATTERN.test(host)) throw new Error("Invalid tunnel hostname");
  return host;
}

function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "quick-tunnel-proxy",
  };
}

class RegistrationError extends Error {
  constructor(message, status = 502, upstreamStatus) {
    super(message);
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

function registrationError(error) {
  return json({
    error: error instanceof RegistrationError ? error.message : "Could not access tunnel registration",
    ...(error.upstreamStatus ? {
      upstreamStatus: error.upstreamStatus
    } : {}),
  }, error instanceof RegistrationError ? error.status : 502);
}

async function variableRequest(env, method, body) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
    throw new RegistrationError("Configure GITHUB_TOKEN, GITHUB_OWNER and GITHUB_REPO", 503);
  }
  const base = `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/actions/variables`;
  return fetch(method === "POST" ? base : `${base}/${REPO_VARIABLE}`, {
    method,
    headers: {
      ...githubHeaders(env),
      ...(body ? {
        "Content-Type": "application/json"
      } : {})
    },
    ...(body ? {
      body: JSON.stringify(body)
    } : {}),
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
}

function validRecord(record) {
  return record && typeof record.host === "string" && HOST_PATTERN.test(record.host) &&
    Number.isFinite(record.expiresAt);
}

async function readRepository(env) {
  const response = await variableRequest(env, "GET");
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new RegistrationError("GitHub tunnel variable lookup failed", 502, response.status);
  }
  const data = await response.json();
  const record = JSON.parse(data.value);
  if (!validRecord(record)) throw new RegistrationError("Invalid GitHub tunnel variable");
  return record.expiresAt > Date.now() ? record : null;
}

async function writeRepository(env, record) {
  const body = {
    name: REPO_VARIABLE,
    value: JSON.stringify(record)
  };
  let response = await variableRequest(env, "PATCH", body);
  if (response.status === 404) {
    await response.body?.cancel();
    response = await variableRequest(env, "POST", body);
    // Another registration may have created the variable in the meantime.
    if (response.status === 422) {
      await response.body?.cancel();
      response = await variableRequest(env, "PATCH", body);
    }
  }
  await response.body?.cancel();
  if (!response.ok) throw new RegistrationError("GitHub tunnel variable write failed", 502, response.status);
}

async function cacheRecord(key, record) {
  const seconds = Math.min(EDGE_SECONDS, Math.floor((record.expiresAt - Date.now()) / 1000));
  if (seconds <= 0) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(key, Response.json(record, {
      headers: {
        "Cache-Control": `public, max-age=${seconds}`
      },
    }));
  } catch {
    // Cache is an optimization; GitHub remains the source of truth.
    console.warn("Tunnel registration cache write failed");
  }
}

async function getTunnel(key, env) {
  const now = Date.now();
  if (cachedTunnel?.key === key && cachedTunnel.refreshAt > now) {
    return cachedTunnel.record;
  }

  const observedRevision = revision;
  let record;
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(key);
    record = response ? await response.json() : null;
  } catch {
    record = null;
  }
  if (!validRecord(record) || record.expiresAt <= Date.now()) {
    record = await readRepository(env);
    if (revision !== observedRevision && cachedTunnel?.key === key) return cachedTunnel.record;
    if (record) await cacheRecord(key, record);
  }

  // A registration completing during the lookup must not be overwritten by it.
  if (revision !== observedRevision && cachedTunnel?.key === key) return cachedTunnel.record;
  if (!record || record.expiresAt <= Date.now()) {
    if (cachedTunnel?.key === key) cachedTunnel = undefined;
    return null;
  }
  cachedTunnel = {
    key,
    record,
    refreshAt: Math.min(Date.now() + MEMORY_MS, record.expiresAt),
  };
  return record;
}

async function tunnelReachable(tunnel) {
  if (!tunnel) return false;
  try {
    const response = await fetch(`https://${tunnel.host}/`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function tunnelStatus(request, env, key, allowDispatch) {
  const methods = allowDispatch ? ["POST"] : ["GET", "POST"];
  if (!methods.includes(request.method)) {
    return json({
      error: `Use ${methods.join(" or ")} for this endpoint`
    }, 405, {
      Allow: methods.join(", ")
    });
  }
  // Startup and monitoring are public. Only /__tunnel requires authentication.
  let tunnel;
  try {
    tunnel = await getTunnel(key, env);
  } catch (error) {
    return registrationError(error);
  }
  if (await tunnelReachable(tunnel)) return json({
    status: "ready"
  });

  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO || !env.GITHUB_REF) {
    return json({
      error: "Configure GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO and GITHUB_REF"
    }, 503);
  }
  const workflow = env.GITHUB_WORKFLOW || "quick-tunnel.yml";
  const base = `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/actions/workflows/${encodeURIComponent(workflow)}`;
  const headers = githubHeaders(env);
  try {
    // Filter each active state server-side: old active runs cannot be hidden by
    // pages of newer completed runs. Include all branches of this workflow.
    for (const status of ["in_progress", "queued", "requested", "waiting", "pending"]) {
      const response = await fetch(`${base}/runs?status=${status}&per_page=1`, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      if (!response.ok) {
        await response.body?.cancel();
        return json({
          error: "GitHub workflow lookup failed",
          upstreamStatus: response.status
        }, 502);
      }
      const data = await response.json();
      if (!Array.isArray(data.workflow_runs) || !Number.isInteger(data.total_count)) {
        return json({
          error: "Invalid GitHub workflow response"
        }, 502);
      }
      if (data.total_count > 0) return json({
        status: "loading"
      });
    }

    if (!allowDispatch) return json({
      status: "idle"
    });

    // GitHub lookup + dispatch is not atomic across requests or data centers.
    // Workflow concurrency prevents simultaneous tunnel jobs, not duplicate dispatches.
    const response = await fetch(`${base}/dispatches`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ref: env.GITHUB_REF
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (!response.ok) {
      return json({
        error: "GitHub workflow dispatch failed",
        upstreamStatus: response.status
      }, 502);
    }
    return json({
      status: "start"
    });
  } catch {
    return json({
      error: "GitHub API unavailable or returned invalid data"
    }, 502);
  }
}

function statusPage() {
  const nonce = crypto.randomUUID();
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tunnel startup</title>
<style nonce="${nonce}">
body{font:16px system-ui,sans-serif;background:#101827;color:#e7eef9;margin:0;min-height:100vh;display:grid;place-items:center}
main{width:min(34rem,85vw);padding:2rem;background:#1b293d;border-radius:1rem}
h1{margin-top:0}p{line-height:1.6;color:#b9c8de}label{display:block;margin-bottom:.5rem}
input{box-sizing:border-box;width:100%;padding:.8rem;border:1px solid #8096b3;border-radius:.4rem;background:#101827;color:inherit}
button,a{display:inline-block;margin-top:1rem;padding:.7rem 1rem;border:0;border-radius:.4rem;background:#8cc8ff;color:#101827;font:inherit}
button:disabled{opacity:.6}progress{width:100%;height:1rem;margin-top:1.5rem;accent-color:#8cc8ff}[hidden]{display:none!important}
</style></head>
<body><main><h1>Tunnel startup</h1>
<p id="message" role="status" aria-live="polite">Checking the tunnel…</p>
<form id="form" hidden><button id="start" type="submit">Try again</button></form>
<progress id="progress" aria-label="Tunnel startup progress"></progress>
<p id="detail">Startup is public. The workflow will start automatically if needed.</p>
<a id="open" href="/" hidden>Open application</a>
<script nonce="${nonce}">
const form = document.getElementById('form');
const button = document.getElementById('start');
const progress = document.getElementById('progress');
const message = document.getElementById('message');
const detail = document.getElementById('detail');
const open = document.getElementById('open');
let timer;
let startedAt;
const candidate = new URL(location.href).searchParams.get('returnTo') || (location.pathname === '/status' ? '/' : location.pathname + location.search);
const destination = new URL(candidate, location.origin);
if (destination.origin === location.origin && !['/status','/init','/__tunnel'].includes(destination.pathname)) {
  open.href = destination.pathname + destination.search;
}
async function call(endpoint, method) {
  const response = await fetch(endpoint, { method, headers: { Accept: 'application/json' }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(80000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed. Try again.');
  return data.status;
}
function stop(text) {
  clearTimeout(timer);
  progress.hidden = true;
  form.hidden = false;
  button.disabled = false;
  message.textContent = text;
}
function display(state) {
  if (state === 'ready') {
    progress.value = 1;
    progress.max = 1;
    message.textContent = 'Ready — the tunnel is online.';
    detail.textContent = 'Monitoring stopped. Open the application to continue.';
    open.hidden = false;
    return;
  }
  if (state === 'idle') {
    stop('No active workflow and no reachable tunnel. Start again when ready.');
    return;
  }
  if (state !== 'start' && state !== 'loading') throw new Error('Unexpected startup status.');
  message.textContent = state === 'start' ? 'Workflow started. Waiting for the tunnel…' : 'Workflow is running. Waiting for the tunnel…';
  detail.textContent = 'Checking every 5 seconds. This bar shows activity, not a completion percentage.';
  timer = setTimeout(poll, 5000);
}
async function poll() {
  try {
    if (Date.now() - startedAt > 10 * 60 * 1000) throw new Error('Startup is taking longer than 10 minutes. Check GitHub Actions and repository variable permissions.');
    display(await call('/status?format=json', 'POST'));
  } catch (error) { stop(error.message); }
}
async function start() {
  clearTimeout(timer);
  startedAt = Date.now();
  button.disabled = true;
  form.hidden = true;
  open.hidden = true;
  progress.hidden = false;
  progress.removeAttribute('value');
  message.textContent = 'Checking the tunnel and GitHub Actions…';
  try { display(await call('/init', 'POST')); }
  catch (error) { stop(error.message); }
}
form.addEventListener('submit', (event) => { event.preventDefault(); void start(); });
addEventListener('pagehide', () => clearTimeout(timer));
void start();
</script></main></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = new URL(REGISTER_PATH, url.origin).href;

    if (url.pathname === "/init") return tunnelStatus(request, env, key, true);
    if (url.pathname === "/status") {
      if (request.method === "GET" && url.searchParams.get("format") !== "json") return statusPage();
      return tunnelStatus(request, env, key, false);
    }

    if (url.pathname === REGISTER_PATH) {
      if (request.method !== "POST") {
        return json({
          error: "Use POST to register a tunnel"
        }, 405, {
          Allow: "POST"
        });
      }
      if (!env.REGISTRATION_TOKEN) {
        return json({
          error: "Registration secret is not configured"
        }, 503);
      }
      if (!authorized(request, env.REGISTRATION_TOKEN)) {
        return json({
          error: "Unauthorized"
        }, 401);
      }
      let host;
      try {
        host = await readRegistration(request);
      } catch {
        return json({
          error: "Expected JSON {host: '<name>.trycloudflare.com'} (maximum 1024 bytes)"
        }, 400);
      }
      const record = {
        host,
        expiresAt: Date.now() + CACHE_SECONDS * 1000
      };
      try {
        await writeRepository(env, record);
      } catch (error) {
        return registrationError(error);
      }
      revision++;
      cachedTunnel = {
        key,
        record,
        refreshAt: Date.now() + MEMORY_MS
      };
      await cacheRecord(key, record);
      return json({
        ...record,
        scope: "repository",
        variable: REPO_VARIABLE
      });
    }

    let tunnel;
    try {
      tunnel = await getTunnel(key, env);
    } catch (error) {
      return registrationError(error);
    }
    if (!tunnel) {
      if (request.method === "GET" && request.headers.get("Accept")?.includes("text/html")) {
        return statusPage();
      }
      // Do not replay a caller's original body after startup. Return start/loading;
      // the caller can retry its request once /status?format=json reports ready.
      return tunnelStatus(new Request(request.url, {
        method: "POST",
        headers: request.headers,
      }), env, key, true);
    }

    url.protocol = "https:";
    url.host = tunnel.host;
    try {
      // Stream both directions; keep method, path, query and application headers.
      const upstream = new Request(url, request);
      upstream.headers.delete("Host");
      // Never follow upstream redirects with the caller's cookies/credentials.
      const response = await fetch(upstream, {
        redirect: "manual",
        cache: "no-store"
      });
      // Preserve WebSocket upgrade objects; ordinary HTTP responses remain streamed.
      if (response.status === 101) return response;
      const outgoing = new Response(response.body, response);
      outgoing.headers.set("Cache-Control", "no-store");
      outgoing.headers.set("CDN-Cache-Control", "no-store");
      outgoing.headers.set("Cloudflare-CDN-Cache-Control", "no-store");
      return outgoing;
    } catch {
      return json({
        error: "Tunnel is unavailable"
      }, 502);
    }
  },
};
