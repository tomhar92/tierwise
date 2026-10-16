import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicErrorBody, describeNetworkError, OutageLog } from "../src/networkError.js";
import { createProxyServer } from "../src/server.js";

function fetchFailed(code: string, extra: object = {}): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: { code, ...extra } });
}

test("a DNS failure is described with the host and the reason", () => {
  assert.equal(
    describeNetworkError(fetchFailed("ENOTFOUND", { hostname: "api.anthropic.com" })),
    "could not reach api.anthropic.com: DNS lookup failed (ENOTFOUND)"
  );
  assert.match(describeNetworkError(fetchFailed("ECONNREFUSED", { address: "127.0.0.1" }))!, /127\.0\.0\.1: connection refused/);
});

test("anything that is not a network failure keeps its stack trace", () => {
  assert.equal(describeNetworkError(new Error("boom")), undefined);
  assert.equal(describeNetworkError(fetchFailed("ERR_SOMETHING_ELSE")), undefined);
  assert.equal(describeNetworkError(null), undefined);
});

test("the client error has Anthropic's shape", () => {
  const body = JSON.parse(anthropicErrorBody("could not reach x"));
  assert.deepEqual(body, { type: "error", error: { type: "api_error", message: "tierwise: could not reach x" } });
});

test("an outage is logged once and its end once", () => {
  const log = new OutageLog();
  assert.equal(log.succeeded(), false);
  assert.equal(log.failed(), true);
  assert.equal(log.failed(), false);
  assert.equal(log.succeeded(), true);
  assert.equal(log.succeeded(), false);
  assert.equal(log.failed(), true);
});

function listen(server: import("node:http").Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, () => resolve((server.address() as { port: number }).port))
  );
}

const messageBody = JSON.stringify({
  model: "claude-sonnet-5",
  max_tokens: 10,
  tools: [{ name: "Read" }],
  messages: [{ role: "user", content: "hi" }],
});

test("an unreachable upstream gives the client an Anthropic-shaped 502 and the log one line", async () => {
  const warn = mock.method(console, "warn", () => {});
  const error = mock.method(console, "error", () => {});
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "l.jsonl");
  // A port that was just open and is now closed refuses connections for real.
  const closed = createServer();
  const closedPort = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
  const router = createProxyServer({ upstream: `http://127.0.0.1:${closedPort}`, ledgerPath, classify: async () => null });
  const port = await listen(router);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messageBody,
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "api_error");
    assert.match(body.error.message, /could not reach 127\.0\.0\.1.*connection refused/);
    assert.equal(error.mock.callCount(), 0, "a network failure must not print a stack trace");
    assert.ok(warn.mock.calls.some((c) => /could not reach 127\.0\.0\.1/.test(String(c.arguments[0]))));
  } finally {
    router.close();
    warn.mock.restore();
    error.mock.restore();
  }
});

test("a repeating classifier outage warns once and announces recovery", async () => {
  const warn = mock.method(console, "warn", () => {});
  const upstream = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }));
  });
  const upstreamPort = await listen(upstream);
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "l.jsonl");
  let healthy = false;
  const router = createProxyServer({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    ledgerPath,
    classify: async () =>
      healthy ? { choice: "haiku" as const, confidence: 0.9, probabilities: { haiku: 0.9, sonnet: 0.05, opus: 0.03, fable: 0.02 } } : null,
  });
  const port = await listen(router);
  const send = (text: string) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 10,
        tools: [{ name: "Read" }],
        messages: [{ role: "user", content: text }],
      }),
    }).then((r) => r.text());
  try {
    await send("one");
    await send("two");
    await send("three");
    healthy = true;
    await send("four");
    const lines = warn.mock.calls.map((c) => String(c.arguments[0]));
    assert.equal(lines.filter((l) => /classifier unavailable/.test(l)).length, 1);
    assert.equal(lines.filter((l) => /classifier available again/.test(l)).length, 1);
  } finally {
    router.close();
    upstream.close();
    warn.mock.restore();
  }
});
