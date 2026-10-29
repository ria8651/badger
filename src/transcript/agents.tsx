import { Show, createContext, createMemo, useContext, type Accessor, type JSX } from 'solid-js'
import { PanelRight } from '../icons'
import { Link } from '../router.tsx'
import { createStickyScroll } from '../stickyScroll.ts'
import { ChildChats, chatCommands } from '../useChat.ts'
import { Markdown } from '../components/Markdown.tsx'
import { Disclosure, Pre, ToolBody, resultText, toolLabel, toolSummary, type ToolResult } from '../components/ToolCard.tsx'
import { LiveDot, compact, plural } from '../components/ui.tsx'
// Each nests the other: a subagent's run shows its conversation, and a conversation shows the subagents it ran.
import { Messages, Transcript } from '../components/Transcript.tsx'
import { NONE, TranscriptIndex, useIndex } from './context.ts'
import { UserMessage } from './items.tsx'
import { agentIdIn, agentLabel, buildView, handBack, hasToolUse, within, type Block, type Index } from './model.ts'

/*
 * Other conversations inside a chat's: subagents Claude started, and chats a tool call runs and waits on, like a
 * merge. Both are nested chats, shown alike: a row in the call that started them that opens to their conversation,
 * and a panel of their own beside the chat, where you can write to them too.
 */

/** Opens a nested chat in a panel beside its chat, by the call that started it; undefined while there's nowhere to. */
export const OpenNested = createContext<() => ((toolUseId: string) => void) | undefined>(() => undefined)

/** A nested chat's row in the call that started it: how it's going, opening to its conversation. */
function NestedRun(props: {
  id: string
  label: string
  detail: string
  running: boolean
  /** It runs on its own while the chat gets on, so it stays folded. */
  background?: boolean
  waiting?: boolean
  steps: number
  tokens?: number
  outcome?: 'failed' | 'stopped'
  /** What it's doing now, under the row while it's folded. */
  peek?: JSX.Element
  holds?: (id: string) => boolean
  /** What else can be done with it, after opening it beside the chat. */
  actions?: JSX.Element
  children: JSX.Element
}) {
  const open = useContext(OpenNested)
  const action = 'text-xs text-fg-3 transition-colors hover:text-fg-2'
  return (
    <Disclosure
      id={props.id}
      label={props.label}
      holds={props.holds}
      detail={props.waiting ? 'Waiting for you' : props.detail}
      trailing={
        <>
          <Show when={props.running && props.background}>
            <span class="shrink-0 text-xs text-fg-3">In background</span>
          </Show>
          <Show when={props.steps}>
            <span class="shrink-0 text-xs text-fg-3 tabular-nums">
              {plural(props.steps, 'step')}
              {!props.running && props.tokens ? ` · ${compact(props.tokens)} tokens` : ''}
            </span>
          </Show>
          <Show when={props.running}>
            <LiveDot />
          </Show>
          <Show when={!props.running && props.outcome === 'failed'}>
            <span class="shrink-0 text-xs text-danger">Failed</span>
          </Show>
          <Show when={!props.running && props.outcome === 'stopped'}>
            <span class="shrink-0 text-xs text-fg-3">Stopped</span>
          </Show>
        </>
      }
      live={props.running && !props.background}
      peek={props.peek}
    >
      {props.children}
      <div class="flex flex-wrap gap-x-4 gap-y-1">
        <Show when={open()}>
          {(open) => (
            <button onClick={() => open()(props.id)} class={`flex items-center gap-1 ${action}`}>
              <PanelRight class="size-3" /> Open beside the chat
            </button>
          )}
        </Show>
        {props.actions}
      </div>
    </Disclosure>
  )
}

/**
 * A tool call that runs another chat and waits on it, e.g. a merge in the
 * main checkout: that chat's transcript, nested. Its permission prompts show
 * with the parent's, by the composer.
 */
