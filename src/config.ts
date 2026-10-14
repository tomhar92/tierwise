import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TIER_ORDER } from "./types.js";

// Settings are the same names the environment already uses, so a value in the
// file and an `export` mean the same thing and the docs need no second
// vocabulary. The file only fills in what the environment leaves unset.

type Kind = "secret" | "number" | "tier" | "url" | "string";

export const SETTINGS: Record<string, { kind: Kind; help: string }> = {
  TYPESAFE_API_KEY: { kind: "secret", help: "API key for the hosted classifier" },
  TYPESAFE_BASE_URL: { kind: "url", help: "classifier backend (default: hosted API)" },
  TYPESAFE_DEFAULT_MODEL: { kind: "string", help: "classifier model (default: jev-latest)" },
  ROUTER_MARGIN_THRESHOLD: { kind: "number", help: "confidence margin needed to switch tier" },
  ROUTER_STICKY_ASSUMPTION: { kind: "number", help: "turns a switch is assumed to last" },
  ROUTER_RESET_CONFIDENCE_FLOOR: { kind: "number", help: "min confidence to switch on a reset" },
  ROUTER_MIN_TIER: { kind: "tier", help: "lowest tier the router may pick" },
  ROUTER_MAX_TIER: { kind: "tier", help: "highest tier the router may pick" },
  ROUTER_LEDGER_PATH: { kind: "string", help: "where turn-by-turn cost data is logged" },
};

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.TIERWISE_CONFIG?.trim() || join(homedir(), ".tierwise", "config.json");
}

/** Null if the value is acceptable, otherwise why not. */
export function validateSetting(key: string, value: string): string | null {
  const setting = SETTINGS[key];
  if (!setting) return `unknown setting ${key} (known: ${Object.keys(SETTINGS).join(", ")})`;
  const trimmed = value.trim();
  if (!trimmed) return `${key} cannot be empty (use unset to remove it)`;
  if (setting.kind === "number" && !Number.isFinite(Number(trimmed))) return `${key} must be a number, got "${value}"`;
  if (setting.kind === "tier" && !(TIER_ORDER as readonly string[]).includes(trimmed.toLowerCase())) {
    return `${key} must be one of ${TIER_ORDER.join(", ")}, got "${value}"`;
  }
  if (setting.kind === "url") {
    try {
      new URL(trimmed);
    } catch {
      return `${key} must be a URL, got "${value}"`;
    }
  }
  return null;
}

export class ConfigFileError extends Error {}

/** The stored values. A missing file is empty; a file that exists but cannot be
 * read as a flat string map is an error, never silently treated as empty. */
export function readConfig(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigFileError(`${path} is not valid JSON (${(error as Error).message}); fix or delete it`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigFileError(`${path} must contain a JSON object of settings`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Written to a temp file and renamed so a crash cannot leave half a config,
 * with owner-only permissions because it can hold the API key. */
export function writeConfig(path: string, values: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(values, null, 2) + "\n", { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** Fills `env` with every stored value it does not already set. */
export function applyConfig(env: NodeJS.ProcessEnv, path: string = configPath(env)): void {
  const stored = readConfig(path);
  for (const [key, value] of Object.entries(stored)) {
    if (key in SETTINGS && !env[key]?.trim()) env[key] = value;
  }
}

export function maskSecret(value: string): string {
  return value.length <= 8 ? "****" : `${value.slice(0, 3)}…${value.slice(-4)}`;
}
