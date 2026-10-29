import { For, Show, createEffect, createSignal, on, onCleanup } from 'solid-js'
import { Check, FileDiff, FolderInput, GitBranch, Pencil, Zap } from '../icons'
import type { GitStatus, SessionSummary } from '../../shared/protocol.ts'
import type { ChatAction } from '../actions.ts'
import { api } from '../api.ts'
import { basename, worktreeOf } from '../folders.ts'
import { ago } from '../format.ts'
import type { Ws } from '../terminals.ts'
import { BasePicker, baseChanged, howText } from './BasePicker.tsx'
import { FileChat } from './FileChat.tsx'
import { RenameChat } from './RenameChat.tsx'
import { TerminalButton } from './Terminals.tsx'
import { GitSummary, gitParts } from './GitSummary.tsx'
import { showError } from './Popover.tsx'
import { DiffCount, Menu, ltr, plural, type MenuItem } from './ui.tsx'
import { Link } from '../router.tsx'
import { cardOf } from '../stores/cards.ts'

/**
 * A checkout's git status, kept current: read as soon as it's shown and again
 * after a fetch, then fetched every few minutes while the tab is in view, and
 * whenever it comes back into view. Fetching is what makes "behind" mean anything.
 * While `paused`, e.g. with the machine offline for a moment, what was read last stays.
 */
export function createGitStatus(target: () => { dir: string; machine: string } | undefined, paused: () => boolean = () => false) {
  const [status, setStatus] = createSignal<GitStatus>()
  const [fetching, setFetching] = createSignal(false)
  const key = (t?: { dir: string; machine: string }) => (t ? `${t.machine}:${t.dir}` : undefined)
  const refresh = async (fetch = false) => {
    const t = target()
    if (!t || paused()) return
    if (fetch) setFetching(true)
    // One that fails, e.g. while git is busy mid-commit, leaves what's shown rather than blanking it.
    const next = await api.git(t.dir, t.machine, fetch).catch(() => false as const)
    if (fetch) setFetching(false)
    // Dropped if the chat moved, e.g. into a worktree, while it was on its way.
    if (next !== false && key(target()) === key(t)) setStatus(next ?? undefined)
  }
  // Cleared only for somewhere else, or nowhere; read again on coming back from a pause.
  let shown: string | undefined
  createEffect(
    on([() => key(target()), paused], ([k, p]) => {
      if (k !== shown) setStatus(undefined)
      shown = k
      if (k && !p) void refresh().then(() => refresh(true))
    }),
  )
  const inView = () => document.visibilityState === 'visible'
  const onVisible = () => inView() && void refresh(true)
  document.addEventListener('visibilitychange', onVisible)
  const timer = setInterval(onVisible, 5 * 60_000)
  createEffect(on(baseChanged, () => void refresh(), { defer: true }))
  onCleanup(() => {
    document.removeEventListener('visibilitychange', onVisible)
    clearInterval(timer)
  })
  return { status, fetching, refresh }
}

/** e.g. "+126 −38 in 4 files". */
const uncommitted = (g: GitStatus) => [g.added && `+${g.added}`, g.removed && `−${g.removed}`, `in ${plural(g.changes, 'file')}`].filter(Boolean).join(' ')

/** Something the git menu can do: run git here, or ask Claude to. */
type GitItem = MenuItem & { run: () => void }

/**
 * Along the top of a chat: its title and card, where it's working and how that
 * checkout stands in git, with the git actions, the chat's actions, its terminals,
 * and what the sidebar does to a chat: move, rename and archive.
 */
