import { Show, createSignal, onCleanup, untrack } from 'solid-js'
import { PanelRight } from '../icons'
import type { PendingPermission, PermissionMode } from '../../shared/protocol.ts'
import { socket } from '../api.ts'
import { Markdown } from './Markdown.tsx'
import { MarkdownEditor } from './MarkdownEditor.tsx'
import { resultText } from './ToolCard.tsx'
import type { Index } from './Transcript.tsx'
import { Button, inputClass } from './ui.tsx'

/*
 * A plan Claude proposes with ExitPlanMode can be edited before it's approved, in the
 * prompt above the composer or in a panel beside the chat. What's approved goes back
 * as the tool's input, and Claude Code tells Claude the plan was edited by the user.
 */

/**
 * Edits made in this tab, by request id, ahead of the server's copy. Kept outside the
 * prompt and the panel so both show the same text, and switching between them keeps it.
 */
const [edits, setEdits] = createSignal<Record<string, string>>({})
/** What to tell Claude when sending the plan back, by request id; shared the same way. */
const [feedback, setFeedback] = createSignal<Record<string, string>>({})
/** Plans seen waiting, by tool_use_id. The transcript only keeps approved ones, so this is how a sent-back plan stays readable. */
const seen = new Map<string, string>()

const without = <T,>(record: Record<string, T>, key: string) => {
  const { [key]: _, ...rest } = record
  return rest
}

// Another tab's edit replaces this one's.
socket.on((e) => {
  if (e.type === 'plan_draft') setEdits((all) => without(all, e.requestId))
})

const original = (p: PendingPermission) => String(p.input.plan ?? '')
/** The plan as it stands: edited here, else edited in another tab, else as Claude wrote it. */
export const planText = (p: PendingPermission) => edits()[p.requestId] ?? p.plan ?? original(p)
const edited = (p: PendingPermission) => planText(p) !== original(p)

