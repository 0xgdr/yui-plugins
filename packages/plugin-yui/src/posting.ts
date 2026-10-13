import { createHash } from "node:crypto";
import { YuiApiError, YuiUnavailableError } from "./client.js";
import { redact } from "./redact.js";
import { residentsOnlyMessage, signedOnlyMessage, type YuiService } from "./service.js";

export const MAX_TEXT_CODE_POINTS = 2000;
const LINK_PATTERN = /https?:\/\//i;

export interface PostRequest {
  room: string;
  text: string;
  replyTo?: number;
  signed: boolean;
}

export type PostOutcome =
  | { ok: true; repeat: boolean; payload: Record<string, unknown> }
  | { ok: false; code: string; reason: string };

/** The v1 post string from skill.md. Used only to check the server's messageToSign. */
export function expectedPostMessage(parts: {
  room: string;
  signedAt: number;
  handle?: string;
  text: string;
  replyTo?: number;
}): string {
  const hash = createHash("sha256").update(parts.text, "utf8").digest("hex");
  const base = `sui-agent-post:v1:${parts.room}:${parts.signedAt}:${parts.handle ?? ""}:${hash}`;
  return parts.replyTo === undefined ? base : `${base}:r=${parts.replyTo}`;
}

class PrepareMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrepareMismatchError";
  }
}

/**
 * Validates locally, enforces the per-room cap before any network call, then posts once.
 * Retries happen inside the client with the same serialised body, so a signed post is
 * prepared and signed exactly once.
 */
export async function submitPost(service: YuiService, req: PostRequest): Promise<PostOutcome> {
  const { room, text, replyTo, signed } = req;

  const length = [...text].length;
  if (length > MAX_TEXT_CODE_POINTS) {
    return refuse(
      "text_too_long",
      `Text is ${length} characters; Yui allows at most ${MAX_TEXT_CODE_POINTS}.`
    );
  }
  if (signed && !service.signer) {
    return refuse("no_signer", "Signed posting requires YUI_PRIVATE_KEY to be configured.");
  }
  if (!signed && LINK_PATTERN.test(text)) {
    return refuse(
      "links_need_signature",
      "Guests can't post links on Yui; configure YUI_PRIVATE_KEY to post it signed."
    );
  }
  if (!service.config.rooms.includes(room)) {
    return refuse(
      "room_not_allowed",
      `Room "${room}" is not in the allowed rooms list (YUI_ROOMS).`
    );
  }
  if (!service.throttle.canPost(room, service.now())) {
    return selfRateLimited(service, room);
  }

  const access = await service.validateRoomAccess(room, signed);
  if (!access.ok) {
    return refuse(access.code, access.reason);
  }

  const release = service.throttle.tryAcquire(room, service.now());
  if (!release) {
    return selfRateLimited(service, room);
  }

  try {
    const payload = signed
      ? await postSigned(service, room, text, replyTo)
      : await service.client.call("post", {
          room,
          text,
          ...(service.config.handle && { handle: service.config.handle }),
          ...(replyTo !== undefined && { replyTo }),
        });
    return { ok: true, repeat: payload.repeat === true, payload };
  } catch (err) {
    if (err instanceof YuiApiError) {
      release();
      return refuse(err.code, describeRefusal(room, err));
    }
    if (err instanceof PrepareMismatchError) {
      release();
      return refuse("prepare_mismatch", err.message);
    }
    if (err instanceof YuiUnavailableError) {
      // The post may have been stored before the connection dropped, so the slot stays used.
      return refuse("unavailable", err.message);
    }
    throw err;
  }
}

async function postSigned(
  service: YuiService,
  room: string,
  text: string,
  replyTo: number | undefined
): Promise<Record<string, unknown>> {
  const signer = service.signer!;
  const handle = service.config.handle;
  const prepared = await service.client.call("prepare_signed_post", {
    room,
    text,
    address: signer.address,
    ...(handle && { handle }),
    ...(replyTo !== undefined && { replyTo }),
  });

  const { messageToSign, args } = checkPrepared(prepared, { room, text, handle, replyTo });
  const { signature } = await signer.signPersonalMessage(new TextEncoder().encode(messageToSign));
  return service.client.call("post", { ...args, address: signer.address, signature });
}

/**
 * The server's messageToSign is what gets signed, but only after checking it is a v1 post
 * string for exactly this room, text and reply, so a bad or spoofed endpoint can't obtain a
 * signature over anything else (a delete, a listing, or a different post).
 */
function checkPrepared(
  prepared: Record<string, unknown>,
  expected: { room: string; text: string; handle?: string; replyTo?: number }
): { messageToSign: string; args: Record<string, unknown> } {
  const messageToSign = prepared.messageToSign;
  const args = (prepared.then as { args?: unknown } | undefined)?.args;
  if (typeof messageToSign !== "string" || !args || typeof args !== "object") {
    throw new PrepareMismatchError(
      "prepare_signed_post did not return messageToSign and then.args; not signing."
    );
  }
  const a = args as Record<string, unknown>;
  const handle = a.handle;
  if (
    a.room !== expected.room ||
    a.text !== expected.text ||
    a.replyTo !== expected.replyTo ||
    typeof a.signedAt !== "number" ||
    (handle !== undefined && typeof handle !== "string") ||
    (expected.handle !== undefined && handle !== expected.handle)
  ) {
    throw new PrepareMismatchError(
      "prepare_signed_post returned arguments for a different post; not signing."
    );
  }
  const local = expectedPostMessage({
    room: expected.room,
    signedAt: a.signedAt,
    handle: handle as string | undefined,
    text: expected.text,
    replyTo: expected.replyTo,
  });
  if (messageToSign !== local) {
    throw new PrepareMismatchError(
      "prepare_signed_post returned a message that does not match the post; not signing."
    );
  }
  return { messageToSign, args: a };
}

function describeRefusal(room: string, err: YuiApiError): string {
  switch (err.code) {
    case "residents_only":
    case "guest_posting_closed":
      return residentsOnlyMessage(room);
    case "signed_only":
      return signedOnlyMessage(room);
    case "rate_limited":
      return err.retryAfterSeconds !== undefined
        ? `Yui is rate limiting posts; try again in ${err.retryAfterSeconds}s.`
        : "Yui is rate limiting posts; try again later.";
    default:
      return `Yui refused the post (${err.code}): ${err.serverMessage}`;
  }
}

function selfRateLimited(service: YuiService, room: string): PostOutcome {
  const limit = service.config.postsPerMinute;
  return refuse(
    "self_rate_limit",
    `Already posted to ${room} ${limit === 1 ? "once" : `${limit} times`} in the last minute; wait before posting there again.`
  );
}

function refuse(code: string, reason: string): PostOutcome {
  return { ok: false, code, reason: redact(reason) };
}
