import { createSignal } from 'solid-js'
import type { DraftAttachments, PermissionMode } from '../shared/protocol.ts'
import { api } from './api.ts'
import { btwView, openView } from './layout.ts'
import { sessions } from './stores/sessions.ts'
import type { Ws } from './terminals.ts'

/**
 * Side chats (/btw): forks of a chat in its own folder, kept under it and
 * shown in one panel beside it. Which one the panel shows, and the ones still
 * being forked, are this tab's.
 */

const [picked, setPicked] = createSignal<Record<string, string>>({})
const [forking, setForking] = createSignal<Record<string, number>>({})

/** A chat's side chats, newest first. */
export const sideChatsOf = (parent: string) =>
  sessions()
    .filter((s) => s.sideOf === parent)
    .sort((a, b) => (b.forkedAt ?? 0) - (a.forkedAt ?? 0))

/** The side chat a chat's panel shows: the one picked, or else the newest. */
export const shownSideChat = (parent: string) => picked()[parent] ?? sideChatsOf(parent)[0]?.id
export const pickSideChat = (parent: string, id: string) => setPicked((p) => ({ ...p, [parent]: id }))
/** Side chats of this chat being forked from here. */
export const forkingSideChat = (parent: string) => (forking()[parent] ?? 0) > 0

const count = (parent: string, by: number) => setForking((f) => ({ ...f, [parent]: (f[parent] ?? 0) + by }))

/** Forks a side chat, sending it `first.text` if there is any, and shows it in the chat's panel. */
export async function startSideChat(
  ws: Ws,
  parent: string,
  first: Partial<DraftAttachments> & { text?: string; mode?: PermissionMode; model?: string } = {},
): Promise<void> {
  openView(ws, btwView(parent))
  count(parent, 1)
  try {
    const { sessionId } = await api.btw(parent, first)
    pickSideChat(parent, sessionId)
  } finally {
    count(parent, -1)
  }
}
