import { Match, Show, Switch, createEffect, createSignal, onCleanup, onMount, on } from 'solid-js'
import { PanelLeft, Plus } from './icons'
import { descendants } from '../shared/cardTree.ts'
import { socket } from './api.ts'
import { attention, looking, needsYou, notify, onAttention } from './attention.ts'
import { draftFor, homeId, newBlank, pick, pickWorktree, promoteHome } from './drafts.ts'
import { lastWorkedIn } from './folders.ts'
import { focus } from './focus.ts'
import { navigate, replace, route } from './router.tsx'
import { cardById, cards, cardsLoaded } from './stores/cards.ts'
import { sessionById, sessions, sessionsLoaded } from './stores/sessions.ts'
import { terminalLabel, terminals, terminalsLoaded } from './terminals.ts'
import { SIDEBAR_DEFAULT, dragSidebar, setSidebarLit, setSidebarWidth, sidebarLit, sidebarWidth } from './sidebar.ts'
import { useDocumentTitle } from './title.ts'
import { Board } from './components/Board.tsx'
import { CardView } from './components/CardView.tsx'
import { Radar } from './components/Radar.tsx'
import { Chat } from './components/Chat.tsx'
import { TerminalPage } from './components/Terminals.tsx'
import { Settings } from './components/Settings.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { ImageViewer } from './components/ImageViewer.tsx'
import { Loading, modalOpen } from './components/ui.tsx'