export function ChatHeader(props: {
  sessionId: string
  /** Absent until the chat is listed, e.g. before its first message. */
  session?: SessionSummary
  cwd?: string
  machine: string
  ws?: Ws
  git?: GitStatus
  fetching: boolean
  onRefresh: (fetch: boolean) => Promise<void>
  actions: ChatAction[]
  /** Sends a prompt to the chat. Absent before it's started, so the header only does what needs no chat. */
  onAsk?: (prompt: string) => void
  /** Shows this folder's changes in a panel beside the chat. */
  onDiff?: () => void
  /** Opens the guided review of this folder's changes, starting one if there isn't one. */
  onReview?: () => void
  /** A row goes under it as part of the same header, e.g. a review chat's tabs: that row has the edge and shadow. */
  joined?: boolean
}) {
  const [busy, setBusy] = createSignal<'push' | 'pull'>()
  const card = () => props.session && cardOf(props.session.id)
  const folder = () => {
    const dir = props.cwd
    if (!dir) return ''
    return basename(worktreeOf(dir)?.repo ?? dir)
  }

  let gitMenu!: HTMLDivElement
  let showBases: (() => void) | undefined
  /** Pushes or pulls, saying what git said by the button or the git menu if it fails. */
  const transfer = async (kind: 'push' | 'pull', from: Element = gitMenu) => {
    const dir = props.cwd
    if (!dir || busy()) return
    setBusy(kind)
    try {
      await (kind === 'push' ? api.push(dir, props.machine) : api.pull(dir, props.machine))
    } catch (e) {
      showError(`Couldn't ${kind}`, (e as Error).message, from)
    } finally {
      await props.onRefresh(false)
      setBusy(undefined)
    }
  }

  /** Pushing as it stands, publishing the branch if it has nowhere to go yet, once it has commits no remote has. */
  const canPush = (g: GitStatus) => !!g.branch && g.ahead > 0 && !!(g.upstream || g.remote)
  /** The one thing worth a button of its own, if there is one: push or pull, when that's all it takes to be in step. */
  const primary = (): 'push' | 'pull' | undefined => {
    const g = props.git
    if (!g) return undefined
    if (canPush(g) && !g.behind) return 'push'
    if (g.upstream && g.behind && !g.ahead) return 'pull'
    return undefined
  }

  const gitItems = (): GitItem[] => {
    const g = props.git
    if (!g) return []
    const items: GitItem[] = []
    const diff = props.onDiff
    if (diff) {
      items.push({ label: 'Diff', description: 'Every change, file by file, beside the chat. Comment line by line for this chat to act on.', run: diff })
    }
    const review = props.onReview
    if (review) {
      items.push({ label: 'Guided review', description: 'Read every change yourself, grouped and explained by Claude, and comment line by line.', run: review })
    }
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
              description: `Push it and its ${plural(g.ahead, 'new commit')} to ${g.remote}, and track it there.`,
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
        description: `${g.base.branch} has ${plural(g.base.behind, 'commit')} this branch doesn't. Claude brings them in.`,
        run: () => ask(`Bring this branch up to date with ${g.base!.branch}.`),
      })
    }
    if (ask && g.changes) {
      items.push({
        label: 'Commit',
        description: `${uncommitted(g)}. Claude writes the message.`,
        run: () => ask('Commit the changes here.'),
      })
    }
    // Detached, there's nowhere to keep one.
    if (g.branch && props.cwd) {
      items.push({
        label: g.base ? `Base: ${g.base.branch}` : 'No base',
        description: g.base
          ? `${howText[g.base.how][0].toUpperCase()}${howText[g.base.how].slice(1)}. Unmerged, behind and the diff count from it.`
          : 'Pick a branch to count unmerged commits and the diff from.',
        run: () => showBases?.(),
      })
    }
    items.push({
      label: 'Fetch',
      description: props.fetching ? 'Fetching…' : g.fetchedAt ? `Last fetched ${ago(g.fetchedAt)}.` : 'Never fetched.',
      run: () => void props.onRefresh(true),
    })
    return items
  }

  /** Everything the summary says, and leaves out or shrinks to icons, spelled out at the top of its menu. */
  const detail = (g: GitStatus) => (
    <div class="mb-1 flex flex-col gap-2 border-b border-line px-2.5 pt-2 pb-3 text-ui">
      <div class="min-w-0">
        <div class="flex items-center gap-1.5 font-mono text-fg">
          <GitBranch class="size-3.5 shrink-0 text-fg-3" />
          <span class="truncate">{g.branch || 'Detached HEAD'}</span>
        </div>
        <div class="mt-0.5 truncate text-left font-mono text-meta text-fg-3 [direction:rtl]">{ltr(props.cwd ?? '')}</div>
      </div>
      <div class="flex items-center gap-2">
        <Pencil class="size-3.5 shrink-0 text-fg-3" />
        <Show when={g.changes} fallback={<span class="text-fg-3">Nothing uncommitted</span>}>
          <span class="text-fg-2">
            {plural(g.changes, 'file')} uncommitted <DiffCount files={g.changes} added={g.added} removed={g.removed} class="ml-1" />
          </span>
        </Show>
      </div>
      <Show when={g.upstream && !g.ahead && !g.behind}>
        <div class="flex items-center gap-2 text-fg-3">
          <Check class="size-3.5 shrink-0" />
          In step with {g.upstream}
        </div>
      </Show>
      <For each={gitParts(g)}>
        {(p) => (
          <div class="flex items-start gap-2">
            <p.icon class={`mt-0.5 size-3.5 shrink-0 ${p.tone}`} />
            <div class="min-w-0">
              <div class={p.tone}>{p.text}</div>
              <div class="text-xs leading-snug text-fg-3">{p.title}</div>
            </div>
          </div>
        )}
      </For>
    </div>
  )

  const button = 'flex h-7 items-center gap-1 rounded-button-md px-2 text-xs transition-colors hover:bg-surface hover:text-fg-2 pointer-coarse:h-9'

  return (
    // A container, so what gives way goes by the chat's width, not the window's: a preview beside it narrows it too.
    <div
      class={`bar @container relative z-10 flex h-10 shrink-0 items-center gap-2 px-3 text-ui md:h-12 md:px-4 ${props.joined ? '' : 'border-b border-line shadow-(--shadow-bar)'}`}
    >
      <Show when={props.session}>
        {(s) => (
          <>
            {/* On narrow screens the bar above has the title, and the sidebar's row renames. */}
            <RenameChat
              session={s()}
              title="Rename"
              triggerClass={(open) =>
                `hidden min-w-[6rem] max-w-[40%] shrink-[10] truncate rounded-md px-1.5 py-0.5 -mx-1.5 font-medium text-fg transition-colors hover:bg-surface md:block ${open ? 'bg-surface' : ''}`
              }
              trigger={() => s().title}
            />
            <Show when={card()}>
              {(c) => (
                <Link to={{ kind: 'card', id: c().id }} title={`Open #${c().id} ${c().title}`} class={`${button} max-w-60 shrink-[20] @4xl:min-w-0 text-fg-3`}>
                  <span class="shrink-0 tabular-nums">#{c().id}</span>
                  {/* Only with room to spare: it's the first thing to give way, down to its number. */}
                  <span class="hidden truncate @4xl:inline">{c().title}</span>
                </Link>
              )}
            </Show>
            <FileChat
              session={s()}
              title={card() ? 'Move to another project or card' : 'Put in a project'}
              triggerClass={(open) => `${button} shrink-0 ${card() ? '-ml-2' : ''} ${open ? 'bg-surface text-fg-2' : 'text-fg-3'}`}
              trigger={() => <FolderInput class="size-3.5" />}
            />
          </>
        )}
      </Show>
      {/* With a branch beside it, the next to go. */}
      <span class={`shrink-0 text-fg-2 ${props.git ? 'hidden @2xl:block' : ''}`}>{folder()}</span>
      <Show when={props.git}>
        {(g) => (
          <>
            {/* Wrapped so the branch and how it stands give way, rather than the buttons. */}
            <div ref={gitMenu} class="min-w-0">
              <Menu
                items={gitItems()}
                onPick={(i) => gitItems()[i].run()}
                placement="bottom"
                header={() => detail(g())}
                class="w-80"
                triggerClass={(open) => `${button} max-w-full min-w-0 gap-2 ${open ? 'bg-surface' : ''}`}
                trigger={() => <GitSummary git={g()} branch hide={primary() === 'push' ? 'ahead' : primary() === 'pull' ? 'behind' : undefined} />}
              />
            </div>
            {/* Opened from the git menu's Base item, where the menu was, and back to its button when closed. */}
            <Show when={props.cwd}>
              {(dir) => <BasePicker dir={dir()} machine={props.machine} anchor={() => gitMenu.querySelector('button') ?? gitMenu} opener={(show) => (showBases = show)} />}
            </Show>
            <Show when={primary()}>
              {(kind) => (
                <button
                  type="button"
                  disabled={!!busy()}
                  onClick={(e) => transfer(kind(), e.currentTarget)}
                  title={
                    kind() === 'push'
                      ? g().upstream
                        ? `Push to ${g().upstream}`
                        : `Publish to ${g().remote}`
                      : `Fast-forward from ${g().upstream}`
                  }
                  class="flex h-6 shrink-0 items-center rounded-button-md border border-button-edge shadow-(--shadow-control) px-2 text-xs text-fg transition-colors hover:bg-surface disabled:opacity-60 pointer-coarse:h-8"
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
        <Show when={props.git && props.onDiff}>
          <button type="button" onClick={props.onDiff} title="Diff: every change, beside the chat" class={`${button} text-fg-3`}>
            <FileDiff class="size-3.5" />
          </button>
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
          <TerminalButton ws={props.ws!} session={props.sessionId} cwd={props.cwd!} />
        </Show>
      </div>
    </div>
  )
}
