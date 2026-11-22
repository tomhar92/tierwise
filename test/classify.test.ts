import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTurn } from "../src/classify.js";

const PROBABILITIES = { haiku: 0.1, sonnet: 0.1, opus: 0.7, fable: 0.1 };

function fakeResponse(choiceValue: string, probabilities: Record<string, number> = PROBABILITIES) {
  return {
    answers: {
      tier: { type: "choice", choice: choiceValue, confidence: 0.8, probabilities },
    },
  };
}

function clientReturning(response: unknown, onCall?: (request: unknown, options: unknown) => void) {
  return {
    systemOne: (async (request: unknown, options: unknown) => {
      onCall?.(request, options);
      return response;
    }) as never,
  };
}

test("maps a successful TypeSafe response to a ClassifyResult", async () => {
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "fix this hard bug" },
    { client: clientReturning(fakeResponse("opus")) }
  );
  assert.deepEqual(result, { choice: "opus", confidence: 0.8, probabilities: PROBABILITIES });
});

test("returns null when the call rejects", async () => {
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "x" },
    {
      client: {
        systemOne: (async () => {
          throw new Error("network error");
        }) as never,
      },
    }
  );
  assert.equal(result, null);
});

test("gives the SDK the deadline and disables its retries", async () => {
  let seen: any = null;
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "hi" },
    {
      timeoutMs: 1500,
      client: clientReturning(fakeResponse("sonnet"), (_request, options) => {
        seen = options;
      }),
    }
  );
  assert.equal(seen.timeout, 1500);
  assert.equal(seen.retry.maxRetries, 0);
  assert.equal(result?.choice, "sonnet");
});

test("forwards the caller's abort signal to the SDK", async () => {
  const controller = new AbortController();
  let seen: any = null;
  await classifyTurn(
    { recentMessages: [], latestUserMessage: "hi" },
    {
      signal: controller.signal,
      client: clientReturning(fakeResponse("sonnet"), (_request, options) => {
        seen = options;
      }),
    }
  );
  assert.equal(seen.signal, controller.signal);
});

test("treats a partial probability set as an unusable answer", async () => {
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "hi" },
    { client: clientReturning(fakeResponse("sonnet", { sonnet: 0.8 })) }
  );
  assert.equal(result, null);
});

test("carries the token usage the API reports, and omits it when the backend sends none", async () => {
  const withUsage = await classifyTurn(
    { recentMessages: [], latestUserMessage: "x" },
    { client: clientReturning({ ...fakeResponse("opus"), usage: { input_tokens: 1800, output_tokens: 3 } }) }
  );
  assert.deepEqual(withUsage?.usage, { inputTokens: 1800, outputTokens: 3 });
  const without = await classifyTurn(
    { recentMessages: [], latestUserMessage: "x" },
    { client: clientReturning(fakeResponse("opus")) }
  );
  assert.equal(without?.usage, undefined);
});

function clientRejecting(error: unknown) {
  return { systemOne: (async () => { throw error; }) as never };
}

async function failureReason(error: unknown): Promise<string | undefined> {
  let reason: string | undefined;
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "hi" },
    { client: clientRejecting(error), onFailure: (r) => { reason = r; } }
  );
  assert.equal(result, null);
  return reason;
}

test("a failed call says why, so a rejected key is not mistaken for a flaky API", async () => {
  assert.equal(await failureReason(Object.assign(new Error("Unauthorized"), { status: 401 })), "key rejected (HTTP 401)");
  assert.equal(await failureReason(Object.assign(new Error("Forbidden"), { status: 403 })), "key rejected (HTTP 403)");
  assert.equal(await failureReason(Object.assign(new Error("slow down"), { status: 429 })), "rate limited (HTTP 429)");
  assert.equal(await failureReason(Object.assign(new Error("oops"), { status: 503 })), "server error (HTTP 503)");
  assert.equal(await failureReason(Object.assign(new Error("Request timed out"), { name: "APIConnectionTimeoutError" })), "timed out");
  assert.match((await failureReason(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", hostname: "api.typesafe.ai" } })))!, /could not reach api\.typesafe\.ai/);
  assert.equal(await failureReason(new RangeError("weird")), "unexpected RangeError");
});

test("the failure reason never includes the error message, which could carry request data", async () => {
  const reason = await failureReason(new Error("sk-secret-value in the message"));
  assert.doesNotMatch(String(reason), /secret/);
});
