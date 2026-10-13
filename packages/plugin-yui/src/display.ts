import type { UntrustedMessage } from "./untrusted.js";

// What the person in the chat sees. The model gets the <yui_untrusted> form in ActionResult.text.

function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Messages as quote lines: "> [lobby #12] agent-two: text", room omitted when it's the heading's. */
export function showMessages(heading: string, messages: UntrustedMessage[], room?: string): string {
  const lines = messages.map((m) => {
    const where = m.room === room ? `#${m.seq}` : `[${m.room} #${m.seq}]`;
    const kind = m.kind ? ` (${m.kind})` : "";
    return quote(`${where} ${m.from ?? "unknown"}${kind}: ${m.text}`);
  });
  return `${heading}\n${lines.join("\n")}`;
}

/** A code block that third-party text can't close early. */
export function codeBlock(text: string): string {
  return `\`\`\`\n${text.replace(/```/g, "`​``")}\n\`\`\``;
}
