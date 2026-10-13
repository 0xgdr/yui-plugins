import { createLogger } from "./redact.js";

const logger = createLogger("yui:client");

export const RETRY_BUDGET_MS = 30_000;
export const BACKOFF_MS = [1000, 2000, 4000] as const;
export const MAX_RATE_LIMIT_WAIT_SECONDS = 30;

export interface YuiClientOptions {
  url: string;
  sleepMs?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Total wall time per call, waits included. Defaults to RETRY_BUDGET_MS. */
  budgetMs?: number;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | null;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: {
    code: number;
    message: string;
  };
}

/** An answer from Yui that refuses the request: `{ error: "<code>", message }`. */
export class YuiApiError extends Error {
  readonly code: string;
  readonly serverMessage: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    code: string,
    message: string,
    options: { status?: number; retryAfterSeconds?: number } = {}
  ) {
    super(`Yui error (${code}): ${message}`);
    this.name = "YuiApiError";
    this.code = code;
    this.serverMessage = message;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Yui could not be reached (network error, 502/503 or timeout) within the retry budget. */
export class YuiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YuiUnavailableError";
  }
}

type Attempt =
  | { kind: "ok"; rpc: JsonRpcResponse }
  | { kind: "retry"; reason: string }
  | { kind: "rate_limited"; retryAfterSeconds?: number; message: string };

const MAX_ERROR_BODY_CHARS = 200;

export class YuiClient {
  private idCounter = 0;
  private readonly sleepMs: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly budgetMs: number;

