import assert from "node:assert/strict";
import {
  readFile
} from "node:fs/promises";
import test from "node:test";
import {
  Miniflare,
  convertV4MiniflareOptions
} from "miniflare";

const script = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
const origin = "https://proxy.example.com";
const token = "test-only-registration-secret";

const cacheName = "tunnel-registration-v2";
const key = `${origin}/__tunnel`;
const noMemory = script.replace("const MEMORY_MS = 5_000;", "const MEMORY_MS = 0;");

async function fixture(t, source = script, options = {}) {
  const upstreamRequests = [];
  const variableRequests = [];
  // Share this Map between fixtures to model repository storage, not edge caches.
  const repository = options.repository ?? new Map();
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: source,
    compatibilityDate: "2026-10-15",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      REGISTRATION_TOKEN: token,
      GITHUB_TOKEN: "test-github-secret",
      GITHUB_OWNER: "owner",
      GITHUB_REPO: "repo",
      GITHUB_REF: "main",
      ...options.bindings,
    },
    outboundService: async (request) => {
      const captured = {
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      };
      const url = new URL(request.url);
      if (url.hostname === "api.github.com" && url.pathname.startsWith("/repos/owner/repo/actions/variables")) {
        variableRequests.push(captured);
        if (options.variableOutbound) return options.variableOutbound(captured, repository);
        if (request.method === "GET") {
          return repository.has("TUNNEL_HOST") ?
            Response.json({
              name: "TUNNEL_HOST",
              value: repository.get("TUNNEL_HOST")
            }) :
            new Response(null, {
              status: 404
            });
        }
        const {
          name,
          value
        } = JSON.parse(captured.body);
        if (request.method === "PATCH" && !repository.has(name)) return new Response(null, {
          status: 404
        });
        if (request.method === "POST" && repository.has(name)) return new Response(null, {
          status: 422
        });
        repository.set(name, value);
        return new Response(null, {
          status: request.method === "POST" ? 201 : 204
        });
      }
      upstreamRequests.push(captured);
      if (options.outbound) return options.outbound(captured);
      if (new URL(request.url).hostname === "api.github.com") {
        return request.method === "POST" ? new Response(null, {
            status: 204
          }) :
          Response.json({
            total_count: 0,
            workflow_runs: []
          });
      }
      return new Response("upstream body", {
        status: 302,
        headers: {
          Location: "https://elsewhere.example/private",
          "X-Upstream": "yes"
        },
      });
    },
  }));
  t.after(() => mf.dispose());
  const register = (host, authorization = `Bearer ${token}`) => mf.dispatchFetch(`${origin}/__tunnel`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      host
    }),
  });
  return {
    mf,
    register,
    upstreamRequests,
    variableRequests,
    repository
  };
}

test("registration requires authorization and validates hostnames", async (t) => {
  const {
    mf,
    register,
    upstreamRequests
  } = await fixture(t);
  assert.equal((await mf.dispatchFetch(`${origin}/__tunnel`)).status, 405);
  assert.equal((await register("demo.trycloudflare.com", "Bearer wrong")).status, 401);
  for (const host of ["localhost", "127.0.0.1", "trycloudflare.com", "demo.trycloudflare.com.evil.test", "https://demo.trycloudflare.com", "a.trycloudflare.com:443", "a.trycloudflare.com/path", "-a.trycloudflare.com"]) {
    assert.equal((await register(host)).status, 400, host);
  }
  assert.equal((await register("a".repeat(2048))).status, 400);
  assert.equal(upstreamRequests.length, 0);
});

