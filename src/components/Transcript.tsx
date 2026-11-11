import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Accessor, type JSX } from 'solid-js'
import { CircleAlert, Repeat2, Scissors, Shield, ShieldAlert } from '../icons'
import type { WireMessage } from '../../shared/protocol.ts'
import { detail } from '../prefs.ts'
import { chatCommands, useChecking, type Partial } from '../useChat.ts'
import { AgentRun, ChildRun } from '../transcript/agents.tsx'
import { NONE, TranscriptIndex, createIndex, useIndex } from '../transcript/context.ts'
import { ApiError, CardContextBadge, CompactDivider, CompactingLine, Idle, Notice, Thinking, UserMessage, WorkingLine, commentChip, contextChip } from '../transcript/items.tsx'
import { buildView, duration, foldWork, lastContext, modelName, retryOf, stopReason, streamingUpdate, within, type Index, type Item, type Row, type Work } from '../transcript/model.ts'
import { Attachments } from './Attachments.tsx'
import { Markdown } from './Markdown.tsx'
import { ReplyBody } from './ReplyComments.tsx'
import { Disclosure, Pre, ToolCard, ToolInput, toolLabel, toolSummary } from './ToolCard.tsx'
import { parsePartialJson } from '../partialJson.ts'
import { LiveDot, compact, plural } from './ui.tsx'

type TranscriptProps = {
  messages: WireMessage[]
  partial: Partial | null
  bashOutput: Record<string, string>
  running: boolean
  /** Running and not stopped on a permission prompt. */
  working: boolean
  cwd?: string
  /** Chats started from tool calls, by tool_use_id; those calls show the child's transcript. */
  children?: Record<string, string>
  /** Given, each turn offers to fork the chat from its end, the id of its last message. */
  onFork?: (at: string) => void
  /** When Claude Code started compacting the conversation, while it is. */
  compacting?: number
  /** Given, an expired login offers to log in again. */
  onLogin?: () => void
  /** Given, a prompt one model refused and another answered offers to fork from just before it, with its text to edit and send again. */
  onRetry?: (retry: { at: string; text: string }) => void
  /** Given, what went in with a prompt can be opened in a panel: by the prompt's message, and which part of it. */
  onOpenAttachment?: (prompt: string, part: string) => void
}

export function Transcript(props: TranscriptProps & { sessionId?: string; index?: Accessor<Index> }) {
  const index = props.index ?? createIndex(() => props.messages, () => props.sessionId)
  return (
    <TranscriptIndex.Provider value={index}>
      <Messages {...props} messages={index().groups.get('') ?? NONE} />
    </TranscriptIndex.Provider>
  )
}

/**
 * One conversation: the chat's own, or a subagent's nested in the call that started it. `folded`: Claude's work always
 * folds, whatever the detail setting, e.g. for an answer shown somewhere other than the chat.
 */
