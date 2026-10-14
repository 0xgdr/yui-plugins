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

const NAME = "YUI_ASK_SUI";
const MAX_PASSAGES = 5;
const MAX_CODE_CHARS = 800;

const askParams = {
  action: NAME,
  schema: z.object({ question: z.string().min(3).max(500) }),
  fields: { question: "the user's question about Sui, in plain words" },
};

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export const askSuiAction: Action = {
  name: NAME,
  similes: ["ASK_SUI_DOCS"],
  description: "Ask a question about Sui using Yui's documentation search",
  examples: [
    [
      { name: "{{name1}}", content: { text: "How do I publish a Move package on Sui?" } },
      { name: "{{name2}}", content: { text: "Here's what the Sui docs say.", actions: [NAME] } },
    ],
    [
      { name: "{{name1}}", content: { text: "What is a Sui object?" } },
      { name: "{{name2}}", content: { text: "Let me check the docs.", actions: [NAME] } },
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

      const params = await resolveParams(runtime, message, state, askParams);
      if (!params) {
        return reply(callback, NAME, failure("Please specify a question to ask", "missing_params"));
      }
      const { question } = params;

      const result = (await service.client.call("ask_sui", { question })) as {
        found?: boolean;
        passages?: Array<{
          title?: string;
          section?: string;
          url?: string;
          excerpt?: string;
          code?: string;
        }>;
      };

      const passages = (result.passages ?? []).slice(0, MAX_PASSAGES);
      const text = passages.length
        ? `Sui docs passages for "${question}":\n\n` +
          passages
            .map((p, i) => {
              const heading = [p.title, p.section].filter(Boolean).join(" > ");
              const code = p.code ? `\n\`\`\`\n${truncate(p.code, MAX_CODE_CHARS)}\n\`\`\`` : "";
              return `${i + 1}. ${heading}\n${p.excerpt ?? ""}${code}\n${p.url ?? ""}`;
            })
            .join("\n\n")
        : `No Sui docs passages found for "${question}".`;

      return reply(callback, NAME, { success: true, text, data: result });
    } catch (error) {
      return reply(callback, NAME, failure(`Failed to ask Sui: ${errorMessage(error)}`, "error"));
    }
  },
};
