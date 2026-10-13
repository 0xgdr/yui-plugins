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
import { getYuiService, reply, failure, serviceUnavailable, errorMessage } from "./common.js";

const NAME = "YUI_SEARCH_DIRECTORY";
const KINDS = ["doc", "docs-site", "mcp-server", "project", "tool", "agent"] as const;

const searchParams = {
  action: NAME,
  schema: z.object({
    query: z.string().min(1).max(200),
    kind: z.enum(KINDS).optional(),
    limit: clampedInt(1, 20).optional(),
  }),
  fields: {
    query: "what the user is looking for, in a few words",
    kind: `only if the user asked for one kind: ${KINDS.join(", ")}`,
    limit: "how many results, if the user said",
  },
};

export const searchDirectoryAction: Action = {
  name: NAME,
  similes: ["FIND_SUI_TOOL"],
  description: "Search Yui's directory for docs, tools, MCP servers, or agents",
  examples: [
    [
      { name: "{{name1}}", content: { text: "Search the Sui directory for wallet tools" } },
      { name: "{{name2}}", content: { text: "Here's what the directory has.", actions: [NAME] } },
    ],
    [
      { name: "{{name1}}", content: { text: "Find MCP servers for Sui" } },
      { name: "{{name2}}", content: { text: "Searching the directory.", actions: [NAME] } },
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

      const params = await resolveParams(runtime, message, state, searchParams);
      if (!params) {
        return reply(callback, NAME, failure("Please specify a search query", "missing_params"));
      }
      const { query, kind, limit } = params;

      const result = (await service.client.call("search_directory", {
        query,
        ...(kind && { kind }),
        ...(limit !== undefined && { limit }),
      })) as {
        results?: Array<{ name?: string; kind?: string; description?: string; url?: string }>;
      };

      const resultsText = result.results?.length
        ? result.results
            .map(
              (r, i) =>
                `${i + 1}. ${r.name ?? "(unnamed)"}${r.kind ? ` [${r.kind}]` : ""}` +
                `${r.description ? `\n   ${r.description}` : ""}${r.url ? `\n   ${r.url}` : ""}`
            )
            .join("\n\n")
        : "No results found";

      return reply(callback, NAME, {
        success: true,
        text: `Directory search results for "${query}":\n\n${resultsText}`,
        data: result,
      });
    } catch (error) {
      return reply(
        callback,
        NAME,
        failure(`Failed to search directory: ${errorMessage(error)}`, "error")
      );
    }
  },
};
