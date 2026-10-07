import { For, Show, createEffect, createSignal, on, onMount } from 'solid-js'
import { ArrowUp, FolderOpen, Square } from 'lucide-solid'
import type { PermissionMode } from '../../shared/protocol.ts'
import { socket } from '../api.ts'
import { createChat } from '../useChat.ts'
import { PermissionPrompt } from './PermissionPrompt.tsx'
import { Transcript } from './Transcript.tsx'

const MODES: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Ask before edits' },
  { value: 'acceptEdits', label: 'Auto-accept edits' },
  { value: 'auto', label: 'Auto mode' },
  { value: 'plan', label: 'Plan mode' },
  { value: 'bypassPermissions', label: 'Bypass permissions' },
]

export function Chat(props: { sessionId: string; draftCwd?: string }) {
  const { state, clearError } = createChat(props.sessionId)
  const [text, setText] = createSignal('')
  const [mode, setMode] = createSignal<PermissionMode>('default')
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
      <header class="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 text-sm dark:border-zinc-800">
        <FolderOpen class="size-4 shrink-0 text-zinc-400" />
        <span class="min-w-0 flex-1 truncate font-mono text-xs text-zinc-500">{cwd() ?? '…'}</span>
        <Show when={state.running}>
          <span class="text-xs text-accent">Working…</span>
        </Show>
      </header>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        class="flex-1 overflow-y-auto"
      >
        <div class="mx-auto max-w-3xl px-4 py-6">
          <Show
            when={!(state.loaded && state.messages.length === 0)}
            fallback={
              <div class="pt-[20vh] text-center text-zinc-400">
                <p class="text-lg">What are we working on?</p>
                <p class="mt-1 font-mono text-xs">{cwd()}</p>
              </div>
            }
          >
            <Transcript messages={state.messages} partial={state.partial} running={state.running} cwd={cwd()} />
          </Show>
          <Show when={state.running && !state.partial && state.permissions.length === 0}>
            <div class="mt-3 flex gap-1">
              <For each={[0, 150, 300]}>
                {(d) => <span class="size-1.5 animate-bounce rounded-full bg-accent" style={{ 'animation-delay': `${d}ms` }} />}
              </For>
            </div>
          </Show>
        </div>
      </div>

      <div class="mx-auto w-full max-w-3xl space-y-2 px-4 pb-4">
        <For each={state.permissions}>
          {(p) => <PermissionPrompt sessionId={props.sessionId} permission={p} cwd={cwd()} />}
        </For>
        <Show when={state.error}>
          <div class="flex items-start justify-between gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            <span>{state.error}</span>
            <button onClick={clearError} class="text-xs underline">Dismiss</button>
          </div>
        </Show>
        <div class="rounded-2xl border border-zinc-300 bg-white shadow-sm focus-within:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900">
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
            placeholder={state.running ? 'Queue a message for Claude…' : 'Message Claude…'}
            class="block w-full resize-none bg-transparent px-4 pt-3 outline-none placeholder:text-zinc-400"
          />
          <div class="flex items-center gap-2 px-2 pb-2">
            <select
              value={mode()}
              onChange={(e) => changeMode(e.currentTarget.value as PermissionMode)}
              class="rounded-md bg-transparent px-2 py-1 text-xs text-zinc-600 outline-none hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              <For each={MODES}>{(m) => <option value={m.value}>{m.label}</option>}</For>
            </select>
            <div class="flex-1" />
            <Show when={state.running}>
              <button
                onClick={interrupt}
                title="Stop (Esc)"
                class="rounded-full border border-zinc-300 p-2 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                <Square class="size-3.5 fill-current" />
              </button>
            </Show>
            <button
              onClick={submit}
              disabled={!text().trim()}
              title="Send (Enter)"
              class="rounded-full bg-accent p-2 text-white disabled:opacity-30"
            >
              <ArrowUp class="size-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
