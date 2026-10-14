import { For, Show, createEffect, createMemo, createResource, createSignal, on, type JSX } from 'solid-js'
import { ChevronDown, FolderInput, GitBranch, Link, Pencil, Plus, Trash2, X } from '../icons'
import { ancestors, descendants, projectOf } from '../../shared/cardTree.ts'
import { CARD_STATUSES, type Card, type SessionSummary } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { folderLabel, lastWorkedIn, worktreeOf } from '../folders.ts'
import { Columns, STATUS_LABELS } from './Board.tsx'
import { MarkdownEditor } from './MarkdownEditor.tsx'
import { RenameChat } from './RenameChat.tsx'
import { ChatDot, Menu, SearchMenu, Select, type SearchItem } from './ui.tsx'
import { ChatSummary } from './ChatSummary.tsx'
import { attention } from '../attention.ts'

const STATUS_OPTIONS = CARD_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] }))

const menuTrigger = (open: boolean) =>
  `flex h-7 items-center gap-1.5 rounded-md px-2 text-xs pointer-coarse:h-9 transition-colors hover:bg-surface hover:text-fg ${
    open ? 'bg-surface text-fg' : 'text-fg-3'
  }`

/**
 * A card's page. A project (a top-level card) is its board, with its brief and chats folded away above it;
 * a card inside a project is its description, chats and worktrees.
 */
