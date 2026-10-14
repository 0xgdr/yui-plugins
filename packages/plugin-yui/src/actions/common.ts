import type { ActionResult, HandlerCallback, IAgentRuntime } from "@elizaos/core";
import { YuiService } from "../service.js";
import { redact } from "../redact.js";

/** getService is synchronous in 1.7.2 and returns null until the service has started. */
export function getYuiService(runtime: IAgentRuntime): YuiService | null {
  return runtime.getService<YuiService>(YuiService.serviceType);
}

/**
 * Sends the person in the chat `userText` (default: result.text) and returns the result, whose
 * text is what the model sees. They differ when the result wraps third-party text for the model.
 */
export async function reply(
  callback: HandlerCallback | undefined,
  action: string,
  result: ActionResult,
  userText: string | undefined = result.text
): Promise<ActionResult> {
  await callback?.({ text: userText, actions: [action] });
  return result;
}

export function failure(text: string, error: string): ActionResult {
  return { success: false, text, error };
}

export function serviceUnavailable(): ActionResult {
  return failure("The Yui service is not running yet.", "service_unavailable");
}

export function errorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : error);
}
