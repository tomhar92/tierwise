import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveLedger, deleteLedger, filterSince, parseSince, type LedgerLine } from "../src/ledger.js";
import { parseResetArgs, resetMain } from "../bin/reset.js";

const NOW = new Date("2026-10-12T12:00:00");

test("parseSince understands durations, today and dates, and rejects the rest", () => {
  assert.equal(parseSince("12h", NOW)?.getTime(), NOW.getTime() - 12 * 3_600_000);
  assert.equal(parseSince("1d", NOW)?.getTime(), NOW.getTime() - 86_400_000);
  assert.equal(parseSince("2w", NOW)?.getTime(), NOW.getTime() - 14 * 86_400_000);
  assert.equal(parseSince("today", NOW)?.getHours(), 0);
  assert.equal(parseSince("2026-10-01", NOW)?.getUTCFullYear(), 2026);
  assert.equal(parseSince("soon", NOW), null);
});

test("filterSince keeps lines at or after the cutoff", () => {
  const lines = [{ ts: "2026-10-10T00:00:00.000Z" }, { ts: "2026-10-12T00:00:00.000Z" }] as LedgerLine[];
  assert.equal(filterSince(lines, new Date("2026-10-11T00:00:00.000Z")).length, 1);
});

test("archiveLedger moves the file aside with a timestamp and a fresh one can start", () => {
  const dir = mkdtempSync(join(tmpdir(), "tierwise-ledger-"));
  const path = join(dir, "ledger.jsonl");
  writeFileSync(path, '{"a":1}\n');
  const archive = archiveLedger(path, new Date(2026, 9, 12, 21, 45, 3));
  assert.equal(archive, join(dir, "ledger-20261012-214503.jsonl"));
  assert.ok(!existsSync(path));
  assert.ok(existsSync(archive!));
  assert.equal(archiveLedger(path), null);
});

test("deleteLedger removes the file and reports whether there was one", () => {
  const dir = mkdtempSync(join(tmpdir(), "tierwise-ledger-"));
  const path = join(dir, "ledger.jsonl");
  writeFileSync(path, "x\n");
  assert.equal(deleteLedger(path), true);
  assert.equal(deleteLedger(path), false);
});

test("reset args: path from env, flags, and misuse", () => {
  assert.equal(parseResetArgs([], { ROUTER_LEDGER_PATH: "e.jsonl" }).path, "e.jsonl");
  assert.equal(parseResetArgs(["a.jsonl", "--delete", "--yes"], {}).remove, true);
  assert.match(parseResetArgs(["--yes"], {}).error ?? "", /--delete/);
  assert.match(parseResetArgs(["a", "b"], {}).error ?? "", /only one/);
  assert.match(parseResetArgs(["--nope"], {}).error ?? "", /unknown option/);
});

test("reset archives by default, and delete needs a yes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tierwise-reset-"));
  const path = join(dir, "ledger.jsonl");
  writeFileSync(path, "x\n");
  assert.equal(await resetMain([path], {}), 0);
  assert.equal(readdirSync(dir).filter((f) => f.startsWith("ledger-")).length, 1);

  writeFileSync(path, "y\n");
  assert.equal(await resetMain([path, "--delete"], {}, async () => false), 1);
  assert.ok(existsSync(path), "declined: the ledger survives");
  assert.equal(await resetMain([path, "--delete"], {}, async () => true), 0);
  assert.ok(!existsSync(path));

  writeFileSync(path, "z\n");
  assert.equal(await resetMain([path, "--delete", "--yes"], {}, async () => false), 0);
  assert.ok(!existsSync(path));
});