export function Messages(props: TranscriptProps & { nested?: boolean; folded?: boolean }) {
  const index = useIndex()
  const isChecking = useChecking()
  const view = createMemo(() => buildView(props.messages, !!props.nested))
  const folded = createMemo(() => foldWork(view().items))
  const full = () => detail() === 'full' && !props.folded
  // A thinking block straight after another is an update, said rather than thought, so it streams as text.
  const partial = createMemo((): Partial | null => {
    const p = props.partial
    return p?.type === 'thinking' && streamingUpdate(props.messages, p.messageId) ? { ...p, type: 'text' } : p
  })
  /**
   * What Claude's saying as it streams, a row of its own that the reply it becomes then takes the place of, so it isn't
   * drawn again when it's done: by the API message it's in, and which of the message's replies it is.
   */
  const streams = new Map<string, Streamed>()
  const streamed = (key: string) => {
    let s = streams.get(key)
    if (!s) streams.set(key, (s = streamedRow()))
    return s
  }
  const rows = createMemo((): Row[] => {
    const seen = new Map<string, number>()
    const out = (full() ? view().items : folded().rows).map((r) => {
      if (r.kind !== 'text' || !r.streamed) return r
      const n = seen.get(r.streamed) ?? 0
      seen.set(r.streamed, n + 1)
      const s = streams.get(`${r.streamed}#${n}`)
      if (!s) return r
      s.set(r.text, r.id)
      return s.item
    })
    const p = partial()
    if (p?.type !== 'text' || !p.text) return out
    const s = streamed(`${p.messageId}#${seen.get(p.messageId) ?? 0}`)
    s.set(p.text)
    return [...out, s.item]
  })

  const toolName = () => partial()?.toolName ?? ''
  const liveInput = streamedInput(() => (partial()?.type === 'tool_use' ? partial()?.text : undefined))

  const partialWork = () => (
    <>
      <Show when={partial()?.type === 'thinking'}>
        <Thinking text={partial()?.text ?? ''} live />
      </Show>
      <Show when={partial()?.type === 'tool_use'}>
        <Disclosure
          label={toolName() ? toolLabel(toolName()) : 'Tool'}
          detail={toolName() ? toolSummary(toolName(), liveInput(), props.cwd) : undefined}
          trailing={<LiveDot />}
          live
        >
          <ToolInput name={toolName()} input={liveInput()} live />
        </Disclosure>
      </Show>
    </>
  )

  /** What the live work row says Claude is doing right now. */
  const activity = (items: Item[]) => {
    const p = partial()
    if (p?.type === 'tool_use') return p.toolName ? `${toolLabel(p.toolName)} ${toolSummary(p.toolName, liveInput(), props.cwd)}`.trim() : ''
    if (p?.type === 'thinking') return 'Thinking'
    const last = items.findLast((i) => i.kind === 'tool' || i.kind === 'thinking')
    if (last?.kind === 'tool') return `${toolLabel(last.name)} ${toolSummary(last.name, last.input, props.cwd)}`
    return last?.kind === 'thinking' ? 'Thinking' : ''
  }

  // Whether the user opened the live work row to watch. Work goes on in a new row after anything Claude says, which
  // opens too, until the turn ends; and the rows they watched stay open, as one row would have.
  const [following, setFollowing] = createSignal(false)
  createEffect(() => props.running || setFollowing(false))
  const [watched, setWatched] = createSignal(new Set<Work>())

  /** A stretch of work; without `work`, the one just starting, of which only the streaming block has come yet. */
  const WorkRow = (p: { work?: Work }) => {
    const items = () => (p.work && folded().groups.get(p.work)) || []
    const live = () => props.running && (!p.work || folded().tail === p.work)
    const checking = () => live() && !partial() && items().some((i) => i.kind === 'tool' && isChecking(i.id))
    const steps = () => items().filter((i) => i.kind === 'tool').length
    createEffect(() => p.work && live() && following() && !watched().has(p.work) && setWatched(new Set(watched()).add(p.work)))
    return (
      <Disclosure
        live={(live() && following()) || (!!p.work && watched().has(p.work))}
        onToggle={(open) => live() && setFollowing(open)}
        holds={(id) => items().some((i) => i.kind === 'tool' && (i.id === id || within(index(), id, i.id)))}
        label={live() ? 'Working' : steps() ? 'Worked' : 'Thought'}
        detail={live() ? activity(items()) : steps() ? plural(steps(), 'step') : ''}
        trailing={
          <Show when={live()}>
            <Show when={steps()}>
              <span class="shrink-0 text-xs text-fg-3 tabular-nums">{plural(steps(), 'step')}</span>
            </Show>
            <Show when={checking()} fallback={<LiveDot />}>
              <span title="Auto mode is checking whether to allow this">
                <Shield class="size-3.5 shrink-0 animate-pulse text-fg-3" />
              </span>
            </Show>
          </Show>
        }
      >
        <div>
          <For each={items()}>{render}</For>
          <Show when={live()}>{partialWork()}</Show>
        </div>
      </Disclosure>
    )
  }

  // Block layout so vertical margins collapse: prose breathes, tool rows stack tightly.
  const render = (item: Row): JSX.Element => {
    switch (item.kind) {
      case 'work':
        return <WorkRow work={item} />
      case 'user': {
        const id = view().promptIds.get(item)
        // Read as it renders, not once: the chat's workspace, which panels need, can be known only after its messages.
        const open = () => (!props.nested && id ? props.onOpenAttachment : undefined)
        return (
          <UserMessage
            text={item.text}
            command={item.command}
            to={item.to}
            pastes={item.pastes}
            images={item.images}
            card={view().extras.get(item)?.card}
            move={view().extras.get(item)?.move}
            context={[...(view().extras.get(item)?.chips.map(contextChip) ?? []), ...(item.comments?.map(commentChip) ?? [])]}
            onOpenAttachment={open() && ((part) => open()?.(id!, part))}
          />
        )
      }
      case 'text':
        // The chat's own replies can be commented on, once they're done; not a subagent's shown in it.
        return (
          <div class="my-4">
            <ReplyBody id={props.nested ? undefined : item.id} text={item.text} done={!!item.id} />
          </div>
        )
      case 'thinking':
        return <Thinking text={item.text} />
      case 'tool': {
        const child = props.children?.[item.id]
        if (child) return <ChildRun id={item.id} sessionId={child} name={item.name} result={index().results.get(item.id)} />
        if (item.name === 'Agent' || item.name === 'Task') {
          return <AgentRun id={item.id} input={item.input} bashOutput={props.bashOutput} running={props.running} cwd={props.cwd} />
        }
        return (
          <ToolCard
            id={item.id}
            name={item.name}
            input={item.input}
            result={index().results.get(item.id)}
            liveOutput={props.bashOutput[item.id]}
            running={props.running}
            startedAt={index().uses.get(item.id)?.at}
            cwd={props.cwd}
            task={index().tasks.get(item.id)}
            context={index().context.get(item.id)}
            onBackground={!props.nested && item.name === 'Bash' && index().sessionId ? () => chatCommands(index().sessionId!).background(item.id) : undefined}
          />
        )
      }
      case 'result': {
        // Stopped by the user, or on an error already shown above, isn't news; any other way of stopping is.
        const quiet = () => item.ok || view().interrupted.has(item) || view().shownError.has(item)
        return (
          // Its own gap below, as a prompt would bring, for when the next turn starts without one.
          <div class={`mt-4 mb-8 last:mb-0 text-xs tabular-nums ${quiet() ? 'text-fg-3' : 'text-danger'}`}>
            {view().interrupted.has(item) ? 'Interrupted · ' : quiet() ? '' : `Stopped: ${stopReason(item.error)} · `}
            {duration(item.seconds)}
            {item.tokens ? ` · ${compact(item.tokens.input)} in · ${compact(item.tokens.output)} out` : ''}
            <Show when={view().answeredBy.get(item)}>{(model) => ` · ${modelName(model())}`}</Show>
            <Show when={item.endedAt}>{(at) => <Idle from={at()} until={view().idleUntil.get(item)} />}</Show>
            <Show when={!props.nested && props.onFork && view().forkAt.get(item)}>
              {(at) => (
                <>
                  {' · '}
                  <button
                    type="button"
                    title="Copy the chat up to here as a new one"
                    onClick={() => props.onFork!(at())}
                    class="-mx-1 rounded-sm px-1 py-0.5 transition-colors hover:bg-surface"
                  >
                    Fork
                  </button>
                </>
              )}
            </Show>
          </div>
        )
      }
      case 'compact':
        return <CompactDivider item={item} summary={view().summaries.get(item)} />
      case 'card':
        return (
          <Show when={item.context}>
            {(context) => <CardContextBadge context={context()} />}
          </Show>
        )
      case 'chip':
        // Only when there's no prompt to go with, e.g. a hook's context before the first.
        return (
          <div class="my-3">
            <Attachments pastes={[]} images={[]} context={[contextChip(item.chip)]} />
          </div>
        )
      case 'output':
        return (
          <div class="my-3 space-y-1.5">
            <div class="text-xs text-fg-3">Claude Code’s output (Claude sees it too)</div>
            <Pre text={item.text} />
          </div>
        )
      case 'notice':
        return (
          <Notice
            icon={item.tone === 'cut' ? Scissors : item.tone === 'safety' ? ShieldAlert : CircleAlert}
            text={item.text}
            danger={item.tone === 'compact_failed'}
          />
        )
      case 'fallback': {
        const retry = props.onRetry && !props.nested ? retryOf(props.messages, item.refused) : undefined
        return (
          <Notice
            icon={Repeat2}
            text={`${modelName(item.from) ?? 'The model'} declined; ${modelName(item.to) ?? 'another model'} answered instead`}
            action={retry ? { label: 'Edit and retry', run: () => props.onRetry!(retry) } : undefined}
          >
            <p class="whitespace-pre-wrap text-fg-3">{item.content}</p>
          </Notice>
        )
      }
      case 'api_error':
        return <ApiError item={item} onLogin={props.nested ? undefined : props.onLogin} />
    }
  }

  return (
    <div>
      <For each={rows()}>{render}</For>
      <Show
        when={full()}
        fallback={
          // No work row at the end: the turn has just started, or Claude has just said something.
          <Show when={props.running && !props.compacting && !folded().tail && partial()?.type !== 'text'}>
            <Show when={partial()} fallback={<WorkingLine />}>
              <WorkRow />
            </Show>
          </Show>
        }
      >
        {partialWork()}
      </Show>
      <Show when={props.compacting} fallback={<Show when={full() && props.working && !partial()}><WorkingLine /></Show>}>
        {(since) => <CompactingLine since={since()} tokens={lastContext(props.messages)} />}
      </Show>
    </div>
  )
}