test("registration writes Cache API and proxies method, path, query, headers and body", async (t) => {
  const {
    mf,
    register,
    upstreamRequests
  } = await fixture(t);
  const registration = await register("demo.trycloudflare.com");
  assert.equal(registration.status, 200);
  assert.equal(registration.headers.get("Cache-Control"), "no-store");
  const cache = await (await mf.getCaches()).open(cacheName);
  const stored = await cache.match(`${origin}/__tunnel`);
  assert.equal((await stored.json()).host, "demo.trycloudflare.com");
  const response = await mf.dispatchFetch(`${origin}/api/items?x=1&x=2`, {
    method: "PATCH",
    headers: {
      "Content-Type": "text/plain",
      "X-Test": "preserved"
    },
    body: "hello tunnel",
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://elsewhere.example/private");
  for (const header of ["Cache-Control", "CDN-Cache-Control", "Cloudflare-CDN-Cache-Control"]) {
    assert.equal(response.headers.get(header), "no-store");
  }
  assert.equal(await response.text(), "upstream body");
  assert.equal(upstreamRequests.length, 1, "redirect must not be followed");
  assert.equal(upstreamRequests[0].url, "https://demo.trycloudflare.com/api/items?x=1&x=2");
  assert.equal(upstreamRequests[0].method, "PATCH");
  assert.equal(upstreamRequests[0].body, "hello tunnel");
  assert.equal(upstreamRequests[0].headers["x-test"], "preserved");
});

test("cold isolate reads Cache API then uses global cache; registration replaces it", async (t) => {
  const {
    mf,
    register,
    upstreamRequests
  } = await fixture(t);
  const cache = await (await mf.getCaches()).open(cacheName);
  const key = `${origin}/__tunnel`;
  await cache.put(key, Response.json({
    host: "cold.trycloudflare.com",
    expiresAt: Date.now() + 60_000
  }, {
    headers: {
      "Cache-Control": "public, max-age=60"
    },
  }));
  await mf.dispatchFetch(`${origin}/first`, {
    redirect: "manual"
  });
  await cache.delete(key);
  await mf.dispatchFetch(`${origin}/second`, {
    redirect: "manual"
  });
  assert.match(upstreamRequests[1].url, /^https:\/\/cold\.trycloudflare\.com\//);
  assert.equal((await register("new.trycloudflare.com")).status, 200);
  await mf.dispatchFetch(`${origin}/third`, {
    redirect: "manual"
  });
  assert.match(upstreamRequests[2].url, /^https:\/\/new\.trycloudflare\.com\//);
  assert.equal((await mf.dispatchFetch("https://other.example.com/", {
    redirect: "manual"
  })).status, 302);
  assert.equal(upstreamRequests[3].url, "https://new.trycloudflare.com/");
});

test("refresh picks up cache changes and recovers expired local records from repository", async (t) => {
  // Disable the memory TTL for this case without waiting on wall-clock time.
  const {
    mf,
    register,
    upstreamRequests
  } = await fixture(t, script.replace("const MEMORY_MS = 5_000;", "const MEMORY_MS = 0;"));
  await register("old.trycloudflare.com");
  const cache = await (await mf.getCaches()).open(cacheName);
  const key = `${origin}/__tunnel`;
  await cache.put(key, Response.json({
    host: "updated.trycloudflare.com",
    expiresAt: Date.now() + 60_000
  }, {
    headers: {
      "Cache-Control": "public, max-age=60"
    },
  }));
  await mf.dispatchFetch(`${origin}/`, {
    redirect: "manual"
  });
  assert.match(upstreamRequests[0].url, /^https:\/\/updated\.trycloudflare\.com\//);
  await cache.put(key, Response.json({
    host: "expired.trycloudflare.com",
    expiresAt: Date.now() - 1
  }, {
    headers: {
      "Cache-Control": "public, max-age=60"
    },
  }));
  assert.equal((await mf.dispatchFetch(`${origin}/`, {
    redirect: "manual"
  })).status, 302);
  assert.equal(upstreamRequests[1].url, "https://old.trycloudflare.com/");
});

test("registration creates then updates JSON repository variable with a 70-minute lifetime", async (t) => {
  const {
    mf,
    register,
    repository,
    variableRequests
  } = await fixture(t);
  const before = Date.now();
  const response = await register("FIRST.trycloudflare.com");
  assert.equal(response.status, 200);
  const result = await response.json();
  const record = JSON.parse(repository.get("TUNNEL_HOST"));
  assert.deepEqual(result, {
    ...record,
    scope: "repository",
    variable: "TUNNEL_HOST"
  });
  assert.equal(record.host, "first.trycloudflare.com");
  assert.ok(record.expiresAt >= before + 70 * 60_000);
  assert.ok(record.expiresAt <= Date.now() + 70 * 60_000);
  assert.deepEqual(variableRequests.map((r) => r.method), ["PATCH", "POST"]);
  const base = "https://api.github.com/repos/owner/repo/actions/variables";
  assert.equal(variableRequests[0].url, `${base}/TUNNEL_HOST`);
  assert.equal(variableRequests[1].url, base);
  for (const request of variableRequests) {
    assert.deepEqual(JSON.parse(request.body), {
      name: "TUNNEL_HOST",
      value: JSON.stringify(record)
    });
    assert.equal(request.headers.authorization, "Bearer test-github-secret");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["x-github-api-version"], "2026-03-10");
  }
  const cache = await (await mf.getCaches()).open(cacheName);
  const stored = await cache.match(key);
  assert.equal(stored.headers.get("Cache-Control"), "public, max-age=30");
  assert.deepEqual(await stored.json(), record);
  assert.equal((await register("second.trycloudflare.com")).status, 200);
  assert.deepEqual(variableRequests.map((r) => r.method), ["PATCH", "POST", "PATCH"]);
  assert.equal(JSON.parse(repository.get("TUNNEL_HOST")).host, "second.trycloudflare.com");
});

test("registration publishes caches only after repository persistence completes", {
  timeout: 10_000
}, async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const {
    mf,
    register,
    repository,
    variableRequests,
    upstreamRequests
  } = await fixture(t, script, {
    variableOutbound: async (request, state) => {
      if (request.method === "GET") return new Response(null, {
        status: 404
      });
      entered.resolve();
      await release.promise;
      state.set("TUNNEL_HOST", JSON.parse(request.body).value);
      return new Response(null, {
        status: 204
      });
    },
  });
  const pending = register("committed.trycloudflare.com");
  try {
    await entered.promise;
    const cache = await (await mf.getCaches()).open(cacheName);
    assert.equal(repository.has("TUNNEL_HOST"), false);
    assert.equal(await cache.match(key), undefined);
    const page = await mf.dispatchFetch(`${origin}/`, {
      headers: {
        Accept: "text/html"
      },
      redirect: "manual"
    });
    assert.match(page.headers.get("Content-Type"), /text\/html/);
    assert.deepEqual(variableRequests.map((r) => r.method), ["PATCH", "GET"]);
    assert.equal(upstreamRequests.length, 0, "pending registration must not publish memory");
  } finally {
    release.resolve();
    await pending;
  }
  assert.equal((await pending).status, 200);
  const cache = await (await mf.getCaches()).open(cacheName);
  assert.deepEqual(await (await cache.match(key)).json(), JSON.parse(repository.get("TUNNEL_HOST")));
  await cache.delete(key);
  await mf.dispatchFetch(`${origin}/committed`, {
    redirect: "manual"
  });
  assert.equal(variableRequests.length, 2, "successful persistence publishes memory");
  assert.equal(upstreamRequests[0].url, "https://committed.trycloudflare.com/committed");
});

test("registration retries PATCH after a concurrent POST creation returns 422", async (t) => {
  const {
    register,
    variableRequests,
    repository
  } = await fixture(t, script, {
    variableOutbound: (request, state) => {
      if (request.method === "POST") {
        state.set("TUNNEL_HOST", JSON.stringify({
          host: "racer.trycloudflare.com",
          expiresAt: Date.now() + 60_000
        }));
        return new Response(null, {
          status: 422
        });
      }
      if (!state.has("TUNNEL_HOST")) return new Response(null, {
        status: 404
      });
      state.set("TUNNEL_HOST", JSON.parse(request.body).value);
      return new Response(null, {
        status: 204
      });
    },
  });
  assert.equal((await register("winner.trycloudflare.com")).status, 200);
  assert.deepEqual(variableRequests.map((r) => r.method), ["PATCH", "POST", "PATCH"]);
  assert.equal(JSON.parse(repository.get("TUNNEL_HOST")).host, "winner.trycloudflare.com");
});

test("separate isolates and origins discover shared repository and populate both caches", async (t) => {
  const writer = await fixture(t);
  await writer.register("shared.trycloudflare.com");
  const reader = await fixture(t, script, {
    repository: writer.repository
  });
  const other = "https://other.example.com";
  const cache = await (await reader.mf.getCaches()).open(cacheName);
  assert.equal(await cache.match(`${other}/__tunnel`), undefined);
  await reader.mf.dispatchFetch(`${other}/first`, {
    redirect: "manual"
  });
  assert.deepEqual(reader.variableRequests.map((r) => r.method), ["GET"]);
  const stored = await cache.match(`${other}/__tunnel`);
  assert.equal(stored.headers.get("Cache-Control"), "public, max-age=30");
  assert.deepEqual(await stored.json(), JSON.parse(writer.repository.get("TUNNEL_HOST")));
  await cache.delete(`${other}/__tunnel`);
  await reader.mf.dispatchFetch(`${other}/second`, {
    redirect: "manual"
  });
  assert.equal(reader.variableRequests.length, 1, "memory hit must avoid GitHub even without edge cache");
  assert.deepEqual(reader.upstreamRequests.map((r) => r.url), [
    "https://shared.trycloudflare.com/first", "https://shared.trycloudflare.com/second",
  ]);
});

test("edge cache avoids GitHub after memory expires and refreshes replacement after edge expiration", async (t) => {
  const writer = await fixture(t);
  await writer.register("old.trycloudflare.com");
  const reader = await fixture(t, noMemory, {
    repository: writer.repository
  });
  await reader.mf.dispatchFetch(`${origin}/first`, {
    redirect: "manual"
  });
  await writer.register("replacement.trycloudflare.com");
  await reader.mf.dispatchFetch(`${origin}/cached`, {
    redirect: "manual"
  });
  assert.equal(reader.variableRequests.length, 1);
  assert.equal(reader.upstreamRequests[1].url, "https://old.trycloudflare.com/cached");
  const cache = await (await reader.mf.getCaches()).open(cacheName);
  await cache.delete(key); // Model edge TTL expiry without a 30-second sleep.
  await reader.mf.dispatchFetch(`${origin}/fresh`, {
    redirect: "manual"
  });
  assert.equal(reader.variableRequests.length, 2);
  assert.equal(reader.upstreamRequests[2].url, "https://replacement.trycloudflare.com/fresh");
  assert.equal((await (await cache.match(key)).json()).host, "replacement.trycloudflare.com");
});

for (const [label, body] of [
    ["malformed JSON", "{"],
    ["invalid host", JSON.stringify({
      host: "evil.example",
      expiresAt: Date.now() + 60_000
    })],
    ["invalid expiry", JSON.stringify({
      host: "valid.trycloudflare.com",
      expiresAt: "tomorrow"
    })],
    ["expired", JSON.stringify({
      host: "old.trycloudflare.com",
      expiresAt: 1
    })],
  ]) {
  test(`edge ${label} falls back to repository`, async (t) => {
    const record = {
      host: "recovered.trycloudflare.com",
      expiresAt: Date.now() + 60_000
    };
    const {
      mf,
      variableRequests,
      upstreamRequests
    } = await fixture(t, script, {
      repository: new Map([
        ["TUNNEL_HOST", JSON.stringify(record)]
      ]),
    });
    const cache = await (await mf.getCaches()).open(cacheName);
    await cache.put(key, new Response(body, {
      headers: {
        "Cache-Control": "public, max-age=30"
      }
    }));
    assert.equal((await mf.dispatchFetch(`${origin}/`, {
      redirect: "manual"
    })).status, 302);
    assert.deepEqual(variableRequests.map((r) => r.method), ["GET"]);
    assert.equal(upstreamRequests[0].url, "https://recovered.trycloudflare.com/");
    assert.deepEqual(await (await cache.match(key)).json(), record);
  });
}

for (const [label, outbound, upstreamStatus] of [
    ["403", () => new Response(null, {
      status: 403
    }), 403],
    ["429", () => new Response(null, {
      status: 429
    }), 429],
    ["network failure", () => {
      throw new Error("simulated variable network failure");
    }],
    ["malformed response JSON", () => new Response("{")],
    ["missing value", () => Response.json({})],
    ["malformed value JSON", () => Response.json({
      value: "{"
    })],
    ["null record", () => Response.json({
      value: "null"
    })],
    ["invalid host", () => Response.json({
      value: JSON.stringify({
        host: "evil.example",
        expiresAt: Date.now() + 60_000
      })
    })],
    ["invalid expiry", () => Response.json({
      value: JSON.stringify({
        host: "valid.trycloudflare.com",
        expiresAt: "tomorrow"
      })
    })],
  ]) {
  test(`repository GET ${label} fails closed without proxy or dispatch`, async (t) => {
    const {
      mf,
      variableRequests,
      upstreamRequests
    } = await fixture(t, script, {
      variableOutbound: outbound
    });
    for (const endpoint of ["/init", "/status?format=json", "/api"]) {
      const response = await mf.dispatchFetch(`${origin}${endpoint}`, {
        method: "POST"
      });
      assert.equal(response.status, 502);
      const data = await response.json();
      assert.equal(typeof data.error, "string");
      if (upstreamStatus) assert.equal(data.upstreamStatus, upstreamStatus);
    }
    assert.deepEqual(variableRequests.map((r) => r.method), ["GET", "GET", "GET"]);
    assert.equal(upstreamRequests.length, 0);
    assert.equal(await (await (await mf.getCaches()).open(cacheName)).match(key), undefined);
  });
}

for (const existing of [false, true]) {
  test(`repository ${existing ? "expired record" : "404"} is absent and not negatively cached`, async (t) => {
    const repository = new Map();
    if (existing) repository.set("TUNNEL_HOST", JSON.stringify({
      host: "expired.trycloudflare.com",
      expiresAt: 1
    }));
    const {
      mf,
      variableRequests,
      upstreamRequests
    } = await fixture(t, script, {
      repository
    });
    for (let i = 0; i < 2; i++) assert.deepEqual(await (await statusRequest(mf)).json(), {
      status: "idle"
    });
    assert.equal(variableRequests.length, 2);
    assert.ok(upstreamRequests.every((r) => r.method === "GET" && r.url.includes("/workflows/")));
    const cache = await (await mf.getCaches()).open(cacheName);
    assert.equal(await cache.match(key), undefined);
    repository.set("TUNNEL_HOST", JSON.stringify({
      host: "new.trycloudflare.com",
      expiresAt: Date.now() + 60_000
    }));
    await mf.dispatchFetch(`${origin}/new`, {
      redirect: "manual"
    });
    assert.equal(variableRequests.length, 3);
    assert.equal(upstreamRequests.at(-1).url, "https://new.trycloudflare.com/new");
  });
}

for (const failureStage of ["PATCH", "POST", "race PATCH"]) {
  test(`registration ${failureStage} failure publishes neither memory nor edge cache`, async (t) => {
    const {
      mf,
      register,
      variableRequests,
      upstreamRequests
    } = await fixture(t, script, {
      variableOutbound: (request) => {
        if (request.method === "GET") return new Response(null, {
          status: 404
        });
        if (failureStage === "PATCH") return new Response(null, {
          status: 403
        });
        if (request.method === "POST") return new Response(null, {
          status: failureStage === "POST" ? 429 : 422
        });
        return new Response(null, {
          status: variableRequests.length === 1 ? 404 : 403
        });
      },
    });
    const response = await register("unpublished.trycloudflare.com");
    assert.equal(response.status, 502);
    assert.equal((await response.json()).upstreamStatus, failureStage === "POST" ? 429 : 403);
    assert.deepEqual(variableRequests.map((r) => r.method), failureStage === "PATCH" ? ["PATCH"] :
      failureStage === "POST" ? ["PATCH", "POST"] : ["PATCH", "POST", "PATCH"]);
    assert.equal(await (await (await mf.getCaches()).open(cacheName)).match(key), undefined);
    assert.deepEqual(await (await statusRequest(mf)).json(), {
      status: "idle"
    });
    assert.equal(variableRequests.at(-1).method, "GET", "failed write must not publish memory");
    assert.ok(upstreamRequests.every((r) => r.url.includes("/workflows/") && r.method === "GET"));
  });
}

for (const binding of ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"]) {
  test(`missing ${binding} returns 503 on registration and repository reads`, async (t) => {
    const {
      mf,
      register,
      variableRequests,
      upstreamRequests
    } = await fixture(t, script, {
      bindings: {
        [binding]: ""
      }
    });
    assert.equal((await register("demo.trycloudflare.com")).status, 503);
    for (const endpoint of ["/init", "/status?format=json", "/api"]) {
      assert.equal((await mf.dispatchFetch(`${origin}${endpoint}`, {
        method: "POST"
      })).status, 503);
    }
    assert.equal(variableRequests.length, 0);
    assert.equal(upstreamRequests.length, 0);
    assert.equal(await (await (await mf.getCaches()).open(cacheName)).match(key), undefined);
  });
}

function initRequest(mf) {
  return mf.dispatchFetch(`${origin}/init`, {
    method: "POST",
    headers: {
      Cookie: "private=cookie"
    },
  });
}

test("init requires POST but not authentication or a registration secret", async (t) => {
  const {
    mf,
    upstreamRequests
  } = await fixture(t, script, {
    bindings: {
      REGISTRATION_TOKEN: ""
    }
  });
  assert.equal((await mf.dispatchFetch(`${origin}/init`)).status, 405);
  assert.equal(upstreamRequests.length, 0);
  assert.deepEqual(await (await initRequest(mf)).json(), {
    status: "start"
  });
});

test("init returns ready for a healthy tunnel without GitHub access or credential forwarding", async (t) => {
  const {
    mf,
    register,
    upstreamRequests
  } = await fixture(t, script, {
    outbound: () => new Response(null, {
      status: 200
    }),
  });
  await register("healthy.trycloudflare.com");
  const response = await initRequest(mf);
  assert.deepEqual(await response.json(), {
    status: "ready"
  });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].url, "https://healthy.trycloudflare.com/");
  assert.equal(upstreamRequests[0].method, "HEAD");
  assert.equal(upstreamRequests[0].headers.authorization, undefined);
  assert.equal(upstreamRequests[0].headers.cookie, undefined);
});

for (const activeStatus of ["in_progress", "queued", "requested", "waiting", "pending"]) {
  test(`init returns loading for ${activeStatus} and does not dispatch`, async (t) => {
    const {
      mf,
      register,
      upstreamRequests
    } = await fixture(t, script, {
      outbound: (request) => {
        const url = new URL(request.url);
        if (url.hostname.endsWith("trycloudflare.com")) return new Response(null, {
          status: 503
        });
        assert.equal(request.method, "GET");
        const active = url.searchParams.get("status") === activeStatus;
        return Response.json({
          total_count: active ? 1 : 0,
          workflow_runs: active ? [{
            status: activeStatus
          }] : []
        });
      },
    });
    await register("starting.trycloudflare.com");
    assert.deepEqual(await (await initRequest(mf)).json(), {
      status: "loading"
    });
    assert.equal(upstreamRequests.filter((request) => request.method === "POST").length, 0);
  });
}

for (const dispatchStatus of [200, 204]) {
  test(`init dispatches once and returns start on GitHub ${dispatchStatus}`, async (t) => {
    const {
      mf,
      upstreamRequests
    } = await fixture(t, script, {
      bindings: {
        GITHUB_REF: "feature/tunnel"
      },
      outbound: (request) => {
        if (request.method === "POST") return new Response(null, {
          status: dispatchStatus
        });
        return Response.json({
          total_count: 0,
          workflow_runs: []
        });
      },
    });
    assert.deepEqual(await (await initRequest(mf)).json(), {
      status: "start"
    });
    const dispatches = upstreamRequests.filter((request) => request.method === "POST");
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].url, "https://api.github.com/repos/owner/repo/actions/workflows/quick-tunnel.yml/dispatches");
    assert.deepEqual(JSON.parse(dispatches[0].body), {
      ref: "feature/tunnel"
    });
    for (const request of upstreamRequests) {
      assert.equal(request.headers.authorization, "Bearer test-github-secret");
      assert.equal(request.headers.cookie, undefined);
      assert.equal(request.headers["x-github-api-version"], "2026-03-10");
    }
  });
}

