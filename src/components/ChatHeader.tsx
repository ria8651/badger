import { Show, createEffect, createSignal, on, onCleanup } from 'solid-js'
import { Archive, ArchiveRestore, FolderInput, Zap } from '../icons'
import type { Card, GitStatus, SessionSummary } from '../../shared/protocol.ts'
import type { ChatAction } from '../actions.ts'
import { api } from '../api.ts'
import { basename, worktreeOf } from '../folders.ts'
import type { Ws } from '../terminals.ts'
import { FileChat } from './FileChat.tsx'
import { RenameChat } from './RenameChat.tsx'
import { TerminalButton } from './Terminals.tsx'
import { GitSummary } from './GitSummary.tsx'
import { Menu, plural, type MenuItem } from './ui.tsx'

/**
 * A checkout's git status, kept current: read as soon as it's shown and again
 * after a fetch, then fetched every few minutes while the tab is in view, and
 * whenever it comes back into view. Fetching is what makes "behind" mean anything.
 */
export function createGitStatus(target: () => { dir: string; machine: string } | undefined) {
  const [status, setStatus] = createSignal<GitStatus>()
  const [fetching, setFetching] = createSignal(false)
  const key = (t?: { dir: string; machine: string }) => (t ? `${t.machine}:${t.dir}` : undefined)
  const refresh = async (fetch = false) => {
    const t = target()
    if (!t) return
    if (fetch) setFetching(true)
    const next = await api.git(t.dir, t.machine, fetch).catch(() => undefined)
    if (fetch) setFetching(false)
    // Dropped if the chat moved, e.g. into a worktree, while it was on its way.
    if (key(target()) === key(t)) setStatus(next ?? undefined)
  }
  createEffect(
    on(
      () => key(target()),
      (k) => {
        setStatus(undefined)
        if (k) void refresh().then(() => refresh(true))
      },
    ),
  )
  const inView = () => document.visibilityState === 'visible'
  const onVisible = () => inView() && void refresh(true)
  document.addEventListener('visibilitychange', onVisible)
  const timer = setInterval(onVisible, 5 * 60_000)
  onCleanup(() => {
    document.removeEventListener('visibilitychange', onVisible)
    clearInterval(timer)
  })
  return { status, fetching, refresh }
}

/** e.g. "+126 −38 in 4 files". */
const uncommitted = (g: GitStatus) => `+${g.added} −${g.removed} in ${plural(g.changes, 'file')}`

const ago = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** Something the git menu can do: run git here, or ask Claude to. */
type GitItem = MenuItem & { run: () => void }

/**
 * Along the top of a chat: its title and card, where it's working and how that
 * checkout stands in git, with the git actions, the chat's actions, its terminals,
 * and what the sidebar does to a chat: move, rename and archive.
 */
