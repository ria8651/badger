import { For, Show, createEffect, createMemo, createResource, createSignal, mapArray, on, onCleanup, onMount, untrack, type JSX } from 'solid-js'
import { ArrowUp, Check, FolderX, GitBranch, ImagePlus, Pencil, ListChevronsDownUp, ListChevronsUpDown, SlidersHorizontal, Square, SquareTerminal, WifiOff, X, Zap } from '../icons'
import { isLongPaste } from '../../shared/pastes.ts'
import type { Card, DraftAttachments, PermissionMode, QueuedMessage } from '../../shared/protocol.ts'
import { chatActions, type ChatAction } from '../actions.ts'
import { api, connected, socket } from '../api.ts'
import { readImage } from '../images.ts'
import { lastModel, modelValue, models, setLastModel } from '../models.ts'
import { cardWorktreeName, folderItem, isScratch, worktreeOf } from '../folders.ts'
import { openView, panelsShown, planView, togglePanels, viewKey, viewShown, wide } from '../layout.ts'
import { terminals, workspaceOf } from '../terminals.ts'
import { ChildChats, createChat } from '../useChat.ts'
import { Attachments } from './Attachments.tsx'
import { PermissionPrompt } from './PermissionPrompt.tsx'
import { PlanPane, latestPlan } from './Plan.tsx'
import { TerminalButton } from './Terminals.tsx'
import { TaskTray, trayItems, waitingOnTask } from './TaskTray.tsx'
import { reveal, revealed, toolLabel } from './ToolCard.tsx'
import { TaskPane, Transcript, UserMessage, createIndex, detail, runInBackground, setDetail } from './Transcript.tsx'
import { ContextMeter } from './Usage.tsx'
import { Workspace, type ChatPanes } from './Workspace.tsx'
import { IconButton, Loading, Menu, Select, ltr, touch, type Option } from './ui.tsx'

const MODES: Option<PermissionMode>[] = [
  { value: 'default', label: 'Ask before edits', description: 'Claude asks before changing files or running commands.' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'File edits go through; commands still ask.' },
  { value: 'auto', label: 'Auto', description: 'A classifier approves safe actions and asks about the rest.' },
  { value: 'plan', label: 'Plan', description: 'Read and propose only. Nothing changes until you approve.' },
  { value: 'bypassPermissions', label: 'Bypass permissions', description: 'Never asks. Anything can run.', tone: 'danger' },
]

