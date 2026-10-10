import { For, Show, createEffect, createMemo, createResource, createSignal, mapArray, on, onCleanup, onMount } from 'solid-js'
import { ArrowUp, Check, GitBranch, ListChevronsDownUp, ListChevronsUpDown, Square, Zap } from 'lucide-solid'
import { isLongPaste } from '../../shared/pastes.ts'
import type { BackgroundTask, Card, PermissionMode } from '../../shared/protocol.ts'
import { chatActions } from '../actions.ts'
import { api, socket } from '../api.ts'
import { cardWorktreeName, folderItem, isScratch, worktreeOf } from '../folders.ts'
import { taskLabel } from '../tasks.ts'
import { workspaceOf } from '../terminals.ts'
import { ChildChats, createChat } from '../useChat.ts'
import { Pastes } from './Pastes.tsx'
import { PermissionPrompt } from './PermissionPrompt.tsx'
import { TerminalButton, TerminalDock } from './Terminals.tsx'
import { toolLabel } from './ToolCard.tsx'
import { CardBadge, Transcript, detail, setDetail } from './Transcript.tsx'
import { IconButton, LiveDot, Menu, Select, ltr, type Option } from './ui.tsx'

const MODES: Option<PermissionMode>[] = [
  { value: 'default', label: 'Ask before edits', description: 'Claude asks before changing files or running commands.' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'File edits go through; commands still ask.' },
  { value: 'auto', label: 'Auto', description: 'A classifier approves safe actions and asks about the rest.' },
  { value: 'plan', label: 'Plan', description: 'Read and propose only. Nothing changes until you approve.' },
  { value: 'bypassPermissions', label: 'Bypass permissions', description: 'Never asks. Anything can run.', tone: 'danger' },
]

/**
 * Unsent pastes by chat. Kept outside the component so they survive switching
 * chats, though not a reload: unlike the draft, they aren't saved on the server.
 */
const unsentPastes = new Map<string, string[]>()