export function ChildRun(props: { id: string; sessionId: string; name: string; result?: ToolResult }) {
  const child = useContext(ChildChats)
  const state = () => child(props.sessionId)
  const steps = () => state()?.messages.filter((m) => m.type === 'assistant' && !m.parent_tool_use_id && hasToolUse(m)).length ?? 0
  return (
    <NestedRun
      id={props.id}
      label={toolLabel(props.name)}
      detail={state()?.running ? 'Working' : ''}
      running={!!state()?.running}
      waiting={!!state()?.permissions.length}
      steps={steps()}
      outcome={props.result?.isError ? 'failed' : undefined}
      actions={
        <Link to={{ kind: 'chat', id: props.sessionId }} class="text-xs text-fg-3 transition-colors hover:text-fg-2">
          Open as a chat
        </Link>
      }
    >
      <Show when={state()?.loaded && state()} fallback={<p class="py-1 text-xs text-fg-3">Loading…</p>}>
        {(s) => (
          <Transcript
            sessionId={props.sessionId}
            messages={s().messages}
            partial={s().partial}
            bashOutput={s().bashOutput}
            running={s().running}
            working={s().running && s().permissions.length === 0}
            cwd={s().cwd}
          />
        )}
      </Show>
      <Show when={props.result?.isError && props.result}>{(r) => <Pre text={resultText(r().content)} class="text-danger" />}</Show>
    </NestedRun>
  )
}

