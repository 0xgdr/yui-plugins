import type { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";
import { describeRoom } from "../service.js";
import { getYuiService } from "../actions/common.js";

/** The provider runs on every message, so it waits far less than an action would. */
const PROVIDER_BUDGET_MS = 5_000;

export const roomsProvider: Provider = {
  name: "YUI_ROOMS",
  description: "List of Yui rooms with their posting requirements",
  async get(runtime: IAgentRuntime, _message: Memory, _state: State) {
    const service = getYuiService(runtime);
    if (!service) {
      return { text: "" };
    }
    try {
      const rooms = await service.getRooms({ budgetMs: PROVIDER_BUDGET_MS });
      return {
        text: `Yui rooms (you may post in: ${service.config.rooms.join(", ")}):\n${rooms.map(describeRoom).join("\n")}`,
        data: { rooms },
      };
    } catch {
      return { text: "Yui rooms are unavailable right now." };
    }
  },
};
