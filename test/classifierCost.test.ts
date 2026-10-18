import { test } from "node:test";
import assert from "node:assert/strict";
import { classifierCostUsd, classifierRates } from "../src/classifierCost.js";

test("the hosted API defaults to TypeSafe's published $0.042 per million input tokens, output free", () => {
  assert.deepEqual(classifierRates({}), { inputUsdPerMTok: 0.042, outputUsdPerMTok: 0 });
  assert.deepEqual(classifierRates({ TYPESAFE_BASE_URL: "https://api.typesafe.ai" }), {
    inputUsdPerMTok: 0.042,
    outputUsdPerMTok: 0,
  });
});

test("a self-hosted backend is unpriced unless the operator sets prices", () => {
  assert.deepEqual(classifierRates({ TYPESAFE_BASE_URL: "http://localhost:8000" }), {
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
  });
  assert.deepEqual(
    classifierRates({ TYPESAFE_BASE_URL: "http://localhost:8000", TYPESAFE_PRICE_IN_PER_MTOK: "0.5" }),
    { inputUsdPerMTok: 0.5, outputUsdPerMTok: 0 }
  );
});

test("environment overrides win, and garbage falls back instead of poisoning the totals", () => {
  assert.deepEqual(classifierRates({ TYPESAFE_PRICE_IN_PER_MTOK: "0.1", TYPESAFE_PRICE_OUT_PER_MTOK: "0.2" }), {
    inputUsdPerMTok: 0.1,
    outputUsdPerMTok: 0.2,
  });
  assert.equal(classifierRates({ TYPESAFE_PRICE_IN_PER_MTOK: "free" }).inputUsdPerMTok, 0.042);
  assert.equal(classifierRates({ TYPESAFE_PRICE_IN_PER_MTOK: "-1" }).inputUsdPerMTok, 0.042);
});

test("cost is tokens times the per-million rate", () => {
  const rates = { inputUsdPerMTok: 0.042, outputUsdPerMTok: 1 };
  assert.ok(Math.abs(classifierCostUsd({ inputTokens: 2_000_000, outputTokens: 500_000 }, rates) - 0.584) < 1e-9);
  assert.equal(classifierCostUsd({ inputTokens: 0, outputTokens: 0 }, rates), 0);
});
