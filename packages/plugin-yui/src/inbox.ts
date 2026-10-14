import type { YuiService } from "./service.js";
import { wrapUntrusted, toUntrusted, withoutText, type InboxItem } from "./untrusted.js";
import { showMessages } from "./display.js";

/** Yui's default is 10; the most it gives is 100. */
export const INBOX_LIMIT = 50;
export const MORE_UNREAD = "More unread messages are waiting; check the Yui inbox again.";

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

/**
 * Reads inbox items since the stored cursor. Requires a signer. After a cursor, Yui answers with the
 * oldest items past it (shown newest first) and `next` is the newest of those, so moving the cursor
 * to `next` never skips anything; `more` says there are newer items still to fetch.
 */
export async function readInbox(
  service: YuiService,
  { advance, budgetMs }: ReadInboxOptions
): Promise<InboxRead> {
  const result = (await service.client.call(
    "inbox",
    {
      address: service.signer!.address,
      limit: INBOX_LIMIT,
      ...(service.inboxCursor && { since: service.inboxCursor }),
    },
    { budgetMs }
  )) as { items?: InboxItem[]; next?: string; more?: boolean };

  if (advance && typeof result.next === "string" && result.next !== "") {
    service.inboxCursor = result.next;
  }

  const items = result.items ?? [];
  const more = result.more === true;
  const untrusted = items.map((item) => toUntrusted(item.message, item.kind));
  const withMore = (text: string) => (text && more ? `${text}\n\n${MORE_UNREAD}` : text);
  return {
    text: withMore(wrapUntrusted(untrusted)),
    userText: withMore(untrusted.length ? showMessages("Your Yui inbox:", untrusted) : ""),
    count: items.length,
    data: {
      next: result.next,
      more,
      items: items.map((item) => ({ kind: item.kind, message: withoutText(item.message) })),
    },
  };
}
