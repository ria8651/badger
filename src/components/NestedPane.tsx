import { Show, useContext, type Accessor, type JSX } from 'solid-js'
import { SquareArrowOutUpRight } from '../icons'
import { navigate } from '../router.tsx'
import { AgentActions, agentState } from '../transcript/agents.tsx'
import { TranscriptIndex } from '../transcript/context.ts'
import { agentLabel, type Index } from '../transcript/model.ts'
import { ChildChats, agentChat, type Chat as ChatHandle } from '../useChat.ts'
import { Chat } from './Chat.tsx'
import { toolLabel } from './ToolCard.tsx'
import { LiveDot } from './ui.tsx'

/**
 * A nested chat in a panel beside the chat it's in, as a chat you can write to: a child chat is a chat of its own,
 * and a subagent is its part of its chat's, which a message to goes through.
 */
export function NestedPane(props: {
  sessionId: string
  /** The call that started it. */
  id: string
  chat: ChatHandle
  index: Accessor<Index>
  /** A child chat's id; without one, it's a subagent. */
  child?: string
  bashOutput: Record<string, string>
  running: boolean
  cwd?: string
  onShowInChat: () => void
  onReady: (focus: () => void) => void
}) {
  const use = () => props.index().uses.get(props.id)
  return (
    <Show when={use()} fallback={<p class="px-5 pt-3 text-xs text-fg-3">This isn’t in the chat any more.</p>}>
      {(u) => (
        <Show
          when={props.child}
          fallback={
            <TranscriptIndex.Provider value={props.index}>
              <AgentPane {...props} input={u().input} />
            </TranscriptIndex.Provider>
          }
        >
          {(child) => <ChildPane {...props} child={child()} name={u().name} />}
        </Show>
      )}
    </Show>
  )
}

/** A subagent as a chat: its conversation out of its chat's, and a composer whose messages Claude passes on. */
function AgentPane(props: Parameters<typeof NestedPane>[0] & { input: Record<string, unknown> }) {
  const agent = agentState(props)
  const chat = agentChat(props.chat, props.sessionId, {
    toolUseId: props.id,
    id: agent.agentId,
    description: agent.description,
    running: agent.running,
    stop: agent.stop,
  })
  return (
    <Frame
      label={agentLabel(props.input)}
      detail={agent.description()}
      live={agent.running()}
      actions={<AgentActions agent={agent} />}
      onShowInChat={props.onShowInChat}
    >
      <Chat sessionId={props.sessionId} embedded host={{ chat, index: props.index, agent, id: props.id }} onReady={props.onReady} />
    </Frame>
  )
}

/** A chat a tool call started, e.g. a merge: the chat itself. */
function ChildPane(props: Parameters<typeof NestedPane>[0] & { child: string; name: string }) {
  const children = useContext(ChildChats)
  const state = () => children(props.child)
  return (
    <Frame
      label={toolLabel(props.name)}
      detail=""
      live={!!state()?.running}
      actions={
        <button
          type="button"
          onClick={() => navigate({ kind: 'chat', id: props.child })}
          title="Open as a chat of its own"
          class="flex items-center gap-1 text-xs text-fg-3 transition-colors hover:text-fg-2"
        >
          <SquareArrowOutUpRight class="size-3" /> Open as a chat
        </button>
      }
      onShowInChat={props.onShowInChat}
    >
      <Chat sessionId={props.child} embedded onReady={props.onReady} />
    </Frame>
  )
}

/** What a nested chat's panel has around the chat: what it is, what can be done with it, and the way back to its call. */
function Frame(props: { label: string; detail: string; live: boolean; actions?: JSX.Element; onShowInChat: () => void; children: JSX.Element }) {
  return (
    <div class="flex size-full flex-col">
      <div class="flex shrink-0 items-center gap-3 border-b border-line px-4 py-1.5 text-xs">
        <span class="flex min-w-0 flex-1 items-center gap-2">
          <span class="shrink-0 text-fg-2">{props.label}</span>
          <span class="truncate text-fg-3">{props.detail}</span>
          <Show when={props.live}>
            <LiveDot />
          </Show>
        </span>
        {props.actions}
        <button onClick={props.onShowInChat} class="shrink-0 text-fg-3 transition-colors hover:text-fg-2">
          Show in chat
        </button>
      </div>
      <div class="relative min-h-0 flex-1">{props.children}</div>
    </div>
  )
}
