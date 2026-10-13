import { For, Index, Match, Show, Switch, children, createEffect, createMemo, createSignal, on, onCleanup, untrack, type JSX } from 'solid-js'
import { Globe, Minimize2, Plus, RotateCw, SquareArrowOutUpRight, X } from 'lucide-solid'
import { api } from '../api.ts'
import {
  CHAT,
  LEADER,
  activeOf,
  dropOtherTasks,
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
  reloadPreview,
  removeView,
  setActive,
  setFocusRequest,
  setSizes,
  togglePanels,
  updateLayout,
  viewKey,
  viewsOf,
  type Divider,
  type Drop,
  type Edge,
  type Group,
  type PreviewView,
  type Rect,
  type View,
} from '../layout.ts'
import { previewUrl } from '../previews.ts'
import { terminalLabel, terminals, terminalsLoaded } from '../terminals.ts'
import { PreviewFrame } from './PreviewFrame.tsx'
import { PortButtons, RestartButton, StatusDot, ghost } from './Terminals.tsx'
import { TerminalView } from './TerminalView.tsx'
import { LiveDot } from './ui.tsx'

/** Height of a group's tab bar, which its views sit under. */
const BAR = 36
/** No pane is dragged smaller than this. */
const MIN = 120

const wideQuery = matchMedia('(min-width: 768px)')
const [wide, setWide] = createSignal(wideQuery.matches)
wideQuery.addEventListener('change', (e) => setWide(e.matches))

const pct = (n: number) => `${n * 100}%`
const box = (r: Rect, top = 0): JSX.CSSProperties => ({
  left: pct(r.x),
  top: `calc(${pct(r.y)} + ${top}px)`,
  width: pct(r.w),
  height: `calc(${pct(r.h)} - ${top}px)`,
})

const terminalOf = (v?: View) => (v?.kind === 'terminal' ? terminals().find((t) => t.id === v.id) : undefined)

