import { For, Match, Show, Switch, createEffect, createSignal, type JSX } from 'solid-js'
import { Check, ChevronRight, Loader2 } from 'lucide-solid'
import type { Task } from '../tasks.ts'
import { Markdown } from './Markdown.tsx'

export interface ToolResult {
  content: unknown
  isError: boolean
  /** The SDK's structured version of the result (`tool_use_result`), on live messages only. */
  structured?: unknown
}

type Input = Record<string, unknown>

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** Path shown relative to the session's working directory when inside it. */
export function relPath(path: string, cwd?: string): string {
  if (cwd && path.startsWith(cwd + '/')) return path.slice(cwd.length + 1)
  return path
}

/** Display name: Badger's own board tools read as actions, other MCP tools as "server: tool". */
export function toolLabel(name: string): string {
  const mcp = name.match(/^mcp__(.+?)__(.+)$/)
  if (!mcp) return name
  const action = mcp[2].replace(/_/g, ' ')
  return mcp[1] === 'badger' ? action[0].toUpperCase() + action.slice(1) : `${mcp[1]}: ${action}`
}

/** One-line description of a tool call for its collapsed header. */
export function toolSummary(name: string, input: Input, cwd?: string): string {
  switch (name) {
    case 'mcp__badger__create_card':
      return str(input.title)
    case 'mcp__badger__update_card': {
      const fields = ['title', 'description', 'status'].filter((k) => input[k] !== undefined)
      return `#${input.id}` + (input.status ? ` → ${input.status}` : fields.length ? ` ${fields.join(', ')}` : '')
    }
    case 'mcp__badger__get_card':
      return input.id === undefined ? 'This chat’s card' : `#${input.id}`
    case 'mcp__badger__link_chat':
    case 'mcp__badger__delete_card':
      return `#${input.id}`
    case 'mcp__badger__list_cards':
      return str(input.status)
    case 'mcp__badger__merge_worktree':
      return ''
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
    case 'SendMessage':
      return str(input.to)
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

export interface Question {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string; preview?: string }[]
}

/**
 * The answers to an AskUserQuestion call. Reloaded transcripts only have the text
 * Claude saw, `"question"="answer", …`, so that's split on the questions it asked.
 */
function questionAnswers(questions: Question[], result: ToolResult): (string | undefined)[] | undefined {
  const structured = (result.structured as { answers?: Record<string, string> } | undefined)?.answers
  if (structured) return questions.map((q) => structured[q.question])
  const text = resultText(result.content)
  const starts = questions.map((q) => {
    const at = text.indexOf(`"${q.question}"="`)
    return at < 0 ? -1 : at + q.question.length + 4
  })
  if (starts.every((s) => s < 0)) return undefined
  return starts.map((start, i) => {
    if (start < 0) return undefined
    const next = starts.slice(i + 1).find((s) => s >= 0)
    const end = next === undefined ? text.indexOf('".', start) : text.lastIndexOf('", "', next)
    return text.slice(start, end < start ? undefined : end)
  })
}

/** What the user answered, laid out like the questions were. */
function Answers(props: { questions: Question[]; answers: (string | undefined)[] }) {
  return (
    <div class="my-3 space-y-2.5 border-l-2 border-line pl-4 text-[13px]">
      <For each={props.questions}>
        {(q, i) => (
          <div>
            <div class="text-fg-3 whitespace-pre-wrap">{q.question}</div>
            <div class="mt-0.5 whitespace-pre-wrap text-fg">{props.answers[i()] ?? '—'}</div>
          </div>
        )}
      </For>
    </div>
  )
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
      <Match when={props.name === 'SendMessage' && typeof props.input.message === 'string'}>
        <Markdown text={str(props.input.message)} />
      </Match>
    </Switch>
  )
}

/**
 * Rows the user opened or closed, by id. Kept outside the rows so the choice
 * survives them being rebuilt: a subagent's steps when its row is folded and
 * reopened, or every row when switching how much detail chats show.
 */
const picks = new Map<string, boolean>()

/**
 * A quiet, expandable row: label, detail, trailing status. Shared by tool calls
 * and thinking so everything Claude does between replies reads the same way.
 */
export function Disclosure(props: {
  /** Stable across rebuilds, e.g. a tool_use_id, so the user's choice is remembered. */
  id?: string
  label: string
  detail?: string
  trailing?: JSX.Element
  /** Shown under the row while collapsed. */
  peek?: JSX.Element
  /** Open while true, folding up once it turns false, until the user opens or closes it. */
  live?: boolean
  children: JSX.Element
}) {
  // Derived rather than synced by an effect: once the user picks, nothing else
  // (other tools finishing, messages arriving) can change it.
  const [picked, setPicked] = createSignal(props.id === undefined ? undefined : picks.get(props.id))
  const open = () => picked() ?? !!props.live
  const toggle = () => {
    const next = !open()
    setPicked(next)
    if (props.id !== undefined) picks.set(props.id, next)
  }
  return (
    <div class="text-[13px]">
      <button
        onClick={toggle}
        class="group -mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-surface"
      >
        <span class="shrink-0 text-fg-2 group-hover:text-fg">{props.label}</span>
        <span class="min-w-0 flex-1 truncate font-mono text-xs text-fg-3">{props.detail}</span>
        {props.trailing}
        <ChevronRight class={`size-3.5 shrink-0 text-fg-3 transition-transform ${open() ? 'rotate-90' : ''}`} />
      </button>
      <Show when={open()} fallback={props.peek && <div class="mt-1 mb-2 pl-4">{props.peek}</div>}>
        <div class="mt-1 mb-2 space-y-2 pl-4">{props.children}</div>
      </Show>
    </div>
  )
}

