import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_SNAPSHOT,
  applyTurn,
  createStatusTracker,
  formatStatusLine,
  readSnapshot,
} from "../src/status.js";
import type { LedgerLine } from "../src/ledger.js";

function line(overrides: Partial<LedgerLine> = {}): LedgerLine {
  return {
    v: 2,
    ts: "2026-10-12T10:00:00.000Z",
    conversationKey: "conv-1",
    probabilities: { haiku: 0.1, sonnet: 0.5, opus: 0.3, fable: 0.1 },
    confidence: 0.5,
    downgradeMargin: 0,
    upgradeMargin: 0,
    decision: "held",
    resetDetected: false,
    suggestedUpgradeTo: null,
    suggestedUpgradeCostUsd: null,
    actualModel: "claude-sonnet-5-5",
    actualTier: "sonnet",
    turnsOnCurrentTier: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    actualCostUsd: 0.1,
    counterfactualNoRoutingCostUsd: 0.2,
    ...overrides,
  };
}

test("before any turn the line says it is waiting, and a missing file reads as null", () => {
  assert.equal(formatStatusLine(EMPTY_SNAPSHOT), "tierwise · waiting for the first turn");
  assert.equal(formatStatusLine(null), "tierwise · waiting for the first turn");
  assert.equal(readSnapshot(undefined), null);
  assert.equal(readSnapshot("/nonexistent/tierwise.json"), null);
});

test("the line shows tier, turns, savings and a pending suggestion", () => {
  let snapshot = applyTurn(EMPTY_SNAPSHOT, line());
  snapshot = applyTurn(snapshot, line({ decision: "upgrade-suggested", suggestedUpgradeTo: "opus" }));
  assert.equal(
    formatStatusLine(snapshot),
    "tierwise · sonnet · 2 turns · saved $0.20 (50%) · ↑ opus suggested"
  );
});

test("a turn that cost more than the baseline says so, and a zero delta shows nothing", () => {
  const dearer = applyTurn(EMPTY_SNAPSHOT, line({ actualCostUsd: 0.3, counterfactualNoRoutingCostUsd: 0.2 }));
  assert.equal(formatStatusLine(dearer), "tierwise · sonnet · 1 turn · cost +$0.10 (50%)");
  const even = applyTurn(EMPTY_SNAPSHOT, line({ actualCostUsd: 0.2, counterfactualNoRoutingCostUsd: 0.2 }));
  assert.equal(formatStatusLine(even), "tierwise · sonnet · 1 turn");
});

test("side requests are costed but not counted as turns", () => {
  const snapshot = applyTurn(EMPTY_SNAPSHOT, line({ decision: "side-request", actualTier: "sonnet" }));
  assert.equal(snapshot.turns, 0);
  assert.equal(snapshot.actualUsd, 0.1);
  assert.equal(snapshot.tier, null);
});

test("an unclassified tool-loop step keeps the pending suggestion; a classified turn replaces it", () => {
  let snapshot = applyTurn(EMPTY_SNAPSHOT, line({ decision: "upgrade-suggested", suggestedUpgradeTo: "opus" }));
  snapshot = applyTurn(snapshot, line({ decision: "skipped-tool-result" }));
  assert.equal(snapshot.suggestedUpgradeTo, "opus");
  snapshot = applyTurn(snapshot, line({ decision: "held" }));
  assert.equal(snapshot.suggestedUpgradeTo, null);
});

test("the tracker publishes after every turn and leaves no temp file behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "tierwise-status-"));
  const file = join(dir, "status.json");
  const record = createStatusTracker(file);
  record(line());
  record(line({ actualTier: "haiku" }));
  const read = readSnapshot(file);
  assert.equal(read?.turns, 2);
  assert.equal(read?.tier, "haiku");
  assert.ok(!existsSync(`${file}.tmp`));
  assert.match(readFileSync(file, "utf8"), /"turns":2/);
});

test("an unwritable status path warns instead of breaking the turn", () => {
  const record = createStatusTracker("/nonexistent-dir/status.json");
  assert.doesNotThrow(() => record(line()));
});

test("savings are net of the classifier, which is shown in dollars when priced", () => {
  const snapshot = applyTurn(
    EMPTY_SNAPSHOT,
    line({ actualCostUsd: 0.1, counterfactualNoRoutingCostUsd: 0.4, classifierCostUsd: 0.0004, classifierInputTokens: 9000 })
  );
  assert.equal(snapshot.classifierTokens, 9000);
  assert.equal(formatStatusLine(snapshot), "tierwise · sonnet · 1 turn · saved $0.30 (75%) · classifier $0.0004");
});

test("an unpriced classifier shows tokens, and a cost that outweighs the saving flips the label", () => {
  const unpriced = applyTurn(EMPTY_SNAPSHOT, line({ classifierInputTokens: 18_000, classifierOutputTokens: 200 }));
  assert.match(formatStatusLine(unpriced), /classifier 18\.2k tok/);
  const dear = applyTurn(
    EMPTY_SNAPSHOT,
    line({ actualCostUsd: 0.2, counterfactualNoRoutingCostUsd: 0.2, classifierCostUsd: 0.05 })
  );
  assert.match(formatStatusLine(dear), /cost \+\$0\.05 \(25%\)/);
});
