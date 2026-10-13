import { describe, test, expect } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import { loadConfig } from "../src/config";

function createMockRuntime(settings: Record<string, string>): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key] || null,
  } as unknown as IAgentRuntime;
}

describe("Config (Test 16)", () => {
  test("default URL is https://suiagent.chat/mcp", () => {
    const runtime = createMockRuntime({});
    const config = loadConfig(runtime);
    expect(config.mcpUrl).toBe("https://suiagent.chat/mcp");
  });

  test("rejects non-https URLs except localhost", () => {
    const runtime1 = createMockRuntime({ YUI_MCP_URL: "http://example.com/mcp" });
    expect(() => loadConfig(runtime1)).toThrow(/https/);

    const runtime2 = createMockRuntime({ YUI_MCP_URL: "http://localhost:3000/mcp" });
    const config2 = loadConfig(runtime2);
    expect(config2.mcpUrl).toBe("http://localhost:3000/mcp");

    const runtime3 = createMockRuntime({ YUI_MCP_URL: "http://127.0.0.1:3000/mcp" });
    const config3 = loadConfig(runtime3);
    expect(config3.mcpUrl).toBe("http://127.0.0.1:3000/mcp");
  });

  test("validates handle regex", () => {
    const runtime1 = createMockRuntime({ YUI_HANDLE: "valid-handle-123" });
    const config1 = loadConfig(runtime1);
    expect(config1.handle).toBe("valid-handle-123");

    const runtime2 = createMockRuntime({ YUI_HANDLE: "-invalid" });
    expect(() => loadConfig(runtime2)).toThrow(/alphanumeric/);

    const runtime3 = createMockRuntime({ YUI_HANDLE: "A" });
    expect(() => loadConfig(runtime3)).toThrow(/alphanumeric/);

    const runtime4 = createMockRuntime({ YUI_HANDLE: "a".repeat(25) });
    expect(() => loadConfig(runtime4)).toThrow(/1-24/);
  });

  test("parses YUI_ROOMS", () => {
    const runtime1 = createMockRuntime({});
    const config1 = loadConfig(runtime1);
    expect(config1.rooms).toEqual(["lobby", "ask-sui"]);

    const runtime2 = createMockRuntime({ YUI_ROOMS: "lobby, sandbox , ask-sui" });
    const config2 = loadConfig(runtime2);
    expect(config2.rooms).toEqual(["lobby", "sandbox", "ask-sui"]);

    const runtime3 = createMockRuntime({ YUI_ROOMS: "single" });
    const config3 = loadConfig(runtime3);
    expect(config3.rooms).toEqual(["single"]);
  });

  test("parses YUI_POSTS_PER_MINUTE", () => {
    const runtime1 = createMockRuntime({});
    const config1 = loadConfig(runtime1);
    expect(config1.postsPerMinute).toBe(1);

    const runtime2 = createMockRuntime({ YUI_POSTS_PER_MINUTE: "5" });
    const config2 = loadConfig(runtime2);
    expect(config2.postsPerMinute).toBe(5);

    const runtime3 = createMockRuntime({ YUI_POSTS_PER_MINUTE: "invalid" });
    expect(() => loadConfig(runtime3)).toThrow(/positive integer/);

    const runtime4 = createMockRuntime({ YUI_POSTS_PER_MINUTE: "0" });
    expect(() => loadConfig(runtime4)).toThrow(/positive integer/);
  });
});
