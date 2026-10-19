import { For, Index, Match, Show, Switch, children, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack, type JSX } from 'solid-js'
import { Globe, Minimize2, NotebookPen, Plus, RotateCw, SquareArrowOutUpRight, X } from '../icons'
import { api } from '../api.ts'
import {
  CHAT,
  LEADER,
  activeOf,
  dropOtherChats,
  focusRequest,
  groupOf,
  groupsOf,
  isLeader,
  layoutOf,
  measure,
  moveView,
  narrowTree,
  openPreview,
  openTerminal,
  panelsShown,
  placeTerminals,
  movePreview,
  reloadPreview,
  removeView,
  sessionOf,
  setActive,
  setFocusRequest,
  setSizes,
  togglePanels,
  updateLayout,
  viewKey,
  viewsOf,
  wide,
  part,
  type Box,
  type Divider,
  type Drop,
  type Edge,
  type Group,
  type Len,
  type PreviewView,
  type View,
} from '../layout.ts'
import { LOCAL, isOnline, onMachine } from '../machines.ts'
import { dragSidebar } from '../sidebar.ts'
import { previewUrl } from '../previews.ts'
import { inWs, terminalLabel, terminalTooltip, terminals, terminalsListed, type Ws } from '../terminals.ts'
import { PreviewFrame } from './PreviewFrame.tsx'
import { PortButtons, RenameTerminal, RestartButton, StatusDot } from './Terminals.tsx'
import { TerminalView } from './TerminalView.tsx'
import { LiveDot, ghostClass, modalOpen } from './ui.tsx'

/** Height of a group's tab bar, which its views sit under. */
const BAR = 36
/** No pane is dragged smaller than this. */
const MIN = 120

/** A length as CSS: its share of the container and its gutters, plus some pixels. */
const css = (l: Len, px = 0) => `calc(${l.f * 100}% + ${l.g} * var(--pane-gutter) + ${px}px)`
/** The middle of a gutter that starts here. */
const mid = (l: Len): Len => ({ f: l.f, g: l.g + 0.5 })
/** Placed over a box. */
const place = (b: Box): JSX.CSSProperties => ({ left: css(b.x), top: css(b.y), width: css(b.w), height: css(b.h) })
/** Placed inside a pane over a box: under its tab bar, and clear of the --inset round its edges. */
const placeIn = (b: Box): JSX.CSSProperties => ({
  left: `calc(${css(b.x)} + var(--inset))`,
  top: `calc(${css(b.y, BAR)} + var(--inset))`,
  width: `calc(${css(b.w)} - 2 * var(--inset))`,
  height: `calc(${css(b.h, -BAR)} - 2 * var(--inset))`,
})

const taskOf = (v?: View) => (v?.kind === 'task' ? v.id : undefined)
const terminalOf = (v?: View) => (v?.kind === 'terminal' ? terminals().find((t) => t.id === v.id) : undefined)

/** What the chat says about its own tasks and plan, for the panels showing them. */
export interface ChatPanes {
  label: (toolUseId: string) => string
  live: (toolUseId: string) => boolean
  render: (toolUseId: string, onReady: (focus: () => void) => void) => JSX.Element
  /** A plan is waiting on the user. */
  planWaiting: () => boolean
  renderPlan: (onReady: (focus: () => void) => void) => JSX.Element
}

const BINDINGS: [string, string][] = [
  ['T', 'New terminal'],
  ['\\', 'Split right'],
  ['-', 'Split down'],
  ['← ↑ ↓ →', 'Move focus'],
  ['W', 'Close tab'],
  ['0', 'Back to the chat'],
  ['P', 'Show or hide panels'],
]

/**
 * A chat with its workspace's panels tiled around it. The chat is the anchor:
 * it can't be moved or closed and has no tab bar. Every view is rendered once,
 * in one flat layer, and placed over its group's rectangle, so splitting,
 * moving and resizing never remount a terminal.
 */
