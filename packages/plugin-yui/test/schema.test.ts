import { describe, test, expect } from "bun:test";
import Ajv from "ajv";
import type { Action, Memory } from "@elizaos/core";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import toolsList from "./fixtures/tools-list.json";
import yuiPlugin from "../src/index";
import { YuiService } from "../src/service";
import { createMockYuiServer } from "./mock-yui";
import { createFakeClock, createMockRuntime } from "./helpers";

const LIVE_TOOLS = [
  "list_rooms",
  "read_room",
  "post",
  "prepare_signed_post",
  "inbox",
  "prepare_delete",
  "delete_post",
  "ask_sui",
  "check_coin",
  "find_service",
  "prepare_listing",
  "submit_listing",
  "get_archive",
  "search_directory",
];

const ACTION_INPUTS: Record<string, Record<string, unknown>> = {
  YUI_LIST_ROOMS: {},
  YUI_READ_ROOM: { room: "lobby", after: 1, limit: 500, wait_seconds: 60 },
  YUI_POST: { room: "lobby", text: "hello", replyTo: 1 },
  YUI_POST_SIGNED: { room: "sandbox", text: "signed hello", replyTo: 2 },
  YUI_ASK_SUI: { question: "How do I publish a Move package?" },
  YUI_CHECK_COIN: { coinType: "0x2::sui::SUI" },
  YUI_SEARCH_DIRECTORY: { query: "walrus", kind: "doc", limit: 5 },
  YUI_FIND_SERVICE: { query: "move audit", limit: 3 },
  YUI_INBOX: {},
};

describe("Schema validation (Test 1)", () => {
  test("the fixture is the live tools/list snapshot", () => {
    expect(toolsList.tools.map((t) => t.name).sort()).toEqual([...LIVE_TOOLS].sort());
  });

  test("every tool call the actions make exists and validates against its inputSchema", async () => {
    const ajv = new Ajv({ strict: false });
    const schemas = new Map(toolsList.tools.map((t) => [t.name, ajv.compile(t.inputSchema)]));

    const clock = createFakeClock();
    const mock = createMockYuiServer({ now: clock.now });
    const runtime = createMockRuntime({
      YUI_MCP_URL: mock.url,
      YUI_ROOMS: "lobby,sandbox",
      YUI_HANDLE: "my-agent",
      YUI_PRIVATE_KEY: Ed25519Keypair.generate().getSecretKey(),
    });
    runtime.addService(new YuiService(runtime, clock));

    try {
      for (const action of yuiPlugin.actions as Action[]) {
        const input = ACTION_INPUTS[action.name];
        expect(input).toBeDefined();
        const result = await action.handler(
          runtime,
          { content: input } as unknown as Memory,
          undefined,
          undefined,
          undefined
        );
        expect({ action: action.name, success: (result as { success: boolean }).success }).toEqual({
          action: action.name,
          success: true,
        });
      }

      const calls = mock.requests.filter((r) => r.rpcMethod === "tools/call");
      const used = new Set(calls.map((c) => c.tool!));
      expect([...used].sort()).toEqual(
        [
          "ask_sui",
          "check_coin",
          "find_service",
          "inbox",
          "list_rooms",
          "post",
          "prepare_signed_post",
          "read_room",
          "search_directory",
        ].sort()
      );
      expect(used.has("prepare_listing")).toBe(false);
      expect(used.has("submit_listing")).toBe(false);

      for (const call of calls) {
        const validate = schemas.get(call.tool!);
        expect(validate).toBeDefined();
        const valid = validate!(call.args);
        expect({ tool: call.tool, errors: valid ? null : validate!.errors }).toEqual({
          tool: call.tool,
          errors: null,
        });
      }

      const read = calls.find((c) => c.tool === "read_room")!;
      expect(read.args).toEqual({ room: "lobby", after: 1, limit: 200, wait_seconds: 25 });
    } finally {
      mock.stop();
    }
  });
});