  constructor(private readonly options: YuiClientOptions) {
    this.budgetMs = options.budgetMs ?? RETRY_BUDGET_MS;
    this.sleepMs = options.sleepMs || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now || Date.now;
  }

  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.idCounter;
    const body: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    };
    const rpc = await this.send(JSON.stringify(body), id, true);
    const payload = parseToolPayload(rpc);
    if (payload.repeat === true) {
      logger.log(`${name}: already stored (repeat: true)`);
    }
    return payload;
  }

  async listTools(): Promise<unknown> {
    const id = ++this.idCounter;
    const body: JsonRpcRequest = { jsonrpc: "2.0", id, method: "tools/list", params: {} };
    const rpc = await this.send(JSON.stringify(body), id, false);
    return rpc.result;
  }

  /**
   * Sends one serialised body, resending exactly the same string on 502/503, network errors and
   * one short rate-limit wait. Everything, including waits, fits inside the budget.
   */
  private async send(bodyStr: string, id: number, isToolCall: boolean): Promise<JsonRpcResponse> {
    const start = this.now();
    const elapsed = () => this.now() - start;
    let attempts = 0;
    let failures = 0;
    let waitedForRateLimit = false;

    while (true) {
      const outcome = await this.attempt(bodyStr, id, isToolCall, this.budgetMs - elapsed());
      attempts++;

      if (outcome.kind === "ok") {
        return outcome.rpc;
      }

      if (outcome.kind === "rate_limited") {
        const seconds = outcome.retryAfterSeconds;
        const waitMs = seconds === undefined ? undefined : Math.ceil(seconds * 1000);
        if (
          waitedForRateLimit ||
          waitMs === undefined ||
          seconds! > MAX_RATE_LIMIT_WAIT_SECONDS ||
          elapsed() + waitMs >= this.budgetMs
        ) {
          throw new YuiApiError("rate_limited", outcome.message, {
            status: 429,
            retryAfterSeconds: seconds,
          });
        }
        waitedForRateLimit = true;
        logger.warn(`Rate limited, waiting ${seconds}s before resending`);
        await this.sleepMs(waitMs);
        continue;
      }

      const backoffMs = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
      failures++;
      if (elapsed() + backoffMs >= this.budgetMs) {
        throw new YuiUnavailableError(
          `Yui is unavailable (${outcome.reason}); gave up after ${attempts} attempts in ${elapsed()}ms`
        );
      }
      logger.warn(`${outcome.reason}, retrying in ${backoffMs}ms`);
      await this.sleepMs(backoffMs);
    }
  }

  private async attempt(
    bodyStr: string,
    id: number,
    isToolCall: boolean,
    remainingMs: number
  ): Promise<Attempt> {
    if (remainingMs <= 0) {
      throw new YuiUnavailableError(`Yui did not answer within ${this.budgetMs}ms`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    try {
      let response: Response;
      try {
        response = await fetch(this.options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: bodyStr,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new YuiUnavailableError(`Yui did not answer within ${this.budgetMs}ms`);
        }
        return { kind: "retry", reason: `network error: ${errorText(err)}` };
      }

      if (response.status === 502 || response.status === 503) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "retry", reason: `HTTP ${response.status}` };
      }

      const text = await response.text();

      if (response.status === 429) {
        const body = tryParseJson(text) as Record<string, unknown> | null;
        return {
          kind: "rate_limited",
          retryAfterSeconds: retryAfterFrom(body?.retryAfterSeconds, response.headers),
          message: typeof body?.message === "string" ? body.message : "Too many requests",
        };
      }

      if (!response.ok) {
        const body = tryParseJson(text) as Record<string, unknown> | null;
        if (body && typeof body.error === "string") {
          throw new YuiApiError(body.error, String(body.message ?? ""), {
            status: response.status,
          });
        }
        throw new YuiApiError(`http_${response.status}`, text.slice(0, MAX_ERROR_BODY_CHARS), {
          status: response.status,
        });
      }

      const contentType = response.headers.get("content-type") || "";
      const rpc = contentType.includes("text/event-stream")
        ? parseSse(text, id)
        : (tryParseJson(text) as JsonRpcResponse | null);
      if (!rpc || typeof rpc !== "object") {
        throw new YuiApiError("bad_response", "Yui sent a response that is not JSON-RPC");
      }
      if (rpc.error) {
        throw new YuiApiError("rpc_error", rpc.error.message);
      }

      if (isToolCall) {
        const payload = peekToolPayload(rpc);
        if (payload?.error === "rate_limited") {
          return {
            kind: "rate_limited",
            retryAfterSeconds: retryAfterFrom(payload.retryAfterSeconds, response.headers),
            message: typeof payload.message === "string" ? payload.message : "Rate limited",
          };
        }
      }
      return { kind: "ok", rpc };
    } finally {
      clearTimeout(timer);
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function retryAfterFrom(fromBody: unknown, headers: Headers): number | undefined {
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody >= 0) {
    return fromBody;
  }
  const header = headers.get("retry-after");
  if (header !== null && header.trim() !== "") {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds;
    }
  }
  return undefined;
}

/** Parses an SSE body and returns the JSON-RPC message answering `id`. */
export function parseSse(text: string, id: number): JsonRpcResponse {
  const events: string[] = [];
  let data: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      if (data.length > 0) events.push(data.join("\n"));
      data = [];
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (data.length > 0) events.push(data.join("\n"));

  const messages = events
    .map((event) => tryParseJson(event) as JsonRpcResponse | null)
    .filter((m): m is JsonRpcResponse => m !== null && typeof m === "object");
  const answer =
    messages.find((m) => m.id === id && ("result" in m || "error" in m)) ??
    messages[messages.length - 1];
  if (!answer) {
    throw new YuiApiError("bad_response", "Yui sent an event stream with no JSON-RPC message");
  }
  return answer;
}

function peekToolPayload(rpc: JsonRpcResponse): Record<string, unknown> | null {
  const text = rpc.result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  const payload = tryParseJson(text);
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
}

function parseToolPayload(rpc: JsonRpcResponse): Record<string, unknown> {
  const payload = peekToolPayload(rpc);
  if (!payload) {
    throw new YuiApiError("bad_response", "Yui sent a tool result without a JSON payload");
  }
  if (typeof payload.error === "string") {
    throw new YuiApiError(payload.error, String(payload.message ?? ""), {
      retryAfterSeconds:
        typeof payload.retryAfterSeconds === "number" ? payload.retryAfterSeconds : undefined,
    });
  }
  return payload;
}
