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
import { wrapBlocks } from "../untrusted.js";
import { codeBlock } from "../display.js";
import { getYuiService, reply, failure, serviceUnavailable, errorMessage } from "./common.js";

const NAME = "YUI_EXPLAIN_TX";
const NOTE =
  "Note: Explained by Sui Lens from on-chain data. Names and symbols are set by whoever deployed the contract; these are facts, not advice.";

const txParams = {
  action: NAME,
  schema: z.object({
    // A base58 transaction digest; Yui answers bad_digest for anything else.
    digest: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
    network: z.preprocess(
      (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
      z.enum(["mainnet", "testnet", "devnet"]).optional()
    ),
  }),
  fields: {
    digest: "the Sui transaction digest (base58) exactly as the user wrote it",
    network: 'mainnet, testnet or devnet, only if the user said (default "mainnet")',
  },
};

export const explainTxAction: Action = {
  name: NAME,
  similes: ["EXPLAIN_SUI_TRANSACTION"],
  description:
    "Explain what a Sui transaction did, in plain English, from its digest (read-only, never gives financial advice)",
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "What did 4ZxVayMx1axxVZJ6RVWAb94cj2L8kVjhkfQEbA5GmVaH do?" },
      },
      { name: "{{name2}}", content: { text: "Here's what it did.", actions: [NAME] } },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Explain testnet transaction 4ZxVayMx1axxVZJ6RVWAb94cj2L8kVjhkfQEbA5GmVaH",
        },
      },
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

      const params = await resolveParams(runtime, message, state, txParams);
      if (!params) {
        return reply(
          callback,
          NAME,
          failure("Please give a Sui transaction digest to explain", "missing_params")
        );
      }
      const { digest, network } = params;

      const result = await service.client.call("explain_tx", {
        digest,
        ...(network !== undefined && { network }),
      });
      // Coin names, symbols and protocol labels are chosen by whoever deployed the contracts.
      const json = JSON.stringify(result, null, 2);
      const facts = wrapBlocks([{ attrs: { digest, network }, text: json }]);
      const text = `What transaction ${digest} did:\n\n${facts}\n\n${NOTE}`;
      const userText = `What transaction ${digest} did:\n${codeBlock(json)}\n\n${NOTE}`;
      return reply(callback, NAME, { success: true, text, data: { digest, network } }, userText);
    } catch (error) {
      return reply(
        callback,
        NAME,
        failure(`Failed to explain transaction: ${errorMessage(error)}`, "error")
      );
    }
  },
};
