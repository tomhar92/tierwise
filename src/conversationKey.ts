import { createHash } from "node:crypto";
import type { ConversationState, IdentityNote, Tier } from "./types.js";
import { detectReset, diagnoseDivergence, EMPTY_MARK, markMessages, stripCacheControl } from "./reset.js";

const store = new WeakMap<object, ConversationState>();

// Anthropic's API sends no session id, and Claude Code opens new TCP
// connections mid-conversation (and shares one between the main thread and
// subagents), so a socket is a poor identity: a fresh connection looked
// like a brand-new conversation, which is a reset, which let an upgrade
// through that the policy says is only ever a suggestion. A conversation
// is identified by its first message instead. It is stable for the life
// of a session, and `/clear`, `/compact` and every new subagent start
// with a different one.
//
// The first message alone is not unique: two sessions can open with the
// same text. So the first message only narrows the search to a few
// candidates, and the one whose recorded history the incoming request
// actually continues wins. Anything that continues none of them (a second
// session that has since diverged, or a rewind or edit of an earlier
// message) starts a fresh state; for a rewind that costs nothing the reset
// had not already cost, since the cache is rebuilt either way.
// Bounded: oldest-used evicted first.
const MAX_CONVERSATIONS = 500;
const MAX_STATES_PER_FIRST_MESSAGE = 8;

function fingerprint(messages: unknown[]): string | null {
  if (messages.length === 0) return null;
  return createHash("sha256")
    .update(JSON.stringify(stripCacheControl(messages[0])))
    .digest("hex");
}

// Ledger lines need a conversationKey that actually distinguishes
// concurrent sessions - the previous hardcoded "socket" string logged the
// same literal for every connection, making it useless for telling
// interleaved sessions apart in the report. This is process-local and
// resets on restart, which is fine: it only needs to be unique among the
// connections a single running proxy instance is currently juggling.
let nextConnectionId = 0;

export interface ConversationStore {
  getOrInitState(socket: object, initialTier: Tier, messages?: unknown[]): ConversationState;
}

// One store per proxy instance, so two servers (or two tests) never share
// conversations just because their first messages happen to match.
export function createConversationStore(): ConversationStore {
  // Candidates per first message, oldest-used first.
  const byFingerprint = new Map<string, ConversationState[]>();
  // Every tracked state and its key, oldest-used first (Map order is
  // insertion order, refreshed by delete + set).
  const recency = new Map<ConversationState, string>();

  function forget(state: ConversationState): void {
    const key = recency.get(state);
    if (key === undefined) return;
    recency.delete(state);
    const remaining = (byFingerprint.get(key) ?? []).filter((s) => s !== state);
    if (remaining.length === 0) byFingerprint.delete(key);
    else byFingerprint.set(key, remaining);
  }

  function remember(state: ConversationState, key: string): void {
    forget(state);
    byFingerprint.set(key, [...(byFingerprint.get(key) ?? []), state]);
    recency.set(state, key);
    const siblings = byFingerprint.get(key)!;
    if (siblings.length > MAX_STATES_PER_FIRST_MESSAGE) forget(siblings[0]);
    if (recency.size > MAX_CONVERSATIONS) forget(recency.keys().next().value as ConversationState);
  }

  return {
    getOrInitState(socket, initialTier, messages = []) {
      const key = fingerprint(messages);
      if (key !== null) {
        const candidates = byFingerprint.get(key) ?? [];
        for (let i = candidates.length - 1; i >= 0; i--) {
          const candidate = candidates[i];
          // A state that never completed a turn (its first request failed)
          // has nothing to disagree with, so a retry reuses it.
          if (candidate.lastMark.count === 0 || !detectReset(candidate.lastMark, messages)) {
            remember(candidate, key);
            return candidate;
          }
        }
      }
      let identityNote: IdentityNote | undefined;
      if (key !== null) {
        const newest = (byFingerprint.get(key) ?? []).at(-1);
        identityNote = newest ? diagnoseDivergence(newest.lastMark, messages) : { reason: "new-first-message" };
      }
      let state = key === null ? store.get(socket) : undefined;
      if (!state) {
        nextConnectionId += 1;
        state = {
          connectionId: `${key === null ? "conn" : "conv"}-${nextConnectionId}`,
          currentTier: initialTier,
          turnsOnCurrentTier: 0,
          lastPrefixTokens: 0,
          lastNewTokens: 0,
          lastOutputTokens: 0,
          lastMark: EMPTY_MARK,
          lastRequestedTier: initialTier,
        };
        if (identityNote) state.identityNote = identityNote;
        if (key === null) store.set(socket, state);
        else remember(state, key);
      }
      return state;
    },
  };
}

const defaultStore = createConversationStore();

export function getOrInitState(
  socket: object,
  initialTier: Tier,
  messages: unknown[] = []
): ConversationState {
  return defaultStore.getOrInitState(socket, initialTier, messages);
}

export function updateState(
  state: ConversationState,
  decisionTier: Tier,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
  currentMessages: unknown[]
): void {
  state.turnsOnCurrentTier = decisionTier === state.currentTier ? state.turnsOnCurrentTier + 1 : 1;
  state.currentTier = decisionTier;
  state.lastPrefixTokens =
    (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  state.lastNewTokens = usage.input_tokens ?? 0;
  state.lastOutputTokens = usage.output_tokens ?? 0;
  state.lastMark = markMessages(currentMessages);
}
