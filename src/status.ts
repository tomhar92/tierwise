import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { LedgerLine } from "./ledger.js";
import type { Tier } from "./types.js";

// What the status line shows, kept as a tiny file the proxy rewrites after
// every turn. The status line is redrawn constantly, so it must not scan a
// ledger that only ever grows; it reads this instead.
export interface StatusSnapshot {
  /** Tier of the most recent routed turn, null before the first one. */
  tier: Tier | null;
  /** Turns the router handled (side requests are costed but not counted). */
  turns: number;
  actualUsd: number;
  baselineUsd: number;
  /** What the classifier calls cost (0 when unpriced) and how many tokens
   * they used, so savings can be stated net of the router's own overhead. */
  classifierUsd: number;
  classifierTokens: number;
  /** The router's pending suggestion from the latest classified turn. */
  suggestedUpgradeTo: Tier | null;
}

export const EMPTY_SNAPSHOT: StatusSnapshot = {
  tier: null,
  turns: 0,
  actualUsd: 0,
  baselineUsd: 0,
  classifierUsd: 0,
  classifierTokens: 0,
  suggestedUpgradeTo: null,
};

export function applyTurn(snapshot: StatusSnapshot, line: LedgerLine): StatusSnapshot {
  const next: StatusSnapshot = {
    ...snapshot,
    actualUsd: snapshot.actualUsd + (line.actualCostUsd ?? 0),
    baselineUsd: snapshot.baselineUsd + (line.counterfactualNoRoutingCostUsd ?? 0),
    classifierUsd: snapshot.classifierUsd + (line.classifierCostUsd ?? 0),
    classifierTokens:
      snapshot.classifierTokens + (line.classifierInputTokens ?? 0) + (line.classifierOutputTokens ?? 0),
  };
  if (line.decision === "side-request") return next;
  next.turns += 1;
  if (line.actualTier) next.tier = line.actualTier;
  // Turns that were not classified (agentic loop steps) say nothing about
  // the suggestion, so it stays until a classified turn replaces it.
  if (line.decision !== "skipped-tool-result") next.suggestedUpgradeTo = line.suggestedUpgradeTo;
  return next;
}

function formatUsd(amount: number): string {
  // The classifier is cheap enough that two decimals would print $0.00.
  return `$${amount >= 0.01 ? amount.toFixed(2) : amount.toFixed(4)}`;
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

export function formatStatusLine(snapshot: StatusSnapshot | null): string {
  if (!snapshot || snapshot.turns === 0) return "tierwise · waiting for the first turn";
  const parts = ["tierwise", snapshot.tier ?? "?", `${snapshot.turns} ${snapshot.turns === 1 ? "turn" : "turns"}`];
  // Savings are net of the classifier: the router's own calls are a cost
  // of routing, so leaving them out would flatter it.
  const delta = snapshot.actualUsd + snapshot.classifierUsd - snapshot.baselineUsd;
  const rounded = Number(Math.abs(delta).toFixed(2));
  if (snapshot.baselineUsd > 0 && rounded > 0) {
    const percent = Math.round((Math.abs(delta) / snapshot.baselineUsd) * 100);
    parts.push(
      delta < 0
        ? `saved $${rounded.toFixed(2)} (${percent}%)`
        : `cost +$${rounded.toFixed(2)} (${percent}%)`
    );
  }
  if (snapshot.classifierUsd > 0) parts.push(`classifier ${formatUsd(snapshot.classifierUsd)}`);
  else if (snapshot.classifierTokens > 0) parts.push(`classifier ${formatTokens(snapshot.classifierTokens)} tok`);
  if (snapshot.suggestedUpgradeTo) parts.push(`↑ ${snapshot.suggestedUpgradeTo} suggested`);
  return parts.join(" · ");
}

export function writeSnapshot(path: string, snapshot: StatusSnapshot): void {
  // Write then rename, so a status line reading mid-turn never sees half a file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot), "utf8");
  renameSync(tmp, path);
}

export function readSnapshot(path: string | undefined): StatusSnapshot | null {
  if (!path) return null;
  try {
    return { ...EMPTY_SNAPSHOT, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<StatusSnapshot>) };
  } catch {
    return null;
  }
}

/** Accumulates this run's turns and publishes them for the status line. */
export function createStatusTracker(path: string): (line: LedgerLine) => void {
  let snapshot = EMPTY_SNAPSHOT;
  return (line) => {
    snapshot = applyTurn(snapshot, line);
    try {
      writeSnapshot(path, snapshot);
    } catch (err) {
      // The status line is a convenience; never let it break a turn.
      console.warn(`tierwise: could not update status file ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
