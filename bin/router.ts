#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createProxyServer, describeBackend, reportStartupProblems } from "../src/server.js";
import { DEFAULT_LIMITS, type PolicyLimits } from "../src/policy.js";
import { isMainModule } from "../src/isMainModule.js";
import { reportMain } from "./report.js";

const USAGE = `tierwise - cache-aware model tier router for Claude Code

  tierwise [claude args]    run claude through the router (capped at opus)
  tierwise run -- <cmd>     the same for any command, with your own settings
  tierwise serve            start a standalone proxy (PORT, HOST)
  tierwise report [path]    summarize a ledger
`;

// The launcher is the first-run path, so it caps autonomous spend at opus
// unless the operator has said otherwise. `serve` and `run` keep the plain
// defaults and the "no ceiling" warning.
export function launchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env.ROUTER_MAX_TIER?.trim() ? env : { ...env, ROUTER_MAX_TIER: "opus" };
}

export function launchLimits(env: NodeJS.ProcessEnv): PolicyLimits {
  return env.ROUTER_MAX_TIER?.trim() ? DEFAULT_LIMITS : { ...DEFAULT_LIMITS, maxTier: "opus" };
}

async function listenOnEphemeralPort(limits: PolicyLimits) {
  const server = createProxyServer({ limits });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  return { server, port };
}

// The whole setup dance - start the proxy, point ANTHROPIC_BASE_URL at
// it, run the client, shut down - in one command, so trying the router
// costs one line instead of two terminals and three env vars.
export async function run(
  argv: string[],
  limits: PolicyLimits = DEFAULT_LIMITS,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  if (argv.length === 0) {
    console.error(USAGE);
    return 1;
  }
  const { server, port } = await listenOnEphemeralPort(limits);
  const child = spawn(argv[0], argv.slice(1), {
    stdio: "inherit",
    env: { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` },
  });
  const code = await new Promise<number>((resolve) => {
    child.on("exit", (exitCode) => resolve(exitCode ?? 0));
    child.on("error", () => resolve(1));
  });
  // Drop keep-alive sockets too, or close() waits on them and the wrapper
  // hangs after the client has already exited.
  server.closeAllConnections();
  server.close();
  return code;
}

// Bare invocation: `tierwise` or `tierwise --model haiku`.
export async function launchClaude(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const effective = launchEnv(env);
  if (reportStartupProblems(effective)) return 1;
  const limits = launchLimits(env);
  console.log(
    `tierwise: routing ${limits.minTier} to ${limits.maxTier} via ${describeBackend(effective)}`
  );
  return run(["claude", ...args], limits, effective);
}

if (isMainModule(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);

  if (command === undefined || command.startsWith("-")) {
    if (command === "--help" || command === "-h") {
      console.log(USAGE);
    } else {
      launchClaude(process.argv.slice(2), process.env).then((code) => process.exit(code));
    }
  } else if (command === "report") {
    reportMain(rest);
  } else if (command === "run") {
    if (reportStartupProblems(process.env)) process.exit(1);
    const args = rest[0] === "--" ? rest.slice(1) : rest;
    run(args).then((code) => process.exit(code));
  } else if (command === "serve") {
    if (reportStartupProblems(process.env)) process.exit(1);
    const port = Number(process.env.PORT ?? 8787);
    const host = process.env.HOST ?? "127.0.0.1";
    createProxyServer().listen(port, host, () => {
      console.log(`tierwise listening on http://${host}:${port}`);
      console.log(`classifier: ${describeBackend(process.env)}`);
    });
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}
