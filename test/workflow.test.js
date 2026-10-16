import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync
} from "node:fs";
import {
  tmpdir
} from "node:os";
import {
  join
} from "node:path";
import {
  spawnSync
} from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/quick-tunnel.yml", import.meta.url), "utf8");
// Extract literal run blocks from this inline-only workflow without executing setup.
const blocks = [...workflow.matchAll(/^        run: \|\n((?:          .*\n|\n)+)/gm)]
  .map((match) => match[1].replace(/^          /gm, ""));
const serve = blocks.find((block) => block.includes("variable_request()"));
assert.ok(serve);
const validation = serve.slice(0, serve.indexOf("# Serve only"));
const registration = serve.slice(serve.indexOf("# Persist directly"), serve.indexOf("# DNS and edge"));

test("workflow run blocks pass bash -n and retain secret binding without checkout", () => {
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    const result = spawnSync("bash", ["-n"], {
      input: block,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.TUNNEL_VARIABLE_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
});

function run(statuses, token = "test-only-token") {
  const dir = mkdtempSync(join(tmpdir(), "tunnel-workflow-test-"));
  try {
    // Only curl is mocked; real jq validates the nested JSON serialization.
    writeFileSync(join(dir, "curl"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const calls = JSON.parse(fs.readFileSync(process.env.CALLS, 'utf8'));
calls.push(args);
fs.writeFileSync(process.env.CALLS, JSON.stringify(calls));
const responses = JSON.parse(process.env.RESPONSES);
const response = responses[calls.length - 1];
if (response === undefined) process.exit(99);
if (response === 'network') { process.stderr.write('PRIVATE RAW ERROR'); process.exit(28); }
if (args.includes('--write-out')) process.stdout.write(String(response));
else if (response >= 400) process.exit(22);
`, {
      mode: 0o700
    });
    writeFileSync(join(dir, "calls.json"), "[]");
    const before = Date.now();
    const result = spawnSync("bash", ["-s"], {
      input: `${validation}\ntunnel_url=https://test-tunnel.trycloudflare.com\n${registration}`,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        GH_TOKEN: token,
        REGISTRATION_TOKEN: "test-registration-token",
        GITHUB_REPOSITORY: "example/repo",
        PROXY_URL: "https://worker.invalid",
        CALLS: join(dir, "calls.json"),
        RESPONSES: JSON.stringify(statuses),
      },
    });
    assert.ifError(result.error);
    assert.doesNotMatch(result.stdout + result.stderr, /test-only-token|test-registration-token|PRIVATE RAW ERROR/);
    return {
      result,
      calls: JSON.parse(readFileSync(join(dir, "calls.json"), "utf8")),
      before,
      after: Date.now()
    };
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
}

for (const [name, statuses, methods] of [
    ["existing", [204, 200],
      ["PATCH"]
    ],
    ["create", [404, 201, 200],
      ["PATCH", "POST"]
    ],
    ["create race", [404, 422, 204, 200],
      ["PATCH", "POST", "PATCH"]
    ],
  ]) {
  test(`direct persistence before registration: ${name}`, () => {
    const {
      result,
      calls,
      before,
      after
    } = run(statuses);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls.length, methods.length + 1);
    for (const [index, method] of methods.entries()) {
      const args = calls[index];
      assert.equal(args[args.indexOf("--request") + 1], method);
      assert.ok(args.includes(`https://api.github.com/repos/example/repo/actions/variables${method === "POST" ? "" : "/TUNNEL_HOST"}`));
      assert.ok(args.includes("Authorization: Bearer test-only-token"));
      assert.ok(args.includes("--connect-timeout"));
      assert.ok(args.includes("--max-time"));
      assert.equal(args[args.indexOf("--output") + 1], "/dev/null");
      assert.ok(!args.includes("--location") && !args.includes("-L"));
      const body = JSON.parse(args[args.indexOf("--data") + 1]);
      assert.equal(body.name, "TUNNEL_HOST");
      assert.equal(typeof body.value, "string");
      const record = JSON.parse(body.value);
      assert.deepEqual(Object.keys(record).sort(), ["expiresAt", "host"]);
      assert.equal(record.host, "test-tunnel.trycloudflare.com");
      assert.ok(Number.isInteger(record.expiresAt));
      assert.ok(record.expiresAt >= before + 70 * 60_000 - 1000);
      assert.ok(record.expiresAt <= after + 70 * 60_000);
    }
    const args = calls.at(-1);
    assert.ok(args.includes("https://worker.invalid/__tunnel"));
    assert.ok(args.includes("--fail-with-body"));
    assert.deepEqual(JSON.parse(args[args.indexOf("--data") + 1]), {
      host: "test-tunnel.trycloudflare.com"
    });
  });
}

for (const statuses of [
    [401],
    [403],
    [422],
    [429],
    [500],
    [302],
    ["network"],
    [404, 403],
    [404, 500],
    [404, "network"],
    [404, 422, 403],
    [404, 422, 404],
    [404, 422, "network"],
  ]) {
  test(`failure stops before registration: ${statuses.join("/")}`, () => {
    const {
      result,
      calls
    } = run(statuses);
    assert.notEqual(result.status, 0);
    assert.equal(calls.length, statuses.length);
    assert.ok(calls.every((args) => !args.includes("https://worker.invalid/__tunnel")));
  });
}

test("missing PAT fails early without any requests", () => {
  const {
    result,
    calls
  } = run([], "");
  assert.notEqual(result.status, 0);
  assert.equal(calls.length, 0);
  assert.match(result.stdout, /TUNNEL_VARIABLE_TOKEN/);
});

test("Worker registration failure remains fatal after direct persistence", () => {
  const {
    result,
    calls
  } = run([204, 503]);
  assert.notEqual(result.status, 0);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("https://worker.invalid/__tunnel"));
  assert.doesNotMatch(result.stdout, /::notice::Registered/);
});