/** What the chat says about its own tasks, for the panels showing them. */
export interface TaskPanes {
  label: (toolUseId: string) => string
  live: (toolUseId: string) => boolean
  render: (toolUseId: string, onReady: (focus: () => void) => void) => JSX.Element
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
  /** The workspace (git root); panels aren't offered until it's known. */
  root?: string
  cwd?: string
  /** The chat's session, whose tasks can show in panels. */
  sessionId: string
  tasks: TaskPanes
  onFocusChat: () => void
  onOpenPage: (terminalId: string) => void
  children: JSX.Element
}) {
  const chat = children(() => props.children)
  let container!: HTMLDivElement

  const tree = createMemo(() => {
    const root = props.root
    if (!root || !panelsShown(root)) return CHAT
    return wide() ? layoutOf(root).tree : narrowTree(layoutOf(root))
  })
  const measured = createMemo(() => measure(tree()))
  const rect = (id: string) => measured().rects.get(id)
  const groupIds = createMemo(() => groupsOf(tree()).map((g) => g.id))
  const groupById = (id: string) => groupsOf(tree()).find((g) => g.id === id)
  // Every view in the workspace, shown or not, so hiding or moving one never unmounts it.
  const keys = createMemo(() =>
    props.root ? viewsOf(layoutOf(props.root).tree).filter((v) => v.kind !== 'task' || v.session === props.sessionId).map(viewKey) : [],
  )

  const update = (change: Parameters<typeof updateLayout>[1]) => props.root && updateLayout(props.root, change)
  const viewOf = (key: string) => (props.root ? viewsOf(layoutOf(props.root).tree).find((v) => viewKey(v) === key) : undefined)

  // The server's terminals are the truth: closed ones leave the layout, new ones join it.
  createEffect(() => {
    const root = props.root
    if (!root || !terminalsLoaded()) return
    const ids = terminals()
      .filter((t) => t.root === root)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => t.id)
    untrack(() => placeTerminals(root, ids))
  })

  // Another chat's tasks don't belong beside this one.
  createEffect(() => props.root && untrack(() => dropOtherTasks(props.root!, props.sessionId)))

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

  /** Closing a terminal's tab stops it, like the dock's did; a preview's or a task's only leaves the panel. The next tab along takes its place. */
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

  const newTerminal = (where?: Parameters<typeof openTerminal>[2]) => props.root && props.cwd && void openTerminal(props.root, props.cwd, where)

  // ── Resizing ──

  /** What's being dragged, for a cover over the page that keeps the cursor and stops terminals taking the pointer. */
  const [dragging, setDragging] = createSignal<'col-resize' | 'row-resize' | 'grabbing'>()

  const resize = (d: Divider, sizes: number[]) =>
    update((l) => (wide() ? { ...l, tree: setSizes(l.tree, d.path, sizes) } : { ...l, narrow: sizes[1] }))

  const startResize = (e: PointerEvent, d: Divider) => {
    if (e.button !== 0) return
    e.preventDefault()
    const bounds = container.getBoundingClientRect()
    const row = d.dir === 'row'
    const span = row ? d.split.w * bounds.width : d.split.h * bounds.height
    const start = row ? e.clientX : e.clientY
    const i = d.index
    const pair = d.sizes[i - 1] + d.sizes[i]
    const min = Math.min(MIN / span, pair / 2)
    setDragging(row ? 'col-resize' : 'row-resize')
    const move = (m: PointerEvent) => {
      const before = Math.max(min, Math.min(pair - min, d.sizes[i - 1] + ((row ? m.clientX : m.clientY) - start) / span))
      const sizes = [...d.sizes]
      sizes[i - 1] = before
      sizes[i] = pair - before
      resize(d, sizes)
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

  /** Over a group's tab bar or middle drops into it; anywhere else, beside the pane on the nearest side. */
  const dropAt = (x: number, y: number): Drop | undefined => {
    const b = container.getBoundingClientRect()
    const fx = (x - b.left) / b.width
    const fy = (y - b.top) / b.height
    for (const [id, r] of measured().rects) {
      if (fx < r.x || fx > r.x + r.w || fy < r.y || fy > r.y + r.h) continue
      const px = (fx - r.x) / r.w
      const py = (fy - r.y) / r.h
      if (id !== 'chat' && (y - b.top - r.y * b.height < BAR || (px > 0.25 && px < 0.75 && py > 0.25 && py < 0.75))) return { target: id, zone: 'center' }
      const sides: [Edge, number][] = [['left', px], ['right', 1 - px], ['top', py], ['bottom', 1 - py]]
      return { target: id, zone: sides.reduce((a, s) => (s[1] < a[1] ? s : a))[0] }
    }
  }

  /** Where a drop would put the tab, to outline it. */
  const dropRect = (d: Drop): Rect | undefined => {
    const r = rect(d.target)
    if (!r) return
    const share = d.target === 'chat' ? 0.4 : 0.5
    switch (d.zone) {
      case 'center':
        return r
      case 'left':
        return { ...r, w: r.w * share }
      case 'right':
        return { ...r, x: r.x + r.w * (1 - share), w: r.w * share }
      case 'top':
        return { ...r, h: r.h * share }
      case 'bottom':
        return { ...r, y: r.y + r.h * (1 - share), h: r.h * share }
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
    if (!leader()) {
      if (!isLeader(e) || !props.root) return
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
        if (panelsShown(props.root!)) return hide()
        return props.cwd && togglePanels(props.root!, props.cwd)
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

  const tabLabel = (v?: View) => {
    if (v?.kind === 'task') return props.tasks.label(v.id)
    if (v?.kind === 'preview') return v.name ?? `:${v.id}`
    const t = terminalOf(v)
    return t ? terminalLabel(t) : 'Starting…'
  }
  const tabTitle = (v?: View) =>
    v?.kind === 'preview'
      ? `${tabLabel(v)}\n${previewUrl(v.id, v.path) ?? `Port ${v.id}`}`
      : v?.kind === 'task'
        ? tabLabel(v)
        : `${tabLabel(v)}\n${terminalOf(v)?.cwd ?? ''}`

  const GroupFrame = (p: { group: Group }) => {
    const g = () => p.group
    const active = () => viewOf(activeOf(g()))
    const preview = () => {
      const v = active()
      return v?.kind === 'preview' ? v : undefined
    }
    const focused = () => current() === g().id
    return (
      <div class="absolute flex flex-col bg-bg" style={box(rect(g().id)!)} onPointerDown={() => focusLeaf(g().id)}>
        <div class="flex shrink-0 items-center gap-0.5 px-1.5" style={{ height: `${BAR}px` }}>
          <div class="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
            <For each={g().views.map(viewKey)}>
              {(key) => {
                const v = () => viewOf(key)
                const isActive = () => activeOf(g()) === key
                return (
                  <div
                    class={`group flex h-7 max-w-56 shrink-0 items-center rounded-md transition-colors ${
                      isActive() ? (focused() ? 'bg-surface text-fg' : 'bg-surface/60 text-fg-2') : 'text-fg-3 hover:bg-surface/60 hover:text-fg-2'
                    } ${drag()?.key === key ? 'opacity-50' : ''}`}
                  >
                    <button
                      onPointerDown={(e) => startTabDrag(e, key, tabLabel(v()))}
                      onClick={(e) => (e.stopPropagation(), activate(key))}
                      title={tabTitle(v())}
                      class="flex h-full min-w-0 items-center gap-1.5 pl-2 text-xs"
                    >
                      <Show when={v()?.kind === 'preview'}>
                        <Globe class="size-3 shrink-0" />
                      </Show>
                      <Show when={terminalOf(v())}>{(t) => <StatusDot terminal={t()} />}</Show>
                      <Show when={v()?.kind === 'task' && props.tasks.live(v()!.id)}>
                        <LiveDot />
                      </Show>
                      <span class="truncate">{tabLabel(v())}</span>
                    </button>
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => close(key)}
                      title={v()?.kind === 'terminal' ? 'Delete terminal: stops it and everything it started' : 'Close'}
                      class={`mx-0.5 grid size-5 shrink-0 place-items-center rounded text-fg-3 transition-colors hover:text-fg ${
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
          <button onClick={() => newTerminal({ group: g().id })} title={`New terminal (${LEADER} T)`} class={ghost()}>
            <Plus class="size-3.5" />
          </button>
          <div class="flex-1" />
          <Show when={terminalOf(active())}>
            {(t) => (
              <>
                <PortButtons terminal={t()} onOpen={(port) => props.root && openPreview(props.root, port, { name: terminalLabel(t()) })} />
                <RestartButton terminal={t()} />
                <button onClick={() => props.onOpenPage(t().id)} title="Open on its own page" class={ghost()}>
                  <SquareArrowOutUpRight class="size-3.5" />
                </button>
              </>
            )}
          </Show>
          <Show when={preview()}>
            {(v) => (
              <>
                <button onClick={() => props.root && reloadPreview(props.root, v())} title="Reload from where it was opened" class={ghost()}>
                  <RotateCw class="size-3.5" />
                </button>
                <Show when={previewUrl(v().id, v().path)}>
                  {(url) => (
                    <a href={url()} target="_blank" rel="noopener" title="Open in a new browser tab" class={ghost()}>
                      <SquareArrowOutUpRight class="size-3.5" />
                    </a>
                  )}
                </Show>
              </>
            )}
          </Show>
          <button onClick={hide} title={`Hide panels (${LEADER} P)`} class={ghost()}>
            <Minimize2 class="size-3.5" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div ref={container} class="relative h-full min-w-0 flex-1 overflow-hidden">
      <div class="absolute flex flex-col" style={box(rect('chat')!)} onFocusIn={() => focusIn('chat')}>
        {chat()}
      </div>

      <For each={groupIds()}>{(id) => <Show when={groupById(id)}>{(g) => <GroupFrame group={g()} />}</Show>}</For>

      <For each={keys()}>
        {(key) => {
          const view = () => viewOf(key)
          const place = createMemo(() => {
            const g = groupOf(tree(), key)
            const r = g && rect(g.id)
            return r && activeOf(g) === key ? { group: g.id, rect: r } : undefined
          })
          return (
            <div
              class="absolute"
              classList={{ hidden: !place() }}
              style={place() ? box(place()!.rect, BAR) : undefined}
              onFocusIn={() => place() && focusIn(place()!.group)}
            >
              <Show when={view()}>
                {(v) => (
                  <Switch>
                    <Match when={v().kind === 'terminal'}>
                      <TerminalView id={v().id} visible={!!place()} onReady={(focus) => ready(key, focus)} class="size-full px-3 py-2" />
                    </Match>
                    <Match when={v().kind === 'preview' && (v() as PreviewView)}>
                      {(p) => <PreviewFrame view={p()} onReady={(focus) => ready(key, focus)} class="size-full" />}
                    </Match>
                    <Match when={v().kind === 'task'}>{props.tasks.render(v().id, (focus) => ready(key, focus))}</Match>
                  </Switch>
                )}
              </Show>
            </div>
          )
        }}
      </For>

      <Index each={measured().dividers}>
        {(d) => (
          <div
            onPointerDown={(e) => startResize(e, d())}
            class={`absolute z-10 flex justify-center ${d().dir === 'row' ? '-ml-1 w-2 cursor-col-resize' : '-mt-1 h-2 cursor-row-resize flex-col'}`}
            style={
              d().dir === 'row'
                ? { left: pct(d().at), top: pct(d().split.y), height: pct(d().split.h) }
                : { top: pct(d().at), left: pct(d().split.x), width: pct(d().split.w) }
            }
          >
            <div class={d().dir === 'row' ? 'h-full w-px bg-line' : 'h-px w-full bg-line'} />
          </div>
        )}
      </Index>

      <Show when={drag()?.drop && dropRect(drag()!.drop!)}>
        {(r) => <div class="pointer-events-none absolute z-20 rounded-md border-2 border-accent/60 bg-accent/10 transition-all duration-100" style={box(r())} />}
      </Show>
      <Show when={dragging()}>
        <div class="fixed inset-0 z-40" style={{ cursor: dragging() }} />
      </Show>
      <Show when={drag()}>
        {(d) => (
          <div
            class="pointer-events-none fixed z-50 rounded-md border border-edge bg-bg px-2 py-1 text-xs text-fg shadow-[0_8px_24px_-8px_rgb(0_0_0/0.35)]"
            style={{ left: `${d().x + 12}px`, top: `${d().y + 8}px` }}
          >
            {d().label}
          </div>
        )}
      </Show>

      <Show when={leader()}>
        <div class="pointer-events-none absolute bottom-4 left-1/2 z-50 w-64 -translate-x-1/2 animate-[pop-in_120ms_ease-out] rounded-xl border border-edge bg-bg p-2 text-[13px] shadow-[0_12px_32px_-12px_rgb(0_0_0/0.35)]">
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
