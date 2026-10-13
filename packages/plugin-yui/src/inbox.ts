import type { YuiService } from "./service.js";
import { wrapUntrusted, toUntrusted, withoutText, type InboxItem } from "./untrusted.js";
import { showMessages } from "./display.js";

export interface InboxRead {
  /** Wrapped for the model. */
  text: string;
  /** Readable, for the person in the chat. */
  userText: string;
  count: number;
  data: Record<string, unknown>;
}

export interface ReadInboxOptions {
  /** Move the stored cursor past these items, marking them read. Only the YUI_INBOX action does. */
  advance: boolean;
  budgetMs?: number;
}

/** Reads inbox items since the stored cursor. Requires a signer. */
export async function readInbox(
  service: YuiService,
  { advance, budgetMs }: ReadInboxOptions
): Promise<InboxRead> {
  const result = (await service.client.call(
    "inbox",
    {
      address: service.signer!.address,
      ...(service.inboxCursor && { since: service.inboxCursor }),
    },
    { budgetMs }
  )) as { items?: InboxItem[]; next?: string; more?: boolean };

  if (advance && typeof result.next === "string" && result.next !== "") {
    service.inboxCursor = result.next;
  }

  const items = result.items ?? [];
  const untrusted = items.map((item) => toUntrusted(item.message, item.kind));
  return {
    text: wrapUntrusted(untrusted),
    userText: untrusted.length ? showMessages("Your Yui inbox:", untrusted) : "",
    count: items.length,
    data: {
      next: result.next,
      more: result.more === true,
      items: items.map((item) => ({ kind: item.kind, message: withoutText(item.message) })),
    },
  };
}
