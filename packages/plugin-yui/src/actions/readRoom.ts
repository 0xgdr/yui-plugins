import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  HandlerOptions,
} from "@elizaos/core";
import { z } from "zod";
import { wrapUntrusted, toUntrusted, withoutText, type RoomMessage } from "../untrusted.js";
import { resolveParams, clampedInt, clampedNumber } from "../params.js";
import { showMessages } from "../display.js";
import { getYuiService, reply, failure, serviceUnavailable, errorMessage } from "./common.js";

const NAME = "YUI_READ_ROOM";

const readParams = {
  action: NAME,
  schema: z.object({
    room: z.string().min(1).max(64),
    after: z.coerce.number().int().nonnegative().optional(),
    before: z.coerce.number().int().positive().optional(),
    limit: clampedInt(1, 200).optional(),
    wait_seconds: clampedNumber(0, 25).optional(),
  }),
  fields: {
    room: 'the Yui room id to read, e.g. "lobby"',
    after: "only messages after this seq number, if the user gave one",
    before: "only messages before this seq number, if the user asked for older ones",
    limit: "how many messages, if the user said",
    wait_seconds: "seconds to wait for new messages (max 25), only if the user asked to wait",
  },
};

export const readRoomAction: Action = {
  name: NAME,
  similes: ["READ_YUI", "CHECK_YUI_ROOM"],
  description:
    "Read messages from a Yui room, newest first. Pass after to get newer messages or before to page back through older ones",
  examples: [
    [
      { name: "{{name1}}", content: { text: "Read recent messages from lobby" } },
      { name: "{{name2}}", content: { text: "Here's what's new in lobby.", actions: [NAME] } },
    ],
    [
      { name: "{{name1}}", content: { text: "Check what's happening in ask-sui" } },
      { name: "{{name2}}", content: { text: "Reading ask-sui now.", actions: [NAME] } },
    ],
  ],
  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State) {
    return getYuiService(runtime) !== null;
  },
  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ) {
    try {
      const service = getYuiService(runtime);
      if (!service) return reply(callback, NAME, serviceUnavailable());

      const params = await resolveParams(runtime, message, state, readParams);
      if (!params) {
        return reply(callback, NAME, failure("Please specify a room to read", "missing_params"));
      }

      const { room, after, before, limit, wait_seconds } = params;
      if (after !== undefined && before !== undefined) {
        return reply(
          callback,
          NAME,
          failure(
            "Read either newer messages (after) or older ones (before), not both",
            "bad_params"
          )
        );
      }
      const result = (await service.client.call("read_room", {
        room,
        ...(after !== undefined && { after }),
        ...(before !== undefined && { before }),
        ...(limit !== undefined && { limit }),
        ...(wait_seconds !== undefined && after !== undefined && { wait_seconds }),
      })) as { lastSeq?: number; messages?: RoomMessage[]; next?: number; older?: number };

      const messages = (result.messages ?? []).map((m) => ({ ...m, room: m.room ?? room }));
      const untrusted = messages.map((m) => toUntrusted(m));
      const none = `No new messages in ${room}.`;
      const paging = pagingNote(result.next, result.older);
      return reply(
        callback,
        NAME,
        {
          success: true,
          text: [wrapUntrusted(untrusted) || none, paging].filter(Boolean).join("\n\n"),
          data: {
            room,
            lastSeq: result.lastSeq,
            next: result.next,
            older: result.older,
            messages: messages.map(withoutText),
          },
        },
        untrusted.length ? showMessages(`Latest in ${room}:`, untrusted, room) : none
      );
    } catch (error) {
      return reply(callback, NAME, failure(`Failed to read room: ${errorMessage(error)}`, "error"));
    }
  },
};

/** How to read on from here; only numbers from Yui, never message text. */
function pagingNote(next: unknown, older: unknown): string {
  const parts = [
    typeof next === "number" && `newer messages: after=${next}`,
    typeof older === "number" && `older messages: before=${older}`,
  ].filter(Boolean);
  return parts.length ? `To read on, pass ${parts.join("; ")}.` : "";
}
