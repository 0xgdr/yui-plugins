import { describe, test, expect, afterEach } from "bun:test";
import type { Action, ActionResult, Memory } from "@elizaos/core";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { YuiService } from "../src/service";
import { listRoomsAction } from "../src/actions/listRooms";
import { readRoomAction } from "../src/actions/readRoom";
import { askSuiAction } from "../src/actions/askSui";
import { checkCoinAction } from "../src/actions/checkCoin";
import { searchDirectoryAction } from "../src/actions/searchDirectory";
import { findServiceAction } from "../src/actions/findService";
import { inboxAction } from "../src/actions/inbox";
import { roomsProvider } from "../src/providers/rooms";
import { createMockYuiServer, type MockYuiServer, type ScriptedResponse } from "./mock-yui";
import { createFakeClock, createMockRuntime } from "./helpers";

let mock: MockYuiServer | undefined;
afterEach(() => {
  mock?.stop();
  mock = undefined;
});

function setup(
  settings: Record<string, string> = {},
  scriptedResponses?: Map<string, ScriptedResponse[]>
) {
  const clock = createFakeClock();
  mock = createMockYuiServer({ now: clock.now, scriptedResponses });
  const runtime = createMockRuntime({ YUI_MCP_URL: mock.url, ...settings });
  const service = new YuiService(runtime, clock);
  runtime.addService(service);
  return { runtime, mock, service, clock };
}

async function run(
  action: Action,
  runtime: ReturnType<typeof createMockRuntime>,
  content: Record<string, unknown> = {}
) {
  const callbacks: Array<{ text?: string; actions?: string[] }> = [];
  const result = (await action.handler(
    runtime,
    { content } as unknown as Memory,
    undefined,
    undefined,
    async (c) => {
      callbacks.push(c);
      return [];
    }
  )) as ActionResult;
  return { result, callbacks };
}

const lastArgs = (m: MockYuiServer, tool: string) => m.toolCalls(tool).at(-1)!.args;

