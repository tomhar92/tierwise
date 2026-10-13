import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, resolveLedgerPath, deltaLabel } from "../bin/report.js";
import type { LedgerLine } from "../src/ledger.js";

function line(overrides: Partial<LedgerLine>): LedgerLine {
  return {
    v: 2,
    ts: new Date().toISOString(),
    conversationKey: "conn-1",
    probabilities: { haiku: 0.25, sonnet: 0.25, opus: 0.25, fable: 0.25 },
    confidence: 0.5,
    downgradeMargin: 0,
    upgradeMargin: 0,
    decision: "held",
    resetDetected: false,
    suggestedUpgradeTo: null,
    suggestedUpgradeCostUsd: null,
    actualModel: "claude-sonnet-5",
    actualTier: "sonnet",
    turnsOnCurrentTier: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    actualCostUsd: 0,
    counterfactualNoRoutingCostUsd: 0,
    ...overrides,
  };
}

test("summarize counts each decision kind and totals actual vs counterfactual cost", () => {
  const lines: LedgerLine[] = [
    line({ decision: "held", actualCostUsd: 0.01, counterfactualNoRoutingCostUsd: 0.01 }),
    line({ decision: "downgraded", actualCostUsd: 0.005, counterfactualNoRoutingCostUsd: 0.01 }),
    line({ decision: "downgraded-on-reset", actualCostUsd: 0.001, counterfactualNoRoutingCostUsd: 0.002 }),
    line({ decision: "upgraded-on-reset", actualCostUsd: 0.02, counterfactualNoRoutingCostUsd: 0.01 }),
    line({ decision: "upgrade-suggested", actualCostUsd: 0.01, counterfactualNoRoutingCostUsd: 0.01 }),
  ];
  const summary = summarize(lines);
  assert.equal(summary.turns, 5);
  assert.equal(summary.held, 1);
  assert.equal(summary.downgraded, 2);
  assert.equal(summary.upgradedOnReset, 1);
  assert.equal(summary.suggested, 1);
  assert.ok(Math.abs(summary.totalActualUsd - 0.046) < 1e-9);
  assert.ok(Math.abs(summary.totalCounterfactualUsd - 0.042) < 1e-9);
  assert.ok(Math.abs(summary.deltaUsd - (0.046 - 0.042)) < 1e-9);
});

test("summarize handles an empty ledger", () => {
  const summary = summarize([]);
  assert.equal(summary.turns, 0);
  assert.equal(summary.totalActualUsd, 0);
  assert.equal(summary.totalCounterfactualUsd, 0);
});

test("summarize counts classifier-unavailable turns separately from a policy-driven hold", () => {
  const lines: LedgerLine[] = [
    line({ decision: "held" }),
    line({ decision: "classifier-unavailable", probabilities: {} as LedgerLine["probabilities"], confidence: null }),
    line({ decision: "classifier-unavailable", probabilities: {} as LedgerLine["probabilities"], confidence: null }),
  ];
  const summary = summarize(lines);
  assert.equal(summary.turns, 3);
  assert.equal(summary.held, 1);
  assert.equal(summary.classifierUnavailable, 2);
});

test("summarize counts unknown-model turns and treats their unpriced cost as zero", () => {
  const lines: LedgerLine[] = [
    line({ decision: "held", actualCostUsd: 0.01, counterfactualNoRoutingCostUsd: 0.01 }),
    line({ decision: "unknown-model", actualCostUsd: null, counterfactualNoRoutingCostUsd: null }),
  ];
  const summary = summarize(lines);
  assert.equal(summary.turns, 2);
  assert.equal(summary.unknownModel, 1);
  assert.ok(Math.abs(summary.totalActualUsd - 0.01) < 1e-9);
  assert.ok(Math.abs(summary.totalCounterfactualUsd - 0.01) < 1e-9);
  assert.ok(Math.abs(summary.deltaUsd) < 1e-9);
});

test("resolveLedgerPath: argument, then env, then default; --help yields null", () => {
  assert.equal(resolveLedgerPath(["a.jsonl"], { ROUTER_LEDGER_PATH: "b.jsonl" }), "a.jsonl");
  assert.equal(resolveLedgerPath([], { ROUTER_LEDGER_PATH: "b.jsonl" }), "b.jsonl");
  assert.equal(resolveLedgerPath([], {}), "./router-ledger.jsonl");
  assert.equal(resolveLedgerPath(["--help"], {}), null);
});

test("deltaLabel says no change for a zero or rounding-dust delta, not cost more", () => {
  assert.equal(deltaLabel(0), "no change");
  assert.equal(deltaLabel(1e-17), "no change");
  assert.equal(deltaLabel(-0.00001), "no change");
  assert.equal(deltaLabel(-0.0123), "saved");
  assert.equal(deltaLabel(0.0123), "cost more");
});

test("report args: --since and --today scope the window, bad values are errors", async () => {
  const { parseReportArgs } = await import("../bin/report.js");
  const now = new Date("2026-10-12T12:00:00");
  assert.equal(parseReportArgs(["--since", "1d"], {}, now).since?.getTime(), now.getTime() - 86_400_000);
  assert.equal(parseReportArgs(["--today"], {}, now).since?.getDate(), 12);
  assert.equal(parseReportArgs(["x.jsonl", "--since", "2w"], {}, now).path, "x.jsonl");
  assert.match(parseReportArgs(["--since", "nonsense"], {}, now).error ?? "", /--since/);
  assert.match(parseReportArgs(["--bogus"], {}, now).error ?? "", /unknown option/);
  assert.equal(parseReportArgs(["--help"], {}, now).path, null);
});

test("summarize adds the classifier's cost and a net delta", () => {
  const s = summarize([
    { decision: "held", actualCostUsd: 0.1, counterfactualNoRoutingCostUsd: 0.3, classifierCostUsd: 0.001, classifierInputTokens: 5000, classifierOutputTokens: 5 },
    { decision: "held", actualCostUsd: 0.1, counterfactualNoRoutingCostUsd: 0.1 },
  ] as never);
  assert.equal(s.classifierTokens, 5005);
  assert.ok(Math.abs(s.classifierUsd - 0.001) < 1e-12);
  assert.ok(Math.abs(s.deltaUsd - -0.2) < 1e-12);
  assert.ok(Math.abs(s.netDeltaUsd - -0.199) < 1e-12);
});
