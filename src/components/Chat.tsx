import { For, Show, createEffect, createSignal, on, onMount } from 'solid-js'
import { ArrowUp, Square } from 'lucide-solid'
import type { PermissionMode } from '../../shared/protocol.ts'
import { socket } from '../api.ts'
import { createChat } from '../useChat.ts'
import { PermissionPrompt } from './PermissionPrompt.tsx'
import { Transcript } from './Transcript.tsx'
import { IconButton, LiveDot, Select, type Option } from './ui.tsx'

const MODES: Option<PermissionMode>[] = [
  { value: 'default', label: 'Ask before edits', description: 'Claude asks before changing files or running commands.' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'File edits go through; commands still ask.' },
  { value: 'auto', label: 'Auto', description: 'A classifier approves safe actions and asks about the rest.' },
  { value: 'plan', label: 'Plan', description: 'Read and propose only. Nothing changes until you approve.' },
  { value: 'bypassPermissions', label: 'Bypass permissions', description: 'Never asks. Anything can run.', tone: 'danger' },
]

export function Chat(props: { sessionId: string; draftCwd?: string }) {
  const { state, clearError } = createChat(props.sessionId)
  const [text, setText] = createSignal('')
  const [mode, setMode] = createSignal<PermissionMode>('auto')
  let scroller!: HTMLDivElement
  let input!: HTMLTextAreaElement
  let pinned = true
  const cwd = () => state.cwd ?? props.draftCwd

  createEffect(on(() => state.mode, setMode))

  // Follow new output only while the user is already at the bottom.
  createEffect(
    on([() => state.messages.length, () => state.partial?.text, () => state.permissions.length], () => {
      if (pinned) scroller.scrollTop = scroller.scrollHeight
    }),
  )

  onMount(() => input.focus())

  const submit = () => {
    const value = text().trim()
    if (!value) return
    socket.send({ type: 'send', sessionId: props.sessionId, text: value, cwd: cwd(), mode: mode() })
    setText('')
    pinned = true
  }

  const changeMode = (next: PermissionMode) => {
    setMode(next)
    socket.send({ type: 'set_mode', sessionId: props.sessionId, mode: next })
  }

  const interrupt = () => socket.send({ type: 'interrupt', sessionId: props.sessionId })

  return (
    <div class="flex h-full min-w-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        class="flex-1 overflow-y-auto"
      >
        <div class="mx-auto max-w-3xl px-5 py-8">
          <Show
            when={!(state.loaded && state.messages.length === 0)}
            fallback={
              <div class="pt-[22vh] text-center">
                <p class="text-base text-fg-2">What are we working on?</p>
                <p class="mt-1.5 font-mono text-xs text-fg-3">{cwd()}</p>
              </div>
            }
          >
            <Transcript messages={state.messages} partial={state.partial} bashOutput={state.bashOutput} running={state.running} cwd={cwd()} />
          </Show>
          <Show when={state.running && !state.partial && state.permissions.length === 0}>
            <div class="mt-4 flex h-6 items-center gap-2 text-[13px] text-fg-3">
              <LiveDot /> Working
            </div>
          </Show>
        </div>
      </div>

      {/* Fade the transcript out as it scrolls under the composer. */}
      <div class="relative mx-auto w-full max-w-3xl space-y-2 px-5 pb-5 before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-linear-to-t before:from-bg">
        <For each={state.permissions}>
          {(p) => <PermissionPrompt sessionId={props.sessionId} permission={p} cwd={cwd()} />}
        </For>
        <Show when={state.error}>
          <div class="flex items-start gap-3 bg-danger/10 rounded-lg px-3 py-2 text-[13px] text-danger">
            <span class="flex-1">{state.error}</span>
            <button onClick={clearError} class="opacity-70 hover:opacity-100">Dismiss</button>
          </div>
        </Show>
        <div class="border border-edge transition-colors rounded-2xl focus-within:border-fg-3">
          <textarea
            ref={input}
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault()
                submit()
              }
              if (e.key === 'Escape' && state.running) interrupt()
            }}
            rows={Math.min(10, Math.max(2, text().split('\n').length))}
            placeholder={state.running ? 'Queue a message' : 'Message Claude'}
            class="block w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed outline-none placeholder:text-fg-3"
          />
          <div class="flex items-center gap-2 px-2 pb-2">
            <Select value={mode()} options={MODES} onChange={changeMode} title="Permission mode" />
            <div class="flex-1" />
            {/* One slot: stop while running with nothing typed, otherwise send. */}
            <Show
              when={state.running && !text().trim()}
              fallback={
                <IconButton onClick={submit} disabled={!text().trim()} title="Send (Enter)">
                  <ArrowUp class="size-4" />
                </IconButton>
              }
            >
              <IconButton onClick={interrupt} title="Stop (Esc)">
                <Square class="size-3 fill-current" />
              </IconButton>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
