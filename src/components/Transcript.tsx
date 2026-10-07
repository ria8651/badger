import { useMemo, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import type { WireMessage } from '../../shared/protocol.ts'
import type { Partial } from '../useChat.ts'
import { Markdown } from './Markdown.tsx'
import { ToolCard, type ToolResult } from './ToolCard.tsx'

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> }
type ContentBlock = Block & { tool_use_id?: string; content?: unknown; is_error?: boolean }

type Item =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tool'; key: string; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'result'; key: string; ok: boolean; seconds: number; cost?: number; error?: string }
  | { kind: 'divider'; key: string; text: string }

/** Turn raw SDK messages into renderable items plus a tool_use_id → result map. */
function buildView(messages: WireMessage[]) {
  const items: Item[] = []
  const results = new Map<string, ToolResult>()
  const subagentSteps = new Map<string, number>()

  messages.forEach((m, i) => {
    const key = m.uuid ?? String(i)
    const parent = m.parent_tool_use_id as string | null | undefined
    if (parent) {
      if (m.type === 'assistant') subagentSteps.set(parent, (subagentSteps.get(parent) ?? 0) + 1)
      collectResults(m, results)
      return
    }
    if (m.type === 'user') {
      collectResults(m, results)
      if (m.isMeta || m.isSynthetic) return
      const text = userText(m)
      if (text) items.push({ kind: 'user', key, text })
    } else if (m.type === 'assistant') {
      const content = ((m.message as { content?: Block[] })?.content ?? []) as Block[]
      content.forEach((b, j) => {
        const k = `${key}:${j}`
        if (b.type === 'text' && b.text?.trim()) items.push({ kind: 'text', key: k, text: b.text })
        else if (b.type === 'thinking' && b.thinking?.trim()) items.push({ kind: 'thinking', key: k, text: b.thinking })
        else if (b.type === 'tool_use' && b.id) items.push({ kind: 'tool', key: k, id: b.id, name: b.name ?? '?', input: b.input ?? {} })
      })
    } else if (m.type === 'result') {
      const ok = m.subtype === 'success' && !m.is_error
      items.push({
        kind: 'result',
        key,
        ok,
        seconds: Math.round(Number(m.duration_ms ?? 0) / 1000),
        cost: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined,
        error: ok ? undefined : String(m.subtype === 'success' ? (m.result ?? 'Error') : m.subtype),
      })
    } else if (m.type === 'system' && m.subtype === 'compact_boundary') {
      items.push({ kind: 'divider', key, text: 'Conversation compacted' })
    }
  })
  return { items, results, subagentSteps }
}

function collectResults(m: WireMessage, results: Map<string, ToolResult>) {
  const content = (m.message as { content?: unknown })?.content
  if (!Array.isArray(content)) return
  for (const b of content as ContentBlock[]) {
    if (b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, { content: b.content, isError: !!b.is_error })
  }
}

function userText(m: WireMessage): string {
  const content = (m.message as { content?: unknown })?.content
  const raw =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? (content as ContentBlock[]).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
        : ''
  const command = raw.match(/<command-name>(.*?)<\/command-name>/)
  if (command) return command[1]
  // Harness-injected content (system reminders, command output) is wrapped in tags.
  if (raw.trimStart().startsWith('<')) return ''
  return raw
}

export function Transcript({
  messages,
  partial,
  running,
  cwd,
}: {
  messages: WireMessage[]
  partial: Partial | null
  running: boolean
  cwd?: string
}) {
  const { items, results, subagentSteps } = useMemo(() => buildView(messages), [messages])

  return (
    <div className="space-y-3">
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <div key={item.key} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl bg-zinc-100 px-4 py-2 whitespace-pre-wrap dark:bg-zinc-800">{item.text}</div>
              </div>
            )
          case 'text':
            return <Markdown key={item.key} text={item.text} />
          case 'thinking':
            return <Thinking key={item.key} text={item.text} />
          case 'tool':
            return (
              <ToolCard
                key={item.key}
                name={item.name}
                input={item.input}
                result={results.get(item.id)}
                running={running}
                cwd={cwd}
                subagentSteps={subagentSteps.get(item.id)}
              />
            )
          case 'result':
            return (
              <div key={item.key} className={`text-xs ${item.ok ? 'text-zinc-400' : 'text-red-600'}`}>
                {item.ok ? 'Done' : `Stopped: ${item.error}`} · {item.seconds}s{item.cost != null ? ` · $${item.cost.toFixed(4)}` : ''}
              </div>
            )
          case 'divider':
            return (
              <div key={item.key} className="flex items-center gap-3 text-xs text-zinc-400">
                <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                {item.text}
                <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
              </div>
            )
        }
      })}
      {partial?.type === 'text' && partial.text && <Markdown text={partial.text} />}
      {partial?.type === 'thinking' && <Thinking text={partial.text} live />}
      {partial?.type === 'tool_use' && (
        <div className="text-sm text-zinc-500">Preparing {partial.toolName}…</div>
      )}
    </div>
  )
}

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-sm text-zinc-500">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 hover:text-zinc-700 dark:hover:text-zinc-300">
        <Brain className={`size-3.5 ${live ? 'animate-pulse' : ''}`} />
        {live ? 'Thinking…' : 'Thought'}
        <ChevronRight className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && <div className="mt-1 border-l-2 border-zinc-200 pl-3 whitespace-pre-wrap dark:border-zinc-800">{text}</div>}
    </div>
  )
}