export function ToolCard(props: {
  id?: string
  name: string
  input: Input
  result?: ToolResult
  /** Output streamed so far while a Bash command runs. */
  liveOutput?: string
  running: boolean
  cwd?: string
  /** Set when Claude Code tracks the call as a task, e.g. a command left running in the background. */
  task?: Task
}) {
  const live = () => (!props.result && props.running ? props.liveOutput : undefined)
  const status = () =>
    props.task?.status === 'running'
      ? 'running'
      : props.result
        ? props.result.isError
          ? 'error'
          : 'done'
        : props.running
          ? 'running'
          : 'stopped'

  const questions = () => (props.input.questions as Question[] | undefined) ?? []
  const answers = () =>
    props.name === 'AskUserQuestion' && props.result && !props.result.isError
      ? questionAnswers(questions(), props.result)
      : undefined

  return (
    <Switch
      fallback={
        <Disclosure
          id={props.id}
          label={toolLabel(props.name)}
          detail={toolSummary(props.name, props.input, props.cwd)}
          trailing={
            <>
              {/* Success is the norm and stays silent; only work in progress and failures show. */}
              <Switch>
                <Match when={status() === 'running'}>
                  <Loader2 class="size-3.5 shrink-0 animate-spin text-fg-3" />
                </Match>
                <Match when={status() === 'error'}>
                  <span class="shrink-0 text-xs text-danger">Failed</span>
                </Match>
              </Switch>
            </>
          }
          live={status() === 'running'}
          peek={live() && <LiveOutput text={live()!} class="max-h-40" />}
        >
          <ToolInput name={props.name} input={props.input} />
          <Show when={live()}>{(text) => <LiveOutput text={text()} class="max-h-96" />}</Show>
          <Show when={props.result}>
            {(r) => <Pre text={resultText(r().content) || '(no output)'} class={r().isError ? 'text-danger' : ''} />}
          </Show>
        </Disclosure>
      }
    >
      <Match when={props.name === 'TodoWrite'}>
        <Todos todos={(props.input.todos as TodoItem[]) ?? []} />
      </Match>
      <Match when={answers()}>{(a) => <Answers questions={questions()} answers={a()} />}</Match>
    </Switch>
  )
}

const preClass = 'overflow-auto rounded-lg bg-surface px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-fg-2'

/** Streaming output that stays scrolled to the bottom unless the user scrolls up. */
function LiveOutput(props: { text: string; class: string }) {
  let el!: HTMLPreElement
  let pinned = true
  createEffect(() => {
    void props.text
    if (pinned) el.scrollTop = el.scrollHeight
  })
  return (
    <pre ref={el} onScroll={() => (pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 8)} class={`${preClass} ${props.class}`}>
      {props.text}
    </pre>
  )
}

const LIMIT = 4000

export function Pre(props: { text: string; class?: string }) {
  const [full, setFull] = createSignal(false)
  const long = () => props.text.length > LIMIT
  return (
    <div>
      <pre class={`max-h-96 ${preClass} ${props.class ?? ''}`}>
        {full() || !long() ? props.text : props.text.slice(0, LIMIT) + '\n…'}
      </pre>
      <Show when={long()}>
        <button onClick={() => setFull(!full())} class="mt-1.5 text-xs text-fg-3 hover:text-fg-2">
          {full() ? 'Show less' : `Show all ${props.text.length.toLocaleString()} characters`}
        </button>
      </Show>
    </div>
  )
}

function Diff(props: { before: string; after: string }) {
  const line = (sign: string, l: string, tone: string) => (
    <div class={`flex px-3 ${tone}`}>
      <span class="w-4 shrink-0 select-none opacity-70">{sign}</span>
      <span class="min-w-0 whitespace-pre-wrap break-words text-fg-2">{l}</span>
    </div>
  )
  return (
    <div class="overflow-auto rounded-lg bg-surface py-2 font-mono text-xs leading-relaxed">
      <For each={props.before.split('\n')}>{(l) => line('−', l, 'bg-danger/10 text-danger')}</For>
      <For each={props.after.split('\n')}>{(l) => line('+', l, 'bg-ok/10 text-ok')}</For>
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
    <div class="my-1 space-y-1 text-[13px]">
      <For each={props.todos}>
        {(t) => (
          <div class="flex items-start gap-2.5">
            <span class="grid h-5 w-3.5 shrink-0 place-items-center">
              <Switch fallback={<span class="size-2 rounded-full border border-fg-3" />}>
                <Match when={t.status === 'completed'}>
                  <Check class="size-3.5 text-fg-3" />
                </Match>
                <Match when={t.status === 'in_progress'}>
                  <span class="size-2 rounded-full bg-accent" />
                </Match>
              </Switch>
            </span>
            <span
              class={`leading-5 ${t.status === 'completed' ? 'text-fg-3 line-through decoration-fg-3/50' : t.status === 'in_progress' ? 'text-fg' : 'text-fg-2'}`}
            >
              {t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}
            </span>
          </div>
        )}
      </For>
    </div>
  )
}
