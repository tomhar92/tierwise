import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "../src/server.js";
import { readLedger } from "../src/ledger.js";
import { DEFAULT_PRICING } from "../src/pricing.js";
import type { ClassifyResult } from "../src/types.js";

const TOOLS = [{ name: "Read" }];
const USAGE = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function listen(server: import("node:http").Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      if (typeof address === "object" && address) resolve(address.port);
    });
  });
}

// An upstream whose replies stop for the given reasons, in order, and which
// records the model each request asked for.
async function upstreamStopping(reasons: string[]) {
  const models: string[] = [];
  let call = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      models.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).model);
      const stop_reason = reasons[Math.min(call++, reasons.length - 1)];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "reply" }], stop_reason, usage: USAGE }));
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, models, close: () => server.close() };
}

const sonnet = (): ClassifyResult => ({
  choice: "sonnet",
  confidence: 0.8,
  probabilities: { haiku: 0.05, sonnet: 0.8, opus: 0.1, fable: 0.05 },
});
const opus = (): ClassifyResult => ({
  choice: "opus",
  confidence: 0.7,
  probabilities: { haiku: 0.05, sonnet: 0.15, opus: 0.7, fable: 0.1 },
});

function poster(port: number) {
  return (model: string, messages: unknown[]) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, tools: TOOLS, messages }),
    }).then((r) => r.json() as Promise<any>);
}

const toolResult = (id: string) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "file contents" }],
});
const toolUse = (id: string) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "Read", input: {} }],
});

test("a suggestion decided on a tool-calling reply is shown on the reply that ends the turn, once", async () => {
  // After a settling request, the classified request stops to call a tool;
  // the tool-result continuation (never classified) ends normally; and a
  // new user message gets its own, suggestion-free classification.
  const fake = await upstreamStopping(["end_turn", "tool_use", "end_turn", "end_turn"]);
  let call = 0;
  const router = createProxyServer({
    upstream: fake.url,
    ledgerPath: join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl"),
    classify: async () => (++call === 2 ? opus() : sonnet()),
  });
  const post = poster(await listen(router));
  const sonnetModel = DEFAULT_PRICING.modelAlias.sonnet;

  // Settle the conversation on sonnet first, so the next classification is mid-session.
  const settled = [{ role: "user", content: "start" }, { role: "assistant", content: "ok" }];
  fake.models.length = 0;
  await post(sonnetModel, [settled[0]]);
  const turn = [...settled, { role: "user", content: "a genuinely hard question" }];

  const first = await post(sonnetModel, turn);
  assert.equal(first.stop_reason, "tool_use");
  assert.equal(first.content.length, 1, "no note on a reply that stops to call a tool");

  const continuation = [...turn, toolUse("t1"), toolResult("t1")];
  const second = await post(sonnetModel, continuation);
  assert.equal(second.content.length, 2, "the note rides on the reply that ends the turn");
  assert.match(second.content[1].text, /\/model opus/);

  const third = await post(sonnetModel, [...continuation, { role: "assistant", content: "done" }, { role: "user", content: "thanks" }]);
  assert.equal(third.content.length, 1, "shown once, not repeated");

  router.close();
  fake.close();
});

test("an upgrade the router applies itself at a reset is announced, with the way back", async () => {
  const fake = await upstreamStopping(["end_turn"]);
  const router = createProxyServer({
    upstream: fake.url,
    ledgerPath: join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl"),
    classify: async () => opus(),
  });
  const post = poster(await listen(router));

  const reply = await post(DEFAULT_PRICING.modelAlias.sonnet, [{ role: "user", content: "design the migration" }]);
  assert.equal(fake.models[0], DEFAULT_PRICING.modelAlias.opus, "the request really was upgraded");
  assert.equal(reply.content.length, 2);
  assert.match(reply.content[1].text, /started on opus instead of sonnet/);
  assert.match(reply.content[1].text, /\/model sonnet/);

  router.close();
  fake.close();
});

