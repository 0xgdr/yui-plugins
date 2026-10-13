import {
  ModelType,
  parseJSONObjectFromText,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { z } from "zod";

export interface ParamSpec<S extends z.AnyZodObject> {
  action: string;
  schema: S;
  /** Shown to the model, one line per field. */
  fields: Record<keyof z.infer<S> & string, string>;
}

export const clampedInt = (min: number, max: number) =>
  z.coerce
    .number()
    .int()
    .transform((n) => Math.min(Math.max(n, min), max));

export const clampedNumber = (min: number, max: number) =>
  z.coerce.number().transform((n) => Math.min(Math.max(n, min), max));

function pick(source: unknown, keys: string[]): Record<string, unknown> | null {
  if (!source || typeof source !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key];
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Resolves action parameters, in order: the 1.7.2 multi-step planner's state.data.actionParams,
 * explicit fields on message.content (programmatic callers), then a small model call that sees
 * only the user's own request text. State, recent messages and room content are never part of
 * that prompt, so text posted on Yui can't choose a room, coin or recipient.
 */
export async function resolveParams<S extends z.AnyZodObject>(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  spec: ParamSpec<S>
): Promise<z.infer<S> | null> {
  const keys = Object.keys(spec.schema.shape);
  const planned = (state?.data as Record<string, unknown> | undefined)?.actionParams;

  for (const candidate of [pick(planned, keys), pick(message.content, keys)]) {
    if (!candidate) continue;
    const parsed = spec.schema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }

  const request = typeof message.content?.text === "string" ? message.content.text.trim() : "";
  if (!request || typeof runtime.useModel !== "function") {
    return null;
  }

  const prompt = [
    `Extract the parameters for the ${spec.action} action from the user's request below.`,
    "Use only what the user wrote. Do not guess or add values: use null for anything they did not state.",
    "Fields:",
    ...Object.entries(spec.fields).map(([key, help]) => `- ${key}: ${help}`),
    "",
    "<user_request>",
    request.replace(/</g, "&lt;"),
    "</user_request>",
    "",
    `Answer with one JSON object with exactly these keys: ${keys.join(", ")}.`,
  ].join("\n");

  try {
    const raw = await runtime.useModel(ModelType.OBJECT_SMALL, { prompt });
    const object = typeof raw === "string" ? parseJSONObjectFromText(raw) : raw;
    const parsed = spec.schema.safeParse(pick(object, keys) ?? {});
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
