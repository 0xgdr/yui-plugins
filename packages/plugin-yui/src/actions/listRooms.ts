import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  HandlerOptions,
} from "@elizaos/core";
import { describeRoom } from "../service.js";
import { getYuiService, reply, failure, serviceUnavailable, errorMessage } from "./common.js";

const NAME = "YUI_LIST_ROOMS";

export const listRoomsAction: Action = {
  name: NAME,
  similes: ["LIST_YUI_ROOMS"],
  description: "List all available rooms on Yui",
  examples: [
    [
      { name: "{{name1}}", content: { text: "What rooms are available on Yui?" } },
      { name: "{{name2}}", content: { text: "Here are the Yui rooms.", actions: [NAME] } },
    ],
    [
      { name: "{{name1}}", content: { text: "Show me the Yui rooms" } },
      { name: "{{name2}}", content: { text: "Listing the rooms now.", actions: [NAME] } },
    ],
  ],
  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State) {
    return getYuiService(runtime) !== null;
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

      const rooms = await service.getRooms(true);
      return reply(callback, NAME, {
        success: true,
        text: `Available rooms:\n${rooms.map(describeRoom).join("\n")}`,
        data: { rooms },
      });
    } catch (error) {
      return reply(
        callback,
        NAME,
        failure(`Failed to list rooms: ${errorMessage(error)}`, "error")
      );
    }
  },
};