test("a manual /model change cancels a note that was still waiting", async () => {
  const fake = await upstreamStopping(["end_turn", "tool_use", "end_turn"]);
  let call = 0;
  const router = createProxyServer({
    upstream: fake.url,
    ledgerPath: join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl"),
    classify: async () => (++call === 2 ? opus() : sonnet()),
  });
  const post = poster(await listen(router));
  const sonnetModel = DEFAULT_PRICING.modelAlias.sonnet;

  await post(sonnetModel, [{ role: "user", content: "start" }]);
  const turn = [{ role: "user", content: "start" }, { role: "assistant", content: "ok" }, { role: "user", content: "hard" }];
  const waiting = await post(sonnetModel, turn);
  assert.equal(waiting.stop_reason, "tool_use", "the suggestion has nowhere to ride yet");
  const afterSwitch = await post(DEFAULT_PRICING.modelAlias.haiku, [...turn, toolUse("t1"), toolResult("t1")]);
  assert.equal(afterSwitch.content.length, 1, "the user already chose; no note about a different choice");

  router.close();
  fake.close();
});

test("the ledger says whether a router note was held or actually shown", async () => {
  const fake = await upstreamStopping(["end_turn", "tool_use", "end_turn", "end_turn"]);
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  let call = 0;
  const router = createProxyServer({ upstream: fake.url, ledgerPath, classify: async () => (++call === 2 ? opus() : sonnet()) });
  const post = poster(await listen(router));
  const sonnetModel = DEFAULT_PRICING.modelAlias.sonnet;
  const settled = [{ role: "user", content: "start" }, { role: "assistant", content: "ok" }];
  await post(sonnetModel, [settled[0]]);
  const turn = [...settled, { role: "user", content: "a genuinely hard question" }];
  await post(sonnetModel, turn);
  const continuation = [...turn, toolUse("t1"), toolResult("t1")];
  await post(sonnetModel, continuation);
  await post(sonnetModel, [...continuation, { role: "assistant", content: "done" }, { role: "user", content: "thanks" }]);
  const lines = readLedger(ledgerPath);
  assert.deepEqual(lines.map((l) => l.note), [undefined, "held", "shown", undefined]);
  router.close();
  fake.close();
});

test("a very sure mid-session upgrade runs this turn on the higher tier and says so", async () => {
  const fake = await upstreamStopping(["end_turn"]);
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  let call = 0;
  const veryHard = (): ClassifyResult => ({
    choice: "opus",
    confidence: 0.95,
    probabilities: { haiku: 0.0, sonnet: 0.04, opus: 0.95, fable: 0.01 },
  });
  const router = createProxyServer({ upstream: fake.url, ledgerPath, classify: async () => (++call === 1 ? sonnet() : veryHard()) });
  const post = poster(await listen(router));
  const sonnetModel = DEFAULT_PRICING.modelAlias.sonnet;
  const start = [{ role: "user", content: "start" }, { role: "assistant", content: "ok" }];
  await post(sonnetModel, [start[0]]);
  fake.models.length = 0;
  const reply = await post(sonnetModel, [...start, { role: "user", content: "a genuinely hard question" }]);
  assert.equal(fake.models[0], DEFAULT_PRICING.modelAlias.opus, "this very turn ran on opus");
  assert.match(reply.content[1].text, /to opus from sonnet/);
  assert.match(reply.content[1].text, /\/model sonnet/);
  const lines = readLedger(ledgerPath);
  assert.equal(lines[1].decision, "upgraded");
  assert.equal(lines[1].actualTier, "opus");
  assert.equal(lines[1].note, "shown");
  router.close();
  fake.close();
});

