import { appendFileSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { IdentityNote, Tier } from "./types.js";

export { computeCostUsd } from "./pricing.js";

export interface LedgerLine {
  v: 2;
  ts: string;
  conversationKey: string;
  probabilities: Record<Tier, number>;
  /** The classifier's confidence in its argmax choice, or null when the
   * classifier was unavailable this turn (see `decision`). */
  confidence: number | null;
  downgradeMargin: number;
  upgradeMargin: number;
  /** One of the `Decision["kind"]` values from policy.ts, or
   * `"classifier-unavailable"` when TypeSafe errored/timed out and the
   * router held by default rather than by policy, `"skipped-tool-result"`
   * when the request only continued an agentic loop and was not
   * classified, `"side-request"` for Claude Code's tool-less side calls
   * (logged for cost, never routed), `"manual-switch"` for the turn on
   * which the user changed the model themselves (never classified), or `"unknown-model"`
   * when no tier could be resolved for the requested model - kept
   * distinct so a broken API key or an unrecognized model doesn't
   * silently masquerade as normal routing. */
  decision: string;
  resetDetected: boolean;
  /** Why this request started a new conversation although its first message
   * was already tracked. Present only on the first line of such a state. */
  identity?: IdentityNote;
  suggestedUpgradeTo: Tier | null;
  suggestedUpgradeCostUsd: number | null;
  actualModel: string;
  /** Null when the turn used a model no tier could be resolved for; the
   * turn is still recorded so the report can count it, but it carries no
   * cost because we have no rate card for that model. */
  actualTier: Tier | null;
  /** How many consecutive turns (including this one) the conversation has
   * now spent on `actualTier`. */
  turnsOnCurrentTier: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  actualCostUsd: number | null;
  counterfactualNoRoutingCostUsd: number | null;
  /** What the classifier call for this turn consumed and cost. Absent on
   * older lines and on turns with no call (or no usage reported). */
  classifierInputTokens?: number;
  classifierOutputTokens?: number;
  classifierCostUsd?: number;
}

export function appendLedgerLine(path: string, line: LedgerLine): void {
  // A single small JSONL append is sub-millisecond on any real disk and
  // negligible next to the network round-trip this proxy is already
  // waiting on for every turn - not worth trading the simple, easy-to-
  // reason-about ordering a synchronous write gives (this line is either
  // durable before the response finishes, or the process crashed and
  // nothing after it ran either) for the async version's own hazard: a
  // fire-and-forget write racing an unrelated "did the response finish"
  // signal, with no guarantee about which comes first.
  appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
}

export function readLedger(path: string): LedgerLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      // Lines written before the unknown-model change carry no `v` and
      // always have a tier and both costs. Defaulting here keeps an
      // existing router-ledger.jsonl reportable instead of dropping it.
      const parsed = JSON.parse(l) as Partial<LedgerLine>;
      return { v: 2, ...parsed } as LedgerLine;
    });
}

const DURATION_MS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "12h", "1d", "2w", "today" or an ISO date -> the cutoff Date, or null
 * when the text is none of those. */
export function parseSince(spec: string, now: Date = new Date()): Date | null {
  const text = spec.trim().toLowerCase();
  if (text === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const duration = /^(\d+)([hdw])$/.exec(text);
  if (duration) return new Date(now.getTime() - Number(duration[1]) * DURATION_MS[duration[2]]);
  const date = new Date(spec.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

export function filterSince(lines: LedgerLine[], since: Date): LedgerLine[] {
  return lines.filter((line) => new Date(line.ts).getTime() >= since.getTime());
}

function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** Moves the ledger aside as `<name>-<timestamp>.jsonl` next to it. The
 * next turn starts a fresh file, because writes open the path each time.
 * Returns the archive path, or null if there was no ledger. */
export function archiveLedger(path: string, now: Date = new Date()): string | null {
  if (!existsSync(path)) return null;
  const extension = extname(path);
  const archive = join(dirname(path), `${basename(path, extension)}-${stamp(now)}${extension}`);
  renameSync(path, archive);
  return archive;
}

export function deleteLedger(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
