import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decide, envNumber, DEFAULT_LIMITS, type PolicyLimits } from "../src/policy.js";
import { DEFAULT_PRICING } from "../src/pricing.js";
import { markMessages } from "../src/reset.js";
import type { ConversationState, ClassifyResult, Tier } from "../src/types.js";

const thresholdsFixture = fileURLToPath(
  new URL("./fixtures/policy-thresholds.ts", import.meta.url)
);

function readThresholds(env: Record<string, string> = {}): { MARGIN_THRESHOLD: number; STICKY_ASSUMPTION: number; DEFAULT_LIMITS: PolicyLimits } {
  const output = execFileSync(process.execPath, ["--import", "tsx", thresholdsFixture], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return JSON.parse(output);
}

test("MARGIN_THRESHOLD/STICKY_ASSUMPTION default to 0.1/3 with no env override", () => {
  const thresholds = readThresholds();
  assert.equal(thresholds.MARGIN_THRESHOLD, 0.1);
  assert.equal(thresholds.STICKY_ASSUMPTION, 3);
});

test("MARGIN_THRESHOLD/STICKY_ASSUMPTION pick up ROUTER_MARGIN_THRESHOLD/ROUTER_STICKY_ASSUMPTION", () => {
  const thresholds = readThresholds({
    ROUTER_MARGIN_THRESHOLD: "0.25",
    ROUTER_STICKY_ASSUMPTION: "5",
  });
  assert.equal(thresholds.MARGIN_THRESHOLD, 0.25);
  assert.equal(thresholds.STICKY_ASSUMPTION, 5);
});

test("DEFAULT_LIMITS picks up ROUTER_MAX_TIER and ROUTER_RESET_CONFIDENCE_FLOOR", () => {
  const thresholds = readThresholds({
    ROUTER_MAX_TIER: "opus",
    ROUTER_RESET_CONFIDENCE_FLOOR: "0.7",
  });
  assert.equal(thresholds.DEFAULT_LIMITS.maxTier, "opus");
  assert.equal(thresholds.DEFAULT_LIMITS.resetConfidenceFloor, 0.7);
});

test("envNumber: uses the fallback when the env var is unset", () => {
  assert.equal(envNumber("ROUTER_TEST_DOES_NOT_EXIST", 0.1), 0.1);
});

test("envNumber: parses a valid numeric value", () => {
  process.env.ROUTER_TEST_NUMBER = "0.25";
  try {
    assert.equal(envNumber("ROUTER_TEST_NUMBER", 0.1), 0.25);
  } finally {
    delete process.env.ROUTER_TEST_NUMBER;
  }
});

test("envNumber: falls back on an empty string, not on Number('') === 0", () => {
  process.env.ROUTER_TEST_NUMBER = "";
  try {
    assert.equal(envNumber("ROUTER_TEST_NUMBER", 3), 3);
  } finally {
    delete process.env.ROUTER_TEST_NUMBER;
  }
});

test("envNumber: falls back on a whitespace-only value, not on Number(' ') === 0", () => {
  process.env.ROUTER_TEST_NUMBER = "   ";
  try {
    assert.equal(envNumber("ROUTER_TEST_NUMBER", 3), 3);
  } finally {
    delete process.env.ROUTER_TEST_NUMBER;
  }
});

test("envNumber: falls back on a non-numeric value instead of silently becoming NaN", () => {
  process.env.ROUTER_TEST_NUMBER = "not-a-number";
  try {
    assert.equal(envNumber("ROUTER_TEST_NUMBER", 3), 3);
  } finally {
    delete process.env.ROUTER_TEST_NUMBER;
  }
});

test("envNumber: falls back on Infinity/-Infinity instead of a threshold no margin could ever clear", () => {
  process.env.ROUTER_TEST_NUMBER = "Infinity";
  try {
    assert.equal(envNumber("ROUTER_TEST_NUMBER", 0.1), 0.1);
  } finally {
    delete process.env.ROUTER_TEST_NUMBER;
  }
});

function state(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    connectionId: "conn-1",
    currentTier: "sonnet",
    turnsOnCurrentTier: 5,
    lastPrefixTokens: 20_000,
    lastNewTokens: 1_000,
    lastOutputTokens: 500,
    lastMark: markMessages([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]),
    lastRequestedTier: "sonnet",
    ...overrides,
  };
}

const currentMessages = [
  { role: "user", content: "a" },
  { role: "assistant", content: "b" },
  { role: "user", content: "c" },
];

test("holds when neither margin clears the threshold", () => {
  const classification: ClassifyResult = {
    choice: "sonnet",
    confidence: 0.4,
    probabilities: { haiku: 0.15, sonnet: 0.4, opus: 0.35, fable: 0.1 },
  };
  const decision = decide(classification, state(), currentMessages, DEFAULT_PRICING);
  assert.deepEqual(decision, { kind: "held" });
});

