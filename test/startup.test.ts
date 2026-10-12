import { test } from "node:test";
import assert from "node:assert/strict";
import { validateStartupConfig, describeBackend } from "../src/server.js";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { run, launchClaude, launchEnv, launchLimits, hasOwnStatusLine, statusLineSettings } from "../bin/router.js";
import { DEFAULT_LIMITS } from "../src/policy.js";

test("refuses to start silently without a TypeSafe key", () => {
  const problems = validateStartupConfig({});
  assert.equal(problems.length >= 1, true);
  assert.match(problems[0], /TYPESAFE_API_KEY/);
});

test("treats a blank TypeSafe key as missing", () => {
  assert.match(validateStartupConfig({ TYPESAFE_API_KEY: "  " })[0], /TYPESAFE_API_KEY/);
});

test("warns when there is no ceiling on spend", () => {
  const problems = validateStartupConfig({ TYPESAFE_API_KEY: "k" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ROUTER_MAX_TIER/);
});

test("is quiet on a complete configuration", () => {
  assert.deepEqual(
    validateStartupConfig({ TYPESAFE_API_KEY: "k", ROUTER_MAX_TIER: "opus" }),
    []
  );
});

test("run points the child at a live proxy and returns its exit code", async () => {
  const probe = `
    const url = process.env.ANTHROPIC_BASE_URL;
    if (!/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(url)) process.exit(2);
    fetch(url + "/healthz").then(() => process.exit(0), () => process.exit(3));
  `;
  // Exit 0 means the base URL was set and something was listening on it;
  // any HTTP response at all (even a 4xx/5xx from the unrouted path) counts.
  assert.equal(await run([process.execPath, "-e", probe]), 0);
});

test("run propagates a non-zero exit code from the child", async () => {
  assert.equal(await run([process.execPath, "-e", "process.exit(7)"]), 7);
});

test("run with no command is a usage error", async () => {
  assert.equal(await run([]), 1);
});

test("does not demand a key for a self-hosted /v1/systemone endpoint", () => {
  assert.deepEqual(validateStartupConfig({ TYPESAFE_BASE_URL: "http://localhost:8000", ROUTER_MAX_TIER: "opus" }), []);
});

test("still demands a key when the base URL is TypeSafe's hosted API", () => {
  const problems = validateStartupConfig({ TYPESAFE_BASE_URL: "https://api.typesafe.ai/" });
  assert.match(problems[0], /TYPESAFE_API_KEY/);
});

test("treats an unparseable base URL as a problem rather than guessing", () => {
  const problems = validateStartupConfig({ TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "not a url", ROUTER_MAX_TIER: "opus" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /TYPESAFE_BASE_URL/);
});

test("describeBackend names the endpoint and model in use", () => {
  assert.equal(
    describeBackend({ TYPESAFE_BASE_URL: "http://localhost:8000", TYPESAFE_DEFAULT_MODEL: "openjev-4b" }),
    "http://localhost:8000 (model openjev-4b)"
  );
  assert.equal(describeBackend({}), "https://api.typesafe.ai (model jev-latest)");
});

test("the launcher caps spend at opus unless the operator chose a ceiling", () => {
  assert.equal(launchEnv({}).ROUTER_MAX_TIER, "opus");
  assert.equal(launchLimits({}).maxTier, "opus");
  assert.equal(launchEnv({ ROUTER_MAX_TIER: "fable" }).ROUTER_MAX_TIER, "fable");
  assert.equal(launchLimits({ ROUTER_MAX_TIER: "fable" }).maxTier, DEFAULT_LIMITS.maxTier);
  // The launcher's default is not a warning: opus is what the warning asks for.
  assert.deepEqual(validateStartupConfig({ ...launchEnv({}), TYPESAFE_API_KEY: "k" }), []);
});

test("the missing-key message says where to get one and how to set it", () => {
  const [problem] = validateStartupConfig({});
  assert.match(problem, /typesafe\.ai/);
  assert.match(problem, /export TYPESAFE_API_KEY=/);
});

test("bare launch runs claude with the user's arguments behind the proxy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const out = join(dir, "seen.json");
  const fake = join(dir, "claude");
  writeFileSync(
    fake,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({args: process.argv.slice(2), url: process.env.ANTHROPIC_BASE_URL}));\n`
  );
  chmodSync(fake, 0o755);
  const code = await launchClaude(["--model", "haiku"], {
    ...process.env,
    PATH: `${dir}${delimiter}${process.env.PATH}`,
    TYPESAFE_API_KEY: "k",
    TIERWISE_STATUSLINE: "0",
  });
  assert.equal(code, 0);
  const seen = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(seen.args, ["--model", "haiku"]);
  assert.match(seen.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("bare launch refuses to start without a key", async () => {
  assert.equal(await launchClaude([], { PATH: process.env.PATH }), 1);
});

test("the status line settings run this script's status command, quoting awkward paths", () => {
  const settings = JSON.parse(statusLineSettings("/a b/it's/router.js", "/usr/bin/node"));
  assert.equal(settings.statusLine.type, "command");
  assert.equal(settings.statusLine.command, "'/usr/bin/node' '/a b/it'\\''s/router.js' status");
});

test("an existing statusLine in the user's settings is detected, anywhere claude would read it", () => {
  const home = mkdtempSync(join(tmpdir(), "tierwise-home-"));
  const project = mkdtempSync(join(tmpdir(), "tierwise-proj-"));
  assert.equal(hasOwnStatusLine(home, project), false);
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
  assert.equal(hasOwnStatusLine(home, project), false);
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "x" } }));
  assert.equal(hasOwnStatusLine(home, project), true);
  writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
  assert.equal(hasOwnStatusLine(home, project), false);
});

test("bare launch hands claude the status line settings and the status file, then cleans up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const out = join(dir, "seen.json");
  const fake = join(dir, "claude");
  writeFileSync(
    fake,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({args: process.argv.slice(2), file: process.env.TIERWISE_STATUS_FILE}));\n`
  );
  chmodSync(fake, 0o755);
  const home = mkdtempSync(join(tmpdir(), "tierwise-home-"));
  const code = await launchClaude(["--model", "haiku"], {
    ...process.env,
    HOME: home,
    PATH: `${dir}${delimiter}${process.env.PATH}`,
    TYPESAFE_API_KEY: "k",
  });
  assert.equal(code, 0);
  const seen = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(seen.args[0], "--settings");
  assert.equal(JSON.parse(seen.args[1]).statusLine.type, "command");
  assert.deepEqual(seen.args.slice(2), ["--model", "haiku"]);
  assert.match(seen.file, /tierwise-\d+\.json$/);
  assert.ok(!existsSync(seen.file), "status file removed on exit");
});

test("TIERWISE_STATUSLINE=0 launches claude without touching its settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const out = join(dir, "seen.json");
  const fake = join(dir, "claude");
  writeFileSync(
    fake,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`
  );
  chmodSync(fake, 0o755);
  await launchClaude(["--model", "haiku"], {
    ...process.env,
    PATH: `${dir}${delimiter}${process.env.PATH}`,
    TYPESAFE_API_KEY: "k",
    TIERWISE_STATUSLINE: "0",
  });
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), ["--model", "haiku"]);
});

test("a user who already has a status line keeps it: no --settings is passed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const out = join(dir, "seen.json");
  const fake = join(dir, "claude");
  writeFileSync(
    fake,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`
  );
  chmodSync(fake, 0o755);
  const home = mkdtempSync(join(tmpdir(), "tierwise-home-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "mine" } }));
  await launchClaude(["-p"], {
    ...process.env,
    HOME: home,
    PATH: `${dir}${delimiter}${process.env.PATH}`,
    TYPESAFE_API_KEY: "k",
  });
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), ["-p"]);
});
