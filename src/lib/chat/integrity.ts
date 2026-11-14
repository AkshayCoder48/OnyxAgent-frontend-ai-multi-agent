/**
 * Development-time chat-integrity assertions (Global Chat State Isolation
 * PRD §14). Wire format mirrors the PRD's event envelopes
 * (chat_created / message_submitted / stream_update …) so a violated
 * ownership invariant is visible in dev tooling.
 *
 * Production-safe: a no-op outside development (no private conversation
 * content is ever logged — ids and counts only).
 */

export function logChatIntegrity(
  event: string,
  payload: Record<string, unknown>,
): void {
  if (process.env.NODE_ENV === "production") return;
  console.debug(`[chat-integrity] ${event}`, payload);
}

/**
 * The PRD §6 conceptual ownership check: every subsystem involved in a
 * send (active selection, composer, context builder, persistence) must
 * agree on ONE conversation id. Returns false on ANY disagreement or a
 * missing id, without ever "recovering" by picking one of them — callers
 * must stop the submission in that case.
 */
export function messageOwnershipVerified(ids: {
  activeChatId: string | null;
  composerChatId: string | null;
  contextChatId: string | null;
}): boolean {
  const { activeChatId, composerChatId, contextChatId } = ids;
  const verified =
    !!activeChatId && activeChatId === composerChatId && activeChatId === contextChatId;
  if (!verified) {
    logChatIntegrity("message_ownership_violation", ids);
  }
  return verified;
}
