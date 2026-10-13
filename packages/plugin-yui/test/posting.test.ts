import { describe, test, expect, afterEach, spyOn } from "bun:test";
import type { ActionResult, Memory } from "@elizaos/core";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { YuiService } from "../src/service";
import { Throttle } from "../src/throttle";
import { expectedPostMessage } from "../src/posting";
import { postGuestAction } from "../src/actions/postGuest";
import { postSignedAction } from "../src/actions/postSigned";
import { createMockYuiServer, type MockYuiServer, type ScriptedResponse } from "./mock-yui";
import { createFakeClock, createMockRuntime, type FakeClock } from "./helpers";

let mock: MockYuiServer | undefined;
afterEach(() => {
  mock?.stop();
  mock = undefined;
});

function setup(
  settings: Record<string, string> = {},
  scripted?: Map<string, ScriptedResponse[]>,
  clock: FakeClock = createFakeClock()
) {
  const server = createMockYuiServer({ scriptedResponses: scripted, now: clock.now });
  mock = server;
  const runtime = createMockRuntime({
    YUI_MCP_URL: mock.url,
    YUI_ROOMS: "lobby,sandbox,sui-news,signed-only",
    ...settings,
  });
  const service = new YuiService(runtime, clock);
  runtime.addService(service);
  return { mock: server, runtime, service, clock };
}

function msg(content: Record<string, unknown>): Memory {
  return { content } as unknown as Memory;
}

async function run(
  action: typeof postGuestAction,
  runtime: ReturnType<typeof createMockRuntime>,
  content: Record<string, unknown>
) {
  const callbacks: unknown[] = [];
  const result = (await action.handler(runtime, msg(content), undefined, undefined, async (c) => {
    callbacks.push(c);
    return [];
  })) as ActionResult;
  return { result, callbacks };
}

const withKey = () => {
  const keypair = Ed25519Keypair.generate();
  return { keypair, settings: { YUI_PRIVATE_KEY: keypair.getSecretKey() } };
};

const httpStatus = (status: number): ScriptedResponse => ({ status, body: {} });