export function App() {
  onMount(() => {
    // The stores load on every connect, the first included.
    socket.connect()
    const offAttention = onAttention((id, state) => {
      const title = sessionById(id)?.title ?? 'New chat'
      notify(id, title, state === 'waiting' ? 'Needs your input' : 'Finished', () => navigate({ kind: 'chat', id }))
    })
    onCleanup(offAttention)
  })

  const [settings, setSettings] = createSignal(false)
  /** On narrow screens the sidebar is a drawer over the page; going anywhere closes it, back and forward included. */
  const [drawer, setDrawer] = createSignal(false)
  createEffect(on(route, () => setDrawer(false), { defer: true }))

  // The page's own keys: Escape puts the drawer away, and Ctrl or Cmd + comma opens Settings.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !modalOpen()) setDrawer(false)
    if (e.key === ',' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      setSettings(true)
    }
  }
  addEventListener('keydown', onKey)
  onCleanup(() => removeEventListener('keydown', onKey))

  const startSidebarDrag = (e: PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    document.body.style.cursor = 'col-resize'
    setSidebarLit(true)
    const move = dragSidebar(e)
    const up = () => {
      document.body.style.cursor = ''
      setSidebarLit(false)
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  /** The chat on screen: the one routed to, or home's blank one. */
  const current = () => {
    const r = route()
    return r.kind === 'chat' ? r.id : r.kind === 'home' ? homeId() : null
  }
  const currentCard = () => {
    const r = route()
    return r.kind === 'card' ? cardById(r.id) : undefined
  }
  const currentTerminal = () => {
    const r = route()
    return r.kind === 'terminal' ? r.id : null
  }
  // Looking at a chat reads it, including a turn that ends while you watch.
  createEffect(() => {
    const id = current()
    if (id && looking() && attention()[id] === 'unread') socket.send({ type: 'seen', sessionId: id })
  })

  const newChat = (from: { cwd: string; machine: string; worktree: boolean } | undefined, cardId?: number) =>
    navigate({ kind: 'chat', id: newBlank(from, cardId) })
  /** In a project, a new chat goes on the project's card and starts where its work last happened; otherwise it's the blank home chat. */
  const newHomeChat = () => {
    const f = focus()
    if (!f) return navigate({ kind: 'home' })
    const ids = [f, ...descendants(cards(), f.id)].flatMap((c) => c.sessionIds)
    const from = lastWorkedIn(sessions().filter((s) => ids.includes(s.id)))
    newChat(from && { ...from, worktree: false }, f.id)
  }

  /** For the top bar on narrow screens, which has no sidebar beside it to say where you are. */
  const pageTitle = () => {
    const r = route()
    if (r.kind === 'chat') return sessionById(r.id)?.title ?? 'New chat'
    if (r.kind === 'card') return currentCard()?.title ?? ''
    if (r.kind === 'terminal') {
      const t = terminals().find((t) => t.id === r.id)
      return t ? terminalLabel(t) : 'Terminal'
    }
    return r.kind === 'board' ? 'Projects' : r.kind === 'radar' ? 'Radar' : 'New chat'
  }
  useDocumentTitle(() => (route().kind === 'home' ? '' : pageTitle()))

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
      <Match when={!(cardsLoaded() && sessionsLoaded())}>
        <Loading />
      </Match>
      <Match when={route().kind === 'radar'}>
        <Radar onOpenCard={(id) => navigate({ kind: 'card', id })} onOpenChat={(id) => navigate({ kind: 'chat', id })} />
      </Match>
      <Match when={route().kind === 'board'}>
        <Board onOpen={(id) => navigate({ kind: 'card', id })} />
      </Match>
      <Match when={route().kind === 'card'}>
        <Show when={currentCard()} fallback={<p class="flex flex-1 items-center justify-center text-ui text-fg-3">No such card</p>}>
          {(card) => (
            <CardView
              card={card()}
              onOpenCard={(id) => navigate(id === null ? { kind: 'board' } : { kind: 'card', id })}
              onOpenChat={(id) => navigate({ kind: 'chat', id })}
              onNewChat={(from) => newChat(from, card().id)}
            />
          )}
        </Show>
      </Match>
    </Switch>
  )

  /** The top bar on narrow screens. A chat puts it at the top of its own header, so they read as one. */
  const mobileBar = () => (
    <div class="bar flex h-12 shrink-0 items-center gap-1 px-1.5 md:hidden">
      <button
        onClick={() => setDrawer(true)}
        title="Chats and projects"
        class="relative grid size-10 place-items-center rounded-button-lg text-fg-2 transition-colors hover:bg-surface hover:text-fg"
      >
        <PanelLeft class="size-5" />
        <Show when={needsYou()}>
          <span class="absolute top-2 right-2 size-2 rounded-full bg-accent ring-2 ring-bg" />
        </Show>
      </button>
      <span class="min-w-0 flex-1 truncate text-ui font-medium">{pageTitle()}</span>
      <button
        onClick={newHomeChat}
        title={focus() ? `New chat on ${focus()!.title}` : 'New chat'}
        class="grid size-10 place-items-center rounded-button-lg text-fg-2 transition-colors hover:bg-surface hover:text-fg"
      >
        <Plus class="size-5" />
      </button>
    </div>
  )

  return (
    <div class="relative flex h-full gap-(--pane-gutter) bg-canvas p-(--pane-margin)" style={{ '--sidebar-w': `${sidebarWidth()}px` }}>
      <Show when={drawer()}>
        <div onClick={() => setDrawer(false)} class="fixed inset-0 z-20 animate-[fade-in_150ms_ease-out] bg-black/40 md:hidden" />
      </Show>
      <aside
        data-pane="sidebar"
        class={`fixed inset-y-0 left-0 z-30 flex w-72 max-w-[85vw] shrink-0 flex-col pane sidebar max-md:rounded-none transition-[translate,visibility] duration-200 ease-out md:relative md:z-10 md:w-(--sidebar-w) md:translate-x-0 md:visible md:transition-none ${
          drawer() ? 'translate-x-0 max-md:shadow-(--shadow-modal)' : 'invisible -translate-x-full'
        }`}
      >
        <Sidebar current={current()} onSettings={() => setSettings(true)} onNewChat={newHomeChat} />
      </aside>
      {/* The gutter beside the sidebar, between the panes' outlines, grown a little each way so a thin one is easy to catch. */}
      <div
        onPointerDown={startSidebarDrag}
        onDblClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
        title="Drag to resize; double-click to reset"
        data-lit={sidebarLit() || undefined}
        class="gutter-handle absolute inset-y-(--pane-margin) left-[calc(var(--pane-margin)+var(--sidebar-w)+var(--pane-outline))] z-10 hidden w-[calc(var(--pane-gutter)-2*var(--pane-outline))] cursor-col-resize after:absolute after:inset-y-0 after:-inset-x-[calc(4px+var(--pane-outline))] after:content-[''] md:block"
      />

      <div class="flex min-w-0 flex-1 flex-col gap-(--pane-gutter)">
        <Show when={!current()}>
          <header class="pane shrink-0 md:hidden">{mobileBar()}</header>
        </Show>
        <div class="flex min-h-0 flex-1">
          {/* A chat lays out its own panes, with its panels; every other page is one pane. */}
          <Show when={current()} keyed fallback={<div class="pane flex min-w-0 flex-1" data-pane="page">{page()}</div>}>
            {(id) => {
              // Same component before and after the first send, so starting a chat doesn't remount it.
              const home = () => route().kind === 'home'
              return (
                <Chat
                  sessionId={id}
                  draftCwd={draftFor(id).cwd}
                  draftMachine={sessionById(id)?.machine ?? draftFor(id).machine}
                  worktree={draftFor(id).worktree}
                  onPickCwd={(cwd, machine) => pick(id, cwd, machine)}
                  onPickWorktree={(on) => pickWorktree(id, on)}
                  onStart={() => {
                    if (!home()) return
                    // Its own URL first, so the chat isn't remounted when home moves on to a fresh one.
                    replace({ kind: 'chat', id })
                    promoteHome(id)
                  }}
                  bar={mobileBar()}
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
