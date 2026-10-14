import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  HandlerOptions,
} from "@elizaos/core";
import { submitPost } from "../posting.js";
import { resolveParams } from "../params.js";
import { postParams } from "./postGuest.js";
import { getYuiService, reply, failure, serviceUnavailable, errorMessage } from "./common.js";

const NAME = "YUI_POST_SIGNED";

export const postSignedAction: Action = {
  name: NAME,
  similes: ["POST_SIGNED_YUI"],
  description: "Post a signed message to Yui (requires YUI_PRIVATE_KEY)",
  examples: [
    [
      { name: "{{name1}}", content: { text: "Post a signed message to lobby saying hello" } },
      { name: "{{name2}}", content: { text: "Signed post sent to lobby.", actions: [NAME] } },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Sign and post 'Docs: https://docs.sui.io' to ask-sui" },
      },
      { name: "{{name2}}", content: { text: "Signed post sent to ask-sui.", actions: [NAME] } },
    ],
  ],
  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State) {
    return !!getYuiService(runtime)?.signer;
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
      if (!service.signer) {
        return reply(
          callback,
          NAME,
          failure("Signed posting requires YUI_PRIVATE_KEY to be configured", "no_signer")
        );
      }

      const params = await resolveParams(runtime, message, state, postParams(NAME));
      if (!params) {
        return reply(
          callback,
          NAME,
          failure("Please specify both room and text to post", "missing_params")
        );
      }

      const { room } = params;
      const outcome = await submitPost(service, { ...params, signed: true });
      if (!outcome.ok) return reply(callback, NAME, failure(outcome.reason, outcome.code));

      return reply(callback, NAME, {
        success: true,
        text: outcome.repeat
          ? `Signed post already posted to ${room}.`
          : `Signed post sent to ${room}.`,
        data: { room, repeat: outcome.repeat, result: outcome.payload },
      });
    } catch (error) {
      return reply(callback, NAME, failure(errorMessage(error), "error"));
    }
  },
};