test("below the threshold the same turn stays on its tier and only suggests", async () => {
  const fake = await upstreamStopping(["end_turn"]);
  let call = 0;
  const router = createProxyServer({
    upstream: fake.url,
    ledgerPath: join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl"),
    classify: async () => (++call === 1 ? sonnet() : opus()),
  });
  const post = poster(await listen(router));
  const sonnetModel = DEFAULT_PRICING.modelAlias.sonnet;
  const start = [{ role: "user", content: "start" }, { role: "assistant", content: "ok" }];
  await post(sonnetModel, [start[0]]);
  fake.models.length = 0;
  const reply = await post(sonnetModel, [...start, { role: "user", content: "a hard question" }]);
  assert.equal(fake.models[0], sonnetModel, "0.7 confidence is below the 0.9 threshold");
  assert.match(reply.content[1].text, /Run `\/model opus`/);
  router.close();
  fake.close();
});

const veryHard = (): ClassifyResult => ({
  choice: "opus",
  confidence: 0.95,
  probabilities: { haiku: 0.0, sonnet: 0.04, opus: 0.95, fable: 0.01 },
});
const modelCommand = {
  role: "user",
  content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>",
};
const startHistory = [{ role: "user", content: "start" }, { role: "assistant", content: "ok" }];
const hardPrompt = { role: "user", content: "a genuinely hard question" };

async function upgradeHarness(reasons: string[], classifications: Array<(() => ClassifyResult) | null>) {
  const fake = await upstreamStopping(reasons);
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  let call = 0;
  const router = createProxyServer({
    upstream: fake.url,
    ledgerPath,
    classify: async () => {
      const next = classifications[Math.min(call++, classifications.length - 1)];
      return next ? next() : null;
    },
  });
  const post = poster(await listen(router));
  return { fake, ledgerPath, post, close: () => { router.close(); fake.close(); } };
}

test("running /model for the model Claude Code already asks for takes the conversation back and pins it", async () => {
  const h = await upgradeHarness(["end_turn"], [sonnet, veryHard]);
  const { sonnet: sonnetModel, opus: opusModel } = DEFAULT_PRICING.modelAlias;
  await h.post(sonnetModel, [startHistory[0]]);
  const upgraded = [...startHistory, hardPrompt];
  await h.post(sonnetModel, upgraded);
  const back = [...upgraded, { role: "assistant", content: "done" }, modelCommand, { role: "user", content: "again" }];
  await h.post(sonnetModel, back);
  await h.post(sonnetModel, [...back, { role: "assistant", content: "ok" }, { role: "user", content: "another hard one" }]);
  assert.deepEqual(h.fake.models.slice(1), [opusModel, sonnetModel, sonnetModel]);
  const lines = readLedger(h.ledgerPath);
  assert.equal(lines[2].decision, "manual-switch");
  assert.equal(lines[3].decision, "upgrade-suggested", "the old command does not count twice, and the pin holds");
  h.close();
});

// 2
test("the note names the tier the conversation was on, not the one Claude Code asks for", async () => {
  const haiku = (): ClassifyResult => ({
    choice: "haiku",
    confidence: 0.99,
    probabilities: { haiku: 0.99, sonnet: 0.01, opus: 0, fable: 0 },
  });
  const h = await upgradeHarness(["end_turn"], [haiku, veryHard]);
  const sonnetModel = DEFAULT_PRICING.modelAlias.sonnet;
  await h.post(sonnetModel, [startHistory[0]]);
  const reply = await h.post(sonnetModel, [...startHistory, hardPrompt]);
  assert.match(reply.content[1].text, /to opus from haiku/);
  assert.match(reply.content[1].text, /\/model haiku/);
  h.close();
});

