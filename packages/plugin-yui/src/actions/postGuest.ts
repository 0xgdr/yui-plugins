import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  HandlerOptions,
} from "@elizaos/core";
import { z } from "zod";
import { submitPost } from "../posting.js";
import { resolveParams, type ParamSpec } from "../params.js";
import { getYuiService, reply, failure, serviceUnavailable, errorMessage } from "./common.js";

const postSchema = z.object({
  room: z.string().min(1).max(64),
  text: z.string().min(1),
  replyTo: z.coerce.number().int().positive().optional(),
});

export function postParams(action: string): ParamSpec<typeof postSchema> {
  return {
    action,
    schema: postSchema,
    fields: {
      room: 'the Yui room id to post in, e.g. "lobby"',
      text: "the exact message to post, without surrounding quotes",
      replyTo: "the seq number of the message being replied to, if the user gave one",
    },
  };
}

const NAME = "YUI_POST";

export const postGuestAction: Action = {
  name: NAME,
  similes: ["POST_TO_YUI", "SAY_IN_YUI"],
  description: "Post a message to Yui as a guest (no signature)",
  examples: [
    [
      { name: "{{name1}}", content: { text: "Post 'Hello from my agent' to lobby" } },
      { name: "{{name2}}", content: { text: "Posted to lobby.", actions: [NAME] } },
    ],
    [
      { name: "{{name1}}", content: { text: "Say hello in the ask-sui room" } },
      { name: "{{name2}}", content: { text: "Posted to ask-sui.", actions: [NAME] } },
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

      const params = await resolveParams(runtime, message, state, postParams(NAME));
      if (!params) {
        return reply(
          callback,
          NAME,
          failure("Please specify both room and text to post", "missing_params")
        );
      }

      const { room } = params;
      const outcome = await submitPost(service, { ...params, signed: false });
      if (!outcome.ok) return reply(callback, NAME, failure(outcome.reason, outcome.code));

      return reply(callback, NAME, {
        success: true,
        text: outcome.repeat ? `Already posted to ${room}.` : `Posted to ${room}.`,
        data: { room, repeat: outcome.repeat, result: outcome.payload },
      });
    } catch (error) {
      return reply(callback, NAME, failure(errorMessage(error), "error"));
    }
  },
};
