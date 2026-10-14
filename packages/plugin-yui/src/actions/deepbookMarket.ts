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

const NAME = "YUI_DEEPBOOK_MARKET";
const NOTE =
  "Note: Market data from DeepBook's public indexer, not financial advice. This plugin never places orders.";

const marketParams = {
  action: NAME,
  schema: z.object({
    pool: z
      .string()
      .regex(/^[A-Za-z0-9]+_[A-Za-z0-9]+$/)
      .max(40)
      .optional(),
  }),
  fields: {
    pool: 'a DeepBook pool name like "SUI_USDC", only if the user named one',
  },
};

// The whole list runs to about 15 KB; these are the fields worth a prompt.
const LIST_FIELDS = ["pool", "lastPrice", "change24hPct", "spreadPct", "volume24h", "activity"];

function summarisePools(result: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(result.pools)) return result;
  return {
    readAt: result.readAt,
    pools: result.pools.map((pool: Record<string, unknown>) =>
      Object.fromEntries(LIST_FIELDS.filter((key) => key in pool).map((key) => [key, pool[key]]))
    ),
  };
}

export const deepbookMarketAction: Action = {
  name: NAME,
  similes: ["DEEPBOOK_PRICES", "CHECK_DEEPBOOK_POOL"],
  description:
    "Read DeepBook market data: every pool's prices and activity, or one pool's order book and latest trades (read-only, never trades or gives financial advice)",
  examples: [
    [
      { name: "{{name1}}", content: { text: "What's the SUI_USDC order book on DeepBook?" } },
      { name: "{{name2}}", content: { text: "Reading the SUI_USDC pool.", actions: [NAME] } },
    ],
    [
      { name: "{{name1}}", content: { text: "Which DeepBook markets are active?" } },
      { name: "{{name2}}", content: { text: "Here are DeepBook's pools.", actions: [NAME] } },
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

      // Every field is optional: with no pool named, list them all.
      const params = await resolveParams(runtime, message, state, marketParams);
      const pool = params?.pool;

      const result = await service.client.call("deepbook_market", {
        ...(pool !== undefined && { pool }),
      });
      // Symbols come from each coin's own metadata, set by whoever published it.
      const json = JSON.stringify(pool ? result : summarisePools(result), null, 2);
      const heading = pool ? `DeepBook pool ${pool}:` : "DeepBook pools:";
      const facts = wrapBlocks([{ attrs: { pool }, text: json }]);
      const text = `${heading}\n\n${facts}\n\n${NOTE}`;
      const userText = `${heading}\n${codeBlock(json)}\n\n${NOTE}`;
      const count = Array.isArray(result.pools) ? result.pools.length : undefined;
      return reply(callback, NAME, { success: true, text, data: { pool, pools: count } }, userText);
    } catch (error) {
      return reply(
        callback,
        NAME,
        failure(`Failed to read DeepBook: ${errorMessage(error)}`, "error")
      );
    }
  },
};