test("downgrades automatically on a steep price drop (opus -> haiku) whose break-even is well under STICKY_ASSUMPTION", () => {
  const classification: ClassifyResult = {
    choice: "haiku",
    confidence: 0.6,
    probabilities: { haiku: 0.6, sonnet: 0.05, opus: 0.3, fable: 0.05 },
  };
  const decision = decide(
    classification,
    state({ currentTier: "opus" }),
    currentMessages,
    DEFAULT_PRICING
  );
  assert.equal(decision.kind, "downgraded");
  if (decision.kind === "downgraded") {
    assert.equal(decision.to, "haiku");
    assert.ok(decision.breakEvenTurns < 1, `expected well under 1, got ${decision.breakEvenTurns}`);
  }
});

test("declines a shallow-drop downgrade (sonnet -> haiku) whose break-even exceeds STICKY_ASSUMPTION", () => {
  const classification: ClassifyResult = {
    choice: "haiku",
    confidence: 0.5,
    probabilities: { haiku: 0.5, sonnet: 0.3, opus: 0.15, fable: 0.05 },
  };
  const decision = decide(classification, state(), currentMessages, DEFAULT_PRICING);
  assert.deepEqual(decision, { kind: "held" });
});

test("never auto-switches on an upgrade outside a reset window; suggests instead, with the cache rebuild as the estimated cost", () => {
  const classification: ClassifyResult = {
    choice: "opus",
    confidence: 0.7,
    probabilities: { haiku: 0.05, sonnet: 0.15, opus: 0.7, fable: 0.1 },
  };
  const decision = decide(classification, state(), currentMessages, DEFAULT_PRICING);
  assert.equal(decision.kind, "upgrade-suggested");
  if (decision.kind === "upgrade-suggested") {
    assert.equal(decision.to, "opus");
    // 21,500 tokens of history written to opus instead of read from sonnet.
    const { opus, sonnet } = DEFAULT_PRICING.rates;
    const expected = (21_500 * (opus.cacheWritePerMTok - sonnet.cacheReadPerMTok)) / 1e6;
    assert.ok(Math.abs(decision.estimatedCostUsd - expected) < 1e-9);
  }
});

test("on reset, adopts the argmax choice immediately with no margin or break-even check, downgrade direction", () => {
  const classification: ClassifyResult = {
    choice: "haiku",
    confidence: 0.34,
    probabilities: { haiku: 0.34, sonnet: 0.33, opus: 0.17, fable: 0.16 },
  };
  const resetState = state({ lastMark: markMessages([]) });
  const decision = decide(classification, resetState, currentMessages, DEFAULT_PRICING, {
    ...DEFAULT_LIMITS,
    marginThreshold: 0,
    resetConfidenceFloor: 0,
  });
  assert.deepEqual(decision, { kind: "downgraded-on-reset", to: "haiku" });
});

test("on reset, adopts the argmax choice immediately, upgrade direction", () => {
  const classification: ClassifyResult = {
    choice: "opus",
    confidence: 0.4,
    probabilities: { haiku: 0.1, sonnet: 0.3, opus: 0.4, fable: 0.2 },
  };
  const resetState = state({ lastMark: markMessages([]) });
  const decision = decide(classification, resetState, currentMessages, DEFAULT_PRICING, {
    ...DEFAULT_LIMITS,
    marginThreshold: 0,
    resetConfidenceFloor: 0,
  });
  assert.deepEqual(decision, { kind: "upgraded-on-reset", to: "opus" });
});

test("on reset, holds when the argmax choice equals the current tier", () => {
  const classification: ClassifyResult = {
    choice: "sonnet",
    confidence: 0.4,
    probabilities: { haiku: 0.2, sonnet: 0.4, opus: 0.3, fable: 0.1 },
  };
  const resetState = state({ lastMark: markMessages([]) });
  const decision = decide(classification, resetState, currentMessages, DEFAULT_PRICING);
  assert.deepEqual(decision, { kind: "held" });
});

test("when both a downgrade and an upgrade candidate clear the threshold, the larger margin wins (downgrade), and it clears break-even too", () => {
  const classification: ClassifyResult = {
    choice: "haiku",
    confidence: 0.45,
    probabilities: { haiku: 0.45, sonnet: 0.05, opus: 0.15, fable: 0.35 },
  };
  const decision = decide(
    classification,
    state({ currentTier: "opus" }),
    currentMessages,
    DEFAULT_PRICING
  );
  assert.equal(decision.kind, "downgraded");
  if (decision.kind === "downgraded") assert.equal(decision.to, "haiku");
});

