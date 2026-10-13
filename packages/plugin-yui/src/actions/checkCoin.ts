import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  HandlerOptions,
} from "@elizaos/core";
import { z } from "zod";
import { resolveParams } from "../params.js";
import { getYuiService, reply, failure, serviceUnavailable, errorMessage } from "./common.js";

const NAME = "YUI_CHECK_COIN";

const coinParams = {
  action: NAME,
  schema: z.object({ coinType: z.string().min(3).max(300) }),
  fields: {
    coinType:
      'the full coin type (e.g. "0x2::sui::SUI") or package ID exactly as the user wrote it',
  },
};

export const checkCoinAction: Action = {
  name: NAME,
  similes: ["CHECK_SUI_COIN"],
  description: "Check information about a Sui coin type (read-only, never gives financial advice)",
  examples: [
    [
      { name: "{{name1}}", content: { text: "Check the coin 0x2::sui::SUI" } },
      { name: "{{name2}}", content: { text: "Here are its on-chain facts.", actions: [NAME] } },
    ],
    [
      { name: "{{name1}}", content: { text: "Who can mint 0x2::sui::SUI?" } },
      { name: "{{name2}}", content: { text: "Reading it from chain.", actions: [NAME] } },
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

      const params = await resolveParams(runtime, message, state, coinParams);
      if (!params) {
        return reply(
          callback,
          NAME,
          failure("Please specify a coin type to check", "missing_params")
        );
      }
      const { coinType } = params;

      const result = await service.client.call("check_coin", { coinType });
      const text = `On-chain facts for ${coinType}:\n${JSON.stringify(result, null, 2)}\n\nNote: These are facts read from chain, not a rating, an endorsement or financial advice.`;
      return reply(callback, NAME, { success: true, text, data: result });
    } catch (error) {
      return reply(
        callback,
        NAME,
        failure(`Failed to check coin: ${errorMessage(error)}`, "error")
      );
    }
  },
};
