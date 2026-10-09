import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from 'solid-js'
import { ArrowUp, ChevronDown, ListChevronsDownUp, ListChevronsUpDown, Square } from 'lucide-solid'
import type { PermissionMode } from '../../shared/protocol.ts'
import { socket } from '../api.ts'
import { folderItem, isScratch } from '../folders.ts'
import { workspaceOf } from '../terminals.ts'
import { createChat } from '../useChat.ts'
import { PermissionPrompt } from './PermissionPrompt.tsx'
import { TerminalButton, TerminalDock } from './Terminals.tsx'
import { Transcript, detail, setDetail } from './Transcript.tsx'
import { IconButton, Menu, Select, ltr, type Option } from './ui.tsx'

const MODES: Option<PermissionMode>[] = [
  { value: 'default', label: 'Ask before edits', description: 'Claude asks before changing files or running commands.' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'File edits go through; commands still ask.' },
  { value: 'auto', label: 'Auto', description: 'A classifier approves safe actions and asks about the rest.' },
  { value: 'plan', label: 'Plan', description: 'Read and propose only. Nothing changes until you approve.' },
  { value: 'bypassPermissions', label: 'Bypass permissions', description: 'Never asks. Anything can run.', tone: 'danger' },
]

export function Chat(props: {
  sessionId: string
  draftCwd?: string
  /** Offered as a directory picker until the first message goes out. */
  projects?: string[]
  onPickCwd?: (cwd: string) => void
  /** Called once, when the first message is sent. */
  onStart?: () => void
  onOpenTerminal: (id: string) => void
}) {
  const { state, clearError } = createChat(props.sessionId)
  const [text, setText] = createSignal('')
  const [started, setStarted] = createSignal(false)
  const [mode, setMode] = createSignal<PermissionMode>('auto')
  let scroller!: HTMLDivElement
  let content!: HTMLDivElement
  let input!: HTMLTextAreaElement
  let pinned = true
  let lastTop = 0
  const cwd = () => state.cwd ?? props.draftCwd
  // Folderless chats get no terminals: there's no project to run anything in.
  const root = () => {
    const dir = cwd()
    return dir && !isScratch(dir) ? workspaceOf(dir)() : undefined
  }
  const where = () => (isScratch(cwd()) ? 'No folder' : (cwd() ?? ''))

  createEffect(on(() => state.mode, setMode))

  // Unsent text is saved on the server, so it survives leaving the chat or
  // reloading, and every tab on this chat shows the same draft.
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let unsaved = false
  const saveDraft = () => {
    clearTimeout(saveTimer)
    if (!unsaved) return
    unsaved = false
    socket.send({ type: 'draft', sessionId: props.sessionId, text: text() })
  }
  const edit = (value: string) => {
    setText(value)
    unsaved = true
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveDraft, 300)
  }
  // Someone else's edit never overwrites what's typed here and not yet saved.
  const offDraft = socket.on((e) => {
    if (!('sessionId' in e) || e.sessionId !== props.sessionId || unsaved) return
    if (e.type === 'snapshot') setText(e.draft)
    if (e.type === 'draft') setText(e.text)
  })
  addEventListener('pagehide', saveDraft)
  onCleanup(() => {
    saveDraft()
    offDraft()
    removeEventListener('pagehide', saveDraft)
  })

  const fromBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
  const toBottom = () => {
    scroller.scrollTop = scroller.scrollHeight
    lastTop = scroller.scrollTop
  }

  // Any upward move unsticks; reaching the bottom again resticks. Content
  // shrinking clamps scrollTop down too, but leaves us at the bottom.
  const onScroll = () => {
    const top = scroller.scrollTop
    if (top < lastTop - 0.5) {
      if (fromBottom() > 1) pinned = false
    } else if (fromBottom() < 24) pinned = true
    lastTop = top
  }

  onMount(() => {
    input.focus()
    // Follow anything that changes size while stuck: messages, streaming, blocks opening, the composer.
    const observer = new ResizeObserver(() => pinned && toBottom())
    observer.observe(content)
    observer.observe(scroller)
    onCleanup(() => observer.disconnect())
  })


  const submit = () => {
    const value = text().trim()
    if (!value) return
    socket.send({ type: 'send', sessionId: props.sessionId, text: value, cwd: cwd(), mode: mode() })
    if (!started()) {
      setStarted(true)
      props.onStart?.()
    }
    // The server clears the saved draft when the message arrives.
    clearTimeout(saveTimer)
    unsaved = false
    setText('')
    pinned = true
    toBottom()
  }

  const changeMode = (next: PermissionMode) => {
    setMode(next)
    socket.send({ type: 'set_mode', sessionId: props.sessionId, mode: next })
  }

  const interrupt = () => socket.send({ type: 'interrupt', sessionId: props.sessionId })

  return (
    <div class="flex h-full min-w-0 flex-1 flex-col">
      <div class="flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          onScroll={onScroll}
          // Unstick on the gesture itself, before streamed content can push the bottom away.
          onWheel={(e) => e.deltaY < 0 && scroller.scrollHeight > scroller.clientHeight && (pinned = false)}
          class="flex-1 overflow-y-auto [overflow-anchor:none]"
        >
          <div ref={content} class="mx-auto max-w-3xl px-5 py-8">
            <Show
              when={!(state.loaded && state.messages.length === 0)}
              fallback={
                <div class="pt-[22vh] text-center">
                  <p class="text-base text-fg-2">What are we working on?</p>
                  <Show
                    when={props.projects?.length && props.onPickCwd && !state.cwd && !started()}
                    fallback={<p class="mt-1.5 font-mono text-xs text-fg-3">{where()}</p>}
                  >
                    <div class="mt-1 inline-block text-left">
                      <Menu
                        items={props.projects!.map((p) => ({ ...folderItem(p), selected: p === cwd() }))}
                        onPick={(i) => props.onPickCwd!(props.projects![i])}
                        placement="bottom"
                        class="w-72"
                        title="Directory"
                        triggerClass={(open) =>
                          `flex h-7 max-w-md items-center gap-1 rounded-md px-2 font-mono text-xs transition-colors hover:bg-surface hover:text-fg-2 ${
                            open ? 'bg-surface text-fg-2' : 'text-fg-3'
                          }`
                        }
                        trigger={(open) => (
                          <>
                            <span class="truncate text-left [direction:rtl]">{ltr(where())}</span>
                            <ChevronDown class={`size-3 shrink-0 transition-transform ${open() ? 'rotate-180' : ''}`} />
                          </>
                        )}
                      />
                    </div>
                  </Show>
                </div>
              }
            >
              <Transcript
                messages={state.messages}
                partial={state.partial}
                bashOutput={state.bashOutput}
                running={state.running}
                working={state.running && state.permissions.length === 0}
                cwd={cwd()}
              />
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
              onInput={(e) => edit(e.currentTarget.value)}
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
              <Show when={root()}>{(r) => <TerminalButton root={r()} cwd={cwd()!} />}</Show>
              <button
                type="button"
                onClick={() => setDetail(detail() === 'full' ? 'result' : 'full')}
                title={detail() === 'full' ? 'Show results only' : 'Show all work'}
                class="flex h-7 items-center rounded-md px-2 text-fg-3 transition-colors hover:bg-surface hover:text-fg-2"
              >
                {/* Shows what a click does, like play/pause: fold the work away or expand it. */}
                <Show when={detail() === 'full'} fallback={<ListChevronsUpDown class="size-3.5" />}>
                  <ListChevronsDownUp class="size-3.5" />
                </Show>
              </button>
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
      <Show when={root()} keyed>
        {(r) => <TerminalDock root={r} cwd={cwd()!} onOpenPage={props.onOpenTerminal} onHide={() => input.focus()} />}
      </Show>
    </div>
  )
}
