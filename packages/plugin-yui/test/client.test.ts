import { describe, test, expect, afterEach } from "bun:test";
import {
  YuiClient,
  YuiApiError,
  YuiUnavailableError,
  RETRY_BUDGET_MS,
  parseSse,
} from "../src/client";
import { createMockYuiServer, type MockYuiServer } from "./mock-yui";
import { createFakeClock } from "./helpers";

let mock: MockYuiServer | undefined;
afterEach(() => {
  mock?.stop();
  mock = undefined;
});

const status = (code: number, extra: Partial<{ headers: Record<string, string> }> = {}) => ({
  status: code,
  body: {},
  ...extra,
});

describe("Client (Test 2)", () => {
  test("parses both a JSON response and an SSE data: response", async () => {
    mock = createMockYuiServer({
      scriptedResponses: new Map([
        ["list_rooms", [{ status: 200, body: { rooms: [{ id: "lobby" }] } }]],
        ["ask_sui", [{ status: 200, body: { found: true, passages: [] }, sse: true }]],
      ]),
    });
    const client = new YuiClient({ url: mock.url });

    expect(await client.call("list_rooms", {})).toEqual({ rooms: [{ id: "lobby" }] });
    expect(await client.call("ask_sui", { question: "What is Sui?" })).toEqual({
      found: true,
      passages: [],
    });
  });

  test("SSE parsing handles data: without a space, CRLF, and picks the answer to our id", () => {
    const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" });
    const answer = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { content: [] } });
    const body = `event: message\r\ndata:${notification}\r\n\r\nevent: message\r\ndata: ${answer}\r\n\r\n`;
    expect(parseSse(body, 7)).toEqual(JSON.parse(answer));
  });

  test("sends the Accept header the live server requires, including for tools/list", async () => {
    mock = createMockYuiServer();
    const client = new YuiClient({ url: mock.url });
    const result = (await client.listTools()) as { tools: unknown[] };
    expect(Array.isArray(result.tools)).toBe(true);
    for (const r of mock.requests) {
      expect(r.accept).toContain("application/json");
      expect(r.accept).toContain("text/event-stream");
    }
  });

  test("application errors become YuiApiError with the server's code", async () => {
    mock = createMockYuiServer({
      scriptedResponses: new Map([
        ["check_coin", [{ status: 200, body: { error: "bad_coin_type", message: "Give a type" } }]],
      ]),
    });
    const client = new YuiClient({ url: mock.url });
    const err = await client.call("check_coin", { coinType: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(YuiApiError);
    expect(err.code).toBe("bad_coin_type");
  });
});

