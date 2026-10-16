// What the classifier itself costs, so the router's savings can be stated
// net of it. TypeSafe's homepage lists Jev at $42 per billion input tokens
// ($0.042 per million) and no output price; a third-party summary says
// output is free, so output defaults to 0. Both are overridable, because a
// price is a fact about an account, not about this code. Prices apply by
// default only to the hosted API: a self-hosted backend costs whatever the
// operator says, and unset means unpriced rather than guessed.
export interface ClassifierRates {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export interface ClassifierUsage {
  inputTokens: number;
  outputTokens: number;
}

const HOSTED_DEFAULT: ClassifierRates = { inputUsdPerMTok: 0.042, outputUsdPerMTok: 0 };
const UNPRICED: ClassifierRates = { inputUsdPerMTok: 0, outputUsdPerMTok: 0 };

function envRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isHosted(env: NodeJS.ProcessEnv): boolean {
  const baseURL = env.TYPESAFE_BASE_URL?.trim();
  if (!baseURL) return true;
  try {
    return new URL(baseURL).hostname === "api.typesafe.ai";
  } catch {
    return false;
  }
}

export function classifierRates(env: NodeJS.ProcessEnv): ClassifierRates {
  const base = isHosted(env) ? HOSTED_DEFAULT : UNPRICED;
  return {
    inputUsdPerMTok: envRate(env.TYPESAFE_PRICE_IN_PER_MTOK, base.inputUsdPerMTok),
    outputUsdPerMTok: envRate(env.TYPESAFE_PRICE_OUT_PER_MTOK, base.outputUsdPerMTok),
  };
}

export function classifierCostUsd(usage: ClassifierUsage, rates: ClassifierRates): number {
  return (
    (usage.inputTokens * rates.inputUsdPerMTok + usage.outputTokens * rates.outputUsdPerMTok) / 1_000_000
  );
}
