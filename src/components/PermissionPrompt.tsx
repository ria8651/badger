import { For, Match, Show, Switch, createSignal, splitProps, type JSX } from 'solid-js'
import { createStore } from 'solid-js/store'
import { ShieldQuestion } from 'lucide-solid'
import type { PendingPermission, PermissionMode } from '../../shared/protocol.ts'
import { socket } from '../api.ts'
import { Markdown } from './Markdown.tsx'
import { ToolInput, relPath, toolSummary } from './ToolCard.tsx'

export function PermissionPrompt(props: { sessionId: string; permission: PendingPermission; cwd?: string }) {
  const [feedback, setFeedback] = createSignal('')
  const p = () => props.permission

  const respond = (decision: 'allow' | 'allow_always' | 'deny', updatedInput?: Record<string, unknown>) =>
    socket.send({
      type: 'permission',
      sessionId: props.sessionId,
      requestId: p().requestId,
      decision,
      message: feedback() || undefined,
      updatedInput,
    })

  const approvePlan = (mode: PermissionMode) => {
    respond('allow')
    socket.send({ type: 'set_mode', sessionId: props.sessionId, mode })
  }

  return (
    <Switch
      fallback={
        <Shell title={`Allow ${p().toolName}?`} subtitle={toolSummary(p().toolName, p().input, props.cwd)}>
          <ToolInput name={p().toolName} input={p().input} />
          <Show when={p().blockedPath}>
            {(path) => (
              <p class="text-xs text-amber-700 dark:text-amber-400">Outside allowed directories: {relPath(path(), props.cwd)}</p>
            )}
          </Show>
          <FeedbackInput value={feedback()} onChange={setFeedback} placeholder="Reason for denying (optional)" />
          <div class="flex flex-wrap gap-2">
            <Button primary onClick={() => respond('allow')}>Allow</Button>
            <Show when={p().canAlwaysAllow}>
              <Button onClick={() => respond('allow_always')}>Always allow</Button>
            </Show>
            <Button onClick={() => respond('deny')}>Deny</Button>
          </div>
        </Shell>
      }
    >
      <Match when={p().toolName === 'AskUserQuestion'}>
        <QuestionPrompt
          input={p().input}
          onAnswer={(answers) => respond('allow', { ...p().input, answers })}
          onSkip={() => respond('deny')}
        />
      </Match>
      <Match when={p().toolName === 'ExitPlanMode'}>
        <Shell title="Ready to leave plan mode?">
          <div class="max-h-[50vh] overflow-auto rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <Markdown text={String(p().input.plan ?? '')} />
          </div>
          <FeedbackInput value={feedback()} onChange={setFeedback} placeholder="Tell Claude what to change (optional)" />
          <div class="flex flex-wrap gap-2">
            <Button primary onClick={() => approvePlan('auto')}>Approve, auto mode</Button>
            <Button onClick={() => approvePlan('acceptEdits')}>Approve, auto-accept edits</Button>
            <Button onClick={() => approvePlan('default')}>Approve, ask before edits</Button>
            <Button onClick={() => respond('deny')}>Keep planning</Button>
          </div>
        </Shell>
      </Match>
    </Switch>
  )
}

interface Question {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string }[]
}

function QuestionPrompt(props: {
  input: Record<string, unknown>
  onAnswer: (answers: Record<string, string>) => void
  onSkip: () => void
}) {
  const questions = () => (props.input.questions as Question[]) ?? []
  const [picked, setPicked] = createStore<Record<string, string[]>>({})
  const [other, setOther] = createStore<Record<string, string>>({})

  const toggle = (q: Question, label: string) => {
    const cur = picked[q.question] ?? []
    if (!q.multiSelect) setPicked(q.question, [label])
    else setPicked(q.question, cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label])
  }

  const answer = (q: Question) => [...(picked[q.question] ?? []), other[q.question]?.trim()].filter(Boolean).join(', ')
  const complete = () => questions().every((q) => answer(q))

  return (
    <Shell title="Claude has a question">
      <For each={questions()}>
        {(q) => (
          <div class="space-y-1.5">
            <p class="font-medium">{q.question}</p>
            <div class="grid gap-1.5">
              <For each={q.options}>
                {(o) => (
                  <button
                    onClick={() => toggle(q, o.label)}
                    class={`rounded-md border px-3 py-2 text-left text-sm ${
                      picked[q.question]?.includes(o.label)
                        ? 'border-accent bg-accent/10'
                        : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900'
                    }`}
                  >
                    <div class="font-medium">{o.label}</div>
                    <Show when={o.description}>
                      <div class="text-xs text-zinc-500">{o.description}</div>
                    </Show>
                  </button>
                )}
              </For>
              <input
                value={other[q.question] ?? ''}
                onInput={(e) => {
                  const value = e.currentTarget.value
                  setOther(q.question, value)
                  if (!q.multiSelect && value) setPicked(q.question, [])
                }}
                placeholder="Other…"
                class="rounded-md border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-800"
              />
            </div>
          </div>
        )}
      </For>
      <div class="flex gap-2">
        <Button
          primary
          disabled={!complete()}
          onClick={() => props.onAnswer(Object.fromEntries(questions().map((q) => [q.question, answer(q)])))}
        >
          Submit
        </Button>
        <Button onClick={props.onSkip}>Skip</Button>
      </div>
    </Shell>
  )
}

function Shell(props: { title: string; subtitle?: string; children: JSX.Element }) {
  return (
    <div class="space-y-3 rounded-xl border border-accent/40 bg-accent/5 p-4 text-sm">
      <div class="flex items-center gap-2">
        <ShieldQuestion class="size-4 text-accent" />
        <span class="font-semibold">{props.title}</span>
        <Show when={props.subtitle}>
          <span class="min-w-0 truncate font-mono text-xs text-zinc-500">{props.subtitle}</span>
        </Show>
      </div>
      {props.children}
    </div>
  )
}

function FeedbackInput(props: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <input
      value={props.value}
      onInput={(e) => props.onChange(e.currentTarget.value)}
      placeholder={props.placeholder}
      class="w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-accent dark:border-zinc-800 dark:bg-zinc-950"
    />
  )
}

export function Button(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  const [local, rest] = splitProps(props, ['primary', 'class'])
  return (
    <button
      {...rest}
      class={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${
        local.primary
          ? 'bg-accent text-white hover:bg-accent/90'
          : 'border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800'
      } ${local.class ?? ''}`}
    />
  )
}
