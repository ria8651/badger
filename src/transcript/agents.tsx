import { Show, createMemo, useContext, type Accessor } from 'solid-js'
import { Link } from '../router.tsx'
import { createStickyScroll } from '../stickyScroll.ts'
import { ChildChats, chatCommands } from '../useChat.ts'
import { Markdown } from '../components/Markdown.tsx'
import { Disclosure, Pre, ToolBody, resultText, toolLabel, toolSummary, type ToolResult } from '../components/ToolCard.tsx'
import { LiveDot, compact, plural } from '../components/ui.tsx'
// Each nests the other: a subagent's run shows its conversation, and a conversation shows the subagents it ran.
import { Messages, Transcript } from '../components/Transcript.tsx'
import { NONE, TranscriptIndex, useIndex } from './context.ts'
import { agentLabel, buildView, handBack, hasToolUse, within, type Block, type Index } from './model.ts'

/* Other conversations inside a chat's: subagents Claude started, and chats a tool call runs and waits on. */

/**
 * A tool call that runs another chat and waits on it, e.g. a merge in the
 * main checkout: that chat's transcript, nested. Its permission prompts show
 * with the parent's, by the composer.
 */
export function ChildRun(props: { sessionId: string; name: string; result?: ToolResult }) {
  const child = useContext(ChildChats)
  const state = () => child(props.sessionId)
  const live = () => !!state()?.running
  const steps = () => state()?.messages.filter((m) => m.type === 'assistant' && !m.parent_tool_use_id && hasToolUse(m)).length ?? 0
  return (
    <Disclosure
      id={props.sessionId}
      label={toolLabel(props.name)}
      detail={state()?.permissions.length ? 'Waiting for you' : live() ? 'Working' : ''}
      trailing={
        <>
          <Show when={steps()}>
            <span class="shrink-0 text-xs text-fg-3 tabular-nums">{plural(steps(), 'step')}</span>
          </Show>
          <Show when={live()}>
            <LiveDot />
          </Show>
          <Show when={props.result?.isError}>
            <span class="shrink-0 text-xs text-danger">Failed</span>
          </Show>
        </>
      }
      live={live()}
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
      <Link to={{ kind: 'chat', id: props.sessionId }} class="inline-block text-xs text-fg-3 transition-colors hover:text-fg-2">
        Open as a chat
      </Link>
    </Disclosure>
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

  return { index, messages, items, task, background, running, status, steps, prompt, report, stop }
}

type Agent = ReturnType<typeof agentState>

/** A subagent's prompt, its own work and its report, with what can be done while it runs. */
export function AgentBody(props: { id: string; agent: Agent; bashOutput: Record<string, string>; cwd?: string }) {
  const a = props.agent
  return (
    <>
      <Show when={a.prompt()}>{(p) => <Markdown text={p()} />}</Show>
      <Show when={a.items().length || a.report()}>
        <div>
          <Messages messages={a.messages()} nested partial={null} bashOutput={props.bashOutput} running={a.running()} working={a.running()} cwd={props.cwd} />
          <Show when={a.report()}>
            {(r) => (
              <div class="my-4">
                <Markdown text={r()} />
              </div>
            )}
          </Show>
        </div>
      </Show>
      <Show when={a.running() && a.task() && a.index().sessionId}>
        <div class="flex gap-4">
          <Show when={!a.background()}>
            <button onClick={() => chatCommands(a.index().sessionId!).background(props.id)} class="text-xs text-fg-3 transition-colors hover:text-fg-2">
              Run in background
            </button>
          </Show>
          <button onClick={a.stop} class="text-xs text-fg-3 transition-colors hover:text-fg-2">
            Stop agent
          </button>
        </div>
      </Show>
    </>
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
    <Disclosure
      id={props.id}
      label={agentLabel(props.input)}
      holds={(id) => within(a.index(), id, props.id)}
      detail={String(props.input.description ?? '')}
      trailing={
        <>
          <Show when={a.running() && a.background()}>
            <span class="shrink-0 text-xs text-fg-3">In background</span>
          </Show>
          <Show when={a.steps()}>
            <span class="shrink-0 text-xs text-fg-3 tabular-nums">
              {plural(a.steps(), 'step')}
              {!a.running() && a.task()?.tokens ? ` · ${compact(a.task()!.tokens!)} tokens` : ''}
            </span>
          </Show>
          <Show when={a.running()}>
            <LiveDot />
          </Show>
          <Show when={!a.running() && a.status() === 'failed'}>
            <span class="shrink-0 text-xs text-danger">Failed</span>
          </Show>
          <Show when={!a.running() && a.status() === 'stopped'}>
            <span class="shrink-0 text-xs text-fg-3">Stopped</span>
          </Show>
        </>
      }
      // One in the background can run for a long while alongside everything else, so it stays folded.
      live={a.running() && !a.background()}
      peek={a.running() && a.task()?.activity && <p class="truncate text-xs text-fg-3">{a.task()!.activity}</p>}
    >
      <AgentBody id={props.id} agent={a} bashOutput={props.bashOutput} cwd={props.cwd} />
    </Disclosure>
  )
}

/**
 * A subagent or background task in a panel of its own: everything its row in
 * the transcript holds, opened out, staying at the bottom as it grows unless
 * scrolled up.
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
  const isAgent = () => use()?.name === 'Agent' || use()?.name === 'Task'
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
        <div
          ref={(el) => sticky.follow(el)}
          class="space-y-2 px-5 pt-2 pb-6 text-[13px]"
        >
          <Show when={use()} fallback={<p class="text-xs text-fg-3">This task isn’t in the chat any more.</p>}>
            {(u) => (
              <>
                <div class="flex items-baseline gap-2">
                  <span class="min-w-0 flex-1 truncate font-mono text-xs text-fg-3">{toolSummary(u().name, u().input, props.cwd)}</span>
                  <button onClick={props.onShowInChat} class="shrink-0 text-xs text-fg-3 transition-colors hover:text-fg-2">
                    Show in chat
                  </button>
                </div>
                <Show
                  when={isAgent()}
                  fallback={
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
                  }
                >
                  <AgentPane id={props.id} input={u().input} bashOutput={props.bashOutput} running={props.running} cwd={props.cwd} />
                </Show>
              </>
            )}
          </Show>
        </div>
      </div>
    </TranscriptIndex.Provider>
  )
}

export function AgentPane(props: { id: string; input: Record<string, unknown>; bashOutput: Record<string, string>; running: boolean; cwd?: string }) {
  const a = agentState(props)
  return <AgentBody id={props.id} agent={a} bashOutput={props.bashOutput} cwd={props.cwd} />
}