test("init reports configuration and lookup failures without dispatching", async (t) => {
  const missing = await fixture(t, script, {
    bindings: {
      GITHUB_TOKEN: ""
    }
  });
  assert.equal((await initRequest(missing.mf)).status, 503);
  assert.equal(missing.upstreamRequests.length, 0);
  const failed = await fixture(t, script, {
    outbound: () => new Response(null, {
      status: 403
    })
  });
  assert.equal((await initRequest(failed.mf)).status, 502);
  assert.equal(failed.upstreamRequests.length, 1);
  const malformed = await fixture(t, script, {
    outbound: () => Response.json({})
  });
  assert.equal((await initRequest(malformed.mf)).status, 502);
  assert.equal(malformed.upstreamRequests.length, 1);
});

test("init does not return start when GitHub rejects dispatch", async (t) => {
  const {
    mf
  } = await fixture(t, script, {
    outbound: (request) => request.method === "POST" ?
      new Response(null, {
        status: 422
      }) :
      Response.json({
        total_count: 0,
        workflow_runs: []
      }),
  });
  const response = await initRequest(mf);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).upstreamStatus, 422);
});

function statusRequest(mf) {
  return mf.dispatchFetch(`${origin}/status?format=json`, {
    method: "POST"
  });
}

test("status serves a public progress UI with POST polling", async (t) => {
  const {
    mf,
    upstreamRequests
  } = await fixture(t);
  const page = await mf.dispatchFetch(`${origin}/status`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("Content-Type"), /text\/html/);
  const html = await page.text();
  assert.match(html, /<progress/);
  assert.match(html, /void start\(\)/);
  assert.ok(html.includes("call('/status?format=json', 'POST')"));
  assert.ok(!html.includes(token));
  assert.ok(!html.includes('type="password"'));
  const wrongMethod = await mf.dispatchFetch(`${origin}/status`, {
    method: "DELETE"
  });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("Allow"), "GET, POST");
  assert.equal(upstreamRequests.length, 0);
});