export function Workspace(props: {
  /** The workspace (git root on the chat's machine); panels aren't offered until it's known. */
  ws?: Ws
  cwd?: string
  /** The chat's session, whose tasks and plan can show in panels. */
  sessionId: string
  panes: ChatPanes
  onFocusChat: () => void
  onOpenPage: (terminalId: string) => void
  children: JSX.Element
}) {
  const chat = children(() => props.children)
  let container!: HTMLDivElement

  const tree = createMemo(() => {
    const ws = props.ws
    if (!ws || !panelsShown(ws)) return CHAT
    return wide() ? layoutOf(ws).tree : narrowTree(layoutOf(ws))
  })
  const measured = createMemo(() => measure(tree()))
  const rect = (id: string) => measured().rects.get(id)
  const boxOf = (id: string) => measured().boxes.get(id)
  const groupIds = createMemo(() => groupsOf(tree()).map((g) => g.id))
  const groupById = (id: string) => groupsOf(tree()).find((g) => g.id === id)
  // Every view in the workspace, shown or not, so hiding or moving one never unmounts it.
  const keys = createMemo(() =>
    props.ws ? viewsOf(layoutOf(props.ws).tree).filter((v) => (sessionOf(v) ?? props.sessionId) === props.sessionId).map(viewKey) : [],
  )

  const update = (change: Parameters<typeof updateLayout>[1]) => props.ws && updateLayout(props.ws, change)
  const viewOf = (key: string) => (props.ws ? viewsOf(layoutOf(props.ws).tree).find((v) => viewKey(v) === key) : undefined)

  // The server's terminals are the truth: closed ones leave the layout, new ones join it.
  // Not while their runner is offline, or back but not yet listed: they're missing from the list then, not closed.
  createEffect(() => {
    const ws = props.ws
    if (!ws || !isOnline(ws.machine) || !terminalsListed(ws.machine)) return
    const ids = terminals()
      .filter((t) => inWs(t, ws))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => t.id)
    untrack(() => placeTerminals(ws, ids))
  })

  // Another chat's tasks and plan don't belong beside this one.
  createEffect(() => props.ws && untrack(() => dropOtherChats(props.ws!, props.sessionId)))

  // ── Focus ──

  /** The pane keyboard focus is in: 'chat' or a group id. */
  const [current, setCurrent] = createSignal('chat')
  const focusIn = (id: string) => {
    setCurrent(id)
    if (id !== 'chat') update((l) => (l.focus === id ? l : { ...l, focus: id }))
  }
  const focusers = new Map<string, () => void>()
  let wantFocus: string | undefined
  const focusView = (key: string) => {
    wantFocus = key
    focusers.get(key)?.()
  }
  const ready = (key: string, focus: () => void) => {
    focusers.set(key, focus)
    if (wantFocus === key) focus()
  }
  createEffect(on(focusRequest, (key) => key && queueMicrotask(() => focusView(key)), { defer: true }))
  const focusLeaf = (id: string) => {
    const g = id === 'chat' ? undefined : groupById(id)
    if (g) focusView(activeOf(g))
    else props.onFocusChat()
  }

  /** The pane next to this one in a direction: the nearest that overlaps it, preferring the one sharing most of its side. */
  const neighbour = (from: string, edge: Edge) => {
    const a = rect(from)
    if (!a) return
    const across = edge === 'left' || edge === 'right'
    let best: string | undefined
    let bestScore = Infinity
    for (const [id, b] of measured().rects) {
      if (id === from) continue
      const gap =
        edge === 'right' ? b.x - (a.x + a.w) : edge === 'left' ? a.x - (b.x + b.w) : edge === 'bottom' ? b.y - (a.y + a.h) : a.y - (b.y + b.h)
      const overlap = across ? Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) : Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      if (gap < -1e-6 || overlap <= 1e-6) continue
      const score = gap * 10 - overlap
      if (score < bestScore) [best, bestScore] = [id, score]
    }
    return best
  }

  // ── Tabs ──

  const activate = (key: string) => {
    update((l) => ({ ...l, tree: setActive(l.tree, key), focus: groupOf(l.tree, key)?.id ?? l.focus }))
    focusView(key)
  }

  /** Closing a terminal's tab stops it, like the dock's did; any other only leaves the panel. The next tab along takes its place. */
  const close = (key: string) => {
    const g = groupOf(tree(), key)
    if (g && activeOf(g) === key) {
      const i = g.views.findIndex((v) => viewKey(v) === key)
      const rest = g.views.filter((v) => viewKey(v) !== key)
      const next = rest[Math.min(i, rest.length - 1)]
      if (next) {
        update((l) => ({ ...l, tree: setActive(l.tree, viewKey(next)) }))
        if (current() === g.id) focusView(viewKey(next))
      } else if (current() === g.id) props.onFocusChat()
    }
    const v = viewOf(key)
    if (v?.kind === 'terminal') void api.closeTerminal(v.id)
    else update((l) => ({ ...l, tree: removeView(l.tree, key) }))
  }

  const hide = () => {
    update((l) => ({ ...l, hidden: true }))
    props.onFocusChat()
  }

  const newTerminal = (where?: Parameters<typeof openTerminal>[2]) => props.ws && props.cwd && void openTerminal(props.ws, props.cwd, where)

  // ── Resizing ──

  /** What's being dragged, for a cover over the page that keeps the cursor and stops terminals taking the pointer. */
  const [dragging, setDragging] = createSignal<'col-resize' | 'row-resize' | 'move' | 'grabbing'>()

  /**
   * Drags gutters: one, or two where they meet. Each keeps the pair of panes either side of it the same size together.
   * With `sidebar`, the sidebar's edge comes too, from where a gutter meets it.
   */
  const startResize = (e: PointerEvent, ds: Divider[], sidebar = false) => {
    if (e.button !== 0) return
    e.preventDefault()
    const bounds = container.getBoundingClientRect()
    const gutter = parseFloat(getComputedStyle(container).getPropertyValue('--pane-gutter')) || 0
    const drags = ds.map((d) => {
      const row = d.dir === 'row'
      const span = d.room.f * (row ? bounds.width : bounds.height) + d.room.g * gutter
      const pair = d.sizes[d.index - 1] + d.sizes[d.index]
      return { d, row, span, pair, start: row ? e.clientX : e.clientY, min: Math.min(MIN / span, pair / 2) }
    })
    const followSidebar = sidebar ? dragSidebar(e) : undefined
    const cursors = new Set(drags.map((g) => g.row))
    if (sidebar) cursors.add(true)
    setDragging(cursors.size > 1 ? 'move' : cursors.has(true) ? 'col-resize' : 'row-resize')
    const move = (m: PointerEvent) => {
      followSidebar?.(m)
      update((l) =>
        drags.reduce((l, { d, row, span, pair, start, min }) => {
          const i = d.index
          const before = Math.max(min, Math.min(pair - min, d.sizes[i - 1] + ((row ? m.clientX : m.clientY) - start) / span))
          const sizes = [...d.sizes]
          sizes[i - 1] = before
          sizes[i] = pair - before
          return wide() ? { ...l, tree: setSizes(l.tree, d.path, sizes) } : { ...l, narrow: sizes[1] }
        }, l),
      )
    }
    const up = () => {
      setDragging()
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  // ── Dragging tabs ──

  const [drag, setDrag] = createSignal<{ key: string; label: string; x: number; y: number; drop?: Drop }>()
  /** The tab whose terminal is being renamed. */
  const [renaming, setRenaming] = createSignal<string>()

  /** A group's tabs as drawn, in order. */
  const tabsOf = (group: string) => [...container.querySelectorAll<HTMLElement>(`[data-tabs="${group}"] > [data-tab]`)]
  const tabMid = (t: HTMLElement) => {
    const r = t.getBoundingClientRect()
    return r.left + r.width / 2
  }

  /** Where in a tab bar a drop would go, as a line between tabs, relative to the container. */
  const tabMark = (d: Drop) => {
    if (d.index === undefined) return
    const tabs = tabsOf(d.target)
    const before = tabs[d.index]?.getBoundingClientRect()
    const after = tabs[d.index - 1]?.getBoundingClientRect()
    const r = before ?? after
    if (!r) return
    const b = container.getBoundingClientRect()
    // Halfway across the gap between tabs; at either end, just inside the first or last.
    const x = before && after ? (after.right + before.left) / 2 : before ? before.left : after!.right
    return { left: `${x - b.left - 1}px`, top: `${r.top - b.top}px`, height: `${r.height}px` }
  }

  /** Over a group's tab bar drops into it beside the nearest tabs, or over its middle, at the end; anywhere else, beside the pane on the nearest side. */
  const dropAt = (x: number, y: number): Drop | undefined => {
    const b = container.getBoundingClientRect()
    const fx = (x - b.left) / b.width
    const fy = (y - b.top) / b.height
    for (const [id, r] of measured().rects) {
      if (fx < r.x || fx > r.x + r.w || fy < r.y || fy > r.y + r.h) continue
      const px = (fx - r.x) / r.w
      const py = (fy - r.y) / r.h
      if (id !== 'chat' && y - b.top - r.y * b.height < BAR) return { target: id, zone: 'center', index: tabsOf(id).filter((t) => tabMid(t) < x).length }
      if (id !== 'chat' && px > 0.25 && px < 0.75 && py > 0.25 && py < 0.75) return { target: id, zone: 'center' }
      const sides: [Edge, number][] = [['left', px], ['right', 1 - px], ['top', py], ['bottom', 1 - py]]
      return { target: id, zone: sides.reduce((a, s) => (s[1] < a[1] ? s : a))[0] }
    }
  }

  /** Where a drop would put the tab, to outline it. */
  const dropBox = (d: Drop): Box | undefined => {
    const b = boxOf(d.target)
    if (!b) return
    const share = d.target === 'chat' ? 0.4 : 0.5
    switch (d.zone) {
      case 'center':
        // Onto a tab bar, the line between tabs shows where.
        return d.index === undefined ? b : undefined
      case 'left':
        return part(b, 'row', 0, share)
      case 'right':
        return part(b, 'row', 1 - share, 1)
      case 'top':
        return part(b, 'col', 0, share)
      case 'bottom':
        return part(b, 'col', 1 - share, 1)
    }
  }

  const startTabDrag = (e: PointerEvent, key: string, label: string) => {
    // One shared group on narrow screens: nowhere to drag to.
    if (e.button !== 0 || !wide()) return
    const sx = e.clientX
    const sy = e.clientY
    let started = false
    const move = (m: PointerEvent) => {
      if (!started && Math.hypot(m.clientX - sx, m.clientY - sy) < 5) return
      started = true
      setDragging('grabbing')
      setDrag({ key, label, x: m.clientX, y: m.clientY, drop: dropAt(m.clientX, m.clientY) })
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      const d = drag()
      setDrag()
      setDragging()
      if (!d?.drop) return
      update((l) => {
        const moved = moveView(l.tree, key, d.drop!)
        return { ...l, tree: moved.tree, focus: moved.group ?? l.focus }
      })
      focusView(key)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  // ── Keyboard: the leader chord, then one key ──

  const [leader, setLeader] = createSignal(false)
  const onKey = (e: KeyboardEvent) => {
    // Behind a modal: its keys aren't for the panels.
    if (modalOpen()) return setLeader(false)
    if (!leader()) {
      if (!isLeader(e) || !props.ws) return
      // Caught on the way down, so neither the composer nor a terminal sees it.
      e.preventDefault()
      e.stopPropagation()
      setLeader(true)
      return
    }
    if (['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) return
    e.preventDefault()
    e.stopPropagation()
    setLeader(false)
    const here = groupById(current()) ? current() : 'chat'
    const arrows: Record<string, Edge> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' }
    if (arrows[e.key]) {
      const next = neighbour(here, arrows[e.key])
      if (next) focusLeaf(next)
      return
    }
    switch (e.key.toLowerCase()) {
      case 't':
        return newTerminal(here === 'chat' ? undefined : { group: here })
      case '\\':
      case '|':
        return newTerminal({ beside: here, edge: 'right' })
      case '-':
      case '_':
        return newTerminal({ beside: here, edge: 'bottom' })
      case 'w': {
        const g = groupById(here)
        return g && close(activeOf(g))
      }
      case '0':
        return props.onFocusChat()
      case 'p':
        if (panelsShown(props.ws!)) return hide()
        return props.cwd && togglePanels(props.ws!, props.cwd)
    }
  }
  const cancelLeader = () => setLeader(false)
  addEventListener('keydown', onKey, true)
  addEventListener('pointerdown', cancelLeader)
  addEventListener('blur', cancelLeader)
  onCleanup(() => {
    removeEventListener('keydown', onKey, true)
    removeEventListener('pointerdown', cancelLeader)
    removeEventListener('blur', cancelLeader)
  })

  // ── Rendering ──

  /** Where the workspace's terminals and ports are, so its previews too. */
  const machine = () => props.ws?.machine ?? LOCAL
  const tabLabel = (v?: View) => {
    if (v?.kind === 'task') return props.panes.label(v.id)
    if (v?.kind === 'plan') return 'Plan'
    if (v?.kind === 'preview') return v.name ?? `:${v.id}`
    const t = terminalOf(v)
    return t ? terminalLabel(t) : 'Starting…'
  }
  const tabTitle = (v?: View) =>
    v?.kind === 'preview'
      ? `${tabLabel(v)}\n${previewUrl(v.id, v.path, machine()) ?? `Port ${v.id}`}`
      : v?.kind === 'task' || v?.kind === 'plan'
        ? tabLabel(v)
        : [
            terminalOf(v) ? terminalTooltip(terminalOf(v)!) : tabLabel(v),
            terminalOf(v)?.cwd,
            onMachine(machine()) && `on ${onMachine(machine())}`,
            terminalOf(v) && 'Double-click to rename',
          ]
            .filter(Boolean)
            .join('\n')

  /** Scroll the tab strip, and only it, so a tab is fully in view. */
  const reveal = (tab: HTMLElement) => {
    const strip = tab.parentElement!
    const s = strip.getBoundingClientRect()
    const t = tab.getBoundingClientRect()
    const by = t.left < s.left ? t.left - s.left : t.right > s.right ? t.right - s.right : 0
    if (by) strip.scrollBy({ left: by, behavior: 'smooth' })
  }

  const GroupFrame = (p: { group: Group }) => {
    const g = () => p.group
    const active = () => viewOf(activeOf(g()))
    const preview = () => {
      const v = active()
      return v?.kind === 'preview' ? v : undefined
    }
    const focused = () => current() === g().id
    return (
      <div class="pane absolute flex flex-col" style={place(boxOf(g().id)!)} onPointerDown={() => focusLeaf(g().id)}>
        <div class="flex shrink-0 items-center gap-0.5 px-1.5" style={{ height: `${BAR}px` }}>
          {/* A mouse wheel only scrolls vertically, so turn that into scrolling along the tabs. */}
          <div
            data-tabs={g().id}
            class="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
            onWheel={(e) => {
              const el = e.currentTarget
              if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return
              e.preventDefault()
              el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
            }}
          >
            <For each={g().views.map(viewKey)}>
              {(key) => {
                const v = () => viewOf(key)
                const isActive = () => activeOf(g()) === key
                let tab!: HTMLDivElement
                createEffect(() => isActive() && reveal(tab))
                // Its label can change after it's shown, a new terminal's from "Starting…".
                const resized = new ResizeObserver(() => untrack(isActive) && reveal(tab))
                onMount(() => resized.observe(tab))
                onCleanup(() => resized.disconnect())
                return (
                  <div
                    ref={tab}
                    data-tab={key}
                    class={`group flex h-7 max-w-56 shrink-0 items-center rounded-md transition-colors ${
                      isActive() ? (focused() ? 'bg-surface text-fg' : 'bg-surface/60 text-fg-2') : 'text-fg-3 hover:bg-surface/60 hover:text-fg-2'
                    } ${drag()?.key === key ? 'opacity-50' : ''}`}
                  >
                    <Show
                      when={renaming() === key && terminalOf(v())}
                      fallback={
                        <button
                          onPointerDown={(e) => startTabDrag(e, key, tabLabel(v()))}
                          onClick={(e) => (e.stopPropagation(), activate(key))}
                          onDblClick={() => terminalOf(v()) && setRenaming(key)}
                          title={tabTitle(v())}
                          class="flex h-full min-w-0 items-center gap-1.5 pl-2 text-xs"
                        >
                          <Show when={v()?.kind === 'preview'}>
                            <Globe class="size-3 shrink-0" />
                          </Show>
                          <Show when={terminalOf(v())}>{(t) => <StatusDot terminal={t()} />}</Show>
                          <Show when={taskOf(v()) && props.panes.live(taskOf(v())!)}>
                            <LiveDot />
                          </Show>
                          <Show when={v()?.kind === 'plan'}>
                            <NotebookPen class="size-3 shrink-0" />
                            {/* Waiting on you, like the prompts' dot. */}
                            <Show when={props.panes.planWaiting()}>
                              <span class="size-1.5 shrink-0 rounded-full bg-accent" />
                            </Show>
                          </Show>
                          <span class="truncate">{tabLabel(v())}</span>
                        </button>
                      }
                    >
                      {(t) => (
                        <div class="flex h-full min-w-0 items-center gap-1.5 pl-2 text-xs">
                          <StatusDot terminal={t()} />
                          <RenameTerminal terminal={t()} onDone={() => setRenaming()} class="w-36" />
                        </div>
                      )}
                    </Show>
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => close(key)}
                      title={v()?.kind === 'terminal' ? 'Delete terminal: stops it and everything it started' : 'Close'}
                      class={`mx-0.5 grid size-5 shrink-0 place-items-center rounded-button-sm text-fg-3 transition-colors hover:text-fg ${
                        isActive() ? '' : 'invisible group-hover:visible'
                      }`}
                    >
                      <X class="size-3" />
                    </button>
                  </div>
                )
              }}
            </For>
          </div>
          <button onClick={() => newTerminal({ group: g().id })} title={`New terminal (${LEADER} T)`} class={ghostClass()}>
            <Plus class="size-3.5" />
          </button>
          <div class="flex-1" />
          <Show when={terminalOf(active())}>
            {(t) => (
              <>
                <PortButtons terminal={t()} onOpen={(port) => props.ws && openPreview(props.ws, port, { name: terminalLabel(t()) })} />
                <RestartButton terminal={t()} />
                <button onClick={() => props.onOpenPage(t().id)} title="Open on its own page" class={ghostClass()}>
                  <SquareArrowOutUpRight class="size-3.5" />
                </button>
              </>
            )}
          </Show>
          <Show when={preview()}>
            {(v) => (
              <>
                <button onClick={() => props.ws && reloadPreview(props.ws, v())} title="Reload" class={ghostClass()}>
                  <RotateCw class="size-3.5" />
                </button>
                <Show when={previewUrl(v().id, v().path, machine())}>
                  {(url) => (
                    <a href={url()} target="_blank" rel="noopener" title="Open in a new browser tab" class={ghostClass()}>
                      <SquareArrowOutUpRight class="size-3.5" />
                    </a>
                  )}
                </Show>
              </>
            )}
          </Show>
          <button onClick={hide} title={`Hide panels (${LEADER} P)`} class={ghostClass()}>
            <Minimize2 class="size-3.5" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div ref={container} class="relative h-full min-w-0 flex-1">
      <div class="pane absolute flex flex-col" style={place(boxOf('chat')!)} onFocusIn={() => focusIn('chat')}>
        {chat()}
      </div>

      <For each={groupIds()}>{(id) => <Show when={groupById(id)}>{(g) => <GroupFrame group={g()} />}</Show>}</For>

      <For each={keys()}>
        {(key) => {
          const view = () => viewOf(key)
          const at = createMemo(() => {
            const g = groupOf(tree(), key)
            const b = g && boxOf(g.id)
            return b && activeOf(g) === key ? { group: g.id, box: b } : undefined
          })
          return (
            <div
              class="absolute overflow-hidden rounded-b-(--pane-radius)"
              classList={{ hidden: !at() }}
              style={at() ? placeIn(at()!.box) : undefined}
              onFocusIn={() => at() && focusIn(at()!.group)}
            >
              <Show when={view()}>
                {(v) => (
                  <Switch>
                    <Match when={v().kind === 'terminal' && (v() as { id: string })}>
                      {(t) => <TerminalView id={t().id} visible={!!at()} onReady={(focus) => ready(key, focus)} class="size-full px-3 py-2" />}
                    </Match>
                    <Match when={v().kind === 'preview' && (v() as PreviewView)}>
                      {(p) => (
                        <PreviewFrame
                          view={p()}
                          machine={machine()}
                          onMove={(path) => props.ws && movePreview(props.ws, p().id, path)}
                          onReady={(focus) => ready(key, focus)}
                          class="size-full"
                        />
                      )}
                    </Match>
                    <Match when={taskOf(v())}>{(id) => props.panes.render(id(), (focus) => ready(key, focus))}</Match>
                    <Match when={v().kind === 'plan'}>{props.panes.renderPlan((focus) => ready(key, focus))}</Match>
                  </Switch>
                )}
              </Show>
            </div>
          )
        }}
      </For>

      {/* The gutters are the handles, grown a little each way so a thin one is easy to catch. */}
      <Index each={measured().dividers}>
        {(d) => (
          <div
            onPointerDown={(e) => startResize(e, [d()])}
            class={`absolute z-10 rounded-full transition-colors delay-150 hover:bg-edge after:absolute after:content-[""] ${
              d().dir === 'row' ? 'cursor-col-resize after:inset-y-0 after:-inset-x-1' : 'cursor-row-resize after:inset-x-0 after:-inset-y-1'
            }`}
            style={place(d().gutter)}
          />
        )}
      </Index>
      <Index each={measured().junctions}>
        {(j) => (
          <div
            onPointerDown={(e) => startResize(e, [j().vertical, j().horizontal])}
            class="absolute z-20 size-4 -translate-1/2 cursor-move"
            style={{ left: css(mid(j().vertical.gutter.x)), top: css(mid(j().horizontal.gutter.y)) }}
          />
        )}
      </Index>
      {/* Where a gutter between stacked panes meets the sidebar's edge. Narrow screens have a drawer instead. */}
      <Index each={measured().dividers.filter((d) => d.dir === 'col' && d.split.x < 1e-6)}>
        {(d) => (
          <div
            onPointerDown={(e) => startResize(e, [d()], true)}
            class="absolute z-20 hidden size-4 -translate-1/2 cursor-move md:block"
            style={{ left: 'calc(var(--sidebar-gutter) / -2)', top: css(mid(d().gutter.y)) }}
          />
        )}
      </Index>

      <Show when={drag()?.drop && dropBox(drag()!.drop!)}>
        {(b) => (
          <div
            class="pointer-events-none absolute z-20 rounded-[max(var(--radius-md),var(--pane-radius))] border-2 border-accent/60 bg-accent/10 transition-all duration-100"
            style={place(b())}
          />
        )}
      </Show>
      <Show when={drag()?.drop && tabMark(drag()!.drop!)}>
        {(m) => <div class="pointer-events-none absolute z-50 w-0.5 rounded-full bg-accent" style={m()} />}
      </Show>
      <Show when={dragging()}>
        <div class="fixed inset-0 z-40" style={{ cursor: dragging() }} />
      </Show>
      <Show when={drag()}>
        {(d) => (
          <div
            class="pointer-events-none fixed z-50 rounded-md border border-edge bg-bg px-2 py-1 text-xs text-fg pop shadow-(--shadow-pop)"
            style={{ left: `${d().x + 12}px`, top: `${d().y + 8}px` }}
          >
            {d().label}
          </div>
        )}
      </Show>

      <Show when={leader()}>
        <div class="pointer-events-none absolute bottom-4 left-1/2 z-50 w-64 -translate-x-1/2 animate-[pop-in_120ms_ease-out] rounded-xl border border-edge bg-bg p-2 text-[13px] pop shadow-(--shadow-pop)">
          <div class="px-1.5 pb-1 text-[11px] text-fg-3">{LEADER}, then</div>
          <For each={BINDINGS}>
            {([key, what]) => (
              <div class="flex items-center gap-3 px-1.5 py-0.5">
                <kbd class="min-w-12 font-mono text-xs text-fg">{key}</kbd>
                <span class="text-fg-2">{what}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
