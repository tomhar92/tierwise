import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createConversationStore, updateState } from "../src/conversationKey.js";
import { createProxyServer } from "../src/server.js";
import { readLedger } from "../src/ledger.js";

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function seed(store: ReturnType<typeof createConversationStore>, messages: unknown[]) {
  const state = store.getOrInitState({}, "sonnet", messages);
  updateState(state, "sonnet", usage, messages);
  return state;
}

const first = { role: "user", content: [{ type: "text", text: "start the task" }] };
const reply = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] };

test("a request that changes an earlier message is reported with the block that moved", () => {
  const store = createConversationStore();
  const before = [first, reply, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "A" }] }];
  seed(store, before);
  const changedReply = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Grep", input: {} }] };
  const after = [
    first,
    changedReply,
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "A" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ];
  const state = store.getOrInitState({}, "sonnet", after);
  const note = state.identityNote;
  assert.equal(note?.reason, "diverged");
  if (note?.reason !== "diverged") return;
  assert.equal(note.at, 1);
  assert.equal(note.previousCount, 3);
  assert.equal(note.currentCount, 4);
  assert.equal(note.changedBlocks.length, 1);
  assert.match(note.changedBlocks[0], /^0: tool_use#[0-9a-f]{4} -> tool_use#[0-9a-f]{4}$/);
});

test("replacing only the newest recorded message is not an identity break", () => {
  const store = createConversationStore();
  const before = [first, reply, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "A" }] }];
  const state = seed(store, before);
  const after = [first, reply, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "B" }] }];
  assert.equal(store.getOrInitState({}, "sonnet", after), state);
});

test("a shorter history is reported as shorter", () => {
  const store = createConversationStore();
  seed(store, [first, reply, { role: "user", content: "x" }]);
  const state = store.getOrInitState({}, "sonnet", [first]);
  // A one-message history equal to the first is a shorter request.
  assert.deepEqual(state.identityNote, { reason: "shorter", previousCount: 3, currentCount: 1 });
});

test("a brand new first message is a plain new conversation, and a continuation carries no note", () => {
  const store = createConversationStore();
  const a = seed(store, [first]);
  assert.deepEqual(a.identityNote, { reason: "new-first-message" });
  const again = store.getOrInitState({}, "sonnet", [first, reply, { role: "user", content: "x" }]);
  assert.equal(again, a);
});

test("the note never contains message text", () => {
  const store = createConversationStore();
  const secret = "SECRET-PASSWORD-123";
  seed(store, [first, { role: "user", content: [{ type: "text", text: secret }] }]);
  const state = store.getOrInitState({}, "sonnet", [first, { role: "user", content: [{ type: "text", text: secret + "!" }] }]);
  assert.doesNotMatch(JSON.stringify(state.identityNote), /SECRET/);
});

test("the ledger records the note once, on the first line of the new conversation", async () => {
  const upstream = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }));
  });
  const upstreamPort = await new Promise<number>((r) => upstream.listen(0, () => r((upstream.address() as { port: number }).port)));
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "l.jsonl");
  const router = createProxyServer({ upstream: `http://127.0.0.1:${upstreamPort}`, ledgerPath, classify: async () => null });
  const port = await new Promise<number>((r) => router.listen(0, () => r((router.address() as { port: number }).port)));
  const send = (messages: unknown[]) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 10, tools: [{ name: "Read" }], messages }),
    }).then((r) => r.text());
  try {
    await send([first]);
    await send([first, reply, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "A" }] }]);
    await send([first, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Grep", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "A" }] }, { role: "assistant", content: "x" }, { role: "user", content: "y" }]);
    const lines = readLedger(ledgerPath);
    assert.equal(lines.length, 3);
    assert.equal(lines[0].identity?.reason, "new-first-message");
    assert.equal(lines[1].identity, undefined);
    assert.equal(lines[2].identity?.reason, "diverged");
  } finally {
    router.close();
    upstream.close();
  }
});

test("a prompt that turns from a list into a string stays one conversation in the ledger", async () => {
  const upstream = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "tool_use" }));
  });
  const upstreamPort = await new Promise<number>((r) => upstream.listen(0, () => r((upstream.address() as { port: number }).port)));
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "l.jsonl");
  const router = createProxyServer({ upstream: `http://127.0.0.1:${upstreamPort}`, ledgerPath, classify: async () => null });
  const port = await new Promise<number>((r) => router.listen(0, () => r((router.address() as { port: number }).port)));
  const send = (messages: unknown[]) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 10, tools: [{ name: "Read" }], messages }),
    }).then((r) => r.text());
  try {
    await send([{ role: "user", content: [{ type: "text", text: "do it", cache_control: { type: "ephemeral" } }] }]);
    await send([
      { role: "user", content: "do it" },
      reply,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ]);
    const lines = readLedger(ledgerPath);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].conversationKey, lines[1].conversationKey);
    assert.equal(lines[1].identity, undefined);
  } finally {
    router.close();
    upstream.close();
  }
});

// What Claude Code does on `/model`: it removes the previous model's thinking
// blocks from earlier replies, records the command, and may reshape other
// messages for the new model. It is still the same conversation.
const thought = { type: "thinking", thinking: "hmm", signature: "s" };
const call = { type: "tool_use", id: "t1", name: "Read", input: {} };
const toolResultB = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "A" }] };
const command = {
  role: "user",
  content: [{ type: "text", text: "<command-name>/model</command-name>\n<command-args>haiku</command-args>" }],
};

test("removing thinking blocks from earlier replies does not lose the conversation", () => {
  const store = createConversationStore();
  const state = seed(store, [first, { role: "assistant", content: [thought, call] }, toolResultB]);
  const after = [
    first,
    { role: "assistant", content: [call] },
    toolResultB,
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: "next" },
  ];
  assert.equal(store.getOrInitState({}, "haiku", after), state);
});

test("a new /model command keeps the conversation even when earlier messages were reshaped", () => {
  const store = createConversationStore();
  const state = seed(store, [first, reply, toolResultB]);
  const reshaped = [
    first,
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { reshaped: true } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "A" }, { type: "text", text: "folded reminder" }] },
    { role: "assistant", content: "done" },
    command,
    { role: "user", content: "next" },
  ];
  assert.equal(store.getOrInitState({}, "haiku", reshaped), state);
});

test("an old /model command does not excuse a later edit of the history", () => {
  const store = createConversationStore();
  const history = [first, reply, command, { role: "user", content: "q" }, { role: "assistant", content: "a" }];
  const state = seed(store, history);
  const edited = [first, { role: "assistant", content: "rewritten" }, command, { role: "user", content: "q2" }];
  assert.notEqual(store.getOrInitState({}, "sonnet", edited), state);
});