// 4
test("a later held turn does not erase an undelivered note about an applied upgrade", async () => {
  const h = await upgradeHarness(["end_turn", "tool_use", "end_turn"], [sonnet, veryHard, opus]);
  const sonnetModel = DEFAULT_PRICING.modelAlias.sonnet;
  await h.post(sonnetModel, [startHistory[0]]);
  await h.post(sonnetModel, [...startHistory, hardPrompt]);
  const reply = await h.post(sonnetModel, [...startHistory, hardPrompt, { role: "assistant", content: "stopped" }, { role: "user", content: "go on" }]);
  assert.equal(readLedger(h.ledgerPath)[2].decision, "held");
  assert.match(reply.content[1].text, /to opus from sonnet/);
  h.close();
});

// 7
test("an upgrade that failed upstream leaves no note behind", async () => {
  let call = 0;
  const upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const failed = ++call === 2;
      res.writeHead(failed ? 529 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(failed
        ? { type: "error", error: { type: "overloaded_error", message: "busy" } }
        : { type: "message", content: [{ type: "text", text: "reply" }], stop_reason: "end_turn", usage: USAGE }));
    });
  });
  const upstreamPort = await listen(upstream);
  let classified = 0;
  const router = createProxyServer({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    ledgerPath: join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl"),
    classify: async () => (++classified === 1 ? sonnet() : classified === 2 ? veryHard() : null),
  });
  const post = poster(await listen(router));
  const sonnetModel = DEFAULT_PRICING.modelAlias.sonnet;
  await post(sonnetModel, [startHistory[0]]);
  await post(sonnetModel, [...startHistory, hardPrompt]);
  const retry = await post(sonnetModel, [...startHistory, hardPrompt]);
  assert.equal(retry.content.length, 1);
  router.close();
  upstream.close();
});

// 3
test("the no-router baseline of an auto upgrade does not pay for the router's own cache rewrite", async () => {
  const upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [], stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 10000, cache_read_input_tokens: 0 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  let classified = 0;
  const router = createProxyServer({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    ledgerPath,
    classify: async () => (++classified === 1 ? sonnet() : veryHard()),
  });
  const post = poster(await listen(router));
  const sonnetModel = DEFAULT_PRICING.modelAlias.sonnet;
  await post(sonnetModel, [startHistory[0]]);
  await post(sonnetModel, [...startHistory, hardPrompt]);
  const line = readLedger(ledgerPath)[1];
  assert.equal(line.decision, "upgraded");
  const readCost = (10000 * DEFAULT_PRICING.rates.sonnet.cacheReadPerMTok) / 1e6;
  assert.ok(Math.abs(line.counterfactualNoRoutingCostUsd! - readCost) < 1e-9);
  router.close();
  upstream.close();
});

test("after /model changes the model, the switch is recorded and the choice pinned", async () => {
  const h = await upgradeHarness(["end_turn"], [sonnet, veryHard]);
  const { sonnet: sonnetModel, haiku: haikuModel } = DEFAULT_PRICING.modelAlias;
  const call = { type: "tool_use", id: "t1", name: "Read", input: {} };
  const thought = { type: "thinking", thinking: "hmm", signature: "s" };
  await h.post(sonnetModel, [startHistory[0]]);
  const before = [...startHistory, hardPrompt, { role: "assistant", content: [thought, call] }, toolResult("t1")];
  await h.post(sonnetModel, before.slice(0, 3));
  await h.post(sonnetModel, before);
  const switched = [
    ...before.slice(0, 3),
    { role: "assistant", content: [call] },
    toolResult("t1"),
    { role: "assistant", content: "done" },
    { ...modelCommand },
    { role: "user", content: "again" },
  ];
  await h.post(haikuModel, switched);
  await h.post(haikuModel, [...switched, { role: "assistant", content: "ok" }, { role: "user", content: "another hard one" }]);
  const lines = readLedger(h.ledgerPath);
  assert.equal(lines[3].decision, "manual-switch");
  assert.equal(lines[3].conversationKey, lines[0].conversationKey);
  assert.equal(lines[4].decision, "upgrade-suggested", "the user's choice is pinned");
  assert.equal(h.fake.models[4], haikuModel);
  h.close();
});
