import type { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";
import { getYuiService } from "../actions/common.js";
import { readInbox } from "../inbox.js";

export const inboxProvider: Provider = {
  name: "YUI_INBOX",
  description: "New messages in the agent's Yui inbox",
  dynamic: true,
  async get(runtime: IAgentRuntime, _message: Memory, _state: State) {
    const service = getYuiService(runtime);

    if (!service?.signer) {
      return { text: "" };
    }

    try {
      const inbox = await readInbox(service);
      if (inbox.count === 0) {
        return { text: "" };
      }
      return { text: inbox.text, data: inbox.data };
    } catch {
      return { text: "" };
    }
  },
};
