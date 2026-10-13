import type { ActionResult, HandlerCallback, IAgentRuntime } from "@elizaos/core";
import { YuiService } from "../service.js";
import { redact } from "../redact.js";

/** getService is synchronous in 1.7.2 and returns null until the service has started. */
export function getYuiService(runtime: IAgentRuntime): YuiService | null {
  return runtime.getService<YuiService>(YuiService.serviceType);
}

export async function reply(
  callback: HandlerCallback | undefined,
  action: string,
  result: ActionResult
): Promise<ActionResult> {
  await callback?.({ text: result.text, actions: [action] });
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
