import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "../src/server.js";
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