describe("Posting (Tests 3-9)", () => {
  test("Test 3: guest post sends {room,text,handle?} with no address/signature and succeeds", async () => {
    const { runtime, mock } = setup({ YUI_HANDLE: "my-agent" });

    const { result, callbacks } = await run(postGuestAction, runtime, {
      room: "lobby",
      text: "hello",
    });

    expect(result.success).toBe(true);
    expect(callbacks).toEqual([{ text: "Posted to lobby.", actions: ["YUI_POST"] }]);
    const posts = mock.toolCalls("post");
    expect(posts).toHaveLength(1);
    expect(posts[0].args).toEqual({ room: "lobby", text: "hello", handle: "my-agent" });
  });

  test("the handle comes from YUI_HANDLE, never from message content", async () => {
    const { runtime, mock } = setup();
    await run(postGuestAction, runtime, { room: "lobby", text: "hi", handle: "someone-else" });
    expect(mock.toolCalls("post")[0].args).toEqual({ room: "lobby", text: "hi" });
  });

  test("Test 4: signed post = prepare_signed_post, sign messageToSign, post ...then.args + address + signature", async () => {
    const { keypair, settings } = withKey();
    const { runtime, mock, service } = setup({ ...settings, YUI_HANDLE: "my-agent" });

    const { result } = await run(postSignedAction, runtime, {
      room: "lobby",
      text: "signed hello 👋",
      replyTo: 12,
    });

    expect(result.success).toBe(true);
    const address = keypair.toSuiAddress();
    expect(service.signer!.address).toBe(address);

    const prepare = mock.toolCalls("prepare_signed_post");
    expect(prepare).toHaveLength(1);
    expect(prepare[0].args).toEqual({
      room: "lobby",
      text: "signed hello 👋",
      address,
      handle: "my-agent",
      replyTo: 12,
    });

    const post = mock.toolCalls("post");
    expect(post).toHaveLength(1);
    expect(post[0].args!.address).toBe(address);
    expect(post[0].args!.signature).not.toBe("{signature}");

    expect(mock.verifications).toHaveLength(1);
    const [verification] = mock.verifications;
    expect(verification.valid).toBe(true);
    expect(verification.messageToVerify).toMatch(
      /^sui-agent-post:v1:lobby:\d+:my-agent:[0-9a-f]{64}:r=12$/
    );
    await verifyPersonalMessageSignature(
      new TextEncoder().encode(verification.messageToVerify),
      post[0].args!.signature as string,
      { address }
    );
    expect(mock.posts).toHaveLength(1);
  });

  test("Test 4 (unit): a signed v1 message verifies with verifyPersonalMessageSignature", async () => {
    const keypair = Ed25519Keypair.generate();
    const message = expectedPostMessage({
      room: "lobby",
      signedAt: 1760000000000,
      text: "gm from my agent",
      replyTo: 12,
    });
    expect(message).toBe(
      "sui-agent-post:v1:lobby:1760000000000::" +
        new Bun.CryptoHasher("sha256").update("gm from my agent").digest("hex") +
        ":r=12"
    );
    const bytes = new TextEncoder().encode(message);
    const { signature } = await keypair.signPersonalMessage(bytes);
    const publicKey = await verifyPersonalMessageSignature(bytes, signature, {
      address: keypair.toSuiAddress(),
    });
    expect(publicKey.toSuiAddress()).toBe(keypair.toSuiAddress());
    await expect(
      verifyPersonalMessageSignature(new TextEncoder().encode(message + "x"), signature, {
        address: keypair.toSuiAddress(),
      })
    ).rejects.toThrow();
  });

  test("Test 5: 502, 503, 201 sends 3 identical post bodies, 1 prepare, 1 signature, delays [1000, 2000]", async () => {
    const { settings } = withKey();
    const clock = createFakeClock();
    const scripted = new Map([["post", [httpStatus(502), httpStatus(503)]]]);
    const { runtime, mock, service } = setup(settings, scripted, clock);
    const signSpy = spyOn(service.signer!, "signPersonalMessage");

    const { result } = await run(postSignedAction, runtime, { room: "lobby", text: "retry me" });

    expect(result.success).toBe(true);
    const bodies = mock.toolCalls("post").map((r) => r.body);
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
    expect(mock.toolCalls("prepare_signed_post")).toHaveLength(1);
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([1000, 2000]);
    expect(mock.posts).toHaveLength(1);
  });

  test("Test 6 (action): 502 forever gives a clear error inside the 30s budget", async () => {
    const { settings } = withKey();
    const clock = createFakeClock();
    const scripted = new Map([["post", Array.from({ length: 50 }, () => httpStatus(502))]]);
    const { runtime, mock, service } = setup(settings, scripted, clock);
    const signSpy = spyOn(service.signer!, "signPersonalMessage");
    const start = clock.now();

    const { result } = await run(postSignedAction, runtime, { room: "lobby", text: "never" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("unavailable");
    expect(result.text).toMatch(/Yui is unavailable/);
    expect(clock.now() - start).toBeLessThanOrEqual(30_000);
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(new Set(mock.toolCalls("post").map((r) => r.body)).size).toBe(1);
  });

  test("Test 7: 502 then 200 repeat:true is success and says already posted, with no new post", async () => {
    const { settings } = withKey();
    const { runtime, mock, service } = setup(settings);
    const signSpy = spyOn(service.signer!, "signPersonalMessage");

    // The first attempt is stored but its answer is lost; the resend of the same body is a repeat.
    const realFetch = globalThis.fetch;
    let postAttempts = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await realFetch(input, init);
      if (String(init?.body).includes('"name":"post"') && postAttempts++ === 0) {
        return new Response("bad gateway", { status: 502 });
      }
      return response;
    }) as typeof fetch;
    let result: ActionResult;
    try {
      ({ result } = await run(postSignedAction, runtime, { room: "lobby", text: "once" }));
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(result.success).toBe(true);
    expect(result.text).toMatch(/already posted/i);
    expect(result.data?.repeat).toBe(true);
    expect(mock.posts).toHaveLength(1);
    expect(signSpy).toHaveBeenCalledTimes(1);
    const bodies = mock.toolCalls("post").map((r) => r.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test("a guest post is not resent after a 502, since the server can't spot a repeat", async () => {
    const clock = createFakeClock();
    const { runtime, mock } = setup({}, new Map([["post", [httpStatus(502)]]]), clock);

    const { result } = await run(postGuestAction, runtime, { room: "lobby", text: "once" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("unavailable");
    expect(result.text).toContain("may or may not have been stored");
    expect(mock.toolCalls("post")).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  test("a 504 is treated like a 502: guest posts keep the slot, signed posts are resent", async () => {
    const guest = setup({}, new Map([["post", [httpStatus(504)]]]));
    const first = await run(postGuestAction, guest.runtime, { room: "lobby", text: "maybe" });
    expect(first.result.error).toBe("unavailable");
    expect(guest.mock.toolCalls("post")).toHaveLength(1);
    expect(guest.service.throttle.canPost("lobby", guest.clock.now())).toBe(false);
    guest.mock.stop();

    const { settings } = withKey();
    const signed = setup(settings, new Map([["post", [httpStatus(504)]]]));
    const second = await run(postSignedAction, signed.runtime, { room: "lobby", text: "again" });
    expect(second.result.success).toBe(true);
    expect(signed.mock.toolCalls("post")).toHaveLength(2);
    expect(signed.mock.posts).toHaveLength(1);
  });

  test("a guest post is resent once after a short 429, which the server refused", async () => {
    const clock = createFakeClock();
    const limited: ScriptedResponse = {
      status: 200,
      body: { error: "rate_limited", message: "Slow down", retryAfterSeconds: 2 },
    };
    const { runtime, mock } = setup({}, new Map([["post", [limited]]]), clock);

    const { result } = await run(postGuestAction, runtime, { room: "lobby", text: "x" });

    expect(result.success).toBe(true);
    expect(clock.sleeps).toEqual([2000]);
    expect(mock.toolCalls("post")).toHaveLength(2);
    expect(mock.posts).toHaveLength(1);
  });

  test("Test 8 (action): retryAfterSeconds 120 is a rate-limit error, no wait, slot released", async () => {
    const clock = createFakeClock();
    const limited: ScriptedResponse = {
      status: 200,
      body: { error: "rate_limited", message: "Slow down", retryAfterSeconds: 120 },
    };
    const { runtime, service } = setup({}, new Map([["post", [limited]]]), clock);

    const { result } = await run(postGuestAction, runtime, { room: "lobby", text: "x" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("rate_limited");
    expect(result.text).toContain("try again in 120s");
    expect(clock.sleeps).toEqual([]);
    expect(service.throttle.canPost("lobby", clock.now())).toBe(true);
  });

  test("Test 9: second post to the same room within 60s is refused locally; other rooms and t+60s are fine", async () => {
    const clock = createFakeClock();
    const { runtime, mock } = setup({}, undefined, clock);

    expect(
      (await run(postGuestAction, runtime, { room: "lobby", text: "one" })).result.success
    ).toBe(true);
    const requestsAfterFirst = mock.requests.length;

    clock.advance(30_000);
    const second = await run(postGuestAction, runtime, { room: "lobby", text: "two" });
    expect(second.result.success).toBe(false);
    expect(second.result.error).toBe("self_rate_limit");
    expect(mock.requests.length).toBe(requestsAfterFirst);

    const other = await run(postGuestAction, runtime, { room: "sandbox", text: "three" });
    expect(other.result.success).toBe(true);

    clock.advance(30_000);
    const later = await run(postGuestAction, runtime, { room: "lobby", text: "four" });
    expect(later.result.success).toBe(true);
    expect(mock.toolCalls("post").map((r) => r.args!.text)).toEqual(["one", "three", "four"]);
  });

  test("Test 9 (signed): the cap applies before prepare_signed_post", async () => {
    const { settings } = withKey();
    const { runtime, mock } = setup(settings);
    await run(postSignedAction, runtime, { room: "lobby", text: "one" });
    const before = mock.requests.length;

    const { result } = await run(postSignedAction, runtime, { room: "lobby", text: "two" });

    expect(result.error).toBe("self_rate_limit");
    expect(mock.requests.length).toBe(before);
  });

  test("concurrent posts to one room can't both pass the cap", async () => {
    const { runtime, mock } = setup();
    const results = await Promise.all([
      run(postGuestAction, runtime, { room: "lobby", text: "a" }),
      run(postGuestAction, runtime, { room: "lobby", text: "b" }),
    ]);
    expect(results.filter((r) => r.result.success)).toHaveLength(1);
    expect(mock.toolCalls("post")).toHaveLength(1);
  });

  test("Throttle unit: rolling 60s window per room, YUI_POSTS_PER_MINUTE respected, release frees a slot", () => {
    const throttle = new Throttle(2);
    const t0 = 1_000_000;
    expect(throttle.tryAcquire("lobby", t0)).not.toBeNull();
    const second = throttle.tryAcquire("lobby", t0 + 1);
    expect(second).not.toBeNull();
    expect(throttle.tryAcquire("lobby", t0 + 2)).toBeNull();
    second!();
    expect(throttle.canPost("lobby", t0 + 2)).toBe(true);
    expect(throttle.tryAcquire("lobby", t0 + 2)).not.toBeNull();
    expect(throttle.canPost("lobby", t0 + 59_999)).toBe(false);
    expect(throttle.canPost("lobby", t0 + 60_000)).toBe(true);
    expect(throttle.canPost("other", t0)).toBe(true);
  });

  test("refuses to sign when messageToSign is not the v1 string for this post", async () => {
    const { settings } = withKey();
    const forged = (messageToSign: string, args: Record<string, unknown>): ScriptedResponse => ({
      status: 200,
      body: { messageToSign, then: { args } },
    });
    const goodArgs = { room: "lobby", text: "hi", signedAt: 1760000000000 };
    const scripted = new Map([
      [
        "prepare_signed_post",
        [
          forged("sui-agent-delete:v1:lobby:12:1760000000000", goodArgs),
          forged(expectedPostMessage({ ...goodArgs, text: "something else" }), goodArgs),
          forged(expectedPostMessage({ ...goodArgs, room: "sandbox" }), {
            ...goodArgs,
            room: "sandbox",
          }),
        ],
      ],
    ]);
    const { runtime, mock, service } = setup(settings, scripted);
    const signSpy = spyOn(service.signer!, "signPersonalMessage");

    for (let i = 0; i < 3; i++) {
      const { result } = await run(postSignedAction, runtime, { room: "lobby", text: "hi" });
      expect(result.success).toBe(false);
      expect(result.error).toBe("prepare_mismatch");
    }
    expect(signSpy).not.toHaveBeenCalled();
    expect(mock.toolCalls("post")).toHaveLength(0);
  });

  test("refuses to sign when then.args describe a different post, even with a matching messageToSign", async () => {
    const { settings } = withKey();
    const signedAt = 1760000000000;
    const wanted = { room: "lobby", text: "hi", replyTo: 5, handle: "my-agent", signedAt };
    const forged = (args: Record<string, unknown>, handle = wanted.handle): ScriptedResponse => ({
      status: 200,
      body: { messageToSign: expectedPostMessage({ ...wanted, handle }), then: { args } },
    });
    const scripted = new Map([
      [
        "prepare_signed_post",
        [
          forged({ ...wanted, room: "sandbox" }),
          forged({ ...wanted, text: "something else" }),
          forged({ ...wanted, replyTo: 6 }),
          forged({ ...wanted, handle: "someone-else" }, "someone-else"),
        ],
      ],
    ]);
    const { runtime, mock, service } = setup({ ...settings, YUI_HANDLE: "my-agent" }, scripted);
    const signSpy = spyOn(service.signer!, "signPersonalMessage");

    for (let i = 0; i < 4; i++) {
      const { result } = await run(postSignedAction, runtime, {
        room: "lobby",
        text: "hi",
        replyTo: 5,
      });
      expect(result.error).toBe("prepare_mismatch");
    }
    expect(signSpy).not.toHaveBeenCalled();
    expect(mock.toolCalls("post")).toHaveLength(0);
  });

  test("with no YUI_HANDLE, refuses to sign when the server adds a handle", async () => {
    const { settings } = withKey();
    const signedAt = 1760000000000;
    const spoofed = { room: "lobby", text: "hi", handle: "mysten-labs", signedAt };
    const scripted = new Map([
      [
        "prepare_signed_post",
        [
          {
            status: 200,
            body: { messageToSign: expectedPostMessage(spoofed), then: { args: spoofed } },
          },
        ],
      ],
    ]);
    const { runtime, mock, service } = setup(settings, scripted);
    const signSpy = spyOn(service.signer!, "signPersonalMessage");

    const { result } = await run(postSignedAction, runtime, { room: "lobby", text: "hi" });

    expect(result.error).toBe("prepare_mismatch");
    expect(signSpy).not.toHaveBeenCalled();
    expect(mock.toolCalls("post")).toHaveLength(0);
  });

  test("the signed post carries the signer's own address even if then.args names another", async () => {
    const { keypair, settings } = withKey();
    const clock = createFakeClock();
    const signedAt = clock.now();
    const args = {
      room: "lobby",
      text: "hi",
      signedAt,
      address: `0x${"b".repeat(64)}`,
      signature: "{signature}",
    };
    const scripted = new Map([
      [
        "prepare_signed_post",
        [
          {
            status: 200,
            body: {
              messageToSign: expectedPostMessage({ room: "lobby", text: "hi", signedAt }),
              then: { args },
            },
          },
        ],
      ],
    ]);
    const { runtime, mock } = setup(settings, scripted, clock);

    const { result } = await run(postSignedAction, runtime, { room: "lobby", text: "hi" });

    expect(result.success).toBe(true);
    expect(mock.toolCalls("post").at(-1)!.args?.address).toBe(keypair.toSuiAddress());
  });

  test("a post that ended unavailable keeps its slot (it may have been stored)", async () => {
    const scripted = new Map([["post", Array.from({ length: 20 }, () => httpStatus(502))]]);
    const { runtime, mock } = setup({}, scripted);

    const first = await run(postGuestAction, runtime, { room: "lobby", text: "maybe stored" });
    expect(first.result.error).toBe("unavailable");
    const posts = mock.toolCalls("post").length;

    const second = await run(postGuestAction, runtime, { room: "lobby", text: "again" });
    expect(second.result.error).toBe("self_rate_limit");
    expect(mock.toolCalls("post")).toHaveLength(posts);
  });

  test("the per-room cap is checked before list_rooms, so a refusal sends nothing", async () => {
    const { runtime, mock, service, clock } = setup();
    await service.getRooms();
    clock.advance(30_000);
    expect(
      (await run(postGuestAction, runtime, { room: "lobby", text: "one" })).result.success
    ).toBe(true);
    clock.advance(31_000);
    const requests = mock.requests.length;

    const { result } = await run(postGuestAction, runtime, { room: "lobby", text: "two" });

    expect(result.error).toBe("self_rate_limit");
    expect(mock.requests).toHaveLength(requests);
  });
});
