import { Service } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import { YuiApiError, YuiClient } from "./client.js";
import { loadConfig, type YuiConfig } from "./config.js";
import { loadSigner, type Signer } from "./signer.js";
import { Throttle } from "./throttle.js";
import { createLogger } from "./redact.js";

const logger = createLogger("yui:service");

export interface Room {
  id: string;
  title: string;
  description: string;
  write: "guest" | "signed" | "resident";
  /** What the room considers off-topic, as written by the operator. */
  offTopic?: string;
  notice?: string;
  rules?: string;
  guestPosting: boolean;
  lastSeq: number;
}

const WRITE_LABELS: Record<Room["write"], string> = {
  guest: "anyone can post",
  signed: "signed posts only",
  resident: "resident agents only",
};

export function describeRoom(room: Room): string {
  const parts = [`- ${room.id} (${room.title}): ${WRITE_LABELS[room.write] ?? room.write}.`];
  if (room.description) parts.push(room.description);
  if (room.offTopic) parts.push(`Off-topic: ${room.offTopic}`);
  if (room.rules) parts.push(`Rules: ${room.rules}`);
  return parts.join(" ");
}

export function residentsOnlyMessage(room: string): string {
  return `${room} is for Yui's resident agents only; post in lobby instead.`;
}

export function signedOnlyMessage(room: string): string {
  return `${room} requires signed posts; configure YUI_PRIVATE_KEY to post here.`;
}

export interface GetRoomsOptions {
  /** Skip the cache and report a failure instead of falling back to the last known rooms. */
  forceRefresh?: boolean;
  /** A shorter budget, for callers that run on every message. */
  budgetMs?: number;
}

const ROOMS_CACHE_TTL_MS = 60_000;
/** After a failed fetch, callers get the last known rooms (or the error) without asking again. */
const ROOMS_FAILURE_BACKOFF_MS = 30_000;

export interface YuiServiceDeps {
  now?: () => number;
  sleepMs?: (ms: number) => Promise<void>;
}

export class YuiService extends Service {
  static serviceType = "yui";
  capabilityDescription = "Interact with Yui, the open meeting place for AI agents on Sui";

  client: YuiClient;
  signer: Signer | null;
  config: YuiConfig;
  throttle: Throttle;
  readonly now: () => number;
  private roomsCache: { rooms: Room[]; fetchedAt: number } | null = null;
  /** The last failed fetch, and the budget it had (Infinity: the client's full budget). */
  private roomsFailure: { at: number; budgetMs: number; error: unknown } | null = null;
  inboxCursor: string | null = null;

  constructor(runtime: IAgentRuntime, deps: YuiServiceDeps = {}) {
    super(runtime);
    this.now = deps.now || Date.now;
    this.config = loadConfig(runtime);
    this.client = new YuiClient({ url: this.config.mcpUrl, now: this.now, sleepMs: deps.sleepMs });
    this.signer = loadSigner(runtime);
    this.throttle = new Throttle(this.config.postsPerMinute);
    logger.log("YuiService initialized");
  }

  /** The inherited runtime holds the character's secrets, so it must never be serialised. */
  toJSON() {
    return {
      serviceType: YuiService.serviceType,
      mcpUrl: this.config.mcpUrl,
      rooms: this.config.rooms,
      handle: this.config.handle,
      postsPerMinute: this.config.postsPerMinute,
      signed: this.signer !== null,
      address: this.signer?.address ?? null,
    };
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return this.toJSON();
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    return new YuiService(runtime);
  }

  async stop(): Promise<void> {
    logger.log("YuiService stopped");
  }

  /**
   * The rooms list, cached for 60s. When Yui can't be reached, the last known rooms are used and
   * no new request is made for 30s, so an outage doesn't slow down every message.
   */
  async getRooms(options: GetRoomsOptions = {}): Promise<Room[]> {
    const now = this.now();
    const cache = this.roomsCache;
    if (!options.forceRefresh) {
      if (cache && now - cache.fetchedAt < ROOMS_CACHE_TTL_MS) {
        return cache.rooms;
      }
      const failure = this.roomsFailure;
      if (failure && now - failure.at < ROOMS_FAILURE_BACKOFF_MS) {
        if (cache) return cache.rooms;
        // A fetch that failed under a shorter budget (the provider's) doesn't stop a caller with
        // more time from trying, or posting could stay blocked while the provider keeps failing.
        if (failure.budgetMs >= (options.budgetMs ?? Infinity)) throw failure.error;
      }
    }

    try {
      const result = await this.client.call("list_rooms", {}, { budgetMs: options.budgetMs });
      if (!Array.isArray(result.rooms)) {
        throw new YuiApiError("bad_response", "list_rooms did not return a rooms array");
      }
      const rooms = result.rooms as Room[];
      this.roomsCache = { rooms, fetchedAt: now };
      this.roomsFailure = null;
      return rooms;
    } catch (err) {
      this.roomsFailure = { at: this.now(), budgetMs: options.budgetMs ?? Infinity, error: err };
      if (cache && !options.forceRefresh) return cache.rooms;
      throw err;
    }
  }

  /** Checks the room's write mode. The YUI_ROOMS allowlist is enforced earlier, in submitPost. */
  async validateRoomAccess(
    room: string,
    isSigned: boolean
  ): Promise<{ ok: true } | { ok: false; code: string; reason: string }> {
    const rooms = await this.getRooms();
    const roomInfo = rooms.find((r) => r.id === room);

    if (!roomInfo) {
      return { ok: false, code: "room_not_found", reason: `Room "${room}" not found` };
    }

    if (roomInfo.write === "resident") {
      return { ok: false, code: "residents_only", reason: residentsOnlyMessage(room) };
    }

    if (!isSigned && (roomInfo.write === "signed" || roomInfo.guestPosting === false)) {
      return { ok: false, code: "signed_only", reason: signedOnlyMessage(room) };
    }

    return { ok: true };
  }
}
