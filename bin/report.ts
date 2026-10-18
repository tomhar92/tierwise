#!/usr/bin/env node
import "../src/loadConfig.js";
import { filterSince, parseSince, readLedger, type LedgerLine } from "../src/ledger.js";
import { isMainModule } from "../src/isMainModule.js";

export interface Summary {
  turns: number;
  held: number;
  downgraded: number;
  upgradedOnReset: number;
  suggested: number;
  classifierUnavailable: number;
  skippedToolResult: number;
  manualSwitch: number;
  sideRequests: number;
  unknownModel: number;
  totalActualUsd: number;
  totalCounterfactualUsd: number;
  deltaUsd: number;
  classifierUsd: number;
  classifierTokens: number;
  /** Delta including the classifier's own cost: what routing really saved. */
  netDeltaUsd: number;
}

export function summarize(lines: LedgerLine[]): Summary {
  const totalActualUsd = lines.reduce((sum, l) => sum + (l.actualCostUsd ?? 0), 0);
  const totalCounterfactualUsd = lines.reduce(
    (sum, l) => sum + (l.counterfactualNoRoutingCostUsd ?? 0),
    0
  );
  const classifierUsd = lines.reduce((sum, l) => sum + (l.classifierCostUsd ?? 0), 0);
  const classifierTokens = lines.reduce(
    (sum, l) => sum + (l.classifierInputTokens ?? 0) + (l.classifierOutputTokens ?? 0),
    0
  );
  return {
    turns: lines.length,
    held: lines.filter((l) => l.decision === "held").length,
    downgraded: lines.filter(
      (l) => l.decision === "downgraded" || l.decision === "downgraded-on-reset"
    ).length,
    upgradedOnReset: lines.filter((l) => l.decision === "upgraded-on-reset").length,
    suggested: lines.filter((l) => l.decision === "upgrade-suggested").length,
    classifierUnavailable: lines.filter((l) => l.decision === "classifier-unavailable").length,
    skippedToolResult: lines.filter((l) => l.decision === "skipped-tool-result").length,
    manualSwitch: lines.filter((l) => l.decision === "manual-switch").length,
    sideRequests: lines.filter((l) => l.decision === "side-request").length,
    unknownModel: lines.filter((l) => l.decision === "unknown-model").length,
    totalActualUsd,
    totalCounterfactualUsd,
    deltaUsd: totalActualUsd - totalCounterfactualUsd,
    classifierUsd,
    classifierTokens,
    netDeltaUsd: totalActualUsd + classifierUsd - totalCounterfactualUsd,
  };
}

/** Judged at the four decimals the report prints, so a zero delta (or
 * floating-point dust around one) reads as "no change" rather than "cost more". */
export function deltaLabel(deltaUsd: number): string {
  const rounded = Number(deltaUsd.toFixed(4));
  if (rounded === 0) return "no change";
  return rounded < 0 ? "saved" : "cost more";
}

const USAGE = "Usage: tierwise-report [path-to-ledger.jsonl] [--since 12h|1d|2w|YYYY-MM-DD] [--today]";

export interface ReportArgs {
  path: string | null;
  since: Date | null;
  error?: string;
}

/** `--help` is the only way to get the usage line now: with a default
 * path, the bare invocation is valid. */
export function parseReportArgs(argv: string[], env: NodeJS.ProcessEnv, now: Date = new Date()): ReportArgs {
  if (argv.includes("--help") || argv.includes("-h")) return { path: null, since: null };
  let since: Date | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--today") {
      since = parseSince("today", now);
    } else if (arg === "--since") {
      const value = argv[++i];
      since = value === undefined ? null : parseSince(value, now);
      if (!since) return { path: null, since: null, error: `--since needs 12h, 1d, 2w, today or a date, got: ${value ?? "nothing"}` };
    } else if (arg.startsWith("-")) {
      return { path: null, since: null, error: `unknown option ${arg}` };
    } else {
      positional.push(arg);
    }
  }
  return { path: positional[0] ?? env.ROUTER_LEDGER_PATH ?? "./router-ledger.jsonl", since };
}

export function resolveLedgerPath(argv: string[], env: NodeJS.ProcessEnv): string | null {
  return parseReportArgs(argv, env).path;
}

export function reportMain(argv: string[]): void {
  const { path, since, error } = parseReportArgs(argv, process.env);
  if (error) {
    console.error(`${error}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (!path) {
    console.log(USAGE);
    return;
  }
  const all = readLedger(path);
  const lines = since ? filterSince(all, since) : all;
  if (lines.length === 0) {
    console.log(
      since
        ? `No ledger entries since ${since.toISOString()} at ${path} (${all.length} older)`
        : `No ledger entries found at ${path}`
    );
    return;
  }
  if (since) console.log(`Since ${since.toISOString()}`);
  const s = summarize(lines);
  console.log(`Turns: ${s.turns}`);
  console.log(
    `  held: ${s.held}, downgraded: ${s.downgraded}, upgraded-on-reset: ${s.upgradedOnReset}, upgrade-suggested: ${s.suggested}`
  );
  if (s.classifierUnavailable > 0) {
    console.log(
      `  classifier-unavailable: ${s.classifierUnavailable} (TypeSafe errored/timed out - router held by default, not by policy, on these turns)`
    );
  }
  if (s.sideRequests > 0) {
    console.log(
      `  side-request: ${s.sideRequests} (Claude Code's tool-less side calls - passed through, never routed, still costed)`
    );
  }
  if (s.skippedToolResult > 0) {
    console.log(
      `  skipped-tool-result: ${s.skippedToolResult} (agentic-loop steps, not classified - stayed on the tier chosen for the user message)`
    );
  }
  if (s.manualSwitch > 0) {
    console.log(
      `  manual-switch: ${s.manualSwitch} (turns where you changed the model; honored, not classified, and pinned against automatic downgrades)`
    );
  }
  if (s.unknownModel > 0) {
    console.log(
      `  unknown-model: ${s.unknownModel} (no tier resolved - forwarded untouched, not priced; add the model to modelAlias in src/pricing.ts)`
    );
  }
  console.log(`Actual cost:         $${s.totalActualUsd.toFixed(4)}`);
  console.log(`No-routing baseline: $${s.totalCounterfactualUsd.toFixed(4)}`);
  console.log(
    `Delta:               $${s.deltaUsd.toFixed(4)} (${deltaLabel(s.deltaUsd)})`
  );
  if (s.classifierTokens > 0) {
    console.log(
      `Classifier:          $${s.classifierUsd.toFixed(4)} (${s.classifierTokens} tokens${s.classifierUsd === 0 ? ", unpriced - set TYPESAFE_PRICE_IN_PER_MTOK" : ""})`
    );
    console.log(
      `Net delta:           $${s.netDeltaUsd.toFixed(4)} (${deltaLabel(s.netDeltaUsd)}, after the classifier)`
    );
  }
}

if (isMainModule(import.meta.url)) {
  reportMain(process.argv.slice(2));
}
