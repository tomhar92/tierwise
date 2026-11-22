import { createHash } from "node:crypto";
import type { IdentityNote, MessageMark } from "./types.js";

// Claude Code moves the `cache_control` breakpoint marker onto whichever
// content block is now the end of the cacheable prefix, so the same
// logical message can carry a different `cache_control` field turn to
// turn even though nothing the user or assistant actually said changed.
// Comparing raw messages byte-for-byte flags that breakpoint move as a
// reset on nearly every turn, which defeats the sticky/break-even policy
// entirely (it always sees "reset" and adopts the raw classifier choice).
// Strip `cache_control` before comparing so only real content changes -
// edits, rewinds, `/clear`, `/compact` - count as a reset.
export function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripCacheControl);
  }
  if (value !== null && typeof value === "object") {
    const { cache_control, ...rest } = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(rest)) {
      normalized[key] = stripCacheControl(nested);
    }
    return normalized;
  }
  return value;
}

// Claude Code sends the same text two ways: the newest user prompt as a list of
// text blocks (the form that can carry the cache marker), and once it is older
// as a plain string. The API reads identical tokens either way, so the cache
// still hits, but compared as JSON they differ - and the router took that for
// a different conversation. Comparing in one canonical form (a list of blocks,
// tool results likewise) removes the difference without hiding a real edit.
function canonicalBlock(block: unknown): unknown {
  if (block && typeof block === "object" && (block as { type?: unknown }).type === "tool_result") {
    const { content } = block as { content?: unknown };
    if (typeof content === "string") return { ...block, content: [{ type: "text", text: content }] };
  }
  return block;
}

export function canonicalMessage(message: unknown): unknown {
  const stripped = stripCacheControl(message);
  if (!stripped || typeof stripped !== "object") return stripped;
  const { content } = stripped as { content?: unknown };
  if (typeof content === "string") return { ...stripped, content: [{ type: "text", text: content }] };
  if (Array.isArray(content)) return { ...stripped, content: content.map(canonicalBlock) };
  return stripped;
}

// Hashing the first `count` messages, each framed by its length so two
// different message lists can never concatenate to the same byte stream.
function digestPrefix(messages: unknown[], count: number): string {
  const hash = createHash("sha256");
  for (let i = 0; i < count; i++) {
    const text = JSON.stringify(canonicalMessage(messages[i])) ?? "null";
    hash.update(`${text.length}:`);
    hash.update(text);
  }
  return hash.digest("hex");
}

function hash4(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex").slice(0, 4);
}

function shortHash(message: unknown): string {
  return hash4(canonicalMessage(message));
}

function blockLabels(message: unknown): string[] {
  const content = (canonicalMessage(message) as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return [`none#${hash4(content)}`];
  return content.map((block) => `${(block as { type?: unknown } | null)?.type ?? "?"}#${hash4(block)}`);
}

function shapeOf(message: unknown): string {
  const role = (message as { role?: unknown } | null)?.role ?? "?";
  return `${role}:${blockLabels(message).join("+")}`;
}

export const EMPTY_MARK: MessageMark = { count: 0, digest: "" };

export function markMessages(messages: unknown[]): MessageMark {
  return {
    count: messages.length,
    digest: digestPrefix(messages, messages.length),
    digests: messages.map((message) => shortHash(message)),
    shapes: messages.map(shapeOf),
  };
}

/** Says where `currentMessages` stopped matching `last`, for the ledger. */
export function diagnoseDivergence(last: MessageMark, currentMessages: unknown[]): IdentityNote | undefined {
  if (currentMessages.length < last.count) {
    return { reason: "shorter", previousCount: last.count, currentCount: currentMessages.length };
  }
  const digests = last.digests ?? [];
  for (let i = 0; i < last.count && i < digests.length; i++) {
    if (shortHash(currentMessages[i]) === digests[i]) continue;
    const before = (last.shapes?.[i] ?? "").split(":").slice(1).join(":").split("+");
    const after = blockLabels(currentMessages[i]);
    const changedBlocks: string[] = [];
    for (let b = 0; b < Math.max(before.length, after.length); b++) {
      if (before[b] !== after[b]) changedBlocks.push(`${b}: ${before[b] ?? "(none)"} -> ${after[b] ?? "(none)"}`);
    }
    return { reason: "diverged", at: i, previousCount: last.count, currentCount: currentMessages.length, changedBlocks };
  }
  return undefined;
}

/** True unless `currentMessages` begins with exactly the messages that
 * `last` was taken from (ignoring cache_control placement). Only the mark is
 * kept between turns, not the messages, so a long-lived proxy does not hold
 * every tracked conversation's full history in memory. */
export function detectReset(last: MessageMark | undefined, currentMessages: unknown[]): boolean {
  if (!last || last.count === 0) return true;
  if (currentMessages.length < last.count) return true;
  return digestPrefix(currentMessages, last.count) !== last.digest;
}
