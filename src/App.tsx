import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { Columns3, Plus } from 'lucide-solid'
import type { Card, SessionSummary } from '../shared/protocol.ts'
import { api, socket } from './api.ts'
import { Board } from './components/Board.tsx'
import { CardView } from './components/CardView.tsx'
import { Chat } from './components/Chat.tsx'
import { StatusDot, TerminalPage } from './components/Terminals.tsx'
import { LiveDot } from './components/ui.tsx'
import { terminalLabel, terminals } from './terminals.ts'

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
          : '/'


export function App() {
  const [config, setConfig] = createSignal<{ defaultCwd: string } | null>(null)
  const [sessions, setSessions] = createSignal<SessionSummary[]>([])
  // Reconciled by id so a refresh updates cards in place instead of rebuilding them mid-drag or mid-edit.
  const [cardStore, setCardStore] = createStore<Card[]>([])
  const cards = () => cardStore
  const setCards = (next: Card[]) => setCardStore(reconcile(next, { key: 'id' }))
  const [route, setRoute] = createSignal<Route>(routeFromPath())
  const [drafts, setDrafts] = createSignal<Record<string, string>>({})
  const [connected, setConnected] = createSignal(false)
  // Home is a blank chat; it gets a real URL once its first message is sent.
  const [homeId, setHomeId] = createSignal(uuid())

  const refresh = () => {
    api.sessions().then(setSessions)
  }
  const refreshCards = () => {
    api.cards().then(setCards)
  }

  onMount(() => {
    api.config().then((c) => {
      setConfig(c)
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
    onCleanup(() => {
      clearTimeout(timer)
      off()
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
  const cardOf = createMemo(() => new Map(cards().flatMap((c) => c.sessionIds.map((id) => [id, c] as const))))

  /** Every directory a session has run in, most recent first, plus the server default. Scratch dirs are skipped. */
  const projects = createMemo(() => {
    const dirs = [...new Set(sessions().flatMap((s) => (s.cwd && !TEMP.test(s.cwd) ? [s.cwd] : [])))]
    const fallback = config()?.defaultCwd
    if (fallback && !dirs.includes(fallback)) dirs.push(fallback)
    return dirs
  })

  const newChat = (cwd: string, cardId?: number) => {
    const id = uuid()
    setDrafts((d) => ({ ...d, [id]: cwd }))
    if (cardId !== undefined) api.linkSession(cardId, id)
    go({ kind: 'chat', id })
  }
  const newHomeChat = () => {
    setHomeId(uuid())
    go({ kind: 'home' })
  }
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
        </div>
        <div class="px-2 pb-3">
          <button
            onClick={() => go({ kind: 'board' })}
            class={`mb-px flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] transition-colors hover:bg-surface hover:text-fg ${
              route().kind === 'board' || route().kind === 'card' ? 'bg-surface text-fg' : 'text-fg-2'
            }`}
          >
            <Columns3 class="size-4" /> Board
          </button>
          <button
            onClick={newHomeChat}
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
          <For each={sessions()}>
            {(s) => (
              <button
                onClick={() => go({ kind: 'chat', id: s.id })}
                class={`group mb-px block w-full rounded-lg px-2 py-1.5 text-left transition-colors ${
                  s.id === current() ? 'bg-surface' : 'hover:bg-surface/60'
                }`}
              >
                <div class="flex items-center gap-2">
                  <span
                    class={`min-w-0 flex-1 truncate text-[13px] ${
                      s.id === current() ? 'text-fg' : 'text-fg-2 group-hover:text-fg'
                    }`}
                  >
                    {s.title}
                  </span>
                  <Show when={s.running}>
                    <LiveDot />
                  </Show>
                </div>
                <div class="mt-0.5 flex gap-1.5 text-[11px] text-fg-3 tabular-nums">
                  <span class="truncate">{s.cwd && basename(s.cwd)}</span>
                  <Show when={cardOf().get(s.id)}>{(c) => <span class="shrink-0">#{c().id}</span>}</Show>
                  <span class="ml-auto shrink-0">{when(s.lastModified)}</span>
                </div>
              </button>
            )}
          </For>
        </nav>
      </aside>

      <Switch>
        <Match when={current()} keyed>
          {(id) => {
            // Same component before and after the first send, so starting a chat doesn't remount it.
            const home = () => route().kind === 'home'
            return (
              <Chat
                sessionId={id}
                draftCwd={drafts()[id] ?? (home() ? projects()[0] : undefined)}
                projects={home() ? projects() : undefined}
                onPickCwd={(cwd) => setDrafts((d) => ({ ...d, [id]: cwd }))}
                onStart={() => home() && startHomeChat(id, drafts()[id] ?? projects()[0])}
                onOpenTerminal={(tid) => go({ kind: 'terminal', id: tid })}
              />
            )
          }}
        </Match>
        <Match when={currentTerminal()} keyed>
          {(id) => <TerminalPage id={id} onClosed={newHomeChat} />}
        </Match>
        <Match when={route().kind === 'board'}>
          <Board cards={cards()} sessions={sessions()} setCards={setCards} onOpen={(id) => go({ kind: 'card', id })} />
        </Match>
        <Match when={route().kind === 'card'}>
          <Show when={currentCard()} fallback={<p class="flex flex-1 items-center justify-center text-[13px] text-fg-3">No such card</p>}>
            {(card) => (
              <CardView
                card={card()}
                sessions={sessions()}
                projects={projects()}
                onOpenChat={(id) => go({ kind: 'chat', id })}
                onNewChat={(cwd) => newChat(cwd, card().id)}
                onBack={() => go({ kind: 'board' })}
              />
            )}
          </Show>
        </Match>
      </Switch>
    </div>
  )
}

const TEMP = /^\/(private\/)?(tmp|var\/folders)\//

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

/** Time today, day and month this year, full date otherwise. */
function when(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