export function CardView(props: {
  card: Card
  /** Every card, for the project above this one and the board inside it. */
  cards: Card[]
  setCards: (cards: Card[]) => void
  sessions: SessionSummary[]
  /** Opens a card, or the projects board for null. */
  onOpenCard: (id: number | null) => void
  onOpenChat: (id: string) => void
  /** Where the card's work last happened, if anywhere: the repo, and whether it was in the card's worktree. */
  onNewChat: (from?: { cwd: string; worktree: boolean }) => void
}) {
  const isProject = () => props.card.parentId === null
  const path = createMemo(() => ancestors(props.cards, props.card.id))
  const inside = createMemo(() => props.cards.filter((c) => c.parentId === props.card.id))
  /** Projects it can move into, or null to make it a project itself. */
  const destinations = createMemo(() => {
    const below = new Set(descendants(props.cards, props.card.id).map((c) => c.id))
    const projects = props.cards.filter((c) => c.parentId === null && c.id !== props.card.id && !below.has(c.id) && c.status !== 'done')
    return [null, ...projects.sort((a, b) => a.title.localeCompare(b.title))]
  })
  // Linked ids with no transcript yet (a chat opened but never sent) are left out.
  const chats = createMemo(() => props.sessions.filter((s) => props.card.sessionIds.includes(s.id)))
  const [renaming, setRenaming] = createSignal<string>()
  /**
   * Chats that could go on this card: ones on no card first, then ones it would take off another card, then archived
   * ones, greyed. Newest first in each.
   */
  const linkable = (q: string): SearchItem[] => {
    const cardOf = new Map(props.cards.flatMap((c) => c.sessionIds.map((id) => [id, c] as const)))
    const needle = q.toLowerCase()
    const found = props.sessions.filter(
      (s) =>
        !props.card.sessionIds.includes(s.id) &&
        (!q || s.title.toLowerCase().includes(needle) || (s.cwd && folderLabel(s.cwd).toLowerCase().includes(needle))),
    )
    const rank = (s: SessionSummary) => (s.archived ? 2 : 0) + (cardOf.has(s.id) ? 1 : 0)
    const item = (s: SessionSummary): SearchItem => ({
      label: s.title,
      render: () => <ChatSummary session={s} card={cardOf.get(s.id)} titleClass={s.archived ? 'text-fg-3' : 'text-fg'} />,
      pick: () => api.linkSession(props.card.id, s.id),
    })
    // Capped so a long history stays quick to open; searching reaches the rest.
    return found.sort((a, b) => rank(a) - rank(b) || b.lastModified - a.lastModified).slice(0, 100).map(item)
  }
  /** Worktrees this card's chats run in. Made by starting a chat in one; nothing else records them. */
  const worktrees = createMemo(() => [...new Set(chats().flatMap((s) => (s.cwd && !s.gone && worktreeOf(s.cwd) ? [s.cwd] : [])))])
  // A new chat picks up where the card's latest chat ran, else where its project's work happens, but not in another card's worktree.
  // Its folder can still be changed before the first message.
  const newChat = () => {
    const project = projectOf(props.cards, props.card.id)
    const projectIds = project ? [project, ...descendants(props.cards, project.id)].flatMap((c) => c.sessionIds) : []
    const fallback = lastWorkedIn(props.sessions.filter((s) => projectIds.includes(s.id)))
    props.onNewChat(lastWorkedIn(chats()) ?? (fallback && { cwd: fallback.cwd, worktree: false }))
  }
  // A project with nothing on its board yet opens with its brief showing, so there's somewhere to start.
  const [showBrief, setShowBrief] = createSignal(!inside().length)
  createEffect(on(() => props.card.id, () => setShowBrief(!inside().length), { defer: true }))

  const saveTitle = (title: string) => {
    if (!title.trim() || title.trim() === props.card.title.trim()) return
    api.updateCard(props.card.id, { title })
  }

  const remove = () => {
    const n = descendants(props.cards, props.card.id).length
    const what = isProject() ? `project "${props.card.title}"` : `card #${props.card.id}`
    const inside = n ? ` and the ${n === 1 ? 'card' : `${n} cards`} inside it` : ''
    if (!confirm(`Delete ${what}${inside}? Chats are kept.`)) return
    const parent = props.card.parentId
    api.deleteCard(props.card.id).then(() => props.onOpenCard(parent))
  }

  const actions = () => (
    <>
      <Menu
        items={destinations().map((c) =>
          c ? { label: c.title, description: `#${c.id}`, selected: c.id === props.card.parentId } : { label: 'Make it a project', selected: isProject() },
        )}
        onPick={(i) => api.updateCard(props.card.id, { parentId: destinations()[i]?.id ?? null })}
        placement="bottom"
        class="right-0 left-auto! max-h-80 w-72 overflow-y-auto"
        triggerClass={menuTrigger}
        title="Move to another project"
        trigger={() => (
          <>
            <FolderInput class="size-3.5" /> Move
          </>
        )}
      />
      <button
        onClick={remove}
        title={isProject() ? 'Delete project' : 'Delete card'}
        class="grid size-7 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface hover:text-danger pointer-coarse:size-9"
      >
        <Trash2 class="size-3.5" />
      </button>
    </>
  )

  const details = (): JSX.Element => (
    <>
      {/* A textarea so long titles wrap rather than run off narrow screens; Enter still ends the edit. */}
      <textarea
        value={props.card.title}
        rows={1}
        onBlur={(e) => saveTitle(e.currentTarget.value.replace(/\s*\n\s*/g, ' '))}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.isComposing) return
          e.preventDefault()
          e.currentTarget.blur()
        }}
        class="block w-full resize-none bg-transparent text-xl leading-snug font-medium outline-none [field-sizing:content]"
      />
      <div class="mt-2 -ml-2">
        <Select value={props.card.status} options={STATUS_OPTIONS} onChange={(status) => api.updateCard(props.card.id, { status })} placement="bottom" title="Status" />
      </div>

      {/* Keyed so switching cards saves the last one's edits to it before loading the next. */}
      <Show when={props.card.id} keyed>
        {(id) => (
          <MarkdownEditor
            value={props.card.description}
            onSave={(description) => api.updateCard(id, { description })}
            placeholder={isProject() ? 'What this project is for, and anything every chat in it should know' : 'Describe the work'}
            class="mt-4 min-h-[6.6em]"
          />
        )}
      </Show>

      <div class="mt-8 flex items-center gap-1 border-b border-line pb-2">
        <h2 class="mr-auto text-[13px] font-medium text-fg-2">Chats</h2>
        <SearchMenu
          items={linkable}
          placeholder="Find a chat by title or folder"
          empty="No chats match"
          width={320}
          triggerClass={menuTrigger}
          trigger={() => (
            <>
              <Link class="size-3.5" /> Link chat
            </>
          )}
        />
        <button type="button" onClick={newChat} class={menuTrigger(false)}>
          <Plus class="size-3.5" /> New chat
        </button>
      </div>
      <Show
        when={chats().length}
        fallback={
          <p class="py-3 text-[13px] text-fg-3">
            {isProject() ? 'No chats on the project itself. Chats about one piece of work go on its card.' : 'No chats yet. Chats can be in any repo.'}
          </p>
        }
      >
        <For each={chats()}>
          {(s) => (
            <div class="group -mx-2 flex items-center gap-2 rounded-lg px-2 transition-colors hover:bg-surface/60">
              <Show
                when={renaming() !== s.id}
                fallback={<RenameChat session={s} onDone={() => setRenaming()} class="flex min-w-0 flex-1 items-center gap-3 py-2.5" />}
              >
                <button onClick={() => props.onOpenChat(s.id)} class="flex min-w-0 flex-1 items-center gap-2 py-2.5 text-left">
                  <span class="min-w-0 flex-1 truncate text-[13px] text-fg-2 group-hover:text-fg">{s.title}</span>
                  <ChatDot running={s.running} attention={attention()[s.id]} />
                  <span class="max-w-[40%] shrink-0 truncate text-[11px] text-fg-3">{s.cwd && folderLabel(s.cwd)}</span>
                </button>
                <button
                  onClick={() => setRenaming(s.id)}
                  title="Rename chat"
                  class="grid size-6 place-items-center rounded-md text-fg-3 opacity-0 transition hover:bg-surface hover:text-fg group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100"
                >
                  <Pencil class="size-3.5" />
                </button>
              </Show>
              <button
                onClick={() => api.unlinkSession(props.card.id, s.id)}
                title="Unlink chat"
                class="grid size-6 place-items-center rounded-md text-fg-3 opacity-0 transition hover:bg-surface hover:text-fg group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100"
              >
                <X class="size-3.5" />
              </button>
            </div>
          )}
        </For>
      </Show>

      <Show when={worktrees().length}>
        <h2 class="mt-8 border-b border-line pb-2 text-[13px] font-medium text-fg-2">Worktrees</h2>
        <For each={worktrees()}>{(path) => <WorktreeRow path={path} sessions={props.sessions} />}</For>
      </Show>
    </>
  )

  const board = (cls: string) => (
    <Columns cards={props.cards} sessions={props.sessions} setCards={props.setCards} onOpen={props.onOpenCard} parentId={props.card.id} class={cls} />
  )

  return (
    <Show
      when={isProject()}
      fallback={
        <div class="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
          <div class="flex h-12 shrink-0 items-center gap-1 px-5 text-[13px]">
            <button onClick={() => props.onOpenCard(null)} class="text-fg-3 transition-colors hover:text-fg">
              Projects
            </button>
            <For each={path()}>
              {(c) => (
                <>
                  <span class="text-fg-3">/</span>
                  <button onClick={() => props.onOpenCard(c.id)} class="max-w-48 truncate text-fg-3 transition-colors hover:text-fg">
                    {c.title}
                  </button>
                </>
              )}
            </For>
            <span class="text-fg-3">/</span>
            <span class="text-fg-2 tabular-nums">#{props.card.id}</span>
            <div class="flex-1" />
            {actions()}
          </div>
          <div class="mx-auto w-full max-w-3xl px-5 py-6">{details()}</div>
          {/* Deeper nesting isn't offered any more, but cards already inside this one still get their board. */}
          <Show when={inside().length}>{board('shrink-0')}</Show>
        </div>
      }
    >
      <div class="flex h-full min-w-0 flex-1 flex-col">
        <div class="flex h-12 shrink-0 items-center gap-1 px-5 text-[13px]">
          <button onClick={() => props.onOpenCard(null)} class="text-fg-3 transition-colors hover:text-fg">
            Projects
          </button>
          <span class="text-fg-3">/</span>
          <span class="truncate font-medium text-fg">{props.card.title}</span>
          <button
            onClick={() => setShowBrief((v) => !v)}
            title={showBrief() ? 'Hide the brief' : 'Show the brief, chats and worktrees'}
            class={`${menuTrigger(showBrief())} ml-2`}
          >
            Brief
            <Show when={chats().length}>
              <span class="tabular-nums">· {chats().length} chat{chats().length === 1 ? '' : 's'}</span>
            </Show>
            <ChevronDown class={`size-3 transition-transform ${showBrief() ? 'rotate-180' : ''}`} />
          </button>
          <div class="flex-1" />
          {actions()}
        </div>
        <Show when={showBrief()}>
          <div class="max-h-[55%] shrink-0 overflow-y-auto border-b border-line">
            <div class="mx-auto w-full max-w-3xl px-5 py-6">{details()}</div>
          </div>
        </Show>
        {board(`flex-1 min-h-0 ${showBrief() ? 'pt-5' : ''}`)}
      </div>
    </Show>
  )
}