describe("Client retries (Tests 5-8)", () => {
  test("Test 5 (client): 502, 503, then success resends byte-identical bodies with 1s, 2s backoff", async () => {
    mock = createMockYuiServer({
      scriptedResponses: new Map([
        ["post", [status(502), status(503), { status: 200, body: { message: { seq: 1 } } }]],
      ]),
    });
    const clock = createFakeClock();
    const client = new YuiClient({ url: mock.url, ...clock });

    await client.call("post", { room: "lobby", text: "retry test" });

    const bodies = mock.toolCalls("post").map((r) => r.body);
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
    expect(clock.sleeps).toEqual([1000, 2000]);
  });

  test("Test 6: 502 forever gives up inside the 30s budget with a clear error", async () => {
    mock = createMockYuiServer({
      scriptedResponses: new Map([["post", Array.from({ length: 50 }, () => status(502))]]),
    });
    const clock = createFakeClock();
    const client = new YuiClient({ url: mock.url, ...clock });
    const start = clock.now();

    const err = await client.call("post", { room: "lobby", text: "will fail" }).catch((e) => e);

    expect(err).toBeInstanceOf(YuiUnavailableError);
    expect(err.message).toMatch(/unavailable \(HTTP 502\); gave up after \d+ attempts/);
    expect(clock.now() - start).toBeLessThanOrEqual(RETRY_BUDGET_MS);
    expect(clock.sleeps).toEqual([1000, 2000, 4000, 4000, 4000, 4000, 4000, 4000]);
    expect(new Set(mock.toolCalls("post").map((r) => r.body)).size).toBe(1);
  });

  test("network errors are retried with the same body (Bun's ECONNREFUSED is not 'fetch failed')", async () => {
    mock = createMockYuiServer({
      scriptedResponses: new Map([["post", [{ status: 200, body: { message: { seq: 1 } } }]]]),
    });
    const realFetch = globalThis.fetch;
    let failures = 0;
    const sent: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent.push(String(init?.body));
      if (failures++ === 0) {
        throw new TypeError(
          "ECONNREFUSED: Unable to connect. Is the computer able to access the url?"
        );
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const clock = createFakeClock();
      const client = new YuiClient({ url: mock.url, ...clock });
      const result = await client.call("post", { room: "lobby", text: "net" });
      expect(result).toEqual({ message: { seq: 1 } });
      expect(sent).toHaveLength(2);
      expect(sent[0]).toBe(sent[1]);
      expect(clock.sleeps).toEqual([1000]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("Test 7 (client): 502 then 200 repeat:true resolves with the repeat payload", async () => {
    mock = createMockYuiServer({
      scriptedResponses: new Map([
        ["post", [status(502), { status: 200, body: { repeat: true, message: { seq: 9 } } }]],
      ]),
    });
    const client = new YuiClient({ url: mock.url, ...createFakeClock() });
    const result = await client.call("post", { room: "lobby", text: "duplicate" });
    expect(result.repeat).toBe(true);
    expect(mock.toolCalls("post")).toHaveLength(2);
  });

  test("Test 8a: retryAfterSeconds 2 is waited once and the same body is resent", async () => {
    mock = createMockYuiServer({
      scriptedResponses: new Map([
        [
          "post",
          [
            { status: 200, body: { error: "rate_limited", message: "Slow", retryAfterSeconds: 2 } },
            { status: 200, body: { message: { seq: 3 } } },
          ],
        ],
      ]),
    });
    const clock = createFakeClock();
    const client = new YuiClient({ url: mock.url, ...clock });

    await client.call("post", { room: "lobby", text: "test" });

    expect(clock.sleeps).toEqual([2000]);
    const bodies = mock.toolCalls("post").map((r) => r.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test("Test 8b: retryAfterSeconds 120 returns a rate-limit error without waiting", async () => {
    mock = createMockYuiServer({
      scriptedResponses: new Map([
        [
          "post",
          [
            {
              status: 200,
              body: { error: "rate_limited", message: "Slow", retryAfterSeconds: 120 },
            },
          ],
        ],
      ]),
    });
    const clock = createFakeClock();
    const client = new YuiClient({ url: mock.url, ...clock });

    const err = await client.call("post", { room: "lobby", text: "test" }).catch((e) => e);

    expect(err).toBeInstanceOf(YuiApiError);
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfterSeconds).toBe(120);
    expect(clock.sleeps).toEqual([]);
    expect(mock.toolCalls("post")).toHaveLength(1);
  });

  test("Test 8c: a second 429 is not waited again (wait once)", async () => {
    const limited = {
      status: 200,
      body: { error: "rate_limited", message: "Slow", retryAfterSeconds: 2 },
    };
    mock = createMockYuiServer({
      scriptedResponses: new Map([["post", [limited, limited, limited]]]),
    });
    const clock = createFakeClock();
    const client = new YuiClient({ url: mock.url, ...clock });

    const err = await client.call("post", { room: "lobby", text: "test" }).catch((e) => e);

    expect(err.code).toBe("rate_limited");
    expect(clock.sleeps).toEqual([2000]);
    expect(mock.toolCalls("post")).toHaveLength(2);
  });

  test("Test 8d: a plain HTTP 429 with Retry-After is honoured", async () => {
    mock = createMockYuiServer({
      scriptedResponses: new Map([
        [
          "post",
          [
            { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "3" } },
            { status: 200, body: { message: { seq: 4 } } },
          ],
        ],
      ]),
    });
    const clock = createFakeClock();
    const client = new YuiClient({ url: mock.url, ...clock });

    await client.call("post", { room: "lobby", text: "test" });

    expect(clock.sleeps).toEqual([3000]);
    const bodies = mock.toolCalls("post").map((r) => r.body);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test("a rate-limit wait that would overrun the 30s budget is not taken", async () => {
    mock = createMockYuiServer({
      scriptedResponses: new Map([
        [
          "post",
          [
            ...Array.from({ length: 6 }, () => status(502)),
            {
              status: 200,
              body: { error: "rate_limited", message: "Slow", retryAfterSeconds: 20 },
            },
          ],
        ],
      ]),
    });
    const clock = createFakeClock();
    const client = new YuiClient({ url: mock.url, ...clock });
    const start = clock.now();

    const err = await client.call("post", { room: "lobby", text: "test" }).catch((e) => e);

    expect(err.code).toBe("rate_limited");
    expect(clock.now() - start).toBeLessThanOrEqual(RETRY_BUDGET_MS);
  });

  test("a retryAfterSeconds of exactly 30 is not waited: it would leave no time to resend", async () => {
    mock = createMockYuiServer({
      scriptedResponses: new Map([
        [
          "post",
          [
            {
              status: 200,
              body: { error: "rate_limited", message: "Slow", retryAfterSeconds: 30 },
            },
          ],
        ],
      ]),
    });
    const clock = createFakeClock();
    const client = new YuiClient({ url: mock.url, ...clock });

    const err = await client.call("post", { room: "lobby", text: "test" }).catch((e) => e);

    expect(err).toBeInstanceOf(YuiApiError);
    expect(err.code).toBe("rate_limited");
    expect(clock.sleeps).toEqual([]);
  });

  test("waits over 30s are never taken, even when a larger budget would fit them", async () => {
    mock = createMockYuiServer({
      scriptedResponses: new Map([
        [
          "post",
          [
            {
              status: 200,
              body: { error: "rate_limited", message: "Slow", retryAfterSeconds: 31 },
            },
          ],
        ],
      ]),
    });
    const clock = createFakeClock();
    const client = new YuiClient({ url: mock.url, ...clock, budgetMs: 120_000 });

    const err = await client.call("post", { room: "lobby", text: "test" }).catch((e) => e);

    expect(err.code).toBe("rate_limited");
    expect(clock.sleeps).toEqual([]);
  });

  test("a server that never answers is aborted when the budget runs out", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError"))
        );
      });
    }) as typeof fetch;
    try {
      const client = new YuiClient({ url: "http://localhost:1/mcp", budgetMs: 50 });
      const started = Date.now();
      const err = await Promise.race([
        client.call("post", { room: "lobby", text: "stall" }).catch((e) => e),
        new Promise((resolve) => setTimeout(() => resolve("still waiting after 2s"), 2000)),
      ]);
      expect(err).toBeInstanceOf(YuiUnavailableError);
      expect(err.message).toContain("did not answer within 50ms");
      expect(calls).toBe(1);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
