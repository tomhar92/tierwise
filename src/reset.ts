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

// Hashing the first `count` messages, each framed by its length so two
// different message lists can never concatenate to the same byte stream.
function digestPrefix(messages: unknown[], count: number): string {
  const hash = createHash("sha256");
  for (let i = 0; i < count; i++) {
    const text = JSON.stringify(stripCacheControl(messages[i])) ?? "null";
    hash.update(`${text.length}:`);
    hash.update(text);
  }
  return hash.digest("hex");
}

function shortHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stripCacheControl(value)) ?? "null").digest("hex").slice(0, 4);
}

function blockLabels(message: unknown): string[] {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return [`string#${shortHash(content)}`];
  if (!Array.isArray(content)) return [`none#${shortHash(content)}`];
  return content.map((block) => `${(block as { type?: unknown } | null)?.type ?? "?"}#${shortHash(block)}`);
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
