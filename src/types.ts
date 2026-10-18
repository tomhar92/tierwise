export type Tier = "haiku" | "sonnet" | "opus" | "fable";

export const TIER_ORDER: readonly Tier[] = ["haiku", "sonnet", "opus", "fable"];

export interface PricingRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export interface PricingConfig {
  rates: Record<Tier, PricingRates>;
  modelAlias: Record<Tier, string>;
}

export interface ClassifyResult {
  choice: Tier;
  confidence: number;
  probabilities: Record<Tier, number>;
  /** Tokens the classifier call consumed, when the backend reports them. */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface MessageMark {
  count: number;
  digest: string;
  /** One hash per message, so a later mismatch can say which message moved. */
  digests?: string[];
  /** One shape per message (role and block types with short content hashes). */
  shapes?: string[];
}

/** Why a request was not recognized as continuing a tracked conversation.
 * Types and short hashes only, never message text. */
export type IdentityNote =
  | { reason: "new-first-message" }
  | { reason: "shorter"; previousCount: number; currentCount: number }
  | {
      reason: "diverged";
      at: number;
      previousCount: number;
      currentCount: number;
      /** `index: before -> after` for each block of the message that changed. */
      changedBlocks: string[];
    };

export interface ConversationState {
  /** Stable per-socket id for this conversation, used as the ledger's
   * `conversationKey` so turns from concurrent sessions can be told apart. */
  connectionId: string;
  currentTier: Tier;
  turnsOnCurrentTier: number;
  lastPrefixTokens: number;
  lastNewTokens: number;
  lastOutputTokens: number;
  /** Fingerprint of the message history after the last successful turn: how
   * many messages there were and a digest of them. Enough to tell whether
   * the next request continues this conversation, without keeping the
   * (potentially huge) messages themselves. */
  lastMark: MessageMark;
  /** The tier Claude Code itself requested on the most recent turn, used to
   * detect a manual `/model` change so the router doesn't fight it. */
  lastRequestedTier: Tier;
  /** Set once the user has changed the model themselves. The router never
   * automatically moves a pinned conversation to a cheaper tier; it can
   * still suggest an upgrade. Ends with the conversation (`/clear`, `/compact`,
   * or a rewind/edit, which the store treats as a new one) - a later
   * `/model` re-pins at the new choice. */
  pinnedByUser?: boolean;
  /** A router note waiting for a reply it can ride on. It is decided on
   * the request that starts a user message, but that reply usually stops
   * to call a tool, and the rest of the loop is never classified, so the
   * note is held here until a reply ends normally. */
  pendingNotice?: string;
  /** Set when this state was created because a request with a known first
   * message did not continue any tracked conversation. Logged once. */
  identityNote?: IdentityNote;
}

export type Decision =
  | { kind: "held" }
  | { kind: "downgraded"; to: Tier; breakEvenTurns: number }
  | { kind: "downgraded-on-reset"; to: Tier }
  | { kind: "upgraded-on-reset"; to: Tier }
  | { kind: "upgrade-suggested"; to: Tier; estimatedCostUsd: number };
