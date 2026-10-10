import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { Archive, ArchiveRestore, Bell, BellOff, ChevronDown, ChevronRight, Columns3, Pencil, Plus, Radar as RadarIcon } from 'lucide-solid'
import { descendants, projectOf } from '../shared/cardTree.ts'
import type { Card, SessionSummary } from '../shared/protocol.ts'
import { api, socket } from './api.ts'
import { attention, looking, notifications, notify, onAttention, toggleNotifications } from './attention.ts'
import { basename, folderLabel, isScratch, lastWorkedIn, setScratch } from './folders.ts'
import { Board } from './components/Board.tsx'
import { CardView } from './components/CardView.tsx'
import { Radar } from './components/Radar.tsx'
import { Chat } from './components/Chat.tsx'
import { RenameChat } from './components/RenameChat.tsx'
import { AccountLimits } from './components/Usage.tsx'
import { StatusDot, TerminalPage } from './components/Terminals.tsx'
import { ChatDot, Menu } from './components/ui.tsx'
import { terminalLabel, terminals } from './terminals.ts'
import { accountUsage } from './usage.ts'

/** crypto.randomUUID needs a secure context; fall back for plain-http hosts. */
function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

type Route =
  | { kind: 'home' }
  | { kind: 'chat'; id: string }
  | { kind: 'board' }
  | { kind: 'radar' }
  | { kind: 'card'; id: number }
  | { kind: 'terminal'; id: string }

function routeFromPath(): Route {
  const path = location.pathname
  const chat = path.match(/^\/s\/([0-9a-f-]{36})/)
  if (chat) return { kind: 'chat', id: chat[1] }
  const card = path.match(/^\/c\/(\d+)/)
  if (card) return { kind: 'card', id: Number(card[1]) }
  const terminal = path.match(/^\/t\/([0-9a-f]+)/)
  if (terminal) return { kind: 'terminal', id: terminal[1] }
  if (path === '/board') return { kind: 'board' }
  if (path === '/radar') return { kind: 'radar' }
  return { kind: 'home' }
}

const pathFor = (r: Route) =>
  r.kind === 'chat'
    ? `/s/${r.id}`
    : r.kind === 'card'
      ? `/c/${r.id}`
      : r.kind === 'terminal'
        ? `/t/${r.id}`
        : r.kind === 'board'
          ? '/board'
          : r.kind === 'radar'
            ? '/radar'
            : '/'


