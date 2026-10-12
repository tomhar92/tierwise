import { createInterface } from "node:readline/promises";
import { archiveLedger, deleteLedger } from "../src/ledger.js";

export const RESET_USAGE =
  "Usage: tierwise reset [path-to-ledger.jsonl] [--delete [--yes]]\n" +
  "  Archives the ledger as <name>-<timestamp>.jsonl next to it and starts fresh.\n" +
  "  --delete removes it instead (asks first unless --yes).";

export interface ResetArgs {
  path: string;
  remove: boolean;
  yes: boolean;
  help: boolean;
  error?: string;
}

export function parseResetArgs(argv: string[], env: NodeJS.ProcessEnv): ResetArgs {
  const args: ResetArgs = {
    path: env.ROUTER_LEDGER_PATH ?? "./router-ledger.jsonl",
    remove: false,
    yes: false,
    help: false,
  };
  let explicitPath = false;
  for (const arg of argv) {
    if (arg === "--delete") args.remove = true;
    else if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("-")) return { ...args, error: `unknown option ${arg}` };
    else if (explicitPath) return { ...args, error: "only one ledger path allowed" };
    else {
      args.path = arg;
      explicitPath = true;
    }
  }
  if (args.yes && !args.remove) return { ...args, error: "--yes only applies to --delete" };
  return args;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export async function resetMain(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  ask: (question: string) => Promise<boolean> = confirm
): Promise<number> {
  const args = parseResetArgs(argv, env);
  if (args.error) {
    console.error(`${args.error}\n${RESET_USAGE}`);
    return 1;
  }
  if (args.help) {
    console.log(RESET_USAGE);
    return 0;
  }
  if (args.remove) {
    if (!args.yes && !(await ask(`Delete ${args.path} permanently? [y/N] `))) {
      console.error("Not deleted (pass --yes to skip the prompt).");
      return 1;
    }
    console.log(deleteLedger(args.path) ? `Deleted ${args.path}` : `No ledger at ${args.path}`);
    return 0;
  }
  const archive = archiveLedger(args.path);
  console.log(archive ? `Archived ${args.path} -> ${archive}` : `No ledger at ${args.path}`);
  return 0;
}
