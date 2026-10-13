import { Service } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import { YuiClient } from "./client.js";
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
  private readonly roomsCacheTtlMs = 60_000;
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

  async getRooms(forceRefresh = false): Promise<Room[]> {
    const now = this.now();
    if (
      !forceRefresh &&
      this.roomsCache &&
      now - this.roomsCache.fetchedAt < this.roomsCacheTtlMs
    ) {
      return this.roomsCache.rooms;
    }

    const result = (await this.client.call("list_rooms", {})) as unknown as { rooms: Room[] };
    this.roomsCache = { rooms: result.rooms, fetchedAt: now };
    return result.rooms;
  }

  findRoom(roomId: string): Room | null {
    if (!this.roomsCache) {
      return null;
    }
    return this.roomsCache.rooms.find((r) => r.id === roomId) || null;
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