test("when both clear the threshold, the larger margin wins (upgrade)", () => {
  const classification: ClassifyResult = {
    choice: "opus",
    confidence: 0.58,
    probabilities: { haiku: 0.22, sonnet: 0.1, opus: 0.58, fable: 0.1 },
  };
  const decision = decide(classification, state(), currentMessages, DEFAULT_PRICING);
  assert.equal(decision.kind, "upgrade-suggested");
  if (decision.kind === "upgrade-suggested") assert.equal(decision.to, "opus");
});

const LIMITS = {
  marginThreshold: 0.1,
  stickyAssumption: 3,
  minTier: "haiku" as const,
  maxTier: "fable" as const,
  resetConfidenceFloor: 0.5,
  upgradeMode: "auto" as const,
  upgradeConfidence: 0.9,
  upgradeMaxCostUsd: 1,
};

test("a reset holds when the classifier is not confident enough to spend on a switch", () => {
  const resetState = state({ currentTier: "sonnet", lastMark: markMessages([]) });
  const classification: ClassifyResult = {
    choice: "fable",
    confidence: 0.34,
    probabilities: { haiku: 0.1, sonnet: 0.22, opus: 0.34, fable: 0.34 },
  };
  const decision = decide(classification, resetState, [{ role: "user", content: "go" }], DEFAULT_PRICING, LIMITS);
  assert.equal(decision.kind, "held");
});

test("ROUTER_MAX_TIER caps a reset-window upgrade at the ceiling", () => {
  const resetState = state({ currentTier: "sonnet", lastMark: markMessages([]) });
  const classification: ClassifyResult = {
    choice: "fable",
    confidence: 0.9,
    probabilities: { haiku: 0.02, sonnet: 0.03, opus: 0.15, fable: 0.8 },
  };
  const decision = decide(classification, resetState, [{ role: "user", content: "go" }], DEFAULT_PRICING, {
    ...LIMITS,
    maxTier: "opus",
  });
  assert.equal(decision.kind, "upgraded-on-reset");
  assert.equal(decision.kind === "upgraded-on-reset" && decision.to, "opus");
});

test("ROUTER_MAX_TIER keeps fable out of the non-reset upgrade candidates", () => {
  const resetState = state({ currentTier: "sonnet", lastMark: markMessages([{ role: "user", content: "go" }]) });
  const classification: ClassifyResult = {
    choice: "fable",
    confidence: 0.9,
    probabilities: { haiku: 0.02, sonnet: 0.03, opus: 0.05, fable: 0.9 },
  };
  const decision = decide(classification, resetState, [{ role: "user", content: "go" }], DEFAULT_PRICING, {
    ...LIMITS,
    maxTier: "opus",
  });
  assert.equal(decision.kind, "held");
});

// A mid-session upgrade is decided for the turn that just arrived, so a
// suggestion shown after the reply helps nothing for it. When the classifier is
// very sure, the turn runs on the higher tier and the user is told.
const hardTurn = (confidence: number): ClassifyResult => ({
  choice: "opus",
  confidence,
  probabilities: { haiku: 0.0, sonnet: 1 - confidence, opus: confidence, fable: 0 },
});
const sameHistory = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
const midSession = (overrides: Partial<ConversationState> = {}) =>
  state({ currentTier: "sonnet", lastMark: markMessages(sameHistory), ...overrides });

test("DEFAULT_LIMITS upgrade settings default to auto at 0.9 with a $1 rebuild cap, and read the environment", () => {
  const defaults = readThresholds().DEFAULT_LIMITS;
  assert.equal(defaults.upgradeMode, "auto");
  assert.equal(defaults.upgradeConfidence, 0.9);
  assert.equal(defaults.upgradeMaxCostUsd, 1);
  const set = readThresholds({
    ROUTER_UPGRADE_MODE: "suggest",
    ROUTER_UPGRADE_CONFIDENCE: "0.95",
    ROUTER_UPGRADE_MAX_COST_USD: "0.25",
  }).DEFAULT_LIMITS;
  assert.equal(set.upgradeMode, "suggest");
  assert.equal(set.upgradeConfidence, 0.95);
  assert.equal(set.upgradeMaxCostUsd, 0.25);
  });

test("a mid-session upgrade the classifier is very sure about runs this turn on the higher tier", () => {
  const decision = decide(hardTurn(0.93), midSession(), sameHistory, DEFAULT_PRICING, DEFAULT_LIMITS);
  assert.equal(decision.kind, "upgraded");
  if (decision.kind === "upgraded") {
    assert.equal(decision.to, "opus");
    assert.ok(decision.estimatedCostUsd > 0);
  }
});