describe("Read-only actions (Test 17)", () => {
  test("YUI_LIST_ROOMS renders write mode and the off-topic text", async () => {
    const { runtime, mock } = setup();
    const { result, callbacks } = await run(listRoomsAction, runtime);

    expect(result.success).toBe(true);
    expect(lastArgs(mock, "list_rooms")).toEqual({});
    expect(result.text).toContain("- lobby (Lobby): anyone can post.");
    expect(result.text).toContain("- sui-news (Sui news): resident agents only.");
    expect(result.text).toContain("Off-topic: Long technical threads");
    expect(callbacks[0].actions).toEqual(["YUI_LIST_ROOMS"]);
  });

  test("YUI_ROOMS provider gives each room's write mode and off-topic text", async () => {
    const { runtime } = setup({ YUI_ROOMS: "lobby,sandbox" });
    const result = await roomsProvider.get(runtime, {} as Memory, {} as never);
    expect(result.text).toContain("you may post in: lobby, sandbox");
    expect(result.text).toContain("- signed-only (Signed only): signed posts only.");
    expect(result.text).toContain("Off-topic: Nothing: it's for testing");
  });

  test("YUI_ROOMS gives up within 5s when Yui is down, then stops asking for 30s", async () => {
    const down = Array.from({ length: 20 }, () => ({ status: 503, body: {} }));
    const { runtime, mock, clock } = setup({}, new Map([["list_rooms", down]]));

    const start = clock.now();
    const first = await roomsProvider.get(runtime, {} as Memory, {} as never);
    expect(first.text).toBe("Yui rooms are unavailable right now.");
    expect(clock.now() - start).toBeLessThanOrEqual(5_000);
    const calls = mock.toolCalls("list_rooms").length;

    clock.advance(10_000);
    const second = await roomsProvider.get(runtime, {} as Memory, {} as never);
    expect(second.text).toBe("Yui rooms are unavailable right now.");
    expect(mock.toolCalls("list_rooms")).toHaveLength(calls);
  });

  test("YUI_ROOMS falls back to the last known rooms when a refresh fails", async () => {
    const { runtime, mock, service, clock } = setup();
    await service.getRooms();
    mock.stop();
    clock.advance(61_000);

    const result = await roomsProvider.get(runtime, {} as Memory, {} as never);
    expect(result.text).toContain("- lobby (");
    await expect(service.getRooms({ forceRefresh: true })).rejects.toThrow();
  });

  test("YUI_READ_ROOM passes after/limit/wait_seconds and wraps each message", async () => {
    const { runtime, mock } = setup();
    const { result } = await run(readRoomAction, runtime, {
      room: "lobby",
      after: 100,
      limit: 50,
      wait_seconds: 10,
    });

    expect(result.success).toBe(true);
    expect(lastArgs(mock, "read_room")).toEqual({
      room: "lobby",
      after: 100,
      limit: 50,
      wait_seconds: 10,
    });
    expect(result.text).toContain('<yui_untrusted room="lobby" seq="1" from="guest-agent-one">');
    expect(result.text).toContain('<yui_untrusted room="lobby" seq="2" from="agent-two">');
    expect(result.data?.lastSeq).toBe(2);
  });

  test("YUI_ASK_SUI renders passages with links and code", async () => {
    const { runtime, mock } = setup();
    const { result } = await run(askSuiAction, runtime, {
      question: "How do I publish a Move package?",
    });

    expect(result.success).toBe(true);
    expect(lastArgs(mock, "ask_sui")).toEqual({ question: "How do I publish a Move package?" });
    expect(result.text).toContain("Build and Publish a Package > Publish");
    expect(result.text).toContain("Run sui client publish");
    expect(result.text).toContain("https://docs.sui.io/guides/developer/first-app/publish");
    expect(result.text).not.toContain("undefined");
  });

  test("YUI_CHECK_COIN sends coinType and presents facts, not advice", async () => {
    const { runtime, mock } = setup();
    const { result } = await run(checkCoinAction, runtime, { coinType: "0x2::sui::SUI" });

    expect(result.success).toBe(true);
    expect(lastArgs(mock, "check_coin")).toEqual({ coinType: "0x2::sui::SUI" });
    expect(result.text).toContain("SUI is the system coin");
    expect(result.text).toContain("not a rating, an endorsement or financial advice");
    expect(result.text).not.toMatch(/\bsafe\b/i);
  });

  test("YUI_SEARCH_DIRECTORY sends query/kind/limit and renders names and links", async () => {
    const { runtime, mock } = setup();
    const { result } = await run(searchDirectoryAction, runtime, {
      query: "walrus",
      kind: "doc",
      limit: 10,
    });

    expect(result.success).toBe(true);
    expect(lastArgs(mock, "search_directory")).toEqual({ query: "walrus", kind: "doc", limit: 10 });
    expect(result.text).toContain('<yui_untrusted n="1" kind="doc">\nData Storage Using Walrus');
    expect(result.text).toContain("https://docs.sui.io/sui-stack/walrus/sui-stack-walrus");
    expect(result.text).not.toContain("undefined");
  });

  test("YUI_FIND_SERVICE renders name, price and link, and never pays", async () => {
    const { runtime, mock } = setup();
    const { result } = await run(findServiceAction, runtime, { query: "move audit", limit: 5 });

    expect(result.success).toBe(true);
    expect(lastArgs(mock, "find_service")).toEqual({ query: "move audit", limit: 5 });
    expect(result.text).toContain(
      '<yui_untrusted n="1" kind="hire" priceUsdc="10" slaMinutes="1440" reviewScore="4.4" reviewCount="5">\nMove Package Review'
    );
    expect(result.text).toContain("https://example.com/services/move-package-review");
    expect(result.text).toContain("never hires or pays");
    expect(result.text).not.toContain("undefined");
    expect(mock.toolCalls("post")).toHaveLength(0);
  });

  test("YUI_INBOX sends the signer's address, stores next and reuses it as since", async () => {
    const keypair = Ed25519Keypair.generate();
    const { runtime, mock, service } = setup({ YUI_PRIVATE_KEY: keypair.getSecretKey() });

    const first = await run(inboxAction, runtime);
    expect(first.result.success).toBe(true);
    expect(lastArgs(mock, "inbox")).toEqual({ address: keypair.toSuiAddress() });
    expect(service.inboxCursor).toBe("start-next");
    expect(first.result.text).toContain('<yui_untrusted room="lobby" seq="8" from="agent-three"');

    await run(inboxAction, runtime);
    expect(lastArgs(mock, "inbox")).toEqual({
      address: keypair.toSuiAddress(),
      since: "start-next",
    });
    expect(service.inboxCursor).toBe("start-next-next");
  });

  test("YUI_INBOX validate is false in guest mode", async () => {
    const { runtime } = setup();
    expect(await inboxAction.validate(runtime, {} as Memory)).toBe(false);
  });
});
