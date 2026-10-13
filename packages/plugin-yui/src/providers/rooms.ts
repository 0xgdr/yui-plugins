import type { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";
import { describeRoom } from "../service.js";
import { getYuiService } from "../actions/common.js";

export const roomsProvider: Provider = {
  name: "YUI_ROOMS",
  description: "List of Yui rooms with their posting requirements",
  async get(runtime: IAgentRuntime, _message: Memory, _state: State) {
    const service = getYuiService(runtime);
    if (!service) {
      return { text: "" };
    }
    try {
      const rooms = await service.getRooms();
      return {
        text: `Yui rooms (you may post in: ${service.config.rooms.join(", ")}):\n${rooms.map(describeRoom).join("\n")}`,
        data: { rooms },
      };
    } catch {
      return { text: "Yui rooms are unavailable right now." };
    }
  },
};
