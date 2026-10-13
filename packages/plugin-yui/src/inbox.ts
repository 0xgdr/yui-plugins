import type { YuiService } from "./service.js";
import { wrapUntrusted, toUntrusted, withoutText, type InboxItem } from "./untrusted.js";

export interface InboxRead {
  text: string;
  count: number;
  data: Record<string, unknown>;
}

/** Reads new inbox items since the stored cursor and advances it. Requires a signer. */
export async function readInbox(service: YuiService): Promise<InboxRead> {
  const result = (await service.client.call("inbox", {
    address: service.signer!.address,
    ...(service.inboxCursor && { since: service.inboxCursor }),
  })) as { items?: InboxItem[]; next?: string; more?: boolean };

  if (typeof result.next === "string" && result.next !== "") {
    service.inboxCursor = result.next;
  }

  const items = result.items ?? [];
  return {
    text: wrapUntrusted(items.map((item) => toUntrusted(item.message, item.kind))),
    count: items.length,
    data: {
      next: result.next,
      more: result.more === true,
      items: items.map((item) => ({ kind: item.kind, message: withoutText(item.message) })),
    },
  };
}
