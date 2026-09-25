/**
 * Titles for ACP-created conversations.
 *
 * The Letta conversation `summary` is the string Desktop and the CLI render as
 * the conversation title, and nothing server-side fills it in, so an ACP
 * session lands as "Untitled" in those lists. The adapter writes it once,
 * after the first completed prompt.
 *
 * The title is a retrieval handle, not a summary, so it is derived from the
 * first user message rather than generated. A model-generated title would need
 * the `POST /v1/conversations/{id}/summarize` route, which the Agent SDK does
 * not expose and which only the cloud backend serves. Deriving the title keeps
 * one behavior across local, remote, and cloud backends, and a rough title
 * beats "Untitled".
 */

/** Matches the cap Desktop applies to auto-generated conversation titles. */
export const CONVERSATION_TITLE_MAX_LENGTH = 100;

/**
 * Turns the first user message into a conversation title.
 *
 * Collapses whitespace, drops one layer of surrounding quotes, and clamps to
 * {@link CONVERSATION_TITLE_MAX_LENGTH}. Returns null when the text yields
 * nothing usable, so the caller leaves the conversation untitled rather than
 * writing an empty summary.
 */
export function titleFromFirstMessage(text: string): string | null {
  let normalized = text.replace(/\s+/g, " ").trim();

  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }

  if (!normalized) return null;
  return normalized.slice(0, CONVERSATION_TITLE_MAX_LENGTH);
}