type Streamed = { item: Extract<Item, { kind: 'text' }>; set: (text: string, id?: string) => void }

/** A reply's row whose text changes: as it streams, then as the message it became, which gives it its id. */
function streamedRow(): Streamed {
  const [text, setText] = createSignal('')
  const [id, setId] = createSignal<string>()
  return {
    item: {
      kind: 'text',
      get text() {
        return text()
      },
      get id() {
        return id()
      },
    },
    set: (t, i) => {
      setText(t)
      setId(i)
    },
  }
}

/**
 * A tool call's input as far as it has arrived, read from its JSON at most once a frame: Edit and Write inputs arrive
 * a few characters at a time, and are long. A new call starts afresh straight away, so the last one's never shows.
 */
function streamedInput(json: () => string | undefined): Accessor<Record<string, unknown>> {
  const read = (text: string | undefined) => {
    const v = text ? parsePartialJson(text) : undefined
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  }
  const [input, setInput] = createSignal(read(json()))
  let seen = json()
  let frame = 0
  createEffect(() => {
    const text = json()
    const fresh = !text || text.length < (seen?.length ?? 0)
    seen = text
    if (fresh) {
      cancelAnimationFrame(frame)
      frame = 0
      setInput(read(text))
    } else if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0
        setInput(read(seen))
      })
    }
  })
  onCleanup(() => cancelAnimationFrame(frame))
  return input
}