for (const state of ["ready", "loading", "idle"]) {
  test(`status reports ${state} without dispatching`, async (t) => {
    const {
      mf,
      register,
      upstreamRequests
    } = await fixture(t, script, {
      outbound: (request) => {
        const url = new URL(request.url);
        if (url.hostname.endsWith("trycloudflare.com")) {
          return new Response(null, {
            status: state === "ready" ? 200 : 503
          });
        }
        const active = state === "loading" && url.searchParams.get("status") === "queued";
        return Response.json({
          total_count: active ? 1 : 0,
          workflow_runs: active ? [{
            status: "queued"
          }] : []
        });
      },
    });
    if (state !== "idle") await register("monitor.trycloudflare.com");
    const response = await statusRequest(mf);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), {
      status: state
    });
    assert.ok(upstreamRequests.every((request) => request.method !== "POST"));
    if (state === "ready") assert.equal(upstreamRequests.length, 1);
  });
}

test("missing tunnel starts publicly for API requests and shows startup UI for browsers", async (t) => {
  const {
    mf,
    upstreamRequests
  } = await fixture(t);
  const page = await mf.dispatchFetch(`${origin}/app?tab=one`, {
    headers: {
      Accept: "text/html"
    }
  });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("Content-Type"), /text\/html/);
  assert.match(await page.text(), /void start\(\)/);
  assert.equal(upstreamRequests.length, 0);
  const response = await mf.dispatchFetch(`${origin}/api/data`, {
    method: "POST",
    body: "do not replay"
  });
  assert.deepEqual(await response.json(), {
    status: "start"
  });
  const dispatches = upstreamRequests.filter((request) => request.method === "POST");
  assert.equal(dispatches.length, 1);
  assert.deepEqual(JSON.parse(dispatches[0].body), {
    ref: "main"
  });
});

test("status reports GitHub failures instead of idle", async (t) => {
  const {
    mf,
    upstreamRequests
  } = await fixture(t, script, {
    outbound: () => new Response(null, {
      status: 403
    }),
  });
  const response = await statusRequest(mf);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).upstreamStatus, 403);
  assert.equal(upstreamRequests.length, 1);
});
