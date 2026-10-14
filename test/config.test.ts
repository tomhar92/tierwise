import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConfig, ConfigFileError, maskSecret, readConfig, validateSetting, writeConfig } from "../src/config.js";
import { configMain } from "../bin/config.js";

const dir = () => mkdtempSync(join(tmpdir(), "tierwise-config-"));

function capture(fn: () => number): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => void out.push(a.join(" "));
  console.error = (...a) => void err.push(a.join(" "));
  try {
    return { code: fn(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test("a stored value fills an unset variable but never overrides one that is set", () => {
  const path = join(dir(), "config.json");
  writeConfig(path, { ROUTER_MAX_TIER: "opus", TYPESAFE_API_KEY: "from-file" });
  const env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: "from-env" };
  applyConfig(env, path);
  assert.equal(env.TYPESAFE_API_KEY, "from-env");
  assert.equal(env.ROUTER_MAX_TIER, "opus");
});

test("a blank variable counts as unset, like the rest of the router", () => {
  const path = join(dir(), "config.json");
  writeConfig(path, { ROUTER_MAX_TIER: "opus" });
  const env: NodeJS.ProcessEnv = { ROUTER_MAX_TIER: "  " };
  applyConfig(env, path);
  assert.equal(env.ROUTER_MAX_TIER, "opus");
});

test("the file is created readable by its owner only", () => {
  const path = join(dir(), "nested", "config.json");
  writeConfig(path, { TYPESAFE_API_KEY: "secret" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("a missing file is empty but a malformed one is an error", () => {
  const base = dir();
  assert.deepEqual(readConfig(join(base, "none.json")), {});
  const bad = join(base, "bad.json");
  writeFileSync(bad, "{not json");
  assert.throws(() => readConfig(bad), ConfigFileError);
  writeFileSync(bad, "[1,2]");
  assert.throws(() => readConfig(bad), ConfigFileError);
});

test("keys not in the registry are ignored when applying", () => {
  const path = join(dir(), "config.json");
  writeFileSync(path, JSON.stringify({ PATH: "/evil", ROUTER_MAX_TIER: "opus" }));
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  applyConfig(env, path);
  assert.equal(env.PATH, "/usr/bin");
});

test("validation rejects unknown keys and bad values", () => {
  assert.match(validateSetting("NOPE", "1")!, /unknown setting/);
  assert.match(validateSetting("ROUTER_MARGIN_THRESHOLD", "abc")!, /number/);
  assert.match(validateSetting("ROUTER_MAX_TIER", "gpt")!, /one of/);
  assert.match(validateSetting("TYPESAFE_BASE_URL", "not a url")!, /URL/);
  assert.match(validateSetting("TYPESAFE_API_KEY", "  ")!, /empty/);
  assert.equal(validateSetting("ROUTER_MAX_TIER", "Opus"), null);
  assert.equal(validateSetting("ROUTER_MARGIN_THRESHOLD", "0.15"), null);
});

test("secrets are masked", () => {
  assert.equal(maskSecret("sk-abcdefghijkl"), "sk-…ijkl");
  assert.equal(maskSecret("short"), "****");
});

test("set, get, list and unset round trip through the file", () => {
  const path = join(dir(), "config.json");
  const env = { TIERWISE_CONFIG: path };
  assert.equal(capture(() => configMain(["set", "ROUTER_MAX_TIER", "opus"], env)).code, 0);
  assert.equal(capture(() => configMain(["set", "TYPESAFE_API_KEY", "sk-abcdefghijkl"], env)).code, 0);
  assert.equal(capture(() => configMain(["get", "ROUTER_MAX_TIER"], env)).out, "opus");
  const list = capture(() => configMain(["list"], env)).out;
  assert.match(list, /ROUTER_MAX_TIER\s+opus\s+file/);
  assert.match(list, /TYPESAFE_API_KEY\s+sk-…ijkl\s+file/);
  assert.doesNotMatch(list, /abcdefgh/);
  assert.match(list, /ROUTER_MIN_TIER\s+-\s+default/);
  assert.equal(capture(() => configMain(["unset", "ROUTER_MAX_TIER"], env)).code, 0);
  assert.equal(capture(() => configMain(["get", "ROUTER_MAX_TIER"], env)).code, 1);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).TYPESAFE_API_KEY, "sk-abcdefghijkl");
});

test("list shows an environment value as winning over the file", () => {
  const path = join(dir(), "config.json");
  writeConfig(path, { ROUTER_MAX_TIER: "opus" });
  const env = { TIERWISE_CONFIG: path, ROUTER_MAX_TIER: "sonnet" };
  assert.match(capture(() => configMain(["list"], env)).out, /ROUTER_MAX_TIER\s+sonnet\s+env/);
  assert.equal(capture(() => configMain(["get", "ROUTER_MAX_TIER"], env)).out, "sonnet");
  assert.match(capture(() => configMain(["set", "ROUTER_MAX_TIER", "haiku"], env)).out, /environment/);
});

test("set rejects bad input without touching the file", () => {
  const path = join(dir(), "config.json");
  const env = { TIERWISE_CONFIG: path };
  const result = capture(() => configMain(["set", "ROUTER_MAX_TIER", "gpt"], env));
  assert.equal(result.code, 1);
  assert.match(result.err, /one of/);
  assert.deepEqual(readConfig(path), {});
  assert.equal(capture(() => configMain(["set", "NOPE", "1"], env)).code, 1);
  assert.equal(capture(() => configMain(["frobnicate"], env)).code, 1);
});

test("a stored threshold reaches policy.ts, which reads it at import time", () => {
  const path = join(dir(), "config.json");
  writeConfig(path, { ROUTER_MARGIN_THRESHOLD: "0.77" });
  const env: NodeJS.ProcessEnv = { ...process.env, TIERWISE_CONFIG: path };
  delete env.NODE_TEST_CONTEXT;
  delete env.ROUTER_MARGIN_THRESHOLD;
  const script =
    'await import("./src/loadConfig.ts"); const p = await import("./src/policy.ts"); console.log(p.DEFAULT_LIMITS.marginThreshold)';
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env, encoding: "utf8" });
  assert.equal(run.stdout.trim(), "0.77", run.stderr);
});

test("a broken config stops the launcher with a clear message", () => {
  const path = join(dir(), "config.json");
  writeFileSync(path, "{oops");
  const env: NodeJS.ProcessEnv = { ...process.env, TIERWISE_CONFIG: path };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'await import("./src/loadConfig.ts")'], {
    env,
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /not valid JSON/);
});