/** The plan's first heading, or else its first line, to name it by. */
export function planTitle(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const line = lines.find((l) => /^#{1,6}\s/.test(l)) ?? lines[0] ?? ''
  return line.replace(/^#{1,6}\s+/, '').replace(/[*_`]/g, '')
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const sendDraft = (sessionId: string, requestId: string) => {
  clearTimeout(timers.get(requestId))
  timers.delete(requestId)
  const plan = edits()[requestId]
  if (plan !== undefined) socket.send({ type: 'plan_draft', sessionId, requestId, plan })
}

/**
 * The plan, editable. Every edit shows straight away wherever else it's open; the server gets it once typing pauses.
 * One editor is for one request: its ids are read once, since it's cleaned up after the request has gone.
 */
export function PlanEditor(props: { sessionId: string; permission: PendingPermission; class?: string }) {
  const { sessionId, requestId: id, toolUseId } = untrack(() => ({ ...props.permission, sessionId: props.sessionId }))
  if (toolUseId) seen.set(toolUseId, untrack(() => original(props.permission)))
  const save = (plan: string) => {
    setEdits((e) => ({ ...e, [id]: plan }))
    clearTimeout(timers.get(id))
    timers.set(id, setTimeout(() => sendDraft(sessionId, id), 300))
  }
  onCleanup(() => timers.has(id) && sendDraft(sessionId, id))
  return <MarkdownEditor value={planText(props.permission)} onSave={save} saveDelay={0} placeholder="An empty plan" class={props.class} />
}

/** Approve or send back, with what to tell Claude. Edits go with either. */
export function PlanActions(props: { sessionId: string; permission: PendingPermission; onOpen?: () => void }) {
  const p = () => props.permission
  const id = () => p().requestId
  const note = () => feedback()[id()] ?? ''

  const respond = (decision: 'allow' | 'deny', extra: { message?: string; updatedInput?: Record<string, unknown> }) => {
    socket.send({ type: 'permission', sessionId: props.sessionId, requestId: id(), decision, ...extra })
    clearTimeout(timers.get(id()))
    timers.delete(id())
    setEdits((e) => without(e, id()))
    setFeedback((f) => without(f, id()))
  }
  const approve = (mode: PermissionMode) => {
    respond('allow', { updatedInput: edited(p()) ? { ...p().input, plan: planText(p()) } : undefined })
    socket.send({ type: 'set_mode', sessionId: props.sessionId, mode })
  }
  // A plan sent back isn't the tool's input any more, so edits go in the message for Claude to start from.
  const keepPlanning = () => {
    const parts = [note().trim(), edited(p()) ? `I edited the plan. Carry on from my version:\n\n${planText(p())}` : '']
    respond('deny', { message: parts.filter(Boolean).join('\n\n') || undefined })
  }
  const revert = () => {
    setEdits((e) => ({ ...e, [id()]: original(p()) }))
    sendDraft(props.sessionId, id())
  }

  return (
    <>
      <Show when={edited(p())}>
        <p class="text-xs text-fg-3">
          You’ve edited this plan. Claude gets your version.{' '}
          <button onClick={revert} class="underline-offset-2 transition-colors hover:text-fg-2 hover:underline">
            Undo all edits
          </button>
        </p>
      </Show>
      <input
        value={note()}
        onInput={(e) => setFeedback((f) => ({ ...f, [id()]: e.currentTarget.value }))}
        placeholder="Tell Claude what to change (optional)"
        class={inputClass}
      />
      <div class="flex flex-wrap items-center gap-2 pt-1">
        <Button primary onClick={() => approve('auto')}>Approve, auto mode</Button>
        <Button onClick={() => approve('acceptEdits')}>Approve, auto-accept edits</Button>
        <Button onClick={() => approve('default')}>Approve, ask before edits</Button>
        <Button onClick={keepPlanning}>Keep planning</Button>
        <Show when={props.onOpen}>
          <button
            onClick={props.onOpen}
            title="Read and edit it in a panel beside the chat"
            class="ml-auto flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-fg-3 transition-colors hover:bg-surface hover:text-fg-2"
          >
            <PanelRight class="size-3.5" />
            Open beside the chat
          </button>
        </Show>
      </div>
    </>
  )
}

/** The chat's latest plan from its transcript, and what became of it. */
export interface PastPlan {
  text: string
  status: 'approved' | 'edited' | 'sent back' | 'proposed'
}

export function latestPlan(index: Index): PastPlan | undefined {
  const ids = [...index.uses].filter(([id, u]) => u.name === 'ExitPlanMode' && !index.parents.get(id)).map(([id]) => id)
  const id = ids.at(-1)
  if (!id) return
  const input = index.uses.get(id)!.input
  const result = index.results.get(id)
  const structured = result?.structured as { plan?: unknown; planWasEdited?: boolean } | undefined
  const approved = result && !result.isError ? resultText(result.content).match(/^## Approved Plan( \(edited by user\))?:\n([\s\S]*)$/m) : null
  const text =
    (typeof structured?.plan === 'string' ? structured.plan : undefined) ?? approved?.[2] ?? (typeof input.plan === 'string' ? input.plan : undefined) ?? seen.get(id) ?? ''
  const status = !result ? 'proposed' : result.isError ? 'sent back' : structured?.planWasEdited || approved?.[1] ? 'edited' : 'approved'
  return { text: text.trim(), status }
}

const STATUS: Record<PastPlan['status'], string> = {
  approved: 'Approved',
  edited: 'Approved with your edits',
  'sent back': 'Sent back. Claude is working on another version.',
  proposed: 'Proposed, not answered',
}

/** The plan in a panel: the one waiting, to edit and answer, else the last one, to read. */
export function PlanPane(props: {
  sessionId: string
  /** The plan waiting on the user, if one is. */
  permission?: PendingPermission
  past?: PastPlan
  onReady: (focus: () => void) => void
}) {
  return (
    <div class="flex size-full flex-col">
      <div
        ref={(el) => props.onReady(() => el.focus({ preventScroll: true }))}
        tabIndex={-1}
        class="min-h-0 flex-1 overflow-y-auto outline-none"
      >
        <div class="mx-auto max-w-[46rem] px-6 pt-3 pb-8 text-[13px]">
          <Show
            when={props.permission}
            keyed
            fallback={
              <Show when={props.past} fallback={<p class="text-xs text-fg-3">No plan yet. Plans Claude proposes in plan mode show here.</p>}>
                {(past) => (
                  <>
                    <p class="mb-4 text-xs text-fg-3">{STATUS[past().status]}</p>
                    <Show when={past().text} fallback={<p class="text-xs text-fg-3">The plan’s text wasn’t kept.</p>}>
                      <Markdown text={past().text} />
                    </Show>
                  </>
                )}
              </Show>
            }
          >
            {(p) => (
              <>
                <p class="mb-4 flex items-center gap-2 text-xs text-fg-3">
                  <span class="size-1.5 shrink-0 rounded-full bg-accent" />
                  Waiting for you. Edit it here, then approve or send it back.
                </p>
                <PlanEditor sessionId={props.sessionId} permission={p} class="min-h-[6.6em]" />
              </>
            )}
          </Show>
        </div>
      </div>
      {/* Keyed, so one request's editor and buttons are never handed the next one, or read after theirs is answered. */}
      <Show when={props.permission} keyed>
        {(p) => (
          <div class="shrink-0 space-y-3 border-t border-line px-6 py-4 text-[13px]">
            <PlanActions sessionId={props.sessionId} permission={p} />
          </div>
        )}
      </Show>
    </div>
  )
}