/** How a subagent Claude Code started with the Agent tool is going, read from the chat's index. */
export function agentState(props: { id: string; input: Record<string, unknown>; running: boolean }) {
  const index = useIndex()
  // A memo: a subagent's group is a new array only when it grows, so the others' views aren't rebuilt for every message.
  const messages = createMemo(() => index().groups.get(props.id) ?? NONE)
  const items = createMemo(() => buildView(messages(), true).items)
  const task = () => index().tasks.get(props.id)
  const result = () => index().results.get(props.id)
  const structured = () => result()?.structured as { status?: string; content?: Block[] } | undefined
  const launched = () => structured()?.status === 'async_launched' || resultText(result()?.content).startsWith('Async agent launched')
  const background = () => task()?.background ?? launched()
  const running = () => {
    const t = task()
    return t ? t.status === 'running' : !result() && props.running
  }
  const status = () => task()?.status ?? (result()?.isError ? 'failed' : undefined)
  const steps = () => Math.max(items().filter((i) => i.kind === 'tool').length, task()?.toolUses ?? 0)
  const prompt = () => (typeof props.input.prompt === 'string' ? props.input.prompt : '')
  const description = () => String(props.input.description ?? '') || agentLabel(props.input)
  /** Its id, which SendMessage reaches it by: from its task, or what its call returned. */
  const agentId = () => task()?.id ?? agentIdIn(result()?.content) ?? [...index().agents].find(([, call]) => call === props.id)?.[0]

  /** The report, when its own transcript doesn't already end with it (live, a foreground agent's last message isn't sent). */
  const report = () => {
    if (running() || items().at(-1)?.kind === 'text') return undefined
    const text = (structured()?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    if (text) return text
    if (task()?.summary) return task()!.summary
    if (result() && !launched()) return handBack(resultText(result()!.content))
  }

  const stop = () => {
    const sessionId = index().sessionId
    const t = task()
    if (sessionId && t) chatCommands(sessionId).stopTask(t.id)
  }
  const toBackground = () => {
    const sessionId = index().sessionId
    if (sessionId) chatCommands(sessionId).background(props.id)
  }

  return { index, messages, items, task, background, running, status, steps, prompt, description, agentId, report, stop, toBackground }
}

export type Agent = ReturnType<typeof agentState>

/** A subagent's conversation: what it was asked, as a message to it, its work and anything sent to it since, then its report. */
export function AgentConversation(props: { agent: Agent; bashOutput: Record<string, string>; cwd?: string }) {
  const a = props.agent
  return (
    <div>
      <Show when={a.prompt()}>{(p) => <UserMessage text={p()} />}</Show>
      <Messages messages={a.messages()} nested partial={null} bashOutput={props.bashOutput} running={a.running()} working={a.running()} cwd={props.cwd} />
      <Show when={a.report()}>
        {(r) => (
          <div class="my-4">
            <Markdown text={r()} />
          </div>
        )}
      </Show>
    </div>
  )
}

/** What can be done with a running subagent: let the chat get on without it, or stop it. */
export function AgentActions(props: { agent: Agent }) {
  const a = props.agent
  const action = 'text-xs text-fg-3 transition-colors hover:text-fg-2'
  return (
    <Show when={a.running() && a.task() && a.index().sessionId}>
      <Show when={!a.background()}>
        <button onClick={a.toBackground} class={action}>
          Run in background
        </button>
      </Show>
      <button onClick={a.stop} class={action}>
        Stop agent
      </button>
    </Show>
  )
}

/**
 * A subagent Claude Code started with the Agent tool: its own work nested in
 * the call, then its report. One in the background keeps running after the
 * call returns, until its task says it's done.
 */
export function AgentRun(props: { id: string; input: Record<string, unknown>; bashOutput: Record<string, string>; running: boolean; cwd?: string }) {
  const a = agentState(props)
  return (
    <NestedRun
      id={props.id}
      label={agentLabel(props.input)}
      holds={(id) => within(a.index(), id, props.id)}
      detail={String(props.input.description ?? '')}
      running={a.running()}
      background={a.background()}
      steps={a.steps()}
      tokens={a.task()?.tokens}
      outcome={a.status() === 'failed' || a.status() === 'stopped' ? a.status() as 'failed' | 'stopped' : undefined}
      peek={a.running() && a.task()?.activity && <p class="truncate text-xs text-fg-3">{a.task()!.activity}</p>}
      actions={<AgentActions agent={a} />}
    >
      <AgentConversation agent={a} bashOutput={props.bashOutput} cwd={props.cwd} />
    </NestedRun>
  )
}

/**
 * A background task other than a subagent, e.g. a shell, in a panel of its
 * own: everything its row in the transcript holds, opened out, staying at the
 * bottom as it grows unless scrolled up.
 */
export function TaskPane(props: {
  id: string
  index: Accessor<Index>
  bashOutput: Record<string, string>
  running: boolean
  cwd?: string
  onShowInChat: () => void
  onReady: (focus: () => void) => void
}) {
  const sticky = createStickyScroll()
  const use = () => props.index().uses.get(props.id)
  return (
    <TranscriptIndex.Provider value={props.index}>
      <div
        ref={(el) => {
          sticky.ref(el)
          props.onReady(() => el.focus({ preventScroll: true }))
        }}
        tabIndex={-1}
        onScroll={sticky.onScroll}
        onWheel={sticky.onWheel}
        class="size-full overflow-y-auto outline-none [overflow-anchor:none]"
      >
        <div ref={(el) => sticky.follow(el)} class="space-y-2 px-5 pt-2 pb-6 text-ui">
          <Show when={use()} fallback={<p class="text-xs text-fg-3">This task isn’t in the chat any more.</p>}>
            {(u) => (
              <>
                <div class="flex items-baseline gap-2">
                  <span class="min-w-0 flex-1 truncate font-mono text-xs text-fg-3">{toolSummary(u().name, u().input, props.cwd)}</span>
                  <button onClick={props.onShowInChat} class="shrink-0 text-xs text-fg-3 transition-colors hover:text-fg-2">
                    Show in chat
                  </button>
                </div>
                <ToolBody
                  id={props.id}
                  name={u().name}
                  input={u().input}
                  result={props.index().results.get(props.id)}
                  liveOutput={props.bashOutput[props.id]}
                  running={props.running}
                  cwd={props.cwd}
                  task={props.index().tasks.get(props.id)}
                  fill
                />
              </>
            )}
          </Show>
        </div>
      </div>
    </TranscriptIndex.Provider>
  )
}
