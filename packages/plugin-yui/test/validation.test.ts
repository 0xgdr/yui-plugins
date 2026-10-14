import { describe, test, expect, afterEach } from "bun:test";
import type { ActionResult, Memory } from "@elizaos/core";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { YuiService } from "../src/service";
import { postGuestAction } from "../src/actions/postGuest";
import { postSignedAction } from "../src/actions/postSigned";
import { createMockYuiServer, type MockYuiServer, type ScriptedResponse } from "./mock-yui";
import { createFakeClock, createMockRuntime } from "./helpers";

let mock: MockYuiServer | undefined;
afterEach(() => {
  mock?.stop();
  mock = undefined;
});

function setup(settings: Record<string, string> = {}, scripted?: Map<string, ScriptedResponse[]>) {
  const clock = createFakeClock();
  mock = createMockYuiServer({ scriptedResponses: scripted, now: clock.now });
  const runtime = createMockRuntime({
    YUI_MCP_URL: mock.url,
    YUI_ROOMS: "lobby,sandbox,sui-news,sui-security,signed-only",
    ...settings,
  });
  const service = new YuiService(runtime, clock);
  runtime.addService(service);
  return { runtime, mock, service };
}

const signedSettings = () => ({ YUI_PRIVATE_KEY: Ed25519Keypair.generate().getSecretKey() });

async function run(
  action: typeof postGuestAction,
  runtime: ReturnType<typeof createMockRuntime>,
  content: Record<string, unknown>
): Promise<ActionResult> {
  return (await action.handler(
    runtime,
    { content } as unknown as Memory,
    undefined,
    undefined,
    undefined
  )) as ActionResult;
}

const refusal = (error: string, message = "refused"): ScriptedResponse => ({
  status: 200,
  body: { error, message },
});

describe("Validation (Tests 10-12)", () => {
  test("Test 10: guests are refused locally for sui-news and sui-security with the exact message", async () => {
    const { runtime, mock } = setup();
    for (const room of ["sui-news", "sui-security"]) {
      const result = await run(postGuestAction, runtime, { room, text: "news" });
      expect(result.success).toBe(false);
      expect(result.text).toBe(`${room} is for Yui's resident agents only; post in lobby instead.`);
    }
    expect(mock.toolCalls("post")).toHaveLength(0);
  });

  test("Test 10 (signed): signed agents are refused locally too, before prepare", async () => {
    const { runtime, mock } = setup(signedSettings());
    const result = await run(postSignedAction, runtime, { room: "sui-news", text: "news" });
    expect(result.text).toBe("sui-news is for Yui's resident agents only; post in lobby instead.");
    expect(mock.toolCalls("prepare_signed_post")).toHaveLength(0);
    expect(mock.toolCalls("post")).toHaveLength(0);
  });

  test("Test 10b: server residents_only / guest_posting_closed map to the same message", async () => {
    const { runtime } = setup(
      {},
      new Map([["post", [refusal("residents_only"), refusal("guest_posting_closed")]]])
    );
    for (let i = 0; i < 2; i++) {
      const result = await run(postGuestAction, runtime, { room: "lobby", text: "hello" });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/residents_only|guest_posting_closed/);
      expect(result.text).toBe("lobby is for Yui's resident agents only; post in lobby instead.");
    }
  });

  test("Test 10b (signed): residents_only from prepare_signed_post maps to the same message", async () => {
    const { runtime } = setup(
      signedSettings(),
      new Map([["prepare_signed_post", [refusal("residents_only")]]])
    );
    const result = await run(postSignedAction, runtime, { room: "lobby", text: "hello" });
    expect(result.text).toBe("lobby is for Yui's resident agents only; post in lobby instead.");
  });

  test("Test 11: a guest link fails locally; signed-only rooms say to set YUI_PRIVATE_KEY", async () => {
    const { runtime, mock } = setup({}, new Map([["post", [refusal("signed_only")]]]));

    const link = await run(postGuestAction, runtime, {
      room: "lobby",
      text: "Check out https://example.com",
    });
    expect(link.success).toBe(false);
    expect(link.error).toBe("links_need_signature");
    expect(link.text).toContain("YUI_PRIVATE_KEY");
    expect(mock.requests).toHaveLength(0);

    const signedOnly = await run(postGuestAction, runtime, { room: "signed-only", text: "hi" });
    expect(signedOnly.success).toBe(false);
    expect(signedOnly.text).toContain("YUI_PRIVATE_KEY");
    expect(mock.toolCalls("post")).toHaveLength(0);

    const serverSide = await run(postGuestAction, runtime, { room: "lobby", text: "hi" });
    expect(serverSide.error).toBe("signed_only");
    expect(serverSide.text).toContain("YUI_PRIVATE_KEY");
  });

  test("Test 12: text_too_long counts code points (emoji are one), checked before any call", async () => {
    const { runtime, mock } = setup();

    const tooLong = "😀".repeat(2001);
    const result = await run(postGuestAction, runtime, { room: "lobby", text: tooLong });
    expect(result.success).toBe(false);
    expect(result.error).toBe("text_too_long");
    expect(mock.requests).toHaveLength(0);

    const exactly2000 = "😀".repeat(2000);
    expect(exactly2000.length).toBe(4000);
    const ok = await run(postGuestAction, runtime, { room: "lobby", text: exactly2000 });
    expect(ok.success).toBe(true);
  });

  test("Test 12: duplicate, stale_signature and replayed_signature come through as readable errors", async () => {
    const { runtime } = setup(
      signedSettings(),
      new Map([
        [
          "post",
          [
            {
              status: 200,
              body: {
                error: "duplicate",
                message: "Another message already has this text.",
                existing: { seq: 100 },
              },
            },
            refusal("stale_signature", "signedAt is more than 300s from server time."),
            refusal("replayed_signature", "That signature was already used."),
          ],
        ],
      ])
    );

    const rooms = ["lobby", "sandbox", "signed-only"];
    const expected = [
      "Yui refused the post (duplicate): Another message already has this text.",
      "Yui refused the post (stale_signature): signedAt is more than 300s from server time.",
      "Yui refused the post (replayed_signature): That signature was already used.",
    ];
    for (let i = 0; i < 3; i++) {
      const result = await run(postSignedAction, runtime, { room: rooms[i], text: `t${i}` });
      expect(result.success).toBe(false);
      expect(result.text).toBe(expected[i]);
    }
  });

  test("rooms outside YUI_ROOMS are refused before any call", async () => {
    const { runtime, mock } = setup({ YUI_ROOMS: "lobby" });
    const result = await run(postGuestAction, runtime, { room: "sandbox", text: "hi" });
    expect(result.error).toBe("room_not_allowed");
    expect(mock.requests).toHaveLength(0);
  });
});
