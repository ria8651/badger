import { For, Show, createMemo, createSignal, type Accessor } from 'solid-js'
import { Check, ChevronRight } from '../icons'
import type { BackgroundTask, WireMessage } from '../../shared/protocol.ts'
import { socket } from '../api.ts'
import { taskLabel, type Task } from '../tasks.ts'
import { toolLabel, toolSummary } from './ToolCard.tsx'
import { agentLabel, runInBackground, type Index } from './Transcript.tsx'
import { LiveDot, compact, plural } from './ui.tsx'

/** A subagent, shell or other task the chat started, as the tray lists it. */
export interface TrayItem {
  /** The tool call that started it; absent for a task whose call isn't in the transcript. */
  toolUseId?: string
  /** Claude Code's task id, to stop it; absent read back from disk. */
  taskId?: string
  label: string
  description: string
  status: Task['status']
  /** The turn isn't waiting on it. */
  background: boolean
  activity?: string
  steps?: number
  tokens?: number
  /** How many subagents deep it was started: 0 for the chat's own. */
  depth: number
}

type Block = { type: string; id?: string; name?: string; input?: Record<string, unknown> }

const isAgent = (name: string) => name === 'Agent' || name === 'Task'

/**
 * Every task the chat started, oldest first, each subagent's own straight
 * after it: subagents, and commands, monitors and workflows once they run as
 * tasks. Plain foreground commands aren't listed; they come and go too quickly
 * to be worth a row. Background work whose call isn't in the transcript is
 * added from `background` so nothing running goes unseen.
 */
export function trayItems(index: Index, running: boolean, background: BackgroundTask[], cwd?: string): TrayItem[] {
  const items: TrayItem[] = []
  const seen = new Set<string>()

  const add = (id: string, name: string, input: Record<string, unknown>, task: Task | undefined, depth: number) => {
    const result = index.results.get(id)
    if (task) seen.add(task.id)
    items.push({
      toolUseId: id,
      taskId: task?.id,
      label: isAgent(name) ? agentLabel(input) : task?.type ? taskLabel(task.type) : toolLabel(name),
      description: String(input.description ?? '') || task?.description || toolSummary(name, input, cwd),
      status: task?.status ?? (!result ? (running ? 'running' : 'stopped') : result.isError ? 'failed' : 'completed'),
      background: !!task?.background,
      activity: task?.activity,
      steps: isAgent(name) ? (task?.toolUses ?? steps(index.groups.get(id))) : undefined,
      tokens: task?.tokens,
      depth,
    })
  }

  const walk = (group: string, depth: number) => {
    for (const m of index.groups.get(group) ?? []) {
      if (m.type !== 'assistant') continue
      for (const b of ((m.message as { content?: Block[] })?.content ?? []) as Block[]) {
        if (b.type !== 'tool_use' || !b.id || !b.name) continue
        const task = index.tasks.get(b.id)
        if (isAgent(b.name)) {
          add(b.id, b.name, b.input ?? {}, task, depth)
          walk(b.id, depth + 1)
        } else if (task && (task.background || (task.type && task.type !== 'local_bash'))) {
          add(b.id, b.name, b.input ?? {}, task, depth)
        }
      }
    }
  }
  walk('', 0)

  for (const t of background) {
    if (seen.has(t.id)) continue
    items.push({ taskId: t.id, label: taskLabel(t.type), description: t.description, status: 'running', background: true, depth: 0 })
  }
  return items
}

const key = (t: TrayItem) => t.toolUseId ?? t.taskId!

/**
 * Splits the tray into what's running and what's finished, keeping each
 * task under the subagent that started it. A subagent that's finished but has
 * work still running stays with the running, so that work keeps its place;
 * its finished work joins it once everything in it is done.
 */
function sections(items: TrayItem[]) {
  // Trees in order, each a top-level task followed by everything under it.
  const trees: TrayItem[][] = []
  for (const t of items) {
    if (t.depth === 0 || !trees.length) trees.push([t])
    else trees.at(-1)!.push(t)
  }
  const running: TrayItem[] = []
  const done: TrayItem[][] = []
  for (const tree of trees) {
    // Busy: it, or anything under it, is running.
    const busy = tree.map((t, i) => {
      if (t.status === 'running') return true
      for (let j = i + 1; j < tree.length && tree[j].depth > t.depth; j++) if (tree[j].status === 'running') return true
      return false
    })
    if (busy[0]) running.push(...tree.filter((_, i) => busy[i]))
    else done.push(tree)
  }
  // Most recent first: the one just finished is the one wanted.
  return { running, done: done.reverse().flat() }
}

