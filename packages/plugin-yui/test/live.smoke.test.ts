import { describe, test, expect } from "bun:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { YuiService } from "../src/service";
import { submitPost } from "../src/posting";
import { createMockRuntime } from "./helpers";

const LIVE_SMOKE = process.env.YUI_LIVE_SMOKE === "1";

// Posts only to sandbox, where everything expires. Without YUI_LIVE_SMOKE_KEY a throwaway key is used.
function sandboxService(privateKey?: string) {
  const runtime = createMockRuntime({
    YUI_MCP_URL: "https://suiagent.chat/mcp",
    YUI_ROOMS: "sandbox",
    YUI_POSTS_PER_MINUTE: "5",
    ...(privateKey && { YUI_PRIVATE_KEY: privateKey }),
  });
  return new YuiService(runtime);
}

describe.skipIf(!LIVE_SMOKE)("Live smoke test (optional)", () => {
  let guestSeq: number | undefined;

  test("guest post to sandbox with unique text", async () => {
    const service = sandboxService();
    const rooms = await service.getRooms();
    expect(rooms.some((r) => r.id === "sandbox")).toBe(true);

    const outcome = await submitPost(service, {
      room: "sandbox",
      text: `Guest smoke test from @0xgdr/plugin-yui at ${Date.now()}`,
      signed: false,
    });
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.reason}`);
    guestSeq = (outcome.payload.message as { seq?: number } | undefined)?.seq;
    expect(typeof guestSeq).toBe("number");
  }, 35_000);

  test("signed reply in sandbox: the server verifies the plugin's signature", async () => {
    const key = process.env.YUI_LIVE_SMOKE_KEY || Ed25519Keypair.generate().getSecretKey();
    const service = sandboxService(key);

    const outcome = await submitPost(service, {
      room: "sandbox",
      text: `Signed smoke test from @0xgdr/plugin-yui at ${Date.now()}`,
      replyTo: guestSeq,
      signed: true,
    });
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.reason}`);

    const { signature } = outcome.payload.diagnostics as {
      signature: {
        valid?: boolean;
        signedBy?: string;
        messageToVerify?: string;
        address?: { matchesSigner?: boolean };
      };
    };
    expect(signature.valid).toBe(true);
    expect(signature.signedBy).toBe(service.signer!.address);
    expect(signature.address?.matchesSigner).toBe(true);
    expect(signature.messageToVerify).toBe(
      `${signature.messageToVerify!.split(":r=")[0]}:r=${guestSeq}`
    );
    expect(signature.messageToVerify).toMatch(
      /^sui-agent-post:v1:sandbox:\d+::[0-9a-f]{64}:r=\d+$/
    );
  }, 35_000);
});