test("below the confidence threshold it is still only a suggestion", () => {
  const decision = decide(hardTurn(0.85), midSession(), sameHistory, DEFAULT_PRICING, DEFAULT_LIMITS);
  assert.equal(decision.kind, "upgrade-suggested");
});

test("the confidence threshold is configurable", () => {
  const lenient = { ...DEFAULT_LIMITS, upgradeConfidence: 0.8 };
  assert.equal(decide(hardTurn(0.85), midSession(), sameHistory, DEFAULT_PRICING, lenient).kind, "upgraded");
  const strict = { ...DEFAULT_LIMITS, upgradeConfidence: 0.99 };
  assert.equal(decide(hardTurn(0.93), midSession(), sameHistory, DEFAULT_PRICING, strict).kind, "upgrade-suggested");
});

test("suggest mode never upgrades on its own, however sure the classifier is", () => {
  const decision = decide(hardTurn(0.99), midSession(), sameHistory, DEFAULT_PRICING, { ...DEFAULT_LIMITS, upgradeMode: "suggest" });
  assert.equal(decision.kind, "upgrade-suggested");
});

test("an upgrade whose cache rebuild costs more than the cap stays a suggestion", () => {
  const big = midSession({ lastPrefixTokens: 400_000 });
  const capped = decide(hardTurn(0.95), big, sameHistory, DEFAULT_PRICING, { ...DEFAULT_LIMITS, upgradeMaxCostUsd: 1 });
  assert.equal(capped.kind, "upgrade-suggested");
  const uncapped = decide(hardTurn(0.95), big, sameHistory, DEFAULT_PRICING, { ...DEFAULT_LIMITS, upgradeMaxCostUsd: 100 });
  assert.equal(uncapped.kind, "upgraded");
});

test("a conversation the user pinned with /model is only ever offered the upgrade", () => {
  const decision = decide(hardTurn(0.97), midSession({ pinnedByUser: true }), sameHistory, DEFAULT_PRICING, DEFAULT_LIMITS);
  assert.equal(decision.kind, "upgrade-suggested");
});

test("an auto upgrade never goes above ROUTER_MAX_TIER", () => {
  const fableTurn: ClassifyResult = {
    choice: "fable",
    confidence: 0.95,
    probabilities: { haiku: 0, sonnet: 0.05, opus: 0.2, fable: 0.75 },
  };
  const decision = decide(fableTurn, midSession(), sameHistory, DEFAULT_PRICING, { ...DEFAULT_LIMITS, maxTier: "opus" });
  assert.equal(decision.kind, "upgraded");
  assert.equal(decision.kind === "upgraded" && decision.to, "opus");
});

test("any invalid upgrade setting turns automatic upgrades off rather than spending on a guess", () => {
  const invalid: Record<string, string>[] = [
    { ROUTER_UPGRADE_MODE: "off" },
    { ROUTER_UPGRADE_MODE: "sugest" },
    { ROUTER_UPGRADE_MAX_COST_USD: "$0.25" },
    { ROUTER_UPGRADE_MAX_COST_USD: "-1" },
    { ROUTER_UPGRADE_CONFIDENCE: "-1" },
    { ROUTER_UPGRADE_CONFIDENCE: "95" },
    { ROUTER_UPGRADE_CONFIDENCE: "high" },
  ];
  for (const env of invalid) {
    assert.equal(readThresholds(env).DEFAULT_LIMITS.upgradeMode, "suggest", JSON.stringify(env));
  }
});

// 8: the cap and the note speak of the cache rebuild, not of how pricey the last reply was.
test("a long previous reply does not make the cache rebuild look expensive", () => {
  const small = midSession({ lastPrefixTokens: 20_000, lastNewTokens: 0, lastOutputTokens: 0 });
  const longReply = midSession({ lastPrefixTokens: 0, lastNewTokens: 0, lastOutputTokens: 20_000 });
  const a = decide(hardTurn(0.95), small, sameHistory, DEFAULT_PRICING, DEFAULT_LIMITS);
  const b = decide(hardTurn(0.95), longReply, sameHistory, DEFAULT_PRICING, DEFAULT_LIMITS);
  assert.equal(a.kind, "upgraded");
  assert.equal(b.kind, "upgraded");
  if (a.kind === "upgraded" && b.kind === "upgraded") {
    // Both leave 20k tokens of history to rewrite.
    assert.ok(Math.abs(a.estimatedCostUsd - b.estimatedCostUsd) < 1e-9);
    const { rates } = DEFAULT_PRICING;
    const expected = (20_000 * (rates.opus.cacheWritePerMTok - rates.sonnet.cacheReadPerMTok)) / 1e6;
    assert.ok(Math.abs(a.estimatedCostUsd - expected) < 1e-9);
  }
});
