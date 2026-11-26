import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpgradeNoticeText } from "../src/upgradeNote.js";

test("names the tier, the one-time cost and the command to switch", () => {
  const text = buildUpgradeNoticeText("opus", 0.5412);
  assert.match(text, /opus/);
  assert.match(text, /\$0\.54/);
  assert.match(text, /\/model opus/);
});

test("reads as the router speaking, not the model", () => {
  assert.match(buildUpgradeNoticeText("sonnet", 0.1), /Router note/);
});

test("an upgrade the router applied to this turn says where it ran, what it cost once, and the way back", async () => {
  const { buildAutoUpgradeNoticeText } = await import("../src/upgradeNote.js");
  const text = buildAutoUpgradeNoticeText("opus", "haiku", 0.2836);
  assert.match(text, /^\n\n---\n\*Router note:/);
  assert.match(text, /ran on opus/);
  assert.match(text, /\$0\.28/);
  assert.match(text, /\/model haiku/);
  const { isRouterNote } = await import("../src/upgradeNote.js");
  assert.equal(isRouterNote(text), true);
});
