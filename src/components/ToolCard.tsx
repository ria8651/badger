import { useState } from 'react'
import { Check, ChevronRight, Circle, CircleDot, Loader2, X } from 'lucide-react'

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

export function ToolInput({ name, input }: { name: string; input: Input }) {
  if (name === 'Bash') return <Pre>{str(input.command)}</Pre>
  if (name === 'Edit') return <Diff before={str(input.old_string)} after={str(input.new_string)} />
  if (name === 'Write') return <Pre>{str(input.content)}</Pre>
  return <Pre>{JSON.stringify(input, null, 2)}</Pre>
}

export function ToolCard(props: {
  name: string
  input: Input
  result?: ToolResult
  running: boolean
  cwd?: string
  subagentSteps?: number
}) {
  const { name, input, result, running, cwd, subagentSteps } = props
  const [open, setOpen] = useState(false)

  if (name === 'TodoWrite') return <Todos todos={(input.todos as TodoItem[]) ?? []} />

  const status = result ? (result.isError ? 'error' : 'done') : running ? 'running' : 'stopped'
  const output = result ? resultText(result.content) : ''

  return (
    <div className="my-1.5 rounded-lg border border-zinc-200 text-sm dark:border-zinc-800">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900"
      >
        <ChevronRight className={`size-3.5 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="shrink-0 font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-500">{toolSummary(name, input, cwd)}</span>
        {subagentSteps ? <span className="text-xs text-zinc-400">{subagentSteps} steps</span> : null}
        {status === 'running' && <Loader2 className="size-3.5 shrink-0 animate-spin text-zinc-400" />}
        {status === 'done' && <Check className="size-3.5 shrink-0 text-emerald-600" />}
        {status === 'error' && <X className="size-3.5 shrink-0 text-red-600" />}
      </button>
      {open && (
        <div className="space-y-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
          <ToolInput name={name} input={input} />
          {result && (
            <Pre className={result.isError ? 'text-red-700 dark:text-red-400' : ''}>{output || '(no output)'}</Pre>
          )}
        </div>
      )}
    </div>
  )
}

export function Pre({ children, className = '' }: { children: string; className?: string }) {
  const [full, setFull] = useState(false)
  const LIMIT = 4000
  const long = children.length > LIMIT
  return (
    <div>
      <pre
        className={`max-h-96 overflow-auto rounded-md bg-zinc-50 p-2 font-mono text-xs whitespace-pre-wrap break-words dark:bg-zinc-900 ${className}`}
      >
        {full || !long ? children : children.slice(0, LIMIT) + '\n…'}
      </pre>
      {long && (
        <button onClick={() => setFull(!full)} className="mt-1 text-xs text-zinc-500 hover:underline">
          {full ? 'Show less' : `Show all (${children.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  )
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <div className="overflow-auto rounded-md font-mono text-xs">
      {before.split('\n').map((l, i) => (
        <div key={`a${i}`} className="bg-red-50 px-2 whitespace-pre-wrap text-red-800 dark:bg-red-950/40 dark:text-red-300">
          - {l}
        </div>
      ))}
      {after.split('\n').map((l, i) => (
        <div key={`b${i}`} className="bg-emerald-50 px-2 whitespace-pre-wrap text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          + {l}
        </div>
      ))}
    </div>
  )
}

interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

function Todos({ todos }: { todos: TodoItem[] }) {
  return (
    <div className="my-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
      {todos.map((t, i) => (
        <div key={i} className="flex items-start gap-2 py-0.5">
          {t.status === 'completed' ? (
            <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
          ) : t.status === 'in_progress' ? (
            <CircleDot className="mt-0.5 size-3.5 shrink-0 text-accent" />
          ) : (
            <Circle className="mt-0.5 size-3.5 shrink-0 text-zinc-400" />
          )}
          <span className={t.status === 'completed' ? 'text-zinc-400 line-through' : t.status === 'in_progress' ? 'font-medium' : ''}>
            {t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}
          </span>
        </div>
      ))}
    </div>
  )
}