export function Chat(props: {
  sessionId: string
  draftCwd?: string
  /** Offered as a directory picker until the first message goes out; existing chats never show it. */
  projects?: string[]
  onPickCwd?: (cwd: string) => void
  /** The card this chat is on. A worktree it starts in is named after the card; otherwise Claude names it. */
  card?: Card
  /** Start with "In a worktree" ticked. */
  worktree?: boolean
  /** Called once, when the first message is sent. */
  onStart?: () => void
  onOpenTerminal: (id: string) => void
}) {
  const { state, clearError } = createChat(props.sessionId)
  const [text, setText] = createSignal('')
  const [pastes, setPastes] = createSignal(unsentPastes.get(props.sessionId) ?? [])
  createEffect(() => unsentPastes.set(props.sessionId, pastes()))
  const hasInput = () => !!text().trim() || pastes().length > 0
  const [started, setStarted] = createSignal(false)
  const [mode, setMode] = createSignal<PermissionMode>('auto')
  const [inWorktree, setInWorktree] = createSignal(!!props.worktree)
  const worktreeName = () => props.card && cardWorktreeName(props.card)
  // Offered before the first message, for a repo checkout that isn't already a worktree.
  const canWorktree = () => !started() && !state.cwd && !!cwd() && !isScratch(cwd()) && !worktreeOf(cwd())
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

  // Chats this one started and waits on, subscribed once here for their tool calls and their prompts.
  // Mapped over tool_use_ids, which are strings, so adding a child never resubscribes the others.
  const childChats = mapArray(
    createMemo(() => Object.keys(state.children)),
    (toolUseId) => {
      const id = state.children[toolUseId]
      return { id, toolUseId, state: createChat(id).state }
    },
  )
  const childState = (id: string) => childChats().find((c) => c.id === id)?.state
  const childPrompts = () => childChats().flatMap((c) => c.state.permissions.map((p) => ({ child: c, permission: p })))
  /** The tool that started a child, to say whose prompt it is. */
  const toolName = (toolUseId: string) => {
    for (const m of state.messages) {
      const content = (m.message as { content?: { type: string; id?: string; name?: string }[] } | undefined)?.content
      const use = Array.isArray(content) && content.find((b) => b.type === 'tool_use' && b.id === toolUseId)
      if (use) return use.name ?? ''
    }
    return ''
  }

  // Fetched on opening and again each time a turn ends, since that's when commits happen.
  const [worktree, { refetch: refetchWorktree }] = createResource(
    () => state.loaded && worktreeOf(cwd()) && cwd(),
    (dir) => api.worktree(dir).catch(() => undefined),
  )
  createEffect(on(() => state.running, (running) => !running && refetchWorktree(), { defer: true }))
  const actions = () => chatActions({ worktree: worktree() })

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


  const send = (value: string, attached: string[] = []) => {
    const worktree = inWorktree() && canWorktree() ? (worktreeName() ?? '') : undefined
    socket.send({ type: 'send', sessionId: props.sessionId, text: value, pastes: attached, cwd: cwd(), mode: mode(), worktree })
    if (!started()) {
      setStarted(true)
      props.onStart?.()
    }
    pinned = true
    toBottom()
  }

  const submit = () => {
    if (!hasInput()) return
    send(text().trim(), pastes())
    // The server clears the saved draft when the message arrives.
    clearTimeout(saveTimer)
    unsaved = false
    setText('')
    setPastes([])
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
                    <FolderPicker folders={props.projects!} selected={cwd()} onPick={props.onPickCwd!} />
                  </Show>
                  <Show when={canWorktree()}>
                    <WorktreeOption checked={inWorktree()} onChange={setInWorktree} name={worktreeName()} />
                  </Show>
                  {/* So a card's new chat isn't mistaken for a plain one. */}
                  <Show when={props.card}>{(card) => <div class="mt-4"><CardBadge card={card()} prefix="On card" /></div>}</Show>
                </div>
              }
            >
              <ChildChats.Provider value={childState}>
                <Transcript
                  sessionId={props.sessionId}
                  messages={state.messages}
                  partial={state.partial}
                  bashOutput={state.bashOutput}
                  running={state.running}
                  working={state.running && state.permissions.length === 0 && childPrompts().length === 0}
                  cwd={cwd()}
                  children={state.children}
                />
              </ChildChats.Provider>
            </Show>
          </div>
        </div>

        {/* Fade the transcript out as it scrolls under the composer. */}
        <div class="relative mx-auto w-full max-w-3xl space-y-2 px-5 pb-5 before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-linear-to-t before:from-bg">
          <For each={state.permissions}>
            {(p) => <PermissionPrompt sessionId={props.sessionId} permission={p} cwd={cwd()} from={p.agent} />}
          </For>
          <For each={childPrompts()}>
            {({ child, permission }) => (
              <PermissionPrompt
                sessionId={child.id}
                permission={permission}
                cwd={child.state.cwd}
                from={toolLabel(toolName(child.toolUseId)) || 'Another chat'}
              />
            )}
          </For>
          <Show when={state.background.length}>
            <Background sessionId={props.sessionId} tasks={state.background} />
          </Show>
          <Show when={state.error}>
            <div class="flex items-start gap-3 bg-danger/10 rounded-lg px-3 py-2 text-[13px] text-danger">
              <span class="flex-1">{state.error}</span>
              <button onClick={clearError} class="opacity-70 hover:opacity-100">Dismiss</button>
            </div>
          </Show>
          <div class="border border-edge transition-colors rounded-2xl focus-within:border-fg-3">
            <Show when={pastes().length}>
              <Pastes pastes={pastes()} onRemove={(i) => setPastes(pastes().filter((_, j) => j !== i))} class="px-3 pt-3" />
            </Show>
            <textarea
              ref={input}
              value={text()}
              onInput={(e) => edit(e.currentTarget.value)}
              onPaste={(e) => {
                // Big pastes become attachments, so the composer stays editable.
                const pasted = e.clipboardData?.getData('text/plain')
                if (!pasted || !isLongPaste(pasted)) return
                e.preventDefault()
                setPastes([...pastes(), pasted])
              }}
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
              <Show when={actions().length}>
                <Menu
                  items={actions().map((a) => ({ label: a.label, description: a.description }))}
                  onPick={(i) => send(actions()[i].prompt)}
                  title="Chat actions"
                  triggerClass={(open) =>
                    `flex h-7 items-center rounded-md px-2 transition-colors hover:bg-surface hover:text-fg-2 ${open ? 'bg-surface text-fg-2' : 'text-fg-3'}`
                  }
                  trigger={() => <Zap class="size-3.5" />}
                />
              </Show>
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
                when={state.running && !hasInput()}
                fallback={
                  <IconButton onClick={submit} disabled={!hasInput()} title="Send (Enter)">
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

/** What's still running after the call that started it returned, by the composer since it outlives turns. */
function Background(props: { sessionId: string; tasks: BackgroundTask[] }) {
  return (
    <div class="rounded-xl border border-line px-3 py-1 text-[13px]">
      <For each={props.tasks}>
        {(t) => (
          <div class="flex h-7 items-center gap-2">
            <LiveDot />
            <span class="shrink-0 text-fg-2">{taskLabel(t.type)}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-xs text-fg-3">{t.description}</span>
            <button
              onClick={() => socket.send({ type: 'stop_task', sessionId: props.sessionId, taskId: t.id })}
              class="shrink-0 text-xs text-fg-3 transition-colors hover:text-fg-2"
            >
              Stop
            </button>
          </div>
        )}
      </For>
    </div>
  )
}

/** How many folders show before "Show more": no folder plus the most recent few. */
const FOLDERS_SHOWN = 5

/** Every folder on view at once, most recent first; the picked one stays visible even when collapsed. */
function FolderPicker(props: { folders: string[]; selected?: string; onPick: (cwd: string) => void }) {
  const [all, setAll] = createSignal(false)
  const shown = () => {
    if (all() || props.folders.length <= FOLDERS_SHOWN + 1) return props.folders
    const top = props.folders.slice(0, FOLDERS_SHOWN)
    return props.selected && !top.includes(props.selected) && props.folders.includes(props.selected) ? [...top, props.selected] : top
  }
  return (
    <div class="mx-auto mt-4 w-80 text-left">
      <div class={all() ? 'max-h-[40vh] overflow-y-auto' : ''}>
        <For each={shown()}>
          {(dir) => {
            const item = folderItem(dir)
            const selected = () => dir === props.selected
            return (
              <button
                type="button"
                onClick={() => props.onPick(dir)}
                aria-pressed={selected()}
                class={`flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  selected() ? 'bg-surface' : 'hover:bg-surface/60'
                }`}
              >
                <div class="min-w-0 flex-1">
                  <div class={`truncate text-[13px] ${selected() ? 'text-fg' : 'text-fg-2'}`}>{item.label}</div>
                  <div
                    class={`mt-0.5 leading-snug text-fg-3 ${item.mono ? 'truncate font-mono text-[11px] text-left [direction:rtl]' : 'text-xs'}`}
                  >
                    {item.mono ? ltr(item.description) : item.description}
                  </div>
                </div>
                <Check class={`mt-0.5 size-3.5 shrink-0 text-fg-2 ${selected() ? '' : 'invisible'}`} />
              </button>
            )
          }}
        </For>
      </div>
      <Show when={props.folders.length > shown().length}>
        <button
          type="button"
          onClick={() => setAll(true)}
          class="mt-0.5 w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-fg-3 transition-colors hover:bg-surface/60 hover:text-fg-2"
        >
          Show {props.folders.length - shown().length} more
        </button>
      </Show>
    </div>
  )
}

/** Start the chat in a git worktree. Drawn rather than a native checkbox so it takes the theme's ink, not the system blue. */
function WorktreeOption(props: { checked: boolean; onChange: (checked: boolean) => void; name?: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
      title="Run this chat in its own git worktree and branch, so it can work alongside others"
      class={`mt-3 inline-flex h-7 items-center gap-2 rounded-md px-2 text-xs transition-colors hover:bg-surface ${
        props.checked ? 'text-fg-2' : 'text-fg-3 hover:text-fg-2'
      }`}
    >
      <span
        class={`grid size-3.5 place-items-center rounded-[4px] border transition-colors ${
          props.checked ? 'border-fg bg-fg text-bg' : 'border-edge'
        }`}
      >
        <Show when={props.checked}>
          <Check class="size-2.5" stroke-width={3} />
        </Show>
      </span>
      <GitBranch class="size-3.5" />
      In a worktree
      <Show when={props.name}>{(name) => <span class="font-mono text-fg-3">{name()}</span>}</Show>
    </button>
  )
}
