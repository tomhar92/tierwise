import type { Tier } from "./types.js";

// Shown to the user under the model's reply. It is worded as the router
// speaking so it is not mistaken for something the model said.
const NOTICE_MARKER = "*Router note:";

/** True for a text block the router itself appended (see buildUpgradeNoticeText). */
export function isRouterNote(text: unknown): boolean {
  return typeof text === "string" && text.trimStart().startsWith(`---\n${NOTICE_MARKER}`);
}

export function buildUpgradeNoticeText(tier: Tier, estimatedCostUsd: number): string {
  return (
    `\n\n---\n${NOTICE_MARKER} this looks like it may suit ${tier}. ` +
    `Switching now means rebuilding the conversation cache, about ` +
    `$${estimatedCostUsd.toFixed(2)} one time. Run \`/model ${tier}\` if you want it.*`
  );
}

/** The upgrade the router applied itself at a reset (session start,
 * `/clear`, `/compact`): the cache was being rebuilt anyway, so it cost
 * nothing extra, but the model changed without the user asking. */
export function buildResetUpgradeNoticeText(to: Tier, from: Tier): string {
  return (
    `\n\n---\n${NOTICE_MARKER} this conversation started on ${to} instead of ${from}, ` +
    `because the request looked like it needed it (the cache was being rebuilt anyway). ` +
    `Run \`/model ${from}\` to switch back.*`
  );
}
