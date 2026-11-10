import { createContext, createSignal, useContext } from 'solid-js'
import { questionMessage } from '../shared/comments.ts'
export { commentLabel } from '../shared/comments.ts'
import type { CommentAnchor, DraftComment, WireMessage } from '../shared/protocol.ts'

/*
 * A chat's comments on what Claude wrote, kept with its draft until they're sent (see shared/comments.ts): on its
 * replies, a plan, the changes, or a file. Each place they're made shows its own; the composer shows them all.
 */

/** A comment being written: what it's on, and with an id, the comment it's editing. */
export type CommentDraft = { on: CommentAnchor; quote: string; id?: string }

/** A question asked about something instead, in a side chat of its own, `chat`, shown where it was asked. */
export type Asked = DraftComment & { chat: string }

export interface Comments {
  all: () => DraftComment[]
  /** Adds it, or replaces the one with its id. */
  save: (c: DraftComment) => void
  remove: (id: string) => void
  /** The comment being written, one at a time, anywhere in the chat; the diff's own are kept by the review. */
  draft: () => CommentDraft | undefined
  /** Starts writing one: what's typed is what an edited one says, else nothing. */
  setDraft: (d: CommentDraft | undefined) => void
  draftText: () => string
  setDraftText: (t: string) => void
  /** Keeps what's typed, if anything, and stops writing. */
  commit: () => void
  /** Shows what a comment's on, e.g. scrolls to it or opens its file. */
  show: (c: DraftComment) => void
  /** Questions asked about what's in the chat, each in a side chat; kept in this browser, since they've gone. */
  /** Whether the draft they're kept with has come yet. */
  loaded: () => boolean
  asked: () => Asked[]
  /** Whether a question can be asked now: there's somewhere beside the chat to show its side chat. */
  canAsk: () => boolean
  /** Asks about what `d` is on, `text`, in a new side chat, and stops writing. */
  ask: (d: CommentDraft, text: string) => void
  forget: (id: string) => void
  /** Shows a question's side chat beside the chat. */
  open: (a: Asked) => void
}

/** Given, what Claude wrote can be commented on. */
export const CommentsContext = createContext<Comments>()
export const useComments = () => useContext(CommentsContext)

/**
 * A chat's comments, kept through `list` and `change`, its draft's; and the questions asked in it, through `ask`, which
 * starts a side chat with the question and gives its id, and `open`, which shows one.
 */
export function createComments(store: {
  session: string
  /** Whether the chat's draft has come, before which changing it would lose what's in it. */
  loaded: () => boolean
  list: () => DraftComment[]
  change: (f: (all: DraftComment[]) => DraftComment[]) => void
  show: (c: DraftComment) => void
  ask: (question: string) => Promise<string>
  canAsk: () => boolean
  open: (chat: string) => void
}): Comments {
  const [draft, setCurrent] = createSignal<CommentDraft>()
  const [draftText, setDraftText] = createSignal('')
  const key = `badger.asked.${store.session}`
  const [asked, setAsked] = createSignal<Asked[]>(read(key))
  const keep = (f: (all: Asked[]) => Asked[]) => {
    setAsked(f)
    localStorage.setItem(key, JSON.stringify(asked()))
  }
  const save = (c: DraftComment) => store.change((all) => (all.some((x) => x.id === c.id) ? all.map((x) => (x.id === c.id ? c : x)) : [...all, c]))
  const setDraft = (d: CommentDraft | undefined) => {
    setCurrent(d)
    setDraftText((d?.id && store.list().find((c) => c.id === d.id)?.text) || '')
  }
  return {
    all: store.list,
    save,
    remove: (id) => store.change((all) => all.filter((c) => c.id !== id)),
    draft,
    setDraft,
    draftText,
    setDraftText,
    commit: () => {
      const d = draft()
      const text = draftText().trim()
      if (d && text) save({ id: d.id ?? crypto.randomUUID(), on: d.on, quote: d.quote, text })
      setDraft(undefined)
    },
    show: store.show,
    asked,
    loaded: store.loaded,
    canAsk: store.canAsk,
    ask: (d, text) => {
      const question = text.trim()
      if (!question || !store.canAsk()) return
      setDraft(undefined)
      void store.ask(questionMessage({ on: d.on, quote: d.quote, text: question })).then(
        (chat) => keep((all) => [...all, { id: crypto.randomUUID(), on: d.on, quote: d.quote, text: question, chat }]),
        () => {},
      )
    },
    forget: (id) => keep((all) => all.filter((a) => a.id !== id)),
    open: (a) => store.open(a.chat),
  }
}

function read(key: string): Asked[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** A reply's anchor: its message and which of its blocks. */
export const replyId = (uuid: string, block: number) => `${uuid}:${block}`
/** What's commented on is marked `data-comments-on`, with a reply's anchor or this for a plan, to be found by. */
export const planAnchor = (request: string) => `plan:${request}`

/** Comments in the order of what they're on: down the chat's replies, then plans, then by file and line. */
export function inOrder(comments: DraftComment[], messages: WireMessage[]): DraftComment[] {
  const at = new Map(messages.map((m, i) => [m.uuid, i]))
  const line = (s: string | number) => (typeof s === 'number' ? s : Number(s.slice(1)) || 0)
  const key = (c: DraftComment): [number, string, number, number] => {
    const on = c.on
    if (on.kind === 'reply') {
      const cut = on.reply.lastIndexOf(':')
      return [0, '', at.get(on.reply.slice(0, cut)) ?? Infinity, Number(on.reply.slice(cut + 1)) * 1e7 + (on.start ?? 0)]
    }
    if (on.kind === 'plan') return [1, on.request, 0, 0]
    return [2, on.path, line(on.from), 0]
  }
  const keyed = comments.map((c, i) => ({ c, i, k: key(c) }))
  keyed.sort((a, b) => a.k[0] - b.k[0] || a.k[1].localeCompare(b.k[1]) || a.k[2] - b.k[2] || a.k[3] - b.k[3] || a.i - b.i)
  return keyed.map((x) => x.c)
}
