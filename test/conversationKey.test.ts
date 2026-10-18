import { test } from "node:test";
import assert from "node:assert/strict";
import { createConversationStore, getOrInitState, updateState } from "../src/conversationKey.js";
import { markMessages } from "../src/reset.js";

test("initializes state on first use and returns the same object on reuse", () => {
  const socket = {};
  const first = getOrInitState(socket, "sonnet");
  assert.equal(first.currentTier, "sonnet");
  assert.equal(first.turnsOnCurrentTier, 0);
  assert.equal(first.lastNewTokens, 0);
  assert.equal(first.lastOutputTokens, 0);
  const second = getOrInitState(socket, "haiku");
  assert.equal(second, first);
  assert.equal(second.currentTier, "sonnet");
});

test("two different sockets never share state, and each gets a distinct connectionId", () => {
  const a = getOrInitState({}, "sonnet");
  const b = getOrInitState({}, "sonnet");
  updateState(
    a,
    "haiku",
    { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
    [{ role: "user", content: "x" }]
  );
  assert.equal(a.currentTier, "haiku");
  assert.equal(b.currentTier, "sonnet");
  assert.notEqual(a.connectionId, b.connectionId);
});

test("updateState advances tier, turn count, prefix/new/output tokens, and tracked messages", () => {
  const state = getOrInitState({}, "sonnet");
  const messages = [{ role: "user", content: "x" }, { role: "assistant", content: "y" }];
  updateState(
    state,
    "haiku",
    {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 1500,
    },
    messages
  );
  assert.equal(state.currentTier, "haiku");
  assert.equal(state.turnsOnCurrentTier, 1);
  assert.equal(state.lastPrefixTokens, 2000);
  assert.equal(state.lastNewTokens, 1000);
  assert.equal(state.lastOutputTokens, 500);
  assert.deepEqual(state.lastMark, markMessages(messages));
});

test("turnsOnCurrentTier accumulates while the tier stays the same and resets on a real change", () => {
  const state = getOrInitState({}, "sonnet");
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  updateState(state, "sonnet", usage, []);
  assert.equal(state.turnsOnCurrentTier, 1);
  updateState(state, "sonnet", usage, []);
  assert.equal(state.turnsOnCurrentTier, 2);
  updateState(state, "haiku", usage, []);
  assert.equal(state.turnsOnCurrentTier, 1);
});

test("the same first message is one conversation across sockets; cache_control does not matter", () => {
  const store = createConversationStore();
  const plain = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  const marked = [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }];
  const a = store.getOrInitState({}, "sonnet", plain);
  const b = store.getOrInitState({}, "haiku", marked);
  assert.equal(a, b);
  assert.equal(b.currentTier, "sonnet");
});

test("a different first message is a different conversation, even on the same socket", () => {
  const store = createConversationStore();
  const socket = {};
  const a = store.getOrInitState(socket, "sonnet", [{ role: "user", content: "one" }]);
  const b = store.getOrInitState(socket, "sonnet", [{ role: "user", content: "two" }]);
  assert.notEqual(a, b);
  assert.notEqual(a.connectionId, b.connectionId);
});

test("with no messages it falls back to the socket", () => {
  const store = createConversationStore();
  const socket = {};
  assert.equal(store.getOrInitState(socket, "sonnet"), store.getOrInitState(socket, "opus"));
  assert.notEqual(store.getOrInitState({}, "sonnet"), store.getOrInitState({}, "sonnet"));
});

test("two stores never share a conversation", () => {
  const messages = [{ role: "user", content: "same" }];
  assert.notEqual(
    createConversationStore().getOrInitState({}, "sonnet", messages),
    createConversationStore().getOrInitState({}, "sonnet", messages)
  );
});

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const turn = (n: number, first = "hello") => {
  const messages: unknown[] = [{ role: "user", content: first }];
  for (let i = 1; i < n; i++) {
    messages.push({ role: "assistant", content: `a${i}` }, { role: "user", content: `u${i}` });
  }
  return messages;
};

test("a continuing request finds its own state among sessions that opened with the same message", () => {
  const store = createConversationStore();
  const a = store.getOrInitState({}, "sonnet", turn(1));
  updateState(a, "sonnet", USAGE, turn(2));
  // Session B opened identically; once A has recorded history, B's
  // different second message no longer continues it.
  const bMessages = [...turn(1), { role: "assistant", content: "b-only" }, { role: "user", content: "b-follow-up" }];
  const b = store.getOrInitState({}, "sonnet", bMessages);
  assert.notEqual(a, b);
  updateState(b, "sonnet", USAGE, bMessages);

  // Each session's next turn lands back on its own state, in either order.
  assert.equal(store.getOrInitState({}, "sonnet", turn(3)), a);
  assert.equal(store.getOrInitState({}, "sonnet", [...bMessages, { role: "assistant", content: "x" }, { role: "user", content: "y" }]), b);
});

test("before any history is recorded, a second request with the same first message continues the same state", () => {
  const store = createConversationStore();
  const a = store.getOrInitState({}, "sonnet", turn(1));
  updateState(a, "sonnet", USAGE, turn(1));
  assert.equal(store.getOrInitState({}, "sonnet", turn(2)), a);
});

test("a state that never finished a turn is reused by a retry instead of leaking a new one", () => {
  const store = createConversationStore();
  const first = store.getOrInitState({}, "sonnet", turn(1));
  assert.equal(store.getOrInitState({}, "sonnet", turn(1)), first);
});

test("a rewind that no longer continues the recorded history starts a fresh state", () => {
  const store = createConversationStore();
  const original = store.getOrInitState({}, "sonnet", turn(3));
  updateState(original, "haiku", USAGE, turn(3));
  const rewound = store.getOrInitState({}, "sonnet", turn(2));
  assert.notEqual(rewound, original);
  assert.equal(rewound.currentTier, "sonnet");
  assert.equal(rewound.lastMark.count, 0);
});

test("keeps no message bodies, and bounds the states kept per first message", () => {
  const store = createConversationStore();
  const states = new Set<unknown>();
  for (let i = 0; i < 20; i++) {
    const messages = [...turn(1), { role: "assistant", content: "x" }, { role: "user", content: `divergent-${i}` }];
    const state = store.getOrInitState({}, "sonnet", messages);
    updateState(state, "sonnet", USAGE, messages);
    // Only counts and hashes are kept; a block's text never appears in the mark.
    assert.deepEqual(Object.keys(state.lastMark).sort(), ["count", "digest", "digests", "shapes"]);
    assert.doesNotMatch(JSON.stringify(state.lastMark), /divergent-|"x"/);
    states.add(state);
  }
  assert.equal(states.size, 20);
  // The oldest were dropped: replaying the first one finds nothing to continue.
  const replay = [...turn(1), { role: "assistant", content: "x" }, { role: "user", content: "divergent-0" }];
  assert.equal(store.getOrInitState({}, "sonnet", replay).lastMark.count, 0);
});