const NO_ATTACHMENTS: DraftAttachments = { pastes: [], images: [] }

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
  const [attached, setAttached] = createSignal(NO_ATTACHMENTS)
  const pastes = () => attached().pastes
  const images = () => attached().images
  // Saved as soon as they change, unlike typing: they change rarely and can be big.
  const attach = (change: (a: DraftAttachments) => DraftAttachments) => {
    const next = change(attached())
    setAttached(next)
    socket.send({ type: 'draft', sessionId: props.sessionId, attachments: next })
  }
  const hasInput = () => !!text().trim() || pastes().length > 0 || images().length > 0
  /** Adds the images among these files, and says whether there were any. */
  const addImages = (files: Iterable<File>) => {
    const found = [...files].filter((f) => f.type.startsWith('image/'))
    for (const f of found) void readImage(f).then((image) => image && attach((a) => ({ ...a, images: [...a.images, image] })))
    return found.length > 0
  }
  const [dragging, setDragging] = createSignal(false)
  let picker!: HTMLInputElement
  const [started, setStarted] = createSignal(false)
  const [mode, setMode] = createSignal<PermissionMode>('auto')
  const [model, setModel] = createSignal(lastModel())
  const modelOptions = createMemo((): Option<string>[] => {
    const options = (models() ?? []).map((m) => ({ value: m.value, label: m.displayName.replace(/ \(.*\)$/, ''), description: m.description }))
    // One Claude Code no longer offers, e.g. an older model a transcript was written with.
    const current = modelValue(model(), models() ?? [])
    return options.some((o) => o.value === current) ? options : [...options, { value: current, label: current }]
  })
  const [inWorktree, setInWorktree] = createSignal(!!props.worktree)
  const worktreeName = () => props.card && cardWorktreeName(props.card)
  // Offered before the first message, for a repo checkout that isn't already a worktree.
  const canWorktree = () => !started() && !state.cwd && !!cwd() && !isScratch(cwd()) && !worktreeOf(cwd())
  let scroller!: HTMLDivElement
  let content!: HTMLDivElement
  let composer!: HTMLDivElement
  let input!: HTMLTextAreaElement
  let pinned = true
  let lastTop = 0
  const cwd = () => state.cwd ?? props.draftCwd
  // Holds the last one while a new folder's is looked up, so moving into a worktree doesn't drop the terminals button for a moment.
  const root = createMemo<string | undefined>((last) => {
    const dir = cwd()
    return dir ? (workspaceOf(dir)() ?? last) : undefined
  })
  /** Running, and not just waiting on Claude Code to make its worktree. */
  const working = () => state.running && !state.makingWorktree
  const where = () => (isScratch(cwd()) ? 'No folder' : (cwd() ?? ''))

  // Shared by the transcript and the task tray, so both read the chat's messages once.
  const index = createIndex(() => state.messages, () => props.sessionId)
  const tasks = createMemo(() => trayItems(index(), state.running, state.background, cwd()))

  /** Scroll to a tool call, opening it and whatever it's folded into. */
  const jump = (toolUseId: string) => {
    reveal(toolUseId)
    pinned = false
    requestAnimationFrame(() => {
      content.querySelector(`[data-id="${CSS.escape(toolUseId)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      revealed()
    })
  }

  /** Open a subagent or background task in a panel beside the chat. */
  const openTask = (toolUseId: string) => {
    const r = root()
    if (r) openView(r, { kind: 'task', session: props.sessionId, id: toolUseId })
    else jump(toolUseId)
  }
  /** The plan waiting on the user, if Claude has proposed one. */
  const planPrompt = () => state.permissions.find((p) => p.toolName === 'ExitPlanMode')
  const openPlan = () => {
    const r = root()
    if (r) openView(r, planView(props.sessionId))
  }
  const planShown = () => !!root() && viewShown(root()!, viewKey(planView(props.sessionId)))
  // A plan arriving while the chat is open gets room beside it, on screens wide enough. Ones
  // already waiting when the chat opened don't, so closing the panel and coming back keeps it closed.
  let known: Set<string> | undefined
  createEffect(() => {
    if (!state.loaded) return
    const ids = state.permissions.filter((p) => p.toolName === 'ExitPlanMode').map((p) => p.requestId)
    const fresh = known ? ids.filter((id) => !known!.has(id)) : []
    known = new Set(ids)
    if (fresh.length && wide()) untrack(openPlan)
  })

  const panes: ChatPanes = {
    label: (id) => {
      const t = tasks().find((t) => t.toolUseId === id)
      return t?.description || t?.label || 'Task'
    },
    live: (id) => tasks().find((t) => t.toolUseId === id)?.status === 'running',
    render: (id, onReady) => (
      <TaskPane
        id={id}
        index={index}
        bashOutput={state.bashOutput}
        running={state.running}
        cwd={cwd()}
        onShowInChat={() => jump(id)}
        onReady={onReady}
      />
    ),
    planWaiting: () => !!planPrompt(),
    renderPlan: (onReady) => (
      <PlanPane sessionId={props.sessionId} permission={planPrompt()} past={latestPlan(index())} onReady={onReady} />
    ),
  }

  createEffect(on(() => state.mode, setMode))
  createEffect(on(() => state.model, (m) => m && setModel(m)))

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
  const [changes, { refetch: refetchChanges }] = createResource(
    () => state.loaded && cwd(),
    (dir) => api.changes(dir).then((c) => c ?? undefined, () => undefined),
  )
  createEffect(
    on(
      () => state.running,
      (running) => {
        if (running) return
        refetchWorktree()
        refetchChanges()
      },
      { defer: true },
    ),
  )
  const actions = () => chatActions({ worktree: worktree(), changes: changes() })

  // Unsent text and attachments are saved on the server, so they survive leaving
  // the chat or reloading, and every tab on this chat shows the same draft.
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
    if (!('sessionId' in e) || e.sessionId !== props.sessionId) return
    if (e.type === 'snapshot') {
      setAttached(e.draftAttachments)
      if (!unsaved) setText(e.draft)
    }
    if (e.type === 'draft') {
      if (e.attachments) setAttached(e.attachments)
      if (e.text !== undefined && !unsaved) setText(e.text)
    }
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
    // On a phone, focusing would put the keyboard over the chat you came to read.
    if (!touch.matches) input.focus()
    // Follow anything that changes size while stuck: messages, streaming, blocks opening, the composer.
    const observer = new ResizeObserver(() => pinned && toBottom())
    observer.observe(content)
    observer.observe(composer)
    observer.observe(scroller)
    onCleanup(() => observer.disconnect())
  })


  const send = (value: string, attachments: DraftAttachments = NO_ATTACHMENTS) => {
    if (state.gone) return
    const worktree = inWorktree() && canWorktree() ? (worktreeName() ?? '') : undefined
    socket.send({ type: 'send', sessionId: props.sessionId, text: value, ...attachments, cwd: cwd(), mode: mode(), model: model(), worktree })
    if (!started()) {
      setStarted(true)
      props.onStart?.()
    }
    pinned = true
    toBottom()
  }

  const submit = () => {
    if (!hasInput()) return
    send(text().trim(), attached())
    // The server clears the saved draft when the message arrives.
    clearTimeout(saveTimer)
    unsaved = false
    setText('')
    setAttached(NO_ATTACHMENTS)
  }

  const changeMode = (next: PermissionMode) => {
    setMode(next)
    socket.send({ type: 'set_mode', sessionId: props.sessionId, mode: next })
  }

  const changeModel = (next: string) => {
    setModel(next)
    setLastModel(next)
    socket.send({ type: 'set_model', sessionId: props.sessionId, model: next })
  }

  // A card's new chat sends the card with its first message, so it's shown as attached until then.
  const pendingCard = () => (props.card && state.loaded && state.messages.length === 0 ? { card: props.card } : undefined)
  const interrupt = () => socket.send({ type: 'interrupt', sessionId: props.sessionId })
  const unqueue = (id: string, edit = false) => {
    // Saved first so the server puts the message ahead of what's typed, and the composer takes the result.
    if (edit) saveDraft()
    socket.send({ type: 'unqueue', sessionId: props.sessionId, id, edit })
    if (edit) input.focus()
  }

  /** The panel a narrow composer keeps its mode, model and the rest in. */
  const [more, setMore] = createSignal(false)
  let moreButton!: HTMLButtonElement
  let morePanel: HTMLDivElement | undefined
  const onOutside = (e: PointerEvent) => {
    const target = e.target as Node
    if (more() && !morePanel?.contains(target) && !moreButton.contains(target)) setMore(false)
  }
  const onEscape = (e: KeyboardEvent) => e.key === 'Escape' && more() && setMore(false)
  document.addEventListener('pointerdown', onOutside)
  document.addEventListener('keydown', onEscape)
  onCleanup(() => {
    document.removeEventListener('pointerdown', onOutside)
    document.removeEventListener('keydown', onEscape)
  })

  return (
    <Workspace
      root={root()}
      cwd={cwd()}
      sessionId={props.sessionId}
      panes={panes}
      onFocusChat={() => input.focus()}
      onOpenPage={props.onOpenTerminal}
    >
      <div class="flex h-full min-w-0 flex-1 flex-col">
        <div
          ref={scroller}
          onScroll={onScroll}
          // Unstick on the gesture itself, before streamed content can push the bottom away.
          onWheel={(e) => e.deltaY < 0 && scroller.scrollHeight > scroller.clientHeight && (pinned = false)}
          // A size container, so prompts above the composer can fit this pane rather than the window.
          class="min-h-0 flex-1 overflow-y-auto [container-type:size] [overflow-anchor:none]"
        >
          {/* One column for the transcript and the composer. Its padding leaves room for your messages and the
              composer to hang out by their own padding, so the text in them lines up with Claude's. */}
          <div class="mx-auto flex min-h-full max-w-[50rem] flex-col px-6 md:px-9">
            <div ref={content} class="flex-1 py-8">
              <Show when={state.loaded} fallback={<Loading class="pt-[22vh]" />}>
                <Show
                  when={state.messages.length}
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
                    </div>
                  }
                >
                  <ChildChats.Provider value={childState}>
                    <Transcript
                      sessionId={props.sessionId}
                      index={index}
                      messages={state.messages}
                      partial={state.partial}
                      bashOutput={state.bashOutput}
                      running={working()}
                      working={working() && state.permissions.length === 0 && childPrompts().length === 0}
                      cwd={cwd()}
                      children={state.children}
                    />
                  </ChildChats.Provider>
                  <Show when={state.makingWorktree}>
                    <div class="mt-4 flex h-6 items-center gap-2 text-[13px] text-fg-3">
                      <GitBranch class="size-3.5 shrink-0 animate-pulse" /> Making worktree
                      <Show when={worktreeName()}>{(name) => <span class="min-w-0 truncate font-mono text-xs">{name()}</span>}</Show>
                    </div>
                  </Show>
                </Show>
              </Show>
            </div>

            {/* Stuck to the bottom of the column and as wide as it, padding included, so the transcript fades out as it
                scrolls under even where the composer hangs into the padding. It leaves room for that fade even when full, and prompts give way first. */}
            <div
              ref={composer}
              class="sticky bottom-0 flex max-h-[calc(100cqh-2rem)] flex-col -mx-6 bg-bg px-6 pb-5 md:-mx-9 md:px-9 before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-linear-to-t before:from-bg"
            >
              {/* Laid out like the transcript's own messages, since that's where they're headed. */}
              <For each={state.queued}>
                {(m) => <Queued message={m} onEdit={() => unqueue(m.id, true)} onRemove={() => unqueue(m.id)} />}
              </For>
              {/* Everything here hangs out as far as the composer, so prompts and notices read as part of it, not the transcript. */}
              <div class="-mx-[calc(1rem+1px)] flex min-h-0 flex-col gap-2">
                <For each={state.permissions}>
                  {(p) => (
                    <PermissionPrompt
                      sessionId={props.sessionId}
                      permission={p}
                      cwd={cwd()}
                      from={p.agent}
                      onOpenPlan={root() ? openPlan : undefined}
                      planShown={planShown()}
                    />
                  )}
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
                <Show when={tasks().length}>
                  <TaskTray sessionId={props.sessionId} items={tasks} onOpen={openTask} />
                </Show>
                <Show when={state.error}>
                  <div class="flex items-start gap-3 bg-danger/10 rounded-lg px-3 py-2 text-[13px] text-danger">
                    <span class="flex-1">{state.error}</span>
                    <button onClick={clearError} class="opacity-70 hover:opacity-100">Dismiss</button>
                  </div>
                </Show>
                <Show when={state.loaded && !connected()}>
                  <div class="flex items-start gap-3 bg-surface rounded-lg px-3 py-2 text-[13px] text-fg-2">
                    <WifiOff class="size-4 shrink-0 mt-0.5" />
                    <span class="flex-1">Can’t reach the server. Retrying… What you send goes out once it’s back.</span>
                  </div>
                </Show>
                <Show when={state.gone}>
                  <div class="flex items-start gap-3 bg-surface rounded-lg px-3 py-2 text-[13px] text-fg-2">
                    <FolderX class="size-4 shrink-0 mt-0.5" />
                    <span class="flex-1">
                      This chat's folder is gone or can't be opened, so it can't take messages. <span class="text-fg-3 break-all">{cwd()}</span>
                    </span>
                  </div>
                </Show>
                <div
                  inert={state.gone}
                  class={`@container relative border transition-colors rounded-2xl focus-within:border-fg-3 ${dragging() ? 'border-fg-3' : 'border-edge'} ${state.gone ? 'opacity-50' : ''}`}
                  onDragOver={(e) => {
                    if (!e.dataTransfer?.types.includes('Files')) return
                    e.preventDefault()
                    setDragging(true)
                  }}
                  onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
                  onDrop={(e) => {
                    setDragging(false)
                    if (!e.dataTransfer?.files.length) return
                    e.preventDefault()
                    addImages(e.dataTransfer.files)
                    input.focus()
                  }}
                >
                  <Show when={more()}>
                    <ComposerPanel
                      ref={(el) => (morePanel = el)}
                      mode={mode()}
                      onMode={changeMode}
                      model={models()?.length ? modelValue(model(), models()!) : undefined}
                      models={modelOptions()}
                      onModel={changeModel}
                      root={root()}
                      cwd={cwd()}
                      actions={actions()}
                      onAction={(a) => send(a.prompt)}
                      onClose={() => setMore(false)}
                    />
                  </Show>
                  <Show when={pastes().length || images().length || pendingCard()}>
                    <Attachments
                      pastes={pastes()}
                      images={images()}
                      card={pendingCard()}
                      onRemovePaste={(i) => attach((a) => ({ ...a, pastes: a.pastes.filter((_, j) => j !== i) }))}
                      onRemoveImage={(i) => attach((a) => ({ ...a, images: a.images.filter((_, j) => j !== i) }))}
                      class="px-3 pt-3"
                    />
                  </Show>
                  <textarea
                    ref={input}
                    value={text()}
                    onInput={(e) => edit(e.currentTarget.value)}
                    onPaste={(e) => {
                      // Images and big pastes become attachments, so the composer stays editable.
                      // Office apps copy text with a picture of it too; the text is what's wanted then.
                      const pasted = e.clipboardData?.getData('text/plain')
                      if (!pasted && e.clipboardData && addImages(e.clipboardData.files)) return e.preventDefault()
                      if (!pasted || !isLongPaste(pasted)) return
                      e.preventDefault()
                      attach((a) => ({ ...a, pastes: [...a.pastes, pasted] }))
                    }}
                    onKeyDown={(e) => {
                      // Phone keyboards have no Shift+Enter, so there Enter is a newline and the button sends.
                      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch.matches) {
                        e.preventDefault()
                        submit()
                      }
                      if (e.key === 'Escape' && working()) interrupt()
                      // Each subagent and command has its own button; this sends every one at once.
                      if (e.key === 'b' && e.ctrlKey && !e.metaKey && state.running && waitingOnTask(index())) {
                        e.preventDefault()
                        runInBackground(props.sessionId)
                      }
                    }}
                    rows={Math.min(10, Math.max(2, text().split('\n').length))}
                    placeholder={state.running ? 'Queue a message' : 'Message Claude'}
                    class="block max-h-[calc(10lh+0.875rem)] min-h-[calc(2lh+0.875rem)] w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed outline-none pointer-coarse:text-base [field-sizing:content] placeholder:text-fg-3"
                  />
                  {/* A narrow composer keeps attaching and sending in the bar and puts the rest in a panel; wide ones show it all.
                      Measured on the composer, not the screen, so the sidebar squeezing it counts too. */}
                  <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pb-2">
                    <div class="hidden items-center gap-2 @md:flex">
                      <Select value={mode()} options={MODES} onChange={changeMode} title="Permission mode" />
                      <Show when={models()?.length}>
                        <Select value={modelValue(model(), models()!)} options={modelOptions()} onChange={changeModel} title="Model" />
                      </Show>
                    </div>
                    <button
                      type="button"
                      onClick={() => picker.click()}
                      title="Attach images"
                      class="flex h-7 items-center rounded-md px-2 text-fg-3 transition-colors hover:bg-surface hover:text-fg-2 pointer-coarse:h-9"
                    >
                      <ImagePlus class="size-3.5" />
                    </button>
                    <input
                      ref={picker}
                      type="file"
                      accept="image/*"
                      multiple
                      class="hidden"
                      onChange={(e) => {
                        addImages(e.currentTarget.files ?? [])
                        e.currentTarget.value = ''
                        input.focus()
                      }}
                    />
                    <div class="hidden items-center gap-2 @md:flex">
                      <Show when={root()}>{(r) => <TerminalButton root={r()} cwd={cwd()!} />}</Show>
                      <Menu
                        items={actions().map((a) => ({ label: a.label, description: a.description }))}
                        onPick={(i) => send(actions()[i].prompt)}
                        title={actions().length ? 'Chat actions' : 'No actions for this chat'}
                        triggerClass={(open) =>
                          `flex h-7 items-center rounded-md px-2 transition-colors hover:bg-surface hover:text-fg-2 pointer-coarse:h-9 ${open ? 'bg-surface text-fg-2' : 'text-fg-3'}`
                        }
                        trigger={() => <Zap class="size-3.5" />}
                      />
                      <button
                        type="button"
                        onClick={() => setDetail(detail() === 'full' ? 'result' : 'full')}
                        title={detail() === 'full' ? 'Show results only' : 'Show all work'}
                        class="flex h-7 items-center rounded-md px-2 text-fg-3 transition-colors hover:bg-surface hover:text-fg-2 pointer-coarse:h-9"
                      >
                        {/* Shows what a click does, like play/pause: fold the work away or expand it. */}
                        <Show when={detail() === 'full'} fallback={<ListChevronsUpDown class="size-3.5" />}>
                          <ListChevronsDownUp class="size-3.5" />
                        </Show>
                      </button>
                    </div>
                    <button
                      ref={moreButton}
                      type="button"
                      onClick={() => setMore((o) => !o)}
                      title="Mode, model and more"
                      aria-expanded={more()}
                      class={`flex h-7 items-center rounded-md px-2 transition-colors hover:bg-surface hover:text-fg-2 pointer-coarse:h-9 @md:hidden ${
                        mode() === 'bypassPermissions' ? 'text-danger' : more() ? 'bg-surface text-fg-2' : 'text-fg-3'
                      }`}
                    >
                      <SlidersHorizontal class="size-3.5" />
                    </button>
                    <div class="ml-auto flex items-center gap-2">
                      <Show when={state.context}>{(u) => <ContextMeter usage={u()} />}</Show>
                      {/* One slot: stop while running with nothing typed, otherwise send. */}
                      <Show
                        when={working() && !hasInput()}
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
            </div>
          </div>
        </div>
      </div>
    </Workspace>
  )
}

/** A message waiting for Claude's next break: your message as it'll appear, with ways to take it back. */
function Queued(props: { message: QueuedMessage; onEdit: () => void; onRemove: () => void }) {
  const button = 'grid size-7 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface hover:text-fg-2 pointer-coarse:size-9'
  return (
    // Clamped shorter than in the transcript so a long one doesn't push the chat out of view above the composer.
    <UserMessage text={props.message.text} pastes={props.message.pastes} images={props.message.images} class="mb-2" maxHeight="6lh">
      <button type="button" onClick={props.onEdit} title="Edit" class={button}>
        <Pencil class="size-3.5" />
      </button>
      <button type="button" onClick={props.onRemove} title="Remove" class={button}>
        <X class="size-3.5" />
      </button>
    </UserMessage>
  )
}

/**
 * What a narrow composer's toolbar has no room for, in a panel above it as wide as the composer:
 * mode, model, terminals, how much work to show, and the chat's actions.
 */
function ComposerPanel(props: {
  ref: (el: HTMLDivElement) => void
  mode: PermissionMode
  onMode: (mode: PermissionMode) => void
  /** Unset until Claude Code has listed its models. */
  model?: string
  models: Option<string>[]
  onModel: (model: string) => void
  root?: string
  cwd?: string
  actions: ChatAction[]
  onAction: (action: ChatAction) => void
  onClose: () => void
}) {
  const pick = (f: () => void) => () => {
    f()
    props.onClose()
  }
  const running = () => terminals().filter((t) => t.root === props.root && t.running).length
  return (
    <div
      ref={props.ref}
      class="absolute inset-x-0 bottom-full z-10 mb-2 max-h-[70vh] origin-bottom animate-[pop-in_120ms_ease-out] overflow-y-auto rounded-2xl border border-edge bg-bg p-1 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.35)]"
    >
      <PanelChoices label="Permission mode" options={MODES} value={props.mode} onPick={props.onMode} />
      <Show when={props.model}>
        {(model) => <PanelChoices label="Model" options={props.models} value={model()} onPick={props.onModel} />}
      </Show>
      <div class="mx-2.5 my-1 border-t border-line" />
      <Show when={props.root}>
        {(root) => (
          <PanelButton onClick={pick(() => togglePanels(root(), props.cwd!))}>
            <SquareTerminal class="size-4" />
            {panelsShown(root()) ? 'Hide terminals' : 'Show terminals'}
            <Show when={running()}>
              <span class="ml-auto text-xs text-fg-3 tabular-nums">{running()} running</span>
            </Show>
          </PanelButton>
        )}
      </Show>
      <PanelButton onClick={pick(() => setDetail(detail() === 'full' ? 'result' : 'full'))}>
        <Show when={detail() === 'full'} fallback={<ListChevronsUpDown class="size-4" />}>
          <ListChevronsDownUp class="size-4" />
        </Show>
        {detail() === 'full' ? 'Show results only' : 'Show all work'}
      </PanelButton>
      <For each={props.actions}>
        {(a) => (
          <PanelButton onClick={pick(() => props.onAction(a))}>
            <Zap class="size-4" />
            {a.label}
          </PanelButton>
        )}
      </For>
    </div>
  )
}

/** One setting's options as chips, with what the current one means underneath. Picking one leaves the panel open. */
function PanelChoices<T extends string>(props: { label: string; options: Option<T>[]; value: T; onPick: (value: T) => void }) {
  const current = () => props.options.find((o) => o.value === props.value)
  return (
    <div class="px-2.5 pt-2.5 pb-2">
      <div class="pb-2 text-[11px] text-fg-3">{props.label}</div>
      <div class="flex flex-wrap gap-1.5">
        <For each={props.options}>
          {(o) => (
            <button
              type="button"
              onClick={() => props.onPick(o.value)}
              aria-pressed={o.value === props.value}
              class={`h-9 rounded-full border px-3 text-[13px] transition-colors ${
                o.value === props.value
                  ? o.tone === 'danger'
                    ? 'border-danger bg-danger/10 text-danger'
                    : 'border-fg-3 bg-surface text-fg'
                  : `border-edge hover:bg-surface ${o.tone === 'danger' ? 'text-danger' : 'text-fg-2 hover:text-fg'}`
              }`}
            >
              {o.label}
            </button>
          )}
        </For>
      </div>
      <Show when={current()?.description}>
        <p class="mt-2 text-xs leading-snug text-fg-3">{current()!.description}</p>
      </Show>
    </div>
  )
}

function PanelButton(props: { onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class="flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left text-[13px] text-fg-2 transition-colors hover:bg-surface hover:text-fg"
    >
      {props.children}
    </button>
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
