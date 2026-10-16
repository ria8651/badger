import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, on, onMount, untrack } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { Archive, ArchiveRestore, Bell, BellOff, ChevronDown, ChevronRight, Columns3, FolderInput, PanelLeft, Pencil, Plus, Radar as RadarIcon, Search, Settings as SettingsIcon, Trash2, X } from './icons'
import { descendants, projectOf } from '../shared/cardTree.ts'
import type { Card, SessionSummary } from '../shared/protocol.ts'
import { api, socket } from './api.ts'
import { attention, looking, notifications, notify, onAttention, toggleNotifications } from './attention.ts'
import { basename, folderLabel, isScratch, lastWorkedIn, scratchDir, setScratch } from './folders.ts'
import { LOCAL, machineOf, machines, onMachine } from './machines.ts'
import { Board } from './components/Board.tsx'
import { CardView } from './components/CardView.tsx'
import { Radar } from './components/Radar.tsx'
import { Chat } from './components/Chat.tsx'
import { RenameChat } from './components/RenameChat.tsx'
import { FileChat } from './components/FileChat.tsx'
import { AccountLimits } from './components/Usage.tsx'
import { StatusDot, TerminalPage } from './components/Terminals.tsx'
import { ChatSummary, MachineName } from './components/ChatSummary.tsx'
import { Settings } from './components/Settings.tsx'
import { ImageViewer } from './components/ImageViewer.tsx'
import { Loading, Menu, inputClass, modalOpen } from './components/ui.tsx'
import { terminalLabel, terminalTooltip, terminalWs, terminals, terminalsLoaded, wsKey } from './terminals.ts'
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
  // `<machine>.<hex id>`; bare hex from before there were other machines.
  const terminal = path.match(/^\/t\/((?:[a-z0-9-]+\.)?[0-9a-f]+)/)
  // Links from before there were other machines are to the hub's own.
  if (terminal) return { kind: 'terminal', id: terminal[1].includes('.') ? terminal[1] : `local.${terminal[1]}` }
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
  const [drafts, setDrafts] = createSignal<Record<string, string>>(loadRecord(DRAFTS_KEY))
  /** The runner each blank chat will run on, picked along with its folder. */
  const [machineDrafts, setMachineDrafts] = createSignal<Record<string, string>>(loadRecord(MACHINES_KEY))
  /** The runner this browser last picked for a chat, which new ones default to while it's online. */
  const [lastMachine, setLastMachine] = createSignal(localStorage.getItem(LAST_MACHINE_KEY) ?? undefined)
  createEffect(() => lastMachine() && localStorage.setItem(LAST_MACHINE_KEY, lastMachine()!))
  /** Blank chats that should start with "In a worktree" ticked, e.g. a card whose work is already in one. */
  const [worktreeDrafts, setWorktreeDrafts] = createSignal<Record<string, boolean>>(loadRecord(WORKTREES_KEY))
  /** Each card's blank chat, kept like the home chat until its first message so leaving it doesn't lose what's typed there. */
  const [blanks, setBlanks] = createSignal<Record<number, string>>(loadRecord(BLANKS_KEY))
  // Home is a blank chat; it gets a real URL once its first message is sent.
  // Its id is kept until then so a draft typed there survives reloads.
  const [homeId, setHomeId] = createSignal(localStorage.getItem(HOME_KEY) ?? uuid())
  createEffect(() => localStorage.setItem(HOME_KEY, homeId()))
  // Only blank chats' runner, folder and worktree picks are kept; once a chat starts, the server has them.
  createEffect(() => {
    const blank = new Set([homeId(), ...Object.values(blanks())])
    const keep = <T,>(all: Record<string, T>) => Object.fromEntries(Object.entries(all).filter(([id]) => blank.has(id)))
    localStorage.setItem(BLANKS_KEY, JSON.stringify(blanks()))
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(keep(drafts())))
    localStorage.setItem(MACHINES_KEY, JSON.stringify(keep(machineDrafts())))
    localStorage.setItem(WORKTREES_KEY, JSON.stringify(keep(worktreeDrafts())))
  })

  const [loaded, setLoaded] = createSignal(false)
  const refresh = () => {
    api.sessions().then((list) => {
      setSessions(list)
      setLoaded(true)
    })
  }
  const [cardsLoaded, setCardsLoaded] = createSignal(false)
  const refreshCards = () => {
    api.cards().then((list) => {
      setCards(list)
      setCardsLoaded(true)
    })
  }
  /** Config first, since the folder defaults need it, then the lists, which may have changed while the server was away. */
  const load = () =>
    (config() ? Promise.resolve() : api.config().then((c) => (setScratch(c.scratchCwd), setConfig(c))))
      .then(() => {
        refresh()
        refreshCards()
      })
      // The next reconnect tries again.
      .catch(() => {})

  onMount(() => {
    // Every connect loads, the first included, so a server that was down when the page opened is picked up once it's back.
    const offConn = socket.onConnection((c) => c && load())
    socket.connect()
    // Refresh the list when sessions appear, finish a turn, or change state.
    let timer: ReturnType<typeof setTimeout>
    const off = socket.on((e) => {
      if (e.type === 'cards_changed') refreshCards()
      if (e.type === 'sessions_changed' || e.type === 'status') {
        clearTimeout(timer)
        timer = setTimeout(refresh, 300)
      }
    })
    const onPop = () => {
      setRoute(routeFromPath())
      setDrawer(false)
    }
    addEventListener('popstate', onPop)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !modalOpen() && setDrawer(false)
    addEventListener('keydown', onKey)
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
      removeEventListener('keydown', onKey)
    })
  })

  const [settings, setSettings] = createSignal(false)
  const onSettingsKey = (e: KeyboardEvent) => {
    if (e.key !== ',' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
    e.preventDefault()
    setSettings(true)
  }
  addEventListener('keydown', onSettingsKey)
  onCleanup(() => removeEventListener('keydown', onSettingsKey))

  /** On narrow screens the sidebar is a drawer over the page; going anywhere closes it. */
  const [drawer, setDrawer] = createSignal(false)
  /** The sidebar's width on wide screens, dragged from its edge. Narrow screens use a fixed drawer. */
  const [sidebarWidth, setSidebarWidth] = createSignal(Number(localStorage.getItem(SIDEBAR_KEY)) || SIDEBAR_DEFAULT)
  createEffect(() => localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth())))
  const startSidebarDrag = (e: PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const start = e.clientX - sidebarWidth()
    document.body.style.cursor = 'col-resize'
    const move = (m: PointerEvent) => setSidebarWidth(Math.round(Math.max(200, Math.min(480, m.clientX - start))))
    const up = () => {
      document.body.style.cursor = ''
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }
  const go = (r: Route) => {
    history.pushState(null, '', pathFor(r))
    setRoute(r)
    setDrawer(false)
  }
  const current = () => {
    const r = route()
    return r.kind === 'chat' ? r.id : r.kind === 'home' ? homeId() : null
  }
  /**
   * The project this tab is working in, null for all of them, or 'none' for chats on no card, for filing them.
   * Per tab, so two tabs can be on two projects. It scopes the sidebar, the Board button and new chats.
   */
  const stored = sessionStorage.getItem(FOCUS_KEY)
  const [focusId, setFocusId] = createSignal<number | 'none' | null>(stored === 'none' ? 'none' : Number(stored) || null)
  createEffect(() => {
    const id = focusId()
    if (id === null) sessionStorage.removeItem(FOCUS_KEY)
    else sessionStorage.setItem(FOCUS_KEY, String(id))
  })
  /** Projects are the top-level cards. */
  const allProjects = createMemo(() => cards().filter((c) => (c.parentId ?? null) === null))
  // Undefined while cards load, or if the project was deleted or moved, in which case the tab shows everything.
  const focus = createMemo(() => allProjects().find((c) => c.id === focusId()))
  const unfiled = () => focusId() === 'none'
  const projectOfChat = (id: string) => {
    const card = cardOf().get(id)
    return card && projectOf(cards(), card.id)
  }
  // Focus follows where you go: a project's board focuses it, the projects board shows them all,
  // and opening something in another project moves there. Chats on no card leave it alone, and so does
  // filing the open chat, so only going somewhere moves it. Filing stays put until you open a project.
  createEffect(
    on([route, cardsLoaded], ([r]) => {
      const card = r.kind === 'card' ? cards().find((c) => c.id === r.id) : r.kind === 'chat' ? cardOf().get(r.id) : undefined
      if (card && (card.parentId ?? null) === null && r.kind === 'card') return setFocusId(card.id)
      if (focusId() === 'none') return
      if (r.kind === 'board') return setFocusId(null)
      const project = card && projectOf(cards(), card.id)
      if (project && focusId() !== null && project.id !== focusId()) setFocusId(project.id)
    }),
  )
  const unfiledCount = createMemo(() => sessions().filter((s) => !s.archived && !cardOf().has(s.id)).length)
  const inFocus = (s: SessionSummary) => {
    if (s.id === current()) return true
    if (unfiled()) return !cardOf().has(s.id)
    const f = focus()
    return !f || projectOfChat(s.id)?.id === f.id
  }
  const currentCard = () => {
    const r = route()
    return r.kind === 'card' ? cards().find((c) => c.id === r.id) : undefined
  }
  const currentTerminal = () => {
    const r = route()
    return r.kind === 'terminal' ? r.id : null
  }
  // Grouped by workspace (the hub's own first), oldest first within each, so a workspace's terminals sit together.
  const sortedTerminals = createMemo(() =>
    [...terminals()].sort((a, b) => wsKey(terminalWs(a)).localeCompare(wsKey(terminalWs(b))) || a.createdAt - b.createdAt),
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

  const active = createMemo(() => sessions().filter((s) => !s.archived && inFocus(s)))
  const archived = createMemo(() => sessions().filter((s) => s.archived && inFocus(s)))
  const [showArchived, setShowArchived] = createSignal(false)
  /**
   * What the sidebar's search box has in it. Searching looks through every chat, archived ones and other projects'
   * too, since a chat you can't find is usually one that isn't in front of you: every word has to be in its title,
   * folder, card or project. Archived ones come after the rest.
   */
  const [query, setQuery] = createSignal('')
  const found = createMemo(() => {
    const words = query().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return
    const matches = sessions().filter((s) => {
      const card = cardOf().get(s.id)
      const text = [s.title, s.cwd && folderLabel(s.cwd), card && `#${card.id} ${card.title}`, projectOfChat(s.id)?.title].join(' ').toLowerCase()
      return words.every((w) => text.includes(w))
    })
    return [...matches.filter((s) => !s.archived), ...matches.filter((s) => s.archived)]
  })
  const toggleArchived = (s: SessionSummary) => {
    // Move it straight away; the server's sessions_changed confirms it.
    setSessions((all) => all.map((x) => (x.id === s.id ? { ...x, archived: !s.archived } : x)))
    ;(s.archived ? api.unarchive(s.id) : api.archive(s.id)).catch(refresh)
  }

  /** The chat whose project picker or rename box is open, so its row keeps its buttons showing. */
  const [filing, setFiling] = createSignal<string>()
  const keepOpen = (id: string) => (open: boolean) => setFiling(open ? id : (current) => (current === id ? undefined : current))
  const renamed = (id: string, title: string) => setSessions((all) => all.map((x) => (x.id === id ? { ...x, title } : x)))

  const SessionRow = (props: { session: SessionSummary }) => {
    const s = () => props.session
    return (
      <div class="group relative mb-px">
        <button
          onClick={() => go({ kind: 'chat', id: s().id })}
          class={`block w-full rounded-lg px-2 py-1.5 text-left transition-colors pointer-coarse:py-2.5 ${
            s().id === current() ? 'bg-surface' : 'hover:bg-surface/60'
          }`}
        >
          <ChatSummary
            session={s()}
            card={cardOf().get(s().id)}
            titleClass={
              s().id === current() || attention()[s().id]
                ? 'text-fg'
                : s().archived
                  ? 'text-fg-3 group-hover:text-fg'
                  : 'text-fg-2 group-hover:text-fg'
            }
            // The buttons sit over the end of this line, so while they show it stops short of them rather than running under.
            timeClass={`group-hover:hidden ${filing() === s().id ? 'hidden' : ''} ${s().id === current() ? 'pointer-coarse:hidden' : ''}`}
            metaClass={`group-hover:pr-17 ${filing() === s().id ? 'pr-17 pointer-coarse:pr-20' : s().id === current() ? 'pointer-coarse:pr-20' : ''}`}
          />
        </button>
        {/* Touch has no hover, so there the open chat's row shows them instead. */}
        <div
          class={`absolute right-1.5 bottom-1 gap-0.5 group-hover:flex ${s().id === current() ? 'pointer-coarse:flex' : ''} ${
            filing() === s().id ? 'flex' : 'hidden'
          }`}
        >
          <FileChat
            session={s()}
            cards={cards()}
            title={cardOf().has(s().id) ? 'Move to another project or card' : 'Put in a project'}
            onOpenChange={keepOpen(s().id)}
            triggerClass={(open) =>
              `grid size-5 place-items-center rounded transition-colors hover:bg-surface hover:text-fg pointer-coarse:size-6 ${open ? 'bg-surface text-fg' : 'text-fg-3'}`
            }
            trigger={() => <FolderInput class="size-3.5" />}
          />
          <RenameChat
            session={s()}
            onSaved={(title) => renamed(s().id, title)}
            title="Rename"
            onOpenChange={keepOpen(s().id)}
            triggerClass={(open) =>
              `grid size-5 place-items-center rounded transition-colors hover:bg-surface hover:text-fg pointer-coarse:size-6 ${open ? 'bg-surface text-fg' : 'text-fg-3'}`
            }
            trigger={() => <Pencil class="size-3.5" />}
          />
          <button
            onClick={() => toggleArchived(s())}
            title={s().archived ? 'Unarchive' : 'Archive'}
            class="grid size-5 place-items-center rounded text-fg-3 transition-colors hover:bg-surface hover:text-fg pointer-coarse:size-6"
          >
            <Show when={s().archived} fallback={<Archive class="size-3.5" />}>
              <ArchiveRestore class="size-3.5" />
            </Show>
          </button>
        </div>
      </div>
    )
  }
  const cardOf = createMemo(() => new Map(cards().flatMap((c) => c.sessionIds.map((id) => [id, c] as const))))

  /** The most recent chat a new one could start where it ran: temp dirs and ones that are gone (removed worktrees) don't count. */
  const latestChat = (machine?: string) =>
    sessions()
      .filter((s) => s.cwd && !s.gone && (isScratch(s.cwd) || !TEMP.test(s.cwd)) && (!machine || (s.machine || LOCAL) === machine))
      .reduce<SessionSummary | undefined>((a, s) => (!a || s.lastModified > a.lastModified ? s : a), undefined)
  /** New chats run on the runner this browser last picked while it's online, else where the most recently active chat ran if that's online. */
  const defaultMachine = createMemo(() => {
    const online = (m?: string) => !!m && !!machineOf(m)?.online
    const picked = lastMachine()
    const latest = latestChat()?.machine
    return online(picked) ? picked! : online(latest) ? latest! : LOCAL
  })
  /** And start where that runner's most recently active chat ran, or with no folder there. */
  const defaultCwd = createMemo(() => {
    const m = defaultMachine()
    return latestChat(m)?.cwd ?? scratchDir(m) ?? (m === LOCAL ? config()?.defaultCwd : machineOf(m)?.workspaceDir)
  })
  // Pin them per blank chat so activity elsewhere doesn't move the folder while you type.
  createEffect(() => {
    const id = homeId()
    // Not until the runners are known, so the one last picked isn't passed over for seeming offline; and a runner
    // that's only just connected may not have said where its folders are yet.
    if (!loaded() || !machines().length || untrack(drafts)[id]) return
    const cwd = defaultCwd()
    if (!cwd) return
    setDrafts((d) => ({ ...d, [id]: cwd }))
    setMachineDrafts((d) => ({ ...d, [id]: untrack(defaultMachine) }))
  })
  /** Where a blank chat will run. A folder picked without a runner was picked before there were any but the hub's. */
  const draftMachine = (id: string) => machineDrafts()[id] ?? (drafts()[id] ? LOCAL : defaultMachine())
  const pickDraft = (id: string, cwd: string | undefined, machine: string) => {
    if (cwd) setDrafts((d) => ({ ...d, [id]: cwd }))
    setMachineDrafts((d) => ({ ...d, [id]: machine }))
  }

  /** A card's new chat is its blank one if it has one, so a draft left there is still there. */
  const newChat = (from: { cwd: string; machine: string; worktree: boolean } | undefined, cardId?: number) => {
    const kept = cardId === undefined ? undefined : untrack(blanks)[cardId]
    if (kept) return go({ kind: 'chat', id: kept })
    const id = uuid()
    untrack(() => pickDraft(id, from?.cwd ?? defaultCwd(), from?.machine ?? defaultMachine()))
    if (from?.worktree) setWorktreeDrafts((w) => ({ ...w, [id]: true }))
    if (cardId !== undefined) {
      setBlanks((b) => ({ ...b, [cardId]: id }))
      api.linkSession(cardId, id)
    }
    go({ kind: 'chat', id })
  }
  // Blank chats that have started, here or in another tab, make way for fresh ones.
  createEffect(() => {
    const started = new Set(sessions().map((s) => s.id))
    if (started.has(untrack(homeId))) setHomeId(uuid())
    const left = Object.entries(untrack(blanks)).filter(([, id]) => !started.has(id))
    if (left.length < Object.keys(untrack(blanks)).length) setBlanks(Object.fromEntries(left))
  })

  /** In a project, a new chat goes on the project's card and starts where its work last happened; otherwise it's the blank home chat. */
  const newHomeChat = () => {
    const f = focus()
    if (!f) return go({ kind: 'home' })
    const ids = [f, ...descendants(cards(), f.id)].flatMap((c) => c.sessionIds)
    const from = lastWorkedIn(sessions().filter((s) => ids.includes(s.id)))
    newChat(from && { ...from, worktree: false }, f.id)
  }
  /** For the switcher: how far along a project is. */
  const projectSummary = (p: Card) => {
    const inside = cards().filter((c) => c.parentId === p.id)
    return inside.length ? `${inside.filter((c) => c.status === 'done').length}/${inside.length} cards done` : 'No cards yet'
  }
  const switchable = createMemo(() => [null, 'none' as const, ...allProjects().filter((c) => c.status !== 'done' || c.id === focusId())])
  /** The home chat's first message went out: give it its own URL and a fresh blank chat for next time. */
  const startHomeChat = (id: string, cwd: string | undefined, machine: string) => {
    pickDraft(id, cwd, machine)
    history.replaceState(null, '', pathFor({ kind: 'chat', id }))
    setRoute({ kind: 'chat', id })
    setHomeId(uuid())
  }

  /** For the top bar on narrow screens, which has no sidebar beside it to say where you are. */
  const pageTitle = () => {
    const r = route()
    if (r.kind === 'chat') return sessions().find((s) => s.id === r.id)?.title ?? 'New chat'
    if (r.kind === 'card') return currentCard()?.title ?? ''
    if (r.kind === 'terminal') {
      const t = terminals().find((t) => t.id === r.id)
      return t ? terminalLabel(t) : 'Terminal'
    }
    return r.kind === 'board' ? 'Projects' : r.kind === 'radar' ? 'Radar' : 'New chat'
  }
  // The page first, since tabs cut titles short, and a dot on the icon for when the count is cut off too.
  createEffect(() => {
    const page = route().kind === 'home' ? '' : pageTitle()
    document.title = `${needsYou() ? `(${needsYou()}) ` : ''}${page ? `${page} · ` : ''}Badger`
  })
  createEffect(() => {
    document.querySelector<HTMLLinkElement>('link[rel=icon]')!.href = needsYou() ? '/favicon-alert.svg' : '/favicon.svg'
  })

  /** Any page but a chat. */
  const page = () => (
    <Switch>
      <Match when={currentTerminal()} keyed>
        {(id) => (
          <Show when={terminalsLoaded()} fallback={<Loading />}>
            <TerminalPage id={id} onClosed={newHomeChat} />
          </Show>
        )}
      </Match>
      <Match when={!(cardsLoaded() && loaded())}>
        <Loading />
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
  )

  return (
    <div class="relative flex h-full gap-(--pane-gutter) bg-canvas p-(--pane-margin)" style={{ '--sidebar-w': `${sidebarWidth()}px` }}>
      <Show when={drawer()}>
        <div onClick={() => setDrawer(false)} class="fixed inset-0 z-20 animate-[fade-in_150ms_ease-out] bg-black/40 md:hidden" />
      </Show>
      <aside
        class={`fixed inset-y-0 left-0 z-30 flex w-72 max-w-[85vw] shrink-0 flex-col pane max-md:rounded-none transition-[translate,visibility] duration-200 ease-out md:relative md:z-10 md:w-(--sidebar-w) md:translate-x-0 md:visible md:transition-none ${
          drawer() ? 'translate-x-0 max-md:shadow-[0_0_48px_rgb(0_0_0/0.3)]' : 'invisible -translate-x-full'
        }`}
      >
        <div class="flex h-12 shrink-0 items-center gap-2 px-4">
          <img src="/favicon.svg" alt="" class="size-5" />
          <span class="font-medium tracking-tight">Badger</span>
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
            class="ml-auto grid size-7 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface hover:text-fg disabled:opacity-40 pointer-coarse:size-10"
          >
            <Show when={notifications() === 'on'} fallback={<BellOff class="size-4" />}>
              <Bell class="size-4" />
            </Show>
          </button>
          <button
            onClick={() => setSettings(true)}
            title="Settings"
            class="grid size-7 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface hover:text-fg pointer-coarse:size-10"
          >
            <SettingsIcon class="size-4" />
          </button>
        </div>
        <div class="px-2 pb-3">
          <Menu
            items={switchable().map((c) =>
              c === 'none'
                ? {
                    label: 'No project',
                    description: unfiledCount() ? `${unfiledCount()} chat${unfiledCount() === 1 ? '' : 's'} to put in a project` : 'Every chat is in a project',
                    selected: unfiled(),
                  }
                : c
                  ? { label: c.title, description: projectSummary(c), selected: c.id === focus()?.id }
                  : { label: 'All projects', description: 'Everything', selected: !focus() && !unfiled() },
            )}
            onPick={(i) => {
              const c = switchable()[i]
              // There's no page for chats on no card; the sidebar is the list.
              if (c === 'none') return setFocusId('none')
              go(c ? { kind: 'card', id: c.id } : { kind: 'board' })
            }}
            placement="bottom"
            class="w-60"
            title="Which project this tab is working in"
            triggerClass={(open) =>
              `mb-1 flex h-8 w-full items-center gap-2 rounded-lg border pointer-coarse:h-10 border-line px-2 text-[13px] transition-colors hover:border-edge ${open ? 'border-edge' : ''}`
            }
            trigger={(open) => (
              <>
                <span class={`min-w-0 flex-1 truncate text-left ${focus() || unfiled() ? 'text-fg' : 'text-fg-2'}`}>
                  {unfiled() ? 'No project' : (focus()?.title ?? 'All projects')}
                </span>
                <Show when={unfiled() && unfiledCount()}>
                  <span class="text-[11px] text-fg-3 tabular-nums">{unfiledCount()}</span>
                </Show>
                <ChevronDown class={`size-3.5 text-fg-3 transition-transform ${open() ? 'rotate-180' : ''}`} />
              </>
            )}
          />
          <button
            onClick={() => go({ kind: 'radar' })}
            title="Everything on your radar, across projects"
            class={`mb-px flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] transition-colors hover:bg-surface hover:text-fg pointer-coarse:h-10 ${
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
            class={`mb-px flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] transition-colors hover:bg-surface hover:text-fg pointer-coarse:h-10 ${
              route().kind === 'board' || route().kind === 'card' ? 'bg-surface text-fg' : 'text-fg-2'
            }`}
          >
            <Columns3 class="size-4" /> {focus() ? 'Board' : 'Projects'}
          </button>
          <button
            onClick={newHomeChat}
            title={focus() ? `A chat on ${focus()!.title}` : undefined}
            class={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] transition-colors hover:bg-surface hover:text-fg pointer-coarse:h-10 ${
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
                <div class="group relative mb-px">
                  <button
                    onClick={() => go({ kind: 'terminal', id: t.id })}
                    title={`${terminalTooltip(t)}\n${t.cwd}`}
                    class={`flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors pointer-coarse:h-9 ${
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
                    <span
                      class={`flex shrink-0 items-center gap-2 group-hover:invisible ${t.id === currentTerminal() ? 'pointer-coarse:invisible' : ''}`}
                    >
                      <span class="text-[11px] text-fg-3">{basename(t.root)}</span>
                      <Show when={onMachine(t.machine)}>{(name) => <MachineName machine={t.machine} name={name()} class="text-[11px] text-fg-3" />}</Show>
                    </span>
                  </button>
                  {/* Touch has no hover, so there the open terminal's row shows it instead. */}
                  <button
                    onClick={() => api.closeTerminal(t.id).then(() => t.id === currentTerminal() && newHomeChat())}
                    title="Delete terminal: stops it and everything it started"
                    class={`absolute top-1/2 right-1.5 hidden size-5 -translate-y-1/2 place-items-center rounded text-fg-3 transition-colors group-hover:grid hover:bg-surface hover:text-fg pointer-coarse:size-6 ${
                      t.id === currentTerminal() ? 'pointer-coarse:grid' : ''
                    }`}
                  >
                    <Trash2 class="size-3.5" />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <div class="relative mx-2">
          <Search class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
          <input
            type="search"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              setQuery('')
              e.currentTarget.blur()
            }}
            placeholder="Search chats"
            aria-label="Search chats"
            class={`${inputClass} border-line pr-7 pl-8 hover:border-edge focus:border-edge pointer-coarse:h-10 [&::-webkit-search-cancel-button]:hidden`}
          />
          <Show when={query()}>
            <button
              onClick={() => setQuery('')}
              title="Clear"
              class="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded text-fg-3 transition-colors hover:bg-surface hover:text-fg pointer-coarse:size-7"
            >
              <X class="size-3.5" />
            </button>
          </Show>
        </div>
        <nav class="flex-1 overflow-y-auto px-2 py-2">
          <Show
            when={found()}
            fallback={
              <>
                <For each={active()}>{(s) => <SessionRow session={s} />}</For>
                <Show when={unfiled() && loaded() && cardsLoaded() && !active().length}>
                  <p class="px-2 py-1.5 text-[13px] text-fg-3">Every chat is in a project.</p>
                </Show>
                <Show when={archived().length}>
                  <button
                    onClick={() => setShowArchived((v) => !v)}
                    class="mt-2 flex h-7 w-full items-center gap-1 rounded-lg px-2 text-[11px] text-fg-3 transition-colors hover:text-fg-2"
                  >
                    <ChevronRight class={`size-3 transition-transform ${showArchived() ? 'rotate-90' : ''}`} />
                    Archived ({archived().length})
                  </button>
                  <For each={showArchived() ? archived() : archived().filter((s) => s.id === current())}>
                    {(s) => <SessionRow session={s} />}
                  </For>
                </Show>
              </>
            }
          >
            {(found) => (
              <>
                <For each={found()}>{(s) => <SessionRow session={s} />}</For>
                <Show when={!found().length}>
                  <p class="px-2 py-1.5 text-[13px] text-fg-3">No chats match.</p>
                </Show>
              </>
            )}
          </Show>
        </nav>
        <Show when={accountUsage()}>{(u) => <AccountLimits usage={u()} />}</Show>
      </aside>
      {/* The gutter beside the sidebar, grown a little each way so a thin one is easy to catch. */}
      <div
        onPointerDown={startSidebarDrag}
        onDblClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
        title="Drag to resize; double-click to reset"
        class="absolute inset-y-0 left-[calc(var(--pane-margin)+var(--sidebar-w))] z-10 hidden w-(--pane-gutter) cursor-col-resize rounded-full transition-colors delay-150 after:absolute after:inset-y-0 after:-inset-x-1 after:content-[''] hover:bg-edge md:block"
      />

      <div class="flex min-w-0 flex-1 flex-col gap-(--pane-gutter)">
        <header class="pane flex h-12 shrink-0 items-center gap-1 px-1.5 md:hidden">
          <button
            onClick={() => setDrawer(true)}
            title="Chats and projects"
            class="relative grid size-10 place-items-center rounded-lg text-fg-2 transition-colors hover:bg-surface hover:text-fg"
          >
            <PanelLeft class="size-5" />
            <Show when={needsYou()}>
              <span class="absolute top-2 right-2 size-2 rounded-full bg-accent ring-2 ring-bg" />
            </Show>
          </button>
          <span class="min-w-0 flex-1 truncate text-[13px] font-medium">{pageTitle()}</span>
          <button
            onClick={newHomeChat}
            title={focus() ? `New chat on ${focus()!.title}` : 'New chat'}
            class="grid size-10 place-items-center rounded-lg text-fg-2 transition-colors hover:bg-surface hover:text-fg"
          >
            <Plus class="size-5" />
          </button>
        </header>
        <div class="flex min-h-0 flex-1">
          {/* A chat lays out its own panes, with its panels; every other page is one pane. */}
          <Show when={current()} keyed fallback={<div class="pane flex min-w-0 flex-1">{page()}</div>}>
            {(id) => {
              // Same component before and after the first send, so starting a chat doesn't remount it.
              const home = () => route().kind === 'home'
              return (
                <Chat
                  sessionId={id}
                  draftCwd={drafts()[id] ?? defaultCwd()}
                  draftMachine={sessions().find((s) => s.id === id)?.machine ?? draftMachine(id)}
                  worktree={worktreeDrafts()[id]}
                  onPickCwd={(cwd, machine) => {
                    pickDraft(id, cwd, machine)
                    setLastMachine(machine)
                  }}
                  onPickWorktree={(on) => setWorktreeDrafts((w) => ({ ...w, [id]: on }))}
                  card={cardOf().get(id)}
                  session={sessions().find((s) => s.id === id)}
                  cards={cards()}
                  onRenamed={(title) => renamed(id, title)}
                  onToggleArchived={() => {
                    const s = sessions().find((s) => s.id === id)
                    if (s) toggleArchived(s)
                  }}
                  onStart={() => home() && startHomeChat(id, drafts()[id] ?? defaultCwd(), draftMachine(id))}
                  onOpenTerminal={(tid) => go({ kind: 'terminal', id: tid })}
                />
              )
            }}
          </Show>
        </div>
      </div>
      <Show when={settings()}>
        <Settings onClose={() => setSettings(false)} />
      </Show>
      <ImageViewer />
    </div>
  )
}
const HOME_KEY = 'badger.homeId'
const BLANKS_KEY = 'badger.blankChats'
const DRAFTS_KEY = 'badger.draftCwds'
const MACHINES_KEY = 'badger.draftMachines'
const LAST_MACHINE_KEY = 'badger.lastMachine'
const WORKTREES_KEY = 'badger.draftWorktrees'
const FOCUS_KEY = 'badger.focus'
const SIDEBAR_KEY = 'badger.sidebarWidth'
const SIDEBAR_DEFAULT = 256

/** A JSON record from localStorage, or an empty one. */
function loadRecord<T>(key: string): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}')
  } catch {
    return {} as T
  }
}

const TEMP = /^\/(private\/)?(tmp|var\/folders)\//
