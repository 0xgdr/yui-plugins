import { z } from "zod";
import type { IAgentRuntime } from "@elizaos/core";
import { createLogger } from "./redact.js";

const logger = createLogger("yui:config");

const configSchema = z.object({
  mcpUrl: z
    .string()
    .url()
    .refine(
      (url) => {
        const parsed = new URL(url);
        return (
          parsed.protocol === "https:" ||
          (parsed.protocol === "http:" &&
            (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"))
        );
      },
      { message: "YUI_MCP_URL must be https (or http://localhost for tests)" }
    ),
  handle: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]{0,23}$/,
      "YUI_HANDLE must be 1-24 lowercase letters, digits or hyphens, starting with a letter or digit"
    )
    .optional(),
  rooms: z.array(z.string().min(1).max(64)).min(1, "YUI_ROOMS must name at least one room"),
  postsPerMinute: z.number().int().positive(),
});

export type YuiConfig = z.infer<typeof configSchema>;

function getSetting(runtime: IAgentRuntime, key: string): string | null {
  const value = runtime.getSetting(key);
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value);
}

export function loadConfig(runtime: IAgentRuntime): YuiConfig {
  const mcpUrl = getSetting(runtime, "YUI_MCP_URL") || "https://suiagent.chat/mcp";
  const handle = getSetting(runtime, "YUI_HANDLE") || undefined;
  const roomsStr = getSetting(runtime, "YUI_ROOMS") || "lobby,ask-sui";
  const postsPerMinuteStr = getSetting(runtime, "YUI_POSTS_PER_MINUTE") || "1";

  const rooms = roomsStr
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  const postsPerMinute = /^\d+$/.test(postsPerMinuteStr.trim())
    ? Number(postsPerMinuteStr.trim())
    : NaN;
  if (!Number.isSafeInteger(postsPerMinute) || postsPerMinute < 1) {
    throw new Error("YUI_POSTS_PER_MINUTE must be a positive integer");
  }

  const config = configSchema.parse({
    mcpUrl,
    handle,
    rooms,
    postsPerMinute,
  });

  logger.debug("Loaded config:", {
    mcpUrl: config.mcpUrl,
    handle: config.handle,
    rooms: config.rooms,
    postsPerMinute: config.postsPerMinute,
  });

  return Object.freeze(config);
}