/** One worktree's branch and what's not merged yet, with a way to remove it once the work is in. */
function WorktreeRow(props: { path: string; sessions: SessionSummary[] }) {
  // Refetched whenever the chat list changes, which is roughly whenever work happened.
  const [status, { refetch }] = createResource(
    () => [props.path, props.sessions] as const,
    ([path]) => api.worktree(path),
  )
  const [error, setError] = createSignal<string>()
  const summary = () => {
    const s = status()
    if (!s) return status.error ? 'Unavailable' : ''
    const parts = [
      s.changes && `${s.changes} uncommitted ${s.changes === 1 ? 'change' : 'changes'}`,
      s.unmerged && `${s.unmerged} ${s.unmerged === 1 ? 'commit' : 'commits'} not on ${s.base || 'HEAD'}`,
    ].filter(Boolean)
    return parts.length ? parts.join(' · ') : `Merged into ${s.base || 'HEAD'}`
  }
  const remove = () => {
    const s = status()
    const warning = s?.unmerged ? `\n\nIts branch ${s.branch} has unmerged commits, so it will be kept.` : ''
    if (!confirm(`Remove worktree ${folderLabel(props.path)}?${warning}`)) return
    setError(undefined)
    api.removeWorktree(props.path).catch((err: Error) => {
      setError(err.message)
      refetch()
    })
  }
  return (
    <div class="group -mx-2 rounded-lg px-2 py-2.5 transition-colors hover:bg-surface/60">
      <div class="flex items-center gap-2 text-[13px]">
        <GitBranch class="size-3.5 shrink-0 text-fg-3" />
        <span class="min-w-0 truncate font-mono text-xs text-fg-2" title={props.path}>
          {status()?.branch || folderLabel(props.path)}
        </span>
        <span class="ml-auto shrink-0 text-[11px] text-fg-3">{summary()}</span>
        <button
          onClick={remove}
          title="Remove worktree (its branch goes too, if merged)"
          class="grid size-6 place-items-center rounded-md text-fg-3 opacity-0 transition hover:bg-surface hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100"
        >
          <Trash2 class="size-3.5" />
        </button>
      </div>
      <Show when={error()}>
        <p class="mt-1 text-xs text-danger">{error()}</p>
      </Show>
    </div>
  )
}