/** Whether the turn is waiting on a subagent or command it could leave running in the background. */
export function waitingOnTask(index: Index): boolean {
  // Only the latest calls can still be running; an older one with no result was interrupted.
  const last = (index.groups.get('') ?? []).findLast((m) => m.type === 'assistant')
  const blocks = ((last?.message as { content?: Block[] } | undefined)?.content ?? []) as Block[]
  return blocks.some(
    (b) => b.type === 'tool_use' && !!b.id && (isAgent(b.name ?? '') || b.name === 'Bash') && !index.results.has(b.id) && !index.tasks.get(b.id)?.background,
  )
}

/** Tool calls a subagent made, for one read back from disk that never said. */
function steps(messages: WireMessage[] | undefined): number {
  let n = 0
  for (const m of messages ?? []) {
    if (m.type !== 'assistant') continue
    n += (((m.message as { content?: Block[] })?.content ?? []) as Block[]).filter((b) => b.type === 'tool_use').length
  }
  return n
}

/**
 * The chat's subagents and background work, by the composer so they stay in
 * view however far the transcript scrolls. What's running is always listed;
 * what's finished folds into one row. A subagent's own work is indented under
 * it. Each opens in a panel beside the chat.
 */
export function TaskTray(props: { sessionId: string; items: Accessor<TrayItem[]>; onOpen: (toolUseId: string) => void }) {
  const [showDone, setShowDone] = createSignal(false)
  // Rows are listed by key, which stays the same as the items are rebuilt, so they aren't remade on every message.
  const byKey = createMemo(() => new Map(props.items().map((t) => [key(t), t])))
  const split = createMemo(() => sections(props.items()))
  const running = () => split().running.map(key)
  const done = () => split().done.map(key)
  const finished = () => split().done.filter((t) => t.depth === 0).length

  const Row = (p: { id: string }) => {
    // A row on its way out can still read once after its item is gone; it shows the item as last seen.
    let last!: TrayItem
    const t = () => (last = byKey().get(p.id) ?? last)
    const live = () => t().status === 'running'
    const stats = () => [t().steps ? plural(t().steps!, 'step') : '', t().tokens && !live() ? `${compact(t().tokens!)} tokens` : ''].filter(Boolean).join(' · ')
    return (
      <div class="flex min-h-7 items-center gap-2" style={{ 'padding-left': `${t().depth * 1.25}rem` }}>
        <span class="grid w-3.5 shrink-0 place-items-center">
          <Show when={live()} fallback={t().status === 'completed' ? <Check class="size-3.5 text-fg-3" /> : <span class="size-1.5 rounded-full bg-fg-3" />}>
            <LiveDot />
          </Show>
        </span>
        <button
          onClick={() => t().toolUseId && props.onOpen(t().toolUseId!)}
          disabled={!t().toolUseId}
          title={t().toolUseId ? 'Open in a panel' : undefined}
          class="group flex min-w-0 flex-1 items-baseline gap-2 py-1 text-left enabled:cursor-pointer"
        >
          <span class="min-w-0 truncate text-fg-2 group-enabled:group-hover:text-fg">{t().label}</span>
          <span class="min-w-0 truncate font-mono text-xs text-fg-3">{t().description}</span>
          <Show when={live() && t().activity}>
            <span class="min-w-0 flex-1 truncate text-xs text-fg-3">· {t().activity}</span>
          </Show>
        </button>
        <span class="shrink-0 text-xs text-fg-3 tabular-nums">
          <Show when={t().status === 'failed'}>
            <span class="text-danger">Failed</span>
          </Show>
          <Show when={t().status === 'stopped'}>Stopped</Show>
          <Show when={(t().status === 'failed' || t().status === 'stopped') && stats()}> · </Show>
          {stats()}
        </span>
        <Show when={live() && t().taskId}>
          <Show when={!t().background && t().toolUseId}>
            <button onClick={() => runInBackground(props.sessionId, t().toolUseId)} class="shrink-0 text-xs text-fg-3 transition-colors hover:text-fg-2">
              Background
            </button>
          </Show>
          <button
            onClick={() => socket.send({ type: 'stop_task', sessionId: props.sessionId, taskId: t().taskId! })}
            class="shrink-0 text-xs text-fg-3 transition-colors hover:text-fg-2"
          >
            Stop
          </button>
        </Show>
      </div>
    )
  }

  return (
    <div class="rounded-xl border border-line px-3 py-1 text-[13px]">
      <For each={running()}>{(id) => <Row id={id} />}</For>
      <Show when={finished()}>
        <button onClick={() => setShowDone(!showDone())} class="group flex h-7 w-full items-center gap-2 text-left text-xs text-fg-3">
          <ChevronRight class={`size-3.5 shrink-0 transition-transform ${showDone() ? 'rotate-90' : ''}`} />
          <span class="group-hover:text-fg-2">{finished()} finished</span>
        </button>
        <Show when={showDone()}>
          <div class="max-h-60 overflow-y-auto">
            <For each={done()}>{(id) => <Row id={id} />}</For>
          </div>
        </Show>
      </Show>
    </div>
  )
}
