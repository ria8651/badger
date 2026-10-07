import { For, Match, Show, Switch, createSignal } from 'solid-js'
import { Check, ChevronRight, Circle, CircleDot, Loader2, X } from 'lucide-solid'

export interface ToolResult {
  content: unknown
  isError: boolean
}

type Input = Record<string, unknown>

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** Path shown relative to the session's working directory when inside it. */
export function relPath(path: string, cwd?: string): string {
  if (cwd && path.startsWith(cwd + '/')) return path.slice(cwd.length + 1)
  return path
}

/** One-line description of a tool call for its collapsed header. */
export function toolSummary(name: string, input: Input, cwd?: string): string {
  switch (name) {
    case 'Bash':
      return str(input.description) || str(input.command)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return relPath(str(input.file_path) || str(input.notebook_path), cwd)
    case 'Glob':
    case 'Grep':
      return str(input.pattern) + (input.path ? ` in ${relPath(str(input.path), cwd)}` : '')
    case 'WebFetch':
      return str(input.url)
    case 'WebSearch':
      return str(input.query)
    case 'Task':
    case 'Agent':
      return str(input.description)
    case 'TodoWrite':
      return 'Update todos'
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string')
      return typeof first === 'string' ? first : ''
    }
  }
}

export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content, null, 2)
}

export function ToolInput(props: { name: string; input: Input }) {
  return (
    <Switch fallback={<Pre text={JSON.stringify(props.input, null, 2)} />}>
      <Match when={props.name === 'Bash'}>
        <Pre text={str(props.input.command)} />
      </Match>
      <Match when={props.name === 'Edit'}>
        <Diff before={str(props.input.old_string)} after={str(props.input.new_string)} />
      </Match>
      <Match when={props.name === 'Write'}>
        <Pre text={str(props.input.content)} />
      </Match>
    </Switch>
  )
}

export function ToolCard(props: {
  name: string
  input: Input
  result?: ToolResult
  running: boolean
  cwd?: string
  subagentSteps?: number
}) {
  const [open, setOpen] = createSignal(false)
  const status = () => (props.result ? (props.result.isError ? 'error' : 'done') : props.running ? 'running' : 'stopped')

  return (
    <Show when={props.name !== 'TodoWrite'} fallback={<Todos todos={(props.input.todos as TodoItem[]) ?? []} />}>
      <div class="my-1.5 rounded-lg border border-zinc-200 text-sm dark:border-zinc-800">
        <button
          onClick={() => setOpen(!open())}
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900"
        >
          <ChevronRight class={`size-3.5 shrink-0 text-zinc-400 transition-transform ${open() ? 'rotate-90' : ''}`} />
          <span class="shrink-0 font-medium">{props.name}</span>
          <span class="min-w-0 flex-1 truncate font-mono text-xs text-zinc-500">{toolSummary(props.name, props.input, props.cwd)}</span>
          <Show when={props.subagentSteps}>
            <span class="text-xs text-zinc-400">{props.subagentSteps} steps</span>
          </Show>
          <Switch>
            <Match when={status() === 'running'}>
              <Loader2 class="size-3.5 shrink-0 animate-spin text-zinc-400" />
            </Match>
            <Match when={status() === 'done'}>
              <Check class="size-3.5 shrink-0 text-emerald-600" />
            </Match>
            <Match when={status() === 'error'}>
              <X class="size-3.5 shrink-0 text-red-600" />
            </Match>
          </Switch>
        </button>
        <Show when={open()}>
          <div class="space-y-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
            <ToolInput name={props.name} input={props.input} />
            <Show when={props.result}>
              {(r) => (
                <Pre text={resultText(r().content) || '(no output)'} class={r().isError ? 'text-red-700 dark:text-red-400' : ''} />
              )}
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}

const LIMIT = 4000

export function Pre(props: { text: string; class?: string }) {
  const [full, setFull] = createSignal(false)
  const long = () => props.text.length > LIMIT
  return (
    <div>
      <pre
        class={`max-h-96 overflow-auto rounded-md bg-zinc-50 p-2 font-mono text-xs whitespace-pre-wrap break-words dark:bg-zinc-900 ${props.class ?? ''}`}
      >
        {full() || !long() ? props.text : props.text.slice(0, LIMIT) + '\n…'}
      </pre>
      <Show when={long()}>
        <button onClick={() => setFull(!full())} class="mt-1 text-xs text-zinc-500 hover:underline">
          {full() ? 'Show less' : `Show all (${props.text.length.toLocaleString()} chars)`}
        </button>
      </Show>
    </div>
  )
}

function Diff(props: { before: string; after: string }) {
  return (
    <div class="overflow-auto rounded-md font-mono text-xs">
      <For each={props.before.split('\n')}>
        {(l) => <div class="bg-red-50 px-2 whitespace-pre-wrap text-red-800 dark:bg-red-950/40 dark:text-red-300">- {l}</div>}
      </For>
      <For each={props.after.split('\n')}>
        {(l) => (
          <div class="bg-emerald-50 px-2 whitespace-pre-wrap text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">+ {l}</div>
        )}
      </For>
    </div>
  )
}

interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

function Todos(props: { todos: TodoItem[] }) {
  return (
    <div class="my-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
      <For each={props.todos}>
        {(t) => (
          <div class="flex items-start gap-2 py-0.5">
            <Switch fallback={<Circle class="mt-0.5 size-3.5 shrink-0 text-zinc-400" />}>
              <Match when={t.status === 'completed'}>
                <Check class="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
              </Match>
              <Match when={t.status === 'in_progress'}>
                <CircleDot class="mt-0.5 size-3.5 shrink-0 text-accent" />
              </Match>
            </Switch>
            <span class={t.status === 'completed' ? 'text-zinc-400 line-through' : t.status === 'in_progress' ? 'font-medium' : ''}>
              {t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}
            </span>
          </div>
        )}
      </For>
    </div>
  )
}
