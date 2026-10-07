import { useState } from 'react'
import { ShieldQuestion } from 'lucide-react'
import type { PendingPermission, PermissionMode } from '../../shared/protocol.ts'
import { socket } from '../api.ts'
import { Markdown } from './Markdown.tsx'
import { ToolInput, relPath, toolSummary } from './ToolCard.tsx'

export function PermissionPrompt({
  sessionId,
  permission,
  cwd,
}: {
  sessionId: string
  permission: PendingPermission
  cwd?: string
}) {
  const [feedback, setFeedback] = useState('')
  const { requestId, toolName, input } = permission

  const respond = (decision: 'allow' | 'allow_always' | 'deny', updatedInput?: Record<string, unknown>) =>
    socket.send({ type: 'permission', sessionId, requestId, decision, message: feedback || undefined, updatedInput })

  if (toolName === 'AskUserQuestion') {
    return <QuestionPrompt input={input} onAnswer={(answers) => respond('allow', { ...input, answers })} onSkip={() => respond('deny')} />
  }

  if (toolName === 'ExitPlanMode') {
    const approve = (mode: PermissionMode) => {
      respond('allow')
      socket.send({ type: 'set_mode', sessionId, mode })
    }
    return (
      <Shell title="Ready to leave plan mode?">
        <div className="max-h-[50vh] overflow-auto rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <Markdown text={String(input.plan ?? '')} />
        </div>
        <FeedbackInput value={feedback} onChange={setFeedback} placeholder="Tell Claude what to change (optional)" />
        <div className="flex flex-wrap gap-2">
          <Button primary onClick={() => approve('acceptEdits')}>Approve, auto-accept edits</Button>
          <Button onClick={() => approve('default')}>Approve, ask before edits</Button>
          <Button onClick={() => respond('deny')}>Keep planning</Button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell title={`Allow ${toolName}?`} subtitle={toolSummary(toolName, input, cwd)}>
      <ToolInput name={toolName} input={input} />
      {permission.blockedPath && (
        <p className="text-xs text-amber-700 dark:text-amber-400">Outside allowed directories: {relPath(permission.blockedPath, cwd)}</p>
      )}
      <FeedbackInput value={feedback} onChange={setFeedback} placeholder="Reason for denying (optional)" />
      <div className="flex flex-wrap gap-2">
        <Button primary onClick={() => respond('allow')}>Allow</Button>
        {permission.canAlwaysAllow && <Button onClick={() => respond('allow_always')}>Always allow</Button>}
        <Button onClick={() => respond('deny')}>Deny</Button>
      </div>
    </Shell>
  )
}

interface Question {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string }[]
}

function QuestionPrompt({
  input,
  onAnswer,
  onSkip,
}: {
  input: Record<string, unknown>
  onAnswer: (answers: Record<string, string>) => void
  onSkip: () => void
}) {
  const questions = (input.questions as Question[]) ?? []
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})

  const toggle = (q: Question, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? []
      if (!q.multiSelect) return { ...p, [q.question]: [label] }
      return { ...p, [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
    })

  const answer = (q: Question) => [...(picked[q.question] ?? []), other[q.question]?.trim()].filter(Boolean).join(', ')
  const complete = questions.every((q) => answer(q))

  return (
    <Shell title="Claude has a question">
      {questions.map((q) => (
        <div key={q.question} className="space-y-1.5">
          <p className="font-medium">{q.question}</p>
          <div className="grid gap-1.5">
            {q.options.map((o) => {
              const on = picked[q.question]?.includes(o.label)
              return (
                <button
                  key={o.label}
                  onClick={() => toggle(q, o.label)}
                  className={`rounded-md border px-3 py-2 text-left text-sm ${
                    on ? 'border-accent bg-accent/10' : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900'
                  }`}
                >
                  <div className="font-medium">{o.label}</div>
                  {o.description && <div className="text-xs text-zinc-500">{o.description}</div>}
                </button>
              )
            })}
            <input
              value={other[q.question] ?? ''}
              onChange={(e) => {
                const value = e.target.value
                setOther((o) => ({ ...o, [q.question]: value }))
                if (!q.multiSelect && value) setPicked((p) => ({ ...p, [q.question]: [] }))
              }}
              placeholder="Other…"
              className="rounded-md border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-800"
            />
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <Button primary disabled={!complete} onClick={() => onAnswer(Object.fromEntries(questions.map((q) => [q.question, answer(q)])))}>
          Submit
        </Button>
        <Button onClick={onSkip}>Skip</Button>
      </div>
    </Shell>
  )
}

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-xl border border-accent/40 bg-accent/5 p-4 text-sm">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="size-4 text-accent" />
        <span className="font-semibold">{title}</span>
        {subtitle && <span className="min-w-0 truncate font-mono text-xs text-zinc-500">{subtitle}</span>}
      </div>
      {children}
    </div>
  )
}

function FeedbackInput(props: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <input
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      placeholder={props.placeholder}
      className="w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-accent dark:border-zinc-800 dark:bg-zinc-950"
    />
  )
}

export function Button({
  primary,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      {...props}
      className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${
        primary
          ? 'bg-accent text-white hover:bg-accent/90'
          : 'border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800'
      } ${props.className ?? ''}`}
    />
  )
}
