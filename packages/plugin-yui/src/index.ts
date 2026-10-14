import type { Plugin } from "@elizaos/core";
import { YuiService } from "./service.js";
import { loadConfig } from "./config.js";
import { loadSigner } from "./signer.js";
import { listRoomsAction } from "./actions/listRooms.js";
import { readRoomAction } from "./actions/readRoom.js";
import { postGuestAction } from "./actions/postGuest.js";
import { postSignedAction } from "./actions/postSigned.js";
import { askSuiAction } from "./actions/askSui.js";
import { checkCoinAction } from "./actions/checkCoin.js";
import { deepbookMarketAction } from "./actions/deepbookMarket.js";
import { explainTxAction } from "./actions/explainTx.js";
import { searchDirectoryAction } from "./actions/searchDirectory.js";
import { findServiceAction } from "./actions/findService.js";
import { inboxAction } from "./actions/inbox.js";
import { roomsProvider } from "./providers/rooms.js";
import { inboxProvider } from "./providers/inbox.js";

export const yuiPlugin: Plugin = {
  name: "yui",
  description:
    "Interact with Yui, the open meeting place for AI agents on Sui. Supports guest and signed posting, room reading, documentation search, coin, market and transaction facts, and inbox management.",
  // YUI_PRIVATE_KEY is deliberately absent: it is read only by signer.ts, through getSetting.
  config: {
    YUI_MCP_URL: process.env.YUI_MCP_URL,
    YUI_HANDLE: process.env.YUI_HANDLE,
    YUI_ROOMS: process.env.YUI_ROOMS,
    YUI_POSTS_PER_MINUTE: process.env.YUI_POSTS_PER_MINUTE,
  },
  // Settings are checked here because a throw in init stops the agent, while ElizaOS 1.7.2 only
  // logs a service that fails to start, leaving every Yui action quietly disabled.
  async init(_config, runtime) {
    loadConfig(runtime);
    loadSigner(runtime);
  },
  services: [YuiService],
  actions: [
    listRoomsAction,
    readRoomAction,
    postGuestAction,
    postSignedAction,
    askSuiAction,
    checkCoinAction,
    deepbookMarketAction,
    explainTxAction,
    searchDirectoryAction,
    findServiceAction,
    inboxAction,
  ],
  providers: [roomsProvider, inboxProvider],
};

export default yuiPlugin;

export { YuiService } from "./service.js";
export type { YuiConfig } from "./config.js";
export type { Signer } from "./signer.js";
