import { For, Match, Show, Switch, createEffect, createSignal, on, onCleanup, type JSX } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { Check } from 'lucide-solid'
import type { AnswerDraft, PendingPermission, PermissionMode } from '../../shared/protocol.ts'
import { socket } from '../api.ts'
import { Markdown } from './Markdown.tsx'
import { ToolInput, relPath, toolLabel, toolSummary, type Question } from './ToolCard.tsx'
import { Button, inputClass } from './ui.tsx'

export function PermissionPrompt(props: {
  sessionId: string
  permission: PendingPermission
  cwd?: string
  /** Set when the prompt is from a chat this one started, e.g. "Merge worktree". */
  from?: string
}) {
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
        <Shell from={props.from} title={`Allow ${toolLabel(p().toolName)}?`} subtitle={toolSummary(p().toolName, p().input, props.cwd)}>
          <ToolInput name={p().toolName} input={p().input} />
          <Show when={p().blockedPath}>
            {(path) => (
              <p class="text-xs text-danger">Outside allowed directories: {relPath(path(), props.cwd)}</p>
            )}
          </Show>
          <FeedbackInput value={feedback()} onChange={setFeedback} placeholder="Reason for denying (optional)" />
          <div class="flex flex-wrap gap-2 pt-1">
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
          from={props.from}
          sessionId={props.sessionId}
          requestId={p().requestId}
          input={p().input}
          draft={p().answers}
          onAnswer={(answers) => respond('allow', { ...p().input, answers })}
          onSkip={() => respond('deny')}
        />
      </Match>
      <Match when={p().toolName === 'ExitPlanMode'}>
        <Shell from={props.from} title="Ready to leave plan mode?">
          <div class="max-h-[50vh] overflow-auto border border-line px-4 py-3 rounded-lg">
            <Markdown text={String(p().input.plan ?? '')} />
          </div>
          <FeedbackInput value={feedback()} onChange={setFeedback} placeholder="Tell Claude what to change (optional)" />
          <div class="flex flex-wrap gap-2 pt-1">
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

/** A plain copy of store data, which structuredClone can't take. */
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

/**
 * Every question at once, so ones that depend on each other can be read together.
 * The questions scroll inside a capped height so the buttons stay on screen.
 * Half-finished answers are saved with the pending question on the server, so they
 * survive reloads and switching chats, and every tab shows the same ones.
 */
function QuestionPrompt(props: {
  from?: string
  sessionId: string
  requestId: string
  input: Record<string, unknown>
  /** Saved answers; changes when another tab edits them. */
  draft?: AnswerDraft
  onAnswer: (answers: Record<string, string>) => void
  onSkip: () => void
}) {
  const questions = () => (props.input.questions as Question[]) ?? []
  const [picked, setPicked] = createStore<Record<string, string[]>>(copy(props.draft?.picked ?? {}))
  const [other, setOther] = createStore<Record<string, string>>(copy(props.draft?.other ?? {}))

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let unsaved = false
  const save = () => {
    clearTimeout(saveTimer)
    if (!unsaved) return
    unsaved = false
    const answers = copy({ picked, other })
    socket.send({ type: 'answer_draft', sessionId: props.sessionId, requestId: props.requestId, answers })
  }
  const edited = () => {
    unsaved = true
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 300)
  }
  onCleanup(save)
  // Another tab's edit never overwrites what's picked here and not yet saved.
  createEffect(
    on(
      () => props.draft,
      (draft) => {
        if (!draft || unsaved) return
        setPicked(reconcile(copy(draft.picked)))
        setOther(reconcile(copy(draft.other)))
      },
      { defer: true },
    ),
  )

  const toggle = (q: Question, label: string) => {
    const cur = picked[q.question] ?? []
    if (q.multiSelect) setPicked(q.question, cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label])
    else setPicked(q.question, cur.includes(label) ? [] : [label])
    edited()
  }

  // With an option picked, the text box is a note on it rather than another answer.
  const answer = (q: Question) => {
    const labels = (picked[q.question] ?? []).join(', ')
    const note = other[q.question]?.trim() ?? ''
    return labels && note ? `${labels} — ${note}` : labels || note
  }
  const unanswered = () => questions().filter((q) => !answer(q)).length

  const submit = () => {
    clearTimeout(saveTimer)
    unsaved = false
    props.onAnswer(Object.fromEntries(questions().map((q) => [q.question, answer(q) || 'No answer'])))
  }

  return (
    <Shell from={props.from} title={questions().length > 1 ? `Claude has ${questions().length} questions` : 'Claude has a question'}>
      <div class="-mx-4 max-h-[60vh] space-y-5 overflow-y-auto px-4">
        <For each={questions()}>
          {(q) => {
            // Only the picked option's preview: following the pointer would reflow the options under it.
            const preview = () => q.options.find((o) => o.label === picked[q.question]?.[0])?.preview
            return (
              <div class="space-y-2">
                <div class="flex items-baseline gap-2">
                  <Show when={q.header && questions().length > 1}>
                    <span class="shrink-0 text-xs text-fg-3">{q.header}</span>
                  </Show>
                  <p class="min-w-0 whitespace-pre-wrap text-fg">{q.question}</p>
                </div>
                <Show when={q.multiSelect}>
                  <p class="text-xs text-fg-3">Pick any that apply.</p>
                </Show>
                <div class="grid gap-1.5">
                  <For each={q.options}>
                    {(o) => {
                      const on = () => picked[q.question]?.includes(o.label)
                      return (
                        <button
                          onClick={() => toggle(q, o.label)}
                          class={`flex items-start gap-2.5 border px-3 py-2 text-left transition-colors rounded-lg ${
                            on() ? 'border-fg-3 bg-surface' : 'border-line hover:bg-surface/60'
                          }`}
                        >
                          <span
                            class={`mt-0.5 grid size-3.5 shrink-0 place-items-center border ${
                              q.multiSelect ? 'rounded' : 'rounded-full'
                            } ${on() ? 'border-fg bg-fg text-bg' : 'border-edge'}`}
                          >
                            <Show when={on()}>
                              <Check size={10} stroke-width={3} />
                            </Show>
                          </span>
                          <span class="min-w-0">
                            <span class="block text-fg">{o.label}</span>
                            <Show when={o.description}>
                              <span class="mt-0.5 block text-xs text-fg-3">{o.description}</span>
                            </Show>
                          </span>
                        </button>
                      )
                    }}
                  </For>
                  <textarea
                    value={other[q.question] ?? ''}
                    onInput={(e) => {
                      setOther(q.question, e.currentTarget.value)
                      edited()
                    }}
                    placeholder={picked[q.question]?.length ? 'Add a note…' : 'Other…'}
                    rows={1}
                    class={`${inputClass} block h-auto min-h-8 resize-none py-1.5 leading-5 [field-sizing:content]`}
                  />
                </div>
                <Show when={preview()}>
                  {(text) => (
                    <div class="border border-line px-4 py-3 rounded-lg">
                      <Markdown text={text()} />
                    </div>
                  )}
                </Show>
              </div>
            )
          }}
        </For>
      </div>
      <div class="flex flex-wrap items-center gap-2 pt-1">
        {/* Unanswered questions go back as "No answer"; Skip declines the whole set. */}
        <Button primary disabled={unanswered() === questions().length} onClick={submit}>
          Submit
        </Button>
        <Button onClick={props.onSkip}>{questions().length > 1 ? 'Skip all' : 'Skip'}</Button>
        <Show when={unanswered() && questions().length > 1}>
          <span class="ml-auto text-xs tabular-nums text-fg-3">{unanswered()} unanswered</span>
        </Show>
      </div>
    </Shell>
  )
}

/** Accent dot: this is waiting on you. */
function Shell(props: { title: string; subtitle?: string; from?: string; children: JSX.Element }) {
  return (
    <div class="space-y-3 border border-edge p-4 text-[13px] rounded-2xl">
      <div class="flex items-center gap-2.5">
        <span class="size-1.5 shrink-0 rounded-full bg-accent" />
        <Show when={props.from}>
          <span class="shrink-0 text-fg-3">{props.from} ·</span>
        </Show>
        <span class="shrink-0 font-medium">{props.title}</span>
        <Show when={props.subtitle}>
          <span class="min-w-0 truncate font-mono text-xs text-fg-3">{props.subtitle}</span>
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
      class={inputClass}
    />
  )
}
