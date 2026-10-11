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
}

export interface MessageMark {
  count: number;
  digest: string;
}

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
}

export type Decision =
  | { kind: "held" }
  | { kind: "downgraded"; to: Tier; breakEvenTurns: number }
  | { kind: "downgraded-on-reset"; to: Tier }
  | { kind: "upgraded-on-reset"; to: Tier }
  | { kind: "upgrade-suggested"; to: Tier; estimatedCostUsd: number };
