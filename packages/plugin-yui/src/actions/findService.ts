import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  HandlerOptions,
} from "@elizaos/core";
import { z } from "zod";
import { resolveParams, clampedInt } from "../params.js";
import { wrapBlocks } from "../untrusted.js";
import { getYuiService, reply, failure, serviceUnavailable, errorMessage } from "./common.js";

const NAME = "YUI_FIND_SERVICE";

const findParams = {
  action: NAME,
  schema: z.object({
    query: z.string().min(2).max(100),
    limit: clampedInt(1, 10).optional(),
  }),
  fields: {
    query: 'what the user needs done, in a few words (e.g. "move audit")',
    limit: "how many results, if the user said",
  },
};

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const findServiceAction: Action = {
  name: NAME,
  similes: ["HIRE_ON_T2000"],
  description:
    "Find paid services other agents offer, via Yui's find_service (read-only, never hires or pays)",
  examples: [
    [
      { name: "{{name1}}", content: { text: "Find someone who can audit a Move package" } },
      { name: "{{name2}}", content: { text: "Here are matching listings.", actions: [NAME] } },
    ],
    [
      { name: "{{name1}}", content: { text: "Look for data analysis agents I could hire" } },
      { name: "{{name2}}", content: { text: "Searching listings.", actions: [NAME] } },
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

      const params = await resolveParams(runtime, message, state, findParams);
      if (!params) {
        return reply(callback, NAME, failure("Please specify a search query", "missing_params"));
      }
      const { query, limit } = params;

      const result = (await service.client.call("find_service", {
        query,
        ...(limit !== undefined && { limit }),
      })) as {
        services?: Array<{
          name?: string;
          kind?: string;
          description?: string;
          priceUsdc?: number;
          slaMinutes?: number;
          reviewScore?: number | null;
          reviewCount?: number;
          url?: string;
        }>;
      };

      // Names, descriptions and links are written by whoever listed the service.
      const services = result.services ?? [];
      const servicesText =
        wrapBlocks(
          services.map((s, i) => ({
            attrs: {
              n: i + 1,
              kind: s.kind,
              priceUsdc: num(s.priceUsdc),
              slaMinutes: num(s.slaMinutes),
              reviewScore: num(s.reviewScore),
              reviewCount: num(s.reviewCount),
            },
            text: [s.name ?? "(unnamed)", s.description, s.url].filter(Boolean).join("\n"),
          }))
        ) || "No services found";

      const userList = services.length
        ? services
            .map((s, i) => {
              const facts = [
                s.kind,
                num(s.priceUsdc) !== undefined ? `${s.priceUsdc} USDC` : undefined,
                num(s.slaMinutes) !== undefined ? `delivery ${s.slaMinutes} min` : undefined,
                num(s.reviewScore) !== undefined
                  ? `rated ${s.reviewScore} (${s.reviewCount ?? 0} reviews)`
                  : undefined,
              ].filter(Boolean);
              return (
                `${i + 1}. ${s.name ?? "(unnamed)"}${facts.length ? ` (${facts.join(", ")})` : ""}` +
                `${s.description ? `\n   ${s.description}` : ""}${s.url ? `\n   ${s.url}` : ""}`
              );
            })
            .join("\n\n")
        : "No services found";
      const note =
        "Note: Listings are shown as the marketplace orders them, not as an endorsement. This plugin never hires or pays; that happens on the listing's page.";

      return reply(
        callback,
        NAME,
        {
          success: true,
          text: `Services found for "${query}":\n\n${servicesText}\n\n${note}`,
          data: {
            query,
            count: services.length,
            services: services.map((s) => ({
              kind: s.kind,
              priceUsdc: num(s.priceUsdc),
              slaMinutes: num(s.slaMinutes),
              reviewScore: num(s.reviewScore),
              reviewCount: num(s.reviewCount),
            })),
          },
        },
        `Services found for "${query}":\n\n${userList}\n\n${note}`
      );
    } catch (error) {
      return reply(
        callback,
        NAME,
        failure(`Failed to find services: ${errorMessage(error)}`, "error")
      );
    }
  },
};
