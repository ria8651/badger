import type { WireMessage } from '../shared/protocol.ts'

/** How a subagent, or other work Claude Code tracks as a task, is going. */
export interface Task {
  id: string
  /** The tool call that started it. */
  toolUseId: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  /** The call returned straight away and the work carried on without it. */
  background: boolean
  /** What it's doing now, while it runs. */
  activity?: string
  /** Its final word, from the notification when it ended. */
  summary?: string
  tokens?: number
  toolUses?: number
}

type Usage = { total_tokens?: number; tool_uses?: number }

const STATUSES: Record<string, Task['status']> = {
  pending: 'running',
  running: 'running',
  paused: 'running',
  completed: 'completed',
  failed: 'failed',
  killed: 'stopped',
  stopped: 'stopped',
}

/**
 * Tasks by the tool_use_id that started them. Live, they come from Claude
 * Code's task events; read back from disk there are none of those, only the
 * notification it gave Claude when a background task ended.
 */
export function collectTasks(messages: WireMessage[]): Map<string, Task> {
  const byId = new Map<string, Task>()
  const byToolUse = new Map<string, Task>()
  const start = (id: string, toolUseId: string, background: boolean) => {
    const task: Task = { id, toolUseId, status: 'running', background }
    byId.set(id, task)
    byToolUse.set(toolUseId, task)
    return task
  }
  const usage = (task: Task, u: Usage | undefined) => {
    if (typeof u?.total_tokens === 'number') task.tokens = u.total_tokens
    if (typeof u?.tool_uses === 'number') task.toolUses = u.tool_uses
  }

  for (const m of messages) {
    if (m.type === 'user') {
      const n = notification(m)
      if (!n) continue
      const task = byId.get(n.id) ?? start(n.id, n.toolUseId, true)
      task.status = n.status
      task.summary = n.summary
      usage(task, n.usage)
      continue
    }
    if (m.type !== 'system') continue
    const id = m.task_id as string
    const toolUseId = m.tool_use_id as string | undefined
    switch (m.subtype) {
      case 'task_started': {
        if (!toolUseId || m.skip_transcript) break
        // A resumed subagent keeps its id and starts again.
        const task = byId.get(id) ?? start(id, toolUseId, !!m.is_backgrounded)
        task.status = 'running'
        task.activity = undefined
        break
      }
      case 'task_progress': {
        const task = byId.get(id)
        if (!task) break
        task.activity = String(m.summary ?? m.description ?? '') || undefined
        usage(task, m.usage as Usage)
        break
      }
      case 'task_updated': {
        const task = byId.get(id)
        const patch = m.patch as { status?: string; is_backgrounded?: boolean }
        if (!task) break
        if (patch.status && STATUSES[patch.status]) task.status = STATUSES[patch.status]
        if (patch.is_backgrounded !== undefined) task.background = patch.is_backgrounded
        break
      }
      case 'task_notification': {
        const task = byId.get(id) ?? (toolUseId ? start(id, toolUseId, true) : undefined)
        if (!task) break
        task.status = STATUSES[String(m.status)] ?? 'completed'
        task.summary = String(m.summary ?? '') || undefined
        usage(task, m.usage as Usage)
        break
      }
    }
  }
  return byToolUse
}

/** The `<task-notification>` Claude was given when a background task ended, as saved in the transcript. */
function notification(m: WireMessage) {
  const content = (m.message as { content?: unknown } | undefined)?.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => b?.text ?? '').join('') : ''
  if (!text.includes('<task-notification>')) return undefined
  const tag = (name: string) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]
  const id = tag('task-id')
  const toolUseId = tag('tool-use-id')
  if (!id || !toolUseId) return undefined
  const num = (name: string) => (tag(name) === undefined ? undefined : Number(tag(name)))
  return {
    id,
    toolUseId,
    status: STATUSES[tag('status') ?? ''] ?? 'completed',
    summary: tag('result')?.trim() || tag('summary'),
    usage: { total_tokens: num('subagent_tokens'), tool_uses: num('tool_uses') },
  }
}

/** What to call a kind of task. */
export function taskLabel(type: string): string {
  switch (type) {
    case 'local_agent':
      return 'Agent'
    case 'local_bash':
      return 'Shell'
    case 'local_workflow':
      return 'Workflow'
    default: {
      const words = type.replace(/^local_/, '').replace(/_/g, ' ')
      return words ? words[0].toUpperCase() + words.slice(1) : 'Task'
    }
  }
}
