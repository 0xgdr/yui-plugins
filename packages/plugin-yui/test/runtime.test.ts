import { describe, test, expect, afterEach } from "bun:test";
import { AgentRuntime, ModelType, type ActionResult, type Memory } from "@elizaos/core";
import { yuiPlugin } from "../src/index";
import { YuiService } from "../src/service";
import { createMockYuiServer, type MockYuiServer } from "./mock-yui";

let mock: MockYuiServer | undefined;
afterEach(() => {
  mock?.stop();
  mock = undefined;
});

/**
 * A real 1.7.2 AgentRuntime. initialize() needs a SQL adapter, so the test releases the init
 * barrier itself and gives useModel an adapter that only accepts its call log. Plugin
 * registration, getSetting, getService and useModel are the real ones; the OBJECT_SMALL model
 * is a stub that answers from the action named in its prompt.
 */
async function freshAgent(answers: Record<string, unknown>) {
  mock = createMockYuiServer();
  const runtime = new AgentRuntime({
    adapter: { log: async () => undefined } as never,
    character: {
      name: "test-agent",
      bio: [],
      settings: { YUI_MCP_URL: mock.url, YUI_ROOMS: "lobby,sandbox" },
    },
  });
  const prompts: string[] = [];
  runtime.registerModel(
    ModelType.OBJECT_SMALL,
    async (_runtime, params: Record<string, unknown>) => {
      const prompt = String(params.prompt);
      prompts.push(prompt);
      const action = /parameters for the (\w+) action/.exec(prompt)?.[1] ?? "";
      return answers[action] ?? {};
    },
    "test"
  );
  await runtime.registerPlugin(yuiPlugin);
  (runtime as unknown as { initResolver?: () => void }).initResolver?.();
  await runtime.getServiceLoadPromise(YuiService.serviceType as never);
  return { runtime, mock, prompts };
}

const say = (text: string) => ({ content: { text } }) as unknown as Memory;

describe("A fresh ElizaOS 1.7.2 agent with no key (AC 6)", () => {
  test("lists rooms, reads lobby and guest-posts from plain user text", async () => {
    const { runtime, mock, prompts } = await freshAgent({
      YUI_READ_ROOM: { room: "lobby" },
      YUI_POST: { room: "lobby", text: "hello from a fresh agent" },
    });
    const service = runtime.getService<YuiService>(YuiService.serviceType);
    expect(service).toBeInstanceOf(YuiService);
    expect(service!.signer).toBeNull();

    const action = (name: string) => runtime.actions.find((a) => a.name === name)!;
    for (const name of ["YUI_LIST_ROOMS", "YUI_READ_ROOM", "YUI_POST"]) {
      expect(await action(name).validate(runtime, say("hi"))).toBe(true);
    }
    expect(await action("YUI_POST_SIGNED").validate(runtime, say("hi"))).toBe(false);

    const rooms = (await action("YUI_LIST_ROOMS").handler(
      runtime,
      say("What rooms are on Yui?")
    )) as ActionResult;
    expect(rooms.success).toBe(true);
    expect(rooms.text).toContain("lobby");

    const read = (await action("YUI_READ_ROOM").handler(
      runtime,
      say("Read the latest messages in lobby")
    )) as ActionResult;
    expect(read.success).toBe(true);
    expect(read.text).toContain("<yui_untrusted");
    expect(mock.toolCalls("read_room").at(-1)!.args).toEqual({ room: "lobby" });

    const posted = (await action("YUI_POST").handler(
      runtime,
      say("Post 'hello from a fresh agent' to lobby")
    )) as ActionResult;
    expect(posted.success).toBe(true);
    expect(mock.toolCalls("post").at(-1)!.args).toEqual({
      room: "lobby",
      text: "hello from a fresh agent",
    });
    expect(prompts.some((p) => p.includes("Post 'hello from a fresh agent' to lobby"))).toBe(true);

    const provided = await runtime.providers
      .find((p) => p.name === "YUI_ROOMS")!
      .get(runtime, say("hi"), { values: {}, data: {}, text: "" });
    expect(provided.text).toContain("lobby");
  });
});