export function App() {
  const [config, setConfig] = createSignal<{ defaultCwd: string; scratchCwd: string } | null>(null)
  const [sessions, setSessions] = createSignal<SessionSummary[]>([])
  // Reconciled by id so a refresh updates cards in place instead of rebuilding them mid-drag or mid-edit.
  const [cardStore, setCardStore] = createStore<Card[]>([])
  const cards = () => cardStore
  const setCards = (next: Card[]) => setCardStore(reconcile(next, { key: 'id' }))
  const [route, setRoute] = createSignal<Route>(routeFromPath())
  const [drafts, setDrafts] = createSignal<Record<string, string>>({})
  /** Blank chats that should start with "In a worktree" ticked, e.g. a card whose work is already in one. */
  const [worktreeDrafts, setWorktreeDrafts] = createSignal<Record<string, boolean>>({})
  const [connected, setConnected] = createSignal(false)
  // Home is a blank chat; it gets a real URL once its first message is sent.
  // Its id is kept until then so a draft typed there survives reloads.
  const [homeId, setHomeId] = createSignal(localStorage.getItem(HOME_KEY) ?? uuid())
  createEffect(() => localStorage.setItem(HOME_KEY, homeId()))

  const [loaded, setLoaded] = createSignal(false)
  const refresh = () => {
    api.sessions().then((list) => {
      setSessions(list)
      setLoaded(true)
    })
  }
  const refreshCards = () => {
    api.cards().then(setCards)
  }

  onMount(() => {
    api.config().then((c) => {
      setConfig(c)
      setScratch(c.scratchCwd)
      socket.connect()
      refresh()
      refreshCards()
    })
    const offConn = socket.onConnection(setConnected)
    // Refresh the list when sessions appear, finish a turn, or change state.
    let timer: ReturnType<typeof setTimeout>
    const off = socket.on((e) => {
      if (e.type === 'cards_changed') refreshCards()
      if (e.type === 'sessions_changed' || e.type === 'status') {
        clearTimeout(timer)
        timer = setTimeout(refresh, 300)
      }
    })
    const onPop = () => setRoute(routeFromPath())
    addEventListener('popstate', onPop)
    const offAttention = onAttention((id, state) => {
      const title = sessions().find((s) => s.id === id)?.title ?? 'New chat'
      notify(id, title, state === 'waiting' ? 'Needs your input' : 'Finished', () => go({ kind: 'chat', id }))
    })
    onCleanup(() => {
      clearTimeout(timer)
      off()
      offAttention()
      offConn()
      removeEventListener('popstate', onPop)
    })
  })

  const go = (r: Route) => {
    history.pushState(null, '', pathFor(r))
    setRoute(r)
  }
  const current = () => {
    const r = route()
    return r.kind === 'chat' ? r.id : r.kind === 'home' ? homeId() : null
  }
  /**
   * The project this tab is working in, or null for all of them. Per tab, so two tabs can be on two projects.
   * It scopes the sidebar, the Board button and new chats.
   */
  const [focusId, setFocusId] = createSignal<number | null>(Number(sessionStorage.getItem(FOCUS_KEY)) || null)
  createEffect(() => {
    const id = focusId()
    if (id === null) sessionStorage.removeItem(FOCUS_KEY)
    else sessionStorage.setItem(FOCUS_KEY, String(id))
  })
  /** Projects are the top-level cards. */
  const allProjects = createMemo(() => cards().filter((c) => (c.parentId ?? null) === null))
  // Undefined while cards load, or if the project was deleted or moved, in which case the tab shows everything.
  const focus = createMemo(() => allProjects().find((c) => c.id === focusId()))
  const projectOfChat = (id: string) => {
    const card = cardOf().get(id)
    return card && projectOf(cards(), card.id)
  }
  // Focus follows where you go: a project's board focuses it, the projects board shows them all,
  // and opening something in another project moves there. Chats on no card leave it alone.
  createEffect(() => {
    const r = route()
    if (r.kind === 'board') return setFocusId(null)
    const card = r.kind === 'card' ? cards().find((c) => c.id === r.id) : r.kind === 'chat' ? cardOf().get(r.id) : undefined
    if (!card) return
    if ((card.parentId ?? null) === null && r.kind === 'card') return setFocusId(card.id)
    const project = projectOf(cards(), card.id)
    if (project && untrack(focusId) !== null && project.id !== untrack(focusId)) setFocusId(project.id)
  })
  const inFocus = (s: SessionSummary) => {
    const f = focus()
    return !f || s.id === current() || projectOfChat(s.id)?.id === f.id
  }
  const currentCard = () => {
    const r = route()
    return r.kind === 'card' ? cards().find((c) => c.id === r.id) : undefined
  }
  const currentTerminal = () => {
    const r = route()
    return r.kind === 'terminal' ? r.id : null
  }
  // Grouped by workspace, oldest first within each, so a workspace's terminals sit together.
  const sortedTerminals = createMemo(() =>
    [...terminals()].sort((a, b) => a.root.localeCompare(b.root) || a.createdAt - b.createdAt),
  )
  // Looking at a chat reads it, including a turn that ends while you watch.
  createEffect(() => {
    const id = current()
    if (id && looking() && attention()[id] === 'unread') socket.send({ type: 'seen', sessionId: id })
  })
  // Archived chats are put away, so they don't count.
  const needsYou = createMemo(() => {
    const archived = new Set(sessions().flatMap((s) => (s.archived ? [s.id] : [])))
    return Object.keys(attention()).filter((id) => !archived.has(id)).length
  })
  createEffect(() => (document.title = needsYou() ? `(${needsYou()}) Badger` : 'Badger'))

  const active = createMemo(() => sessions().filter((s) => !s.archived && inFocus(s)))
  const archived = createMemo(() => sessions().filter((s) => s.archived && inFocus(s)))
  const [showArchived, setShowArchived] = createSignal(false)
  const toggleArchived = (s: SessionSummary) => {
    // Move it straight away; the server's sessions_changed confirms it.
    setSessions((all) => all.map((x) => (x.id === s.id ? { ...x, archived: !s.archived } : x)))
    ;(s.archived ? api.unarchive(s.id) : api.archive(s.id)).catch(refresh)
  }

  const [renaming, setRenaming] = createSignal<string>()
  const renamed = (id: string, title: string) => setSessions((all) => all.map((x) => (x.id === id ? { ...x, title } : x)))

  const SessionRow = (props: { session: SessionSummary }) => {
    const s = () => props.session
    return (
      <Show
        when={renaming() !== s().id}
        fallback={
          <RenameChat
            session={s()}
            onSaved={(title) => renamed(s().id, title)}
            onDone={() => setRenaming()}
            class="mb-px flex flex-col gap-0.5 rounded-lg bg-surface px-2 py-1.5"
          />
        }
      >
        <div class="group relative mb-px">
          <button
            onClick={() => go({ kind: 'chat', id: s().id })}
            class={`block w-full rounded-lg px-2 py-1.5 text-left transition-colors ${
              s().id === current() ? 'bg-surface' : 'hover:bg-surface/60'
            }`}
          >
            <div class="flex items-center gap-2">
              <span
                class={`min-w-0 flex-1 truncate text-[13px] ${
                  s().id === current() || attention()[s().id]
                    ? 'text-fg'
                    : s().archived
                      ? 'text-fg-3 group-hover:text-fg'
                      : 'text-fg-2 group-hover:text-fg'
                }`}
              >
                {s().title}
              </span>
              <ChatDot running={s().running} attention={attention()[s().id]} />
            </div>
            <div class="mt-0.5 flex gap-1.5 text-[11px] text-fg-3 tabular-nums">
              <span class="truncate">{s().cwd && folderLabel(s().cwd!)}</span>
              <Show when={cardOf().get(s().id)}>{(c) => <span class="shrink-0">#{c().id}</span>}</Show>
              <span class="ml-auto shrink-0 group-hover:invisible">{when(s().lastModified)}</span>
            </div>
          </button>
          <div class="absolute right-1.5 bottom-1 hidden gap-0.5 group-hover:flex">
            <button
              onClick={() => setRenaming(s().id)}
              title="Rename"
              class="grid size-5 place-items-center rounded text-fg-3 transition-colors hover:bg-surface hover:text-fg"
            >
              <Pencil class="size-3.5" />
            </button>
            <button
              onClick={() => toggleArchived(s())}
              title={s().archived ? 'Unarchive' : 'Archive'}
              class="grid size-5 place-items-center rounded text-fg-3 transition-colors hover:bg-surface hover:text-fg"
            >
              <Show when={s().archived} fallback={<Archive class="size-3.5" />}>
                <ArchiveRestore class="size-3.5" />
              </Show>
            </button>
          </div>
        </div>
      </Show>
    )
  }
  const cardOf = createMemo(() => new Map(cards().flatMap((c) => c.sessionIds.map((id) => [id, c] as const))))

  /**
   * No folder first, then every directory a session has run in, most recent
   * first, plus the server default. Temp dirs and ones that are gone (removed worktrees) are skipped.
   */
  const projects = createMemo(() => {
    const dirs = [...new Set(sessions().flatMap((s) => (s.cwd && !s.gone && !TEMP.test(s.cwd) && !isScratch(s.cwd) ? [s.cwd] : [])))]
    const fallback = config()?.defaultCwd
    if (fallback && !dirs.includes(fallback)) dirs.push(fallback)
    const scratch = config()?.scratchCwd
    return scratch ? [scratch, ...dirs] : dirs
  })
  /** New chats start where the most recently active chat ran, or with no folder. */
  const defaultCwd = createMemo(() => {
    const recent = sessions()
      .filter((s) => s.cwd && projects().includes(s.cwd))
      .reduce<SessionSummary | undefined>((a, s) => (!a || s.lastModified > a.lastModified ? s : a), undefined)
    return recent?.cwd ?? projects()[0]
  })
  // Pin it per blank chat so activity elsewhere doesn't move the folder while you type.
  createEffect(() => {
    const id = homeId()
    if (loaded() && !untrack(drafts)[id]) setDrafts((d) => ({ ...d, [id]: untrack(defaultCwd) }))
  })

  const newChat = (from: { cwd: string; worktree: boolean } | undefined, cardId?: number) => {
    const id = uuid()
    setDrafts((d) => ({ ...d, [id]: from?.cwd ?? untrack(defaultCwd) }))
    if (from?.worktree) setWorktreeDrafts((w) => ({ ...w, [id]: true }))
    if (cardId !== undefined) api.linkSession(cardId, id)
    go({ kind: 'chat', id })
  }
  // Another tab may have started the blank chat both were showing.
  createEffect(() => {
    if (sessions().some((s) => s.id === untrack(homeId))) setHomeId(uuid())
  })

  /** In a project, a new chat goes on the project's card and starts where its work last happened; otherwise it's the blank home chat. */
  const newHomeChat = () => {
    const f = focus()
    if (!f) return go({ kind: 'home' })
    const ids = [f, ...descendants(cards(), f.id)].flatMap((c) => c.sessionIds)
    const from = lastWorkedIn(sessions().filter((s) => ids.includes(s.id)))
    newChat(from && { cwd: from.cwd, worktree: false }, f.id)
  }
  /** For the switcher: how far along a project is. */
  const projectSummary = (p: Card) => {
    const inside = cards().filter((c) => c.parentId === p.id)
    return inside.length ? `${inside.filter((c) => c.status === 'done').length}/${inside.length} cards done` : 'No cards yet'
  }
  const switchable = createMemo(() => [null, ...allProjects().filter((c) => c.status !== 'done' || c.id === focusId())])
  /** The home chat's first message went out: give it its own URL and a fresh blank chat for next time. */
  const startHomeChat = (id: string, cwd?: string) => {
    if (cwd) setDrafts((d) => ({ ...d, [id]: cwd }))
    history.replaceState(null, '', pathFor({ kind: 'chat', id }))
    setRoute({ kind: 'chat', id })
    setHomeId(uuid())
  }

  return (
    <div class="flex h-full">
      <aside class="hidden w-64 shrink-0 flex-col border-r border-line md:flex">
        <div class="flex h-12 shrink-0 items-center gap-2 px-4">
          <span class="font-medium tracking-tight">Badger</span>
          <Show when={!connected()}>
            <span class="text-xs text-fg-3">Reconnecting…</span>
          </Show>
          <button
            onClick={toggleNotifications}
            disabled={notifications() === 'blocked'}
            title={
              notifications() === 'on'
                ? 'Notifications on: chats that finish or need you while you’re away'
                : notifications() === 'blocked'
                  ? 'Notifications are blocked in this browser, or need https'
                  : 'Turn on notifications'
            }
            class="ml-auto grid size-7 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface hover:text-fg disabled:opacity-40"
          >
            <Show when={notifications() === 'on'} fallback={<BellOff class="size-4" />}>
              <Bell class="size-4" />
            </Show>
          </button>
        </div>
        <div class="px-2 pb-3">
          <Menu
            items={switchable().map((c) =>
              c
                ? { label: c.title, description: projectSummary(c), selected: c.id === focus()?.id }
                : { label: 'All projects', description: 'Everything', selected: !focus() },
            )}
            onPick={(i) => {
              const c = switchable()[i]
              go(c ? { kind: 'card', id: c.id } : { kind: 'board' })
            }}
            placement="bottom"
            class="w-60"
            title="Which project this tab is working in"
            triggerClass={(open) =>
              `mb-1 flex h-8 w-full items-center gap-2 rounded-lg border border-line px-2 text-[13px] transition-colors hover:border-edge ${open ? 'border-edge' : ''}`
            }
            trigger={(open) => (
              <>
                <span class={`min-w-0 flex-1 truncate text-left ${focus() ? 'text-fg' : 'text-fg-2'}`}>{focus()?.title ?? 'All projects'}</span>
                <ChevronDown class={`size-3.5 text-fg-3 transition-transform ${open() ? 'rotate-180' : ''}`} />
              </>
            )}
          />
          <button
            onClick={() => go({ kind: 'radar' })}
            title="Everything on your radar, across projects"
            class={`mb-px flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] transition-colors hover:bg-surface hover:text-fg ${
              route().kind === 'radar' ? 'bg-surface text-fg' : 'text-fg-2'
            }`}
          >
            <RadarIcon class="size-4" /> Radar
            <Show when={needsYou()}>
              <span class="ml-auto text-[11px] text-accent tabular-nums">{needsYou()}</span>
            </Show>
          </button>
          <button
            onClick={() => go(focus() ? { kind: 'card', id: focus()!.id } : { kind: 'board' })}
            class={`mb-px flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] transition-colors hover:bg-surface hover:text-fg ${
              route().kind === 'board' || route().kind === 'card' ? 'bg-surface text-fg' : 'text-fg-2'
            }`}
          >
            <Columns3 class="size-4" /> {focus() ? 'Board' : 'Projects'}
          </button>
          <button
            onClick={newHomeChat}
            title={focus() ? `A chat on ${focus()!.title}` : undefined}
            class={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] transition-colors hover:bg-surface hover:text-fg ${
              route().kind === 'home' ? 'bg-surface text-fg' : 'text-fg-2'
            }`}
          >
            <Plus class="size-4" /> New chat
          </button>
        </div>
        <Show when={sortedTerminals().length}>
          <div class="px-2 pb-3">
            <div class="px-2 pb-1 text-[11px] text-fg-3">Terminals</div>
            <For each={sortedTerminals()}>
              {(t) => (
                <button
                  onClick={() => go({ kind: 'terminal', id: t.id })}
                  title={`${terminalLabel(t)}\n${t.cwd}`}
                  class={`group mb-px flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors ${
                    t.id === currentTerminal() ? 'bg-surface' : 'hover:bg-surface/60'
                  }`}
                >
                  <StatusDot terminal={t} />
                  <span
                    class={`min-w-0 flex-1 truncate text-[13px] ${
                      t.id === currentTerminal() ? 'text-fg' : 'text-fg-2 group-hover:text-fg'
                    }`}
                  >
                    {terminalLabel(t)}
                  </span>
                  <span class="shrink-0 text-[11px] text-fg-3">{basename(t.root)}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <nav class="flex-1 overflow-y-auto px-2 py-2">
          <For each={active()}>{(s) => <SessionRow session={s} />}</For>
          <Show when={archived().length}>
            <button
              onClick={() => setShowArchived((v) => !v)}
              class="mt-2 flex h-7 w-full items-center gap-1 rounded-lg px-2 text-[11px] text-fg-3 transition-colors hover:text-fg-2"
            >
              <ChevronRight class={`size-3 transition-transform ${showArchived() ? 'rotate-90' : ''}`} />
              Archived ({archived().length})
            </button>
            <Show when={showArchived()}>
              <For each={archived()}>{(s) => <SessionRow session={s} />}</For>
            </Show>
          </Show>
        </nav>
        <Show when={accountUsage()}>{(u) => <AccountLimits usage={u()} />}</Show>
      </aside>

      <Switch>
        <Match when={current()} keyed>
          {(id) => {
            // Same component before and after the first send, so starting a chat doesn't remount it.
            const home = () => route().kind === 'home'
            return (
              <Chat
                sessionId={id}
                draftCwd={drafts()[id] ?? defaultCwd()}
                projects={projects()}
                worktree={worktreeDrafts()[id]}
                onPickCwd={(cwd) => setDrafts((d) => ({ ...d, [id]: cwd }))}
                card={cardOf().get(id)}
                onStart={() => home() && startHomeChat(id, drafts()[id] ?? defaultCwd())}
                onOpenTerminal={(tid) => go({ kind: 'terminal', id: tid })}
              />
            )
          }}
        </Match>
        <Match when={currentTerminal()} keyed>
          {(id) => <TerminalPage id={id} onClosed={newHomeChat} />}
        </Match>
        <Match when={route().kind === 'radar'}>
          <Radar cards={cards()} sessions={sessions()} onOpenCard={(id) => go({ kind: 'card', id })} onOpenChat={(id) => go({ kind: 'chat', id })} />
        </Match>
        <Match when={route().kind === 'board'}>
          <Board cards={cards()} sessions={sessions()} setCards={setCards} onOpen={(id) => go({ kind: 'card', id })} />
        </Match>
        <Match when={route().kind === 'card'}>
          <Show when={currentCard()} fallback={<p class="flex flex-1 items-center justify-center text-[13px] text-fg-3">No such card</p>}>
            {(card) => (
              <CardView
                card={card()}
                cards={cards()}
                setCards={setCards}
                sessions={sessions()}
                onOpenCard={(id) => go(id === null ? { kind: 'board' } : { kind: 'card', id })}
                onOpenChat={(id) => go({ kind: 'chat', id })}
                onNewChat={(from) => newChat(from, card().id)}
              />
            )}
          </Show>
        </Match>
      </Switch>
    </div>
  )
}

const HOME_KEY = 'badger.homeId'
const FOCUS_KEY = 'badger.focus'

const TEMP = /^\/(private\/)?(tmp|var\/folders)\//

/** Time today, day and month this year, full date otherwise. */
function when(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
