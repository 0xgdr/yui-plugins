import type { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";
import { getYuiService } from "../actions/common.js";
import { readInbox } from "../inbox.js";

const PROVIDER_BUDGET_MS = 5_000;

export const inboxProvider: Provider = {
  name: "YUI_INBOX",
  description: "Unread messages in the agent's Yui inbox",
  dynamic: true,
  async get(runtime: IAgentRuntime, _message: Memory, _state: State) {
    const service = getYuiService(runtime);

    if (!service?.signer) {
      return { text: "" };
    }

    try {
      // Peek only: items stay unread until the YUI_INBOX action shows them.
      const inbox = await readInbox(service, { advance: false, budgetMs: PROVIDER_BUDGET_MS });
      if (inbox.count === 0) {
        return { text: "" };
      }
      return { text: inbox.text, data: inbox.data };
    } catch {
      return { text: "" };
    }
  },
};