export function ChatHeader(props: {
  /** Absent until the chat is listed, e.g. before its first message. */
  session?: SessionSummary
  cards: Card[]
  onRenamed: (title: string) => void
  onToggleArchived: () => void
  cwd?: string
  machine: string
  ws?: Ws
  git?: GitStatus
  fetching: boolean
  onRefresh: (fetch: boolean) => Promise<void>
  actions: ChatAction[]
  /** Sends a prompt to the chat. Absent before it's started, so the header only does what needs no chat. */
  onAsk?: (prompt: string) => void
}) {
  const [busy, setBusy] = createSignal<'push' | 'pull'>()
  const card = () => props.session && props.cards.find((c) => c.sessionIds.includes(props.session!.id))
  const folder = () => {
    const dir = props.cwd
    if (!dir) return ''
    return basename(worktreeOf(dir)?.repo ?? dir)
  }

  const transfer = async (kind: 'push' | 'pull') => {
    const dir = props.cwd
    if (!dir || busy()) return
    setBusy(kind)
    try {
      await (kind === 'push' ? api.push(dir, props.machine) : api.pull(dir, props.machine))
    } catch (e) {
      alert(`Couldn't ${kind}: ${(e as Error).message}`)
    } finally {
      await props.onRefresh(false)
      setBusy(undefined)
    }
  }

  /** Pushing as it stands, publishing the branch if it has nowhere to go yet. */
  const canPush = (g: GitStatus) => !!g.branch && (g.upstream ? g.ahead > 0 : !!g.remote)
  /** The one thing worth a button of its own, if there is one: push or pull, when that's all it takes to be in step. */
  const primary = (): 'push' | 'pull' | undefined => {
    const g = props.git
    if (!g) return undefined
    if (g.upstream && g.ahead && !g.behind) return 'push'
    if (g.upstream && g.behind && !g.ahead) return 'pull'
    // A worktree's branch normally goes back by merging, not by being published.
    if (!g.upstream && !g.base && canPush(g)) return 'push'
    return undefined
  }

  const gitItems = (): GitItem[] => {
    const g = props.git
    if (!g) return []
    const items: GitItem[] = []
    if (canPush(g) && !g.behind) {
      items.push(
        g.upstream
          ? {
              label: `Push ${plural(g.ahead, 'commit')}`,
              description: `To ${g.upstream}.`,
              run: () => transfer('push'),
            }
          : {
              label: `Publish ${g.branch}`,
              description: `Push it to ${g.remote} and track it there.`,
              run: () => transfer('push'),
            },
      )
    }
    if (g.behind && !g.ahead) {
      items.push({
        label: `Pull ${plural(g.behind, 'commit')}`,
        description: `Fast-forward from ${g.upstream}.`,
        run: () => transfer('pull'),
      })
    }
    const ask = props.onAsk
    if (ask && g.behind && g.ahead) {
      items.push({
        label: `Bring up to date with ${g.upstream}`,
        description: `${g.ahead} here and ${g.behind} there that the other doesn't have. Claude merges or rebases.`,
        run: () => ask(`Bring this branch up to date with ${g.upstream}.`),
      })
    }
    if (ask && g.base?.behind) {
      items.push({
        label: `Update from ${g.base.branch}`,
        description: `${g.base.branch} has ${plural(g.base.behind, 'commit')} this worktree doesn't. Claude brings them in.`,
        run: () => ask(`Bring this worktree up to date with ${g.base!.branch}.`),
      })
    }
    if (ask && g.changes) {
      items.push({
        label: 'Commit',
        description: `${uncommitted(g)}. Claude writes the message.`,
        run: () => ask('Commit the changes here.'),
      })
    }
    items.push({
      label: 'Fetch',
      description: props.fetching ? 'Fetching…' : g.fetchedAt ? `Last fetched ${ago(g.fetchedAt)}.` : 'Never fetched.',
      run: () => void props.onRefresh(true),
    })
    return items
  }

  /** Everything the summary leaves out, for hovering. */
  const detail = () => {
    const g = props.git
    if (!g) return ''
    return [
      `${g.branch || 'Detached HEAD'} in ${props.cwd}`,
      g.changes ? `Uncommitted: ${uncommitted(g)}` : 'Nothing uncommitted',
      g.upstream ? `${g.ahead} ahead, ${g.behind} behind ${g.upstream}` : g.remote ? `Not on ${g.remote} yet` : 'No remote',
      g.base && `${g.base.ahead} not on ${g.base.branch}, ${g.base.behind} on ${g.base.branch} not here`,
      g.fetchedAt ? `Fetched ${ago(g.fetchedAt)}` : 'Never fetched',
    ]
      .filter(Boolean)
      .join('\n')
  }

  const button = 'flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors hover:bg-surface hover:text-fg-2 pointer-coarse:h-9'

  return (
    <div class="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 text-[13px] md:px-4">
      <Show when={props.session}>
        {(s) => (
          <>
            {/* On narrow screens the page's own header has the title, and the sidebar's row moves and renames. */}
            <RenameChat
              session={s()}
              onSaved={props.onRenamed}
              title="Rename"
              triggerClass={(open) =>
                `hidden min-w-[6rem] max-w-[40%] shrink-[10] truncate rounded-md px-1.5 py-0.5 -mx-1.5 font-medium text-fg transition-colors hover:bg-surface md:block ${open ? 'bg-surface' : ''}`
              }
              trigger={() => s().title}
            />
            <FileChat
              session={s()}
              cards={props.cards}
              title={card() ? 'Move to another project or card' : 'Put in a project'}
              triggerClass={(open) => `${button} hidden max-w-60 md:flex ${open ? 'bg-surface text-fg-2' : 'text-fg-3'}`}
              trigger={() => (
                <Show when={card()} fallback={<FolderInput class="size-3.5" />}>
                  {(c) => (
                    <>
                      <span class="tabular-nums">#{c().id}</span>
                      <span class="hidden truncate lg:inline">{c().title}</span>
                    </>
                  )}
                </Show>
              )}
            />
          </>
        )}
      </Show>
      <span class={`shrink-0 text-fg-2 ${props.git ? 'hidden sm:block' : ''}`}>{folder()}</span>
      <Show when={props.git}>
        {(g) => (
          <>
            {/* Wrapped so the branch name gives way on narrow screens, rather than the buttons. */}
            <div class="min-w-0">
              <Menu
                items={gitItems()}
                onPick={(i) => gitItems()[i].run()}
                placement="bottom"
                title={detail()}
                class="w-80"
                triggerClass={(open) => `${button} max-w-full min-w-0 gap-2 ${open ? 'bg-surface' : ''}`}
                trigger={() => <GitSummary git={g()} branch hide={primary() === 'push' ? 'ahead' : primary() === 'pull' ? 'behind' : undefined} />}
              />
            </div>
            <Show when={primary()}>
              {(kind) => (
                <button
                  type="button"
                  disabled={!!busy()}
                  onClick={() => transfer(kind())}
                  title={
                    kind() === 'push'
                      ? g().upstream
                        ? `Push to ${g().upstream}`
                        : `Publish to ${g().remote}`
                      : `Fast-forward from ${g().upstream}`
                  }
                  class="flex h-6 shrink-0 items-center rounded-md border border-edge px-2 text-xs text-fg transition-colors hover:bg-surface disabled:opacity-60 pointer-coarse:h-8"
                >
                  {busy() === 'push'
                    ? 'Pushing…'
                    : busy() === 'pull'
                      ? 'Pulling…'
                      : kind() === 'push'
                        ? g().upstream
                          ? `Push ${g().ahead}`
                          : 'Publish'
                        : `Pull ${g().behind}`}
                </button>
              )}
            </Show>
          </>
        )}
      </Show>
      <div class="ml-auto flex shrink-0 items-center gap-1">
        <Show when={props.session}>
          {(s) => (
            <>
              <button type="button" onClick={props.onToggleArchived} title={s().archived ? 'Unarchive' : 'Archive'} class={`${button} text-fg-3`}>
                <Show when={s().archived} fallback={<Archive class="size-3.5" />}>
                  <ArchiveRestore class="size-3.5" />
                </Show>
              </button>
            </>
          )}
        </Show>
        <Show when={props.onAsk && props.actions.length}>
          <Menu
            items={props.actions.map((a) => ({ label: a.label, description: a.description }))}
            onPick={(i) => props.onAsk!(props.actions[i].prompt)}
            placement="bottom"
            align="right"
            title="Chat actions"
            triggerClass={(open) => `${button} ${open ? 'bg-surface text-fg-2' : 'text-fg-3'}`}
            trigger={() => <Zap class="size-3.5" />}
          />
        </Show>
        <Show when={props.ws && props.cwd}>
          <TerminalButton ws={props.ws!} cwd={props.cwd!} />
        </Show>
      </div>
    </div>
  )
}
