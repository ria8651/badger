import { For, Show, createEffect, createMemo, createResource, createSignal, on } from 'solid-js'
import { GitBranch, Link, Pencil, Plus, Trash2, X } from 'lucide-solid'
import { CARD_STATUSES, type Card, type SessionSummary } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { folderLabel, isScratch, worktreeOf } from '../folders.ts'
import { STATUS_LABELS } from './Board.tsx'
import { Markdown } from './Markdown.tsx'
import { RenameChat } from './RenameChat.tsx'
import { LiveDot, Menu, Select } from './ui.tsx'

const STATUS_OPTIONS = CARD_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] }))

const menuTrigger = (open: boolean) =>
  `flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-surface hover:text-fg ${
    open ? 'bg-surface text-fg' : 'text-fg-3'
  }`

export function CardView(props: {
  card: Card
  sessions: SessionSummary[]
  onOpenChat: (id: string) => void
  /** Where the card's work last happened, if anywhere: the repo, and whether it was in the card's worktree. */
  onNewChat: (from?: { cwd: string; worktree: boolean }) => void
  onBack: () => void
}) {
  // Linked ids with no transcript yet (a chat opened but never sent) are left out.
  const chats = createMemo(() => props.sessions.filter((s) => props.card.sessionIds.includes(s.id)))
  const [renaming, setRenaming] = createSignal<string>()
  const unlinked = createMemo(() => props.sessions.filter((s) => !props.card.sessionIds.includes(s.id)).slice(0, 30))
  /** Worktrees this card's chats run in. Made by starting a chat in one; nothing else records them. */
  const worktrees = createMemo(() => [...new Set(chats().flatMap((s) => (s.cwd && !s.gone && worktreeOf(s.cwd) ? [s.cwd] : [])))])
  // A new chat picks up where the card's latest chat ran; its folder can still be changed before the first message.
  const newChat = () => {
    const latest = chats()
      .filter((s) => s.cwd && !s.gone && !isScratch(s.cwd))
      .reduce<SessionSummary | undefined>((a, s) => (!a || s.lastModified > a.lastModified ? s : a), undefined)
    const wt = worktreeOf(latest?.cwd)
    props.onNewChat(latest?.cwd ? { cwd: wt?.repo ?? latest.cwd, worktree: !!wt } : undefined)
  }
  const [editing, setEditing] = createSignal(false)
  // What was just typed, shown until the saved card comes back so the old text doesn't flash.
  const [draft, setDraft] = createSignal<string>()
  createEffect(on(() => props.card.description, () => setDraft(undefined), { defer: true }))
  const description = () => draft() ?? props.card.description

  const save = (patch: { title?: string; description?: string }) => {
    const [key, value] = Object.entries(patch)[0] as ['title' | 'description', string]
    if (value.trim() === props.card[key].trim()) return
    if (key === 'title' && !value.trim()) return
    api.updateCard(props.card.id, patch)
  }

  const remove = () => {
    if (!confirm(`Delete card #${props.card.id}? Its chats are kept.`)) return
    api.deleteCard(props.card.id).then(props.onBack)
  }

  return (
    <div class="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
      <div class="flex h-12 shrink-0 items-center gap-1 px-5 text-[13px]">
        <button onClick={props.onBack} class="text-fg-3 transition-colors hover:text-fg">
          Board
        </button>
        <span class="text-fg-3">/</span>
        <span class="text-fg-2 tabular-nums">#{props.card.id}</span>
        <div class="flex-1" />
        <button
          onClick={remove}
          title="Delete card"
          class="grid size-7 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface hover:text-danger"
        >
          <Trash2 class="size-3.5" />
        </button>
      </div>

      <div class="mx-auto w-full max-w-3xl px-5 py-6">
        <input
          value={props.card.title}
          onBlur={(e) => save({ title: e.currentTarget.value })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          class="w-full bg-transparent text-xl font-medium outline-none"
        />
        <div class="mt-2 -ml-2">
          <Select value={props.card.status} options={STATUS_OPTIONS} onChange={(status) => api.updateCard(props.card.id, { status })} placement="bottom" title="Status" />
        </div>

        <Show
          when={editing() || !description().trim()}
          fallback={
            <div
              onClick={(e) => !(e.target as Element).closest('a') && setEditing(true)}
              title="Click to edit"
              class="mt-4 min-h-[6.6em] cursor-text"
            >
              <Markdown text={description()} />
            </div>
          }
        >
          <textarea
            ref={(el) => editing() && queueMicrotask(() => el.focus())}
            value={description()}
            onBlur={(e) => {
              setDraft(e.currentTarget.value)
              save({ description: e.currentTarget.value })
              setEditing(false)
            }}
            onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
            placeholder="Describe the work"
            rows={Math.max(4, description().split('\n').length + 1)}
            class="mt-4 block w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-fg-3"
          />
        </Show>

        <div class="mt-8 flex items-center gap-1 border-b border-line pb-2">
          <h2 class="mr-auto text-[13px] font-medium text-fg-2">Chats</h2>
          <Menu
            items={unlinked().map((s) => ({ label: s.title, description: isScratch(s.cwd) ? 'No folder' : s.cwd, mono: true }))}
            onPick={(i) => api.linkSession(props.card.id, unlinked()[i].id)}
            placement="bottom"
            class="right-0 left-auto! w-80"
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
        <Show when={chats().length} fallback={<p class="py-3 text-[13px] text-fg-3">No chats yet. Chats can be in any repo.</p>}>
          <For each={chats()}>
            {(s) => (
              <div class="group flex items-center gap-2 border-b border-line">
                <Show
                  when={renaming() !== s.id}
                  fallback={<RenameChat session={s} onDone={() => setRenaming()} class="flex min-w-0 flex-1 items-center gap-3 py-2.5" />}
                >
                  <button onClick={() => props.onOpenChat(s.id)} class="flex min-w-0 flex-1 items-center gap-2 py-2.5 text-left">
                    <span class="min-w-0 flex-1 truncate text-[13px] text-fg-2 group-hover:text-fg">{s.title}</span>
                    <Show when={s.running}>
                      <LiveDot />
                    </Show>
                    <span class="shrink-0 text-[11px] text-fg-3">{s.cwd && folderLabel(s.cwd)}</span>
                  </button>
                  <button
                    onClick={() => setRenaming(s.id)}
                    title="Rename chat"
                    class="grid size-6 place-items-center rounded-md text-fg-3 opacity-0 transition hover:bg-surface hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Pencil class="size-3.5" />
                  </button>
                </Show>
                <button
                  onClick={() => api.unlinkSession(props.card.id, s.id)}
                  title="Unlink chat"
                  class="grid size-6 place-items-center rounded-md text-fg-3 opacity-0 transition hover:bg-surface hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
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
      </div>
    </div>
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
    <div class="group border-b border-line py-2.5">
      <div class="flex items-center gap-2 text-[13px]">
        <GitBranch class="size-3.5 shrink-0 text-fg-3" />
        <span class="min-w-0 truncate font-mono text-xs text-fg-2" title={props.path}>
          {status()?.branch || folderLabel(props.path)}
        </span>
        <span class="ml-auto shrink-0 text-[11px] text-fg-3">{summary()}</span>
        <button
          onClick={remove}
          title="Remove worktree (its branch goes too, if merged)"
          class="grid size-6 place-items-center rounded-md text-fg-3 opacity-0 transition hover:bg-surface hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
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
