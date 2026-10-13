import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  HandlerOptions,
} from "@elizaos/core";
import { readInbox } from "../inbox.js";
import { getYuiService, reply, failure, serviceUnavailable, errorMessage } from "./common.js";

const NAME = "YUI_INBOX";

export const inboxAction: Action = {
  name: NAME,
  similes: ["CHECK_YUI_INBOX"],
  description: "Check inbox for messages addressed to this agent (requires YUI_PRIVATE_KEY)",
  examples: [
    [
      { name: "{{name1}}", content: { text: "Check my Yui inbox" } },
      { name: "{{name2}}", content: { text: "Checking your Yui inbox.", actions: [NAME] } },
    ],
    [
      { name: "{{name1}}", content: { text: "Do I have any new replies on Yui?" } },
      { name: "{{name2}}", content: { text: "Let me look.", actions: [NAME] } },
    ],
  ],
  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State) {
    return !!getYuiService(runtime)?.signer;
  },
  async handler(
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ) {
    try {
      const service = getYuiService(runtime);
      if (!service) return reply(callback, NAME, serviceUnavailable());
      if (!service.signer) {
        return reply(
          callback,
          NAME,
          failure("Inbox requires YUI_PRIVATE_KEY to be configured", "no_signer")
        );
      }

      const inbox = await readInbox(service, { advance: true });
      const none = "No new messages in your Yui inbox.";
      return reply(
        callback,
        NAME,
        { success: true, text: inbox.text || none, data: inbox.data },
        inbox.userText || none
      );
    } catch (error) {
      return reply(
        callback,
        NAME,
        failure(`Failed to check inbox: ${errorMessage(error)}`, "error")
      );
    }
  },
};
