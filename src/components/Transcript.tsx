import { For, Show, createMemo, type Accessor, type JSX } from 'solid-js'
import { CircleAlert, Repeat2, Scissors, Shield, ShieldAlert } from '../icons'
import type { WireMessage } from '../../shared/protocol.ts'
import { detail } from '../prefs.ts'
import { chatCommands, useChecking, type Partial } from '../useChat.ts'
import { AgentRun, ChildRun } from '../transcript/agents.tsx'
import { NONE, TranscriptIndex, createIndex, useIndex } from '../transcript/context.ts'
import { ApiError, CardContextBadge, CompactDivider, CompactingLine, Idle, Notice, Thinking, UserMessage, WorkingLine, contextChip } from '../transcript/items.tsx'
import { buildView, duration, foldWork, lastContext, modelName, retryOf, stopReason, within, type Index, type Item, type Row, type Work } from '../transcript/model.ts'
import { Attachments } from './Attachments.tsx'
import { Markdown } from './Markdown.tsx'
import { Disclosure, Pre, ToolCard, toolLabel, toolSummary } from './ToolCard.tsx'
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
}

export function Transcript(props: TranscriptProps & { sessionId?: string; index?: Accessor<Index> }) {
  const index = props.index ?? createIndex(() => props.messages, () => props.sessionId)
  return (
    <TranscriptIndex.Provider value={index}>
      <Messages {...props} messages={index().groups.get('') ?? NONE} />
    </TranscriptIndex.Provider>
  )
}

/** One conversation: the chat's own, or a subagent's nested in the call that started it. */
export function Messages(props: TranscriptProps & { nested?: boolean }) {
  const index = useIndex()
  const isChecking = useChecking()
  const view = createMemo(() => buildView(props.messages, !!props.nested))
  const folded = createMemo(() => foldWork(view().items))
  const rows = (): Row[] => (detail() === 'full' ? view().items : folded().rows)

  const partialWork = () => (
    <>
      <Show when={props.partial?.type === 'thinking'}>
        <Thinking text={props.partial?.text ?? ''} live />
      </Show>
      <Show when={props.partial?.type === 'tool_use'}>
        <Disclosure label={props.partial?.toolName ? toolLabel(props.partial.toolName) : 'Tool'} trailing={<LiveDot />} live>
          <Pre text={props.partial?.text ?? ''} />
        </Disclosure>
      </Show>
    </>
  )

  /** What the live work row says Claude is doing right now. */
  const activity = (items: Item[]) => {
    const p = props.partial
    if (p?.type === 'tool_use') return p.toolName ? toolLabel(p.toolName) : ''
    if (p?.type === 'thinking') return 'Thinking'
    const last = items.findLast((i) => i.kind === 'tool' || i.kind === 'thinking')
    if (last?.kind === 'tool') return `${toolLabel(last.name)} ${toolSummary(last.name, last.input, props.cwd)}`
    return last?.kind === 'thinking' ? 'Thinking' : ''
  }

  const WorkRow = (p: { work: Work }) => {
    const items = () => folded().groups.get(p.work) ?? []
    const live = () => props.running && folded().tail === p.work
    const checking = () => live() && !props.partial && items().some((i) => i.kind === 'tool' && isChecking(i.id))
    const steps = () => items().filter((i) => i.kind === 'tool').length
    return (
      <Disclosure
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
      case 'user':
        return (
          <UserMessage
            text={item.text}
            pastes={item.pastes}
            images={item.images}
            card={view().extras.get(item)?.card}
            move={view().extras.get(item)?.move}
            context={view().extras.get(item)?.chips.map(contextChip)}
          />
        )
      case 'text':
        return (
          <div class="my-4">
            <Markdown text={item.text} />
          </div>
        )
      case 'thinking':
        return <Thinking text={item.text} />
      case 'tool': {
        const child = props.children?.[item.id]
        if (child) return <ChildRun sessionId={child} name={item.name} result={index().results.get(item.id)} />
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
          <div class={`mt-4 text-xs tabular-nums ${quiet() ? 'text-fg-3' : 'text-danger'}`}>
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
        when={detail() === 'full'}
        fallback={
          // Nothing to fold yet: the turn has just started, or it's only thinking so far.
          <Show when={props.running && !props.compacting && !folded().tail && props.partial?.type !== 'text'}>
            <WorkingLine detail={activity([])} />
          </Show>
        }
      >
        {partialWork()}
      </Show>
      <Show when={props.partial?.type === 'text' && props.partial.text}>
        <div class="my-4">
          <Markdown text={props.partial?.text ?? ''} />
        </div>
      </Show>
      <Show when={props.compacting} fallback={<Show when={detail() === 'full' && props.working && !props.partial}><WorkingLine /></Show>}>
        {(since) => <CompactingLine since={since()} tokens={lastContext(props.messages)} />}
      </Show>
    </div>
  )
}

