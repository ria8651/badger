import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack, type JSX } from 'solid-js'
import { FolderX, GitBranch, MonitorOff, Pencil, TextQuote, WifiOff, X } from '../icons'
import type { DraftAttachments, PermissionMode, QueuedMessage } from '../../shared/protocol.ts'
import { chatActions } from '../actions.ts'
import { api, connected } from '../api.ts'
import { cardWorktreeName, isScratch, worktreeOf } from '../folders.ts'
import { diffView, openTerminal, openView, planView, viewKey, viewShown, wide } from '../layout.ts'
import { sideChatsOf, startSideChat } from '../btw.ts'
import { LOCAL, isOnline, isRemoved, knownName, machineName, onMachine } from '../machines.ts'
import { lastModel, modelValue, models, setLastModel } from '../models.ts'
import { navigate } from '../router.tsx'
import { createStickyScroll } from '../stickyScroll.ts'
import { cardOf } from '../stores/cards.ts'
import { sessionById } from '../stores/sessions.ts'
import { knownRoot, workspaceOf, type Ws } from '../terminals.ts'
import { Checking, ChildChats, NO_ATTACHMENTS, createChat, createChildChats } from '../useChat.ts'
import { ChatHeader, createGitStatus } from './ChatHeader.tsx'
import { Composer, type ComposerControls } from './Composer.tsx'
import { FolderPicker } from './FolderPicker.tsx'
import { ForkDialog } from './ForkDialog.tsx'
import { PermissionPrompt } from './PermissionPrompt.tsx'
import { PlanPane, latestPlan } from './Plan.tsx'
import { ReviewPage } from './Review.tsx'
import { showError } from './Popover.tsx'
import { TaskTray, trayItems, waitingOnTask } from './TaskTray.tsx'
import { reveal, revealed, toolLabel } from './ToolCard.tsx'
import { Transcript } from './Transcript.tsx'
import { TaskPane } from '../transcript/agents.tsx'
import { AttachmentPane, attachmentOf } from '../transcript/attachments.tsx'
import { BtwPane } from './Btw.tsx'
import { createIndex } from '../transcript/context.ts'
import { UserMessage } from '../transcript/items.tsx'
import { Workspace, type ChatPanes } from './Workspace.tsx'
import { Loading, Notice, touch, type Option } from './ui.tsx'

export function Chat(props: {
  sessionId: string
  draftCwd?: string
  /** The runner a chat that hasn't started will run on; the hub's own if not given. */
  draftMachine?: string
  /** Given, the empty chat offers runners, folders and worktrees to start in until the first message goes out. */
  onPickCwd?: (cwd: string, machine: string) => void
  /** Start with "New worktree" picked. */
  worktree?: boolean
  onPickWorktree?: (worktree: boolean) => void
  /** Called once, when the first message is sent. */
  onStart?: () => void
  /** The top bar on narrow screens, to go above the chat's header. */
  bar?: JSX.Element
  /** Shown in a panel beside another chat, as a side chat is: no header, and no panels of its own. */
  embedded?: boolean
  /** Called once, with a way to put the cursor in its composer. */
  onReady?: (focus: () => void) => void
}) {
  const chat = createChat(props.sessionId)
  const state = chat.state
  /** The chat as the sidebar lists it, for the header's title, move, rename and archive. Absent until it's listed. */
  const session = () => sessionById(props.sessionId)
  let composer: ComposerControls | undefined

  const [started, setStarted] = createSignal(false)
  const [mode, setMode] = createSignal<PermissionMode>('auto')
  const [model, setModel] = createSignal(lastModel())
  createEffect(on(() => state.mode, setMode))
  createEffect(on(() => state.model, (m) => m && setModel(m)))
  const modelOptions = createMemo((): Option<string>[] => {
    const options = (models() ?? []).map((m) => ({ value: m.value, label: m.displayName.replace(/ \(.*\)$/, ''), description: m.description }))
    // One Claude Code no longer offers, e.g. an older model a transcript was written with.
    const current = modelValue(model(), models() ?? [])
    return options.some((o) => o.value === current) ? options : [...options, { value: current, label: current }]
  })
  const changeMode = (next: PermissionMode) => {
    setMode(next)
    chat.setMode(next)
  }
  const changeModel = (next: string) => {
    setModel(next)
    setLastModel(next)
    chat.setModel(next)
  }

  const [inWorktree, setInWorktree] = createSignal(!!props.worktree)
  /** The card this chat is on. A worktree it starts in is named after the card; otherwise Claude names it. */
  const card = () => cardOf(props.sessionId)
  const worktreeName = () => card() && cardWorktreeName(card()!)
  // Offered before the first message, for a repo checkout that isn't already a worktree.
  const canWorktree = () => !started() && !state.cwd && !session() && !!cwd() && !isScratch(cwd()) && !worktreeOf(cwd())
  const cwd = () => state.cwd ?? session()?.cwd ?? props.draftCwd
  /**
   * A chat stays on the machine it started on; one that hasn't started goes where it was picked. Until the
   * server says which, a chat started elsewhere is taken to be on the hub's, but not one just sent from here.
   */
  const machine = () => state.machine ?? (state.cwd && !started() ? LOCAL : (props.draftMachine ?? LOCAL))
  // Its runner isn't connected, so it can be read but can't run. A memo, since the machine list changes
  // whenever any machine's chats start or stop.
  const offline = createMemo(() => !isOnline(machine()))
  /** Offline as far as the hub knows. While the hub itself can't be reached, what's typed still queues up for it. */
  const stranded = () => offline() && connected()
  /** Not started yet, so where it runs is still being picked. One in the list has started, even before its transcript is here. */
  const picking = () => !!props.onPickCwd && !state.cwd && !session() && !started()
  // Holds the last one while a new folder's is looked up, so moving into a worktree doesn't drop the terminals button for a moment.
  const ws = createMemo<Ws | undefined>(
    (last) => {
      const dir = cwd()
      const m = machine()
      // Not asked while the machine's offline, and asked again once it's back; one the hub knows still does.
      const root = dir && (offline() ? knownRoot(m, dir) : workspaceOf(m, dir)())
      return root ? { machine: m, root } : dir && last?.machine === m ? last : undefined
    },
    undefined,
    { equals: (a, b) => a?.machine === b?.machine && a?.root === b?.root },
  )
  /** Running, and not just waiting on Claude Code to make its worktree. */
  const working = () => state.running && !state.makingWorktree
  const where = () => (isScratch(cwd()) ? 'No folder' : (cwd() ?? ''))

  // Shared by the transcript and the task tray, so both read the chat's messages once.
  const index = createIndex(() => state.messages, () => props.sessionId)
  const tasks = createMemo(() => trayItems(index(), state.running, state.background, cwd()))
  const children = createChildChats(state)

  const sticky = createStickyScroll(`chat:${untrack(() => props.sessionId)}`)
  let content!: HTMLDivElement
  let bottom!: HTMLDivElement
  let scroller!: HTMLDivElement
  onMount(() => {
    // On a phone, focusing would put the keyboard over the chat you came to read.
    if (!touch.matches) composer?.focus()
    sticky.follow(content, bottom, scroller)
    props.onReady?.(() => composer?.focus())
  })
  // Back where it was left, once there's a transcript to scroll; one left at the bottom just stays stuck there.
  let restored = false
  createEffect(() => {
    // A review chat's conversation can't be scrolled while the review is showing in its place.
    if (restored || !state.loaded || !state.messages.length || reviewing()) return
    restored = true
    requestAnimationFrame(() => sticky.restore(content))
  })

  /** Where tasks, plans and attachments open beside the chat. An embedded chat has nowhere: they stay in it. */
  const beside = () => (props.embedded ? undefined : ws())

  /** Scroll to a tool call, opening it and whatever it's folded into. */
  const jump = (toolUseId: string) => {
    reveal(toolUseId)
    sticky.unpin()
    requestAnimationFrame(() => {
      content.querySelector(`[data-id="${CSS.escape(toolUseId)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      revealed()
    })
  }

  /** Open a subagent or background task in a panel beside the chat. */
  const openTask = (toolUseId: string) => {
    const w = beside()
    if (w) openView(w, { kind: 'task', session: props.sessionId, id: toolUseId })
    else jump(toolUseId)
  }
  /** The plan waiting on the user, if Claude has proposed one. */
  const planPrompt = () => state.permissions.find((p) => p.toolName === 'ExitPlanMode')
  const openPlan = () => {
    const w = beside()
    if (w) openView(w, planView(props.sessionId))
  }
  /** Open a paste or context sent with a prompt in a panel beside the chat. */
  const openAttachment = (prompt: string, part: string) => {
    const w = beside()
    if (w) openView(w, { kind: 'attachment', session: props.sessionId, prompt, part })
  }
  const planShown = () => !!beside() && viewShown(beside()!, props.sessionId, viewKey(planView(props.sessionId)))
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
    attachment: (v) => attachmentOf(index(), v.prompt, v.part),
    renderAttachment: (v, onReady) => <AttachmentPane index={index} prompt={v.prompt} part={v.part} onReady={onReady} />,
    btwLive: () => sideChatsOf(props.sessionId).some((s) => s.running),
    renderBtw: (onReady) => <BtwPane parent={props.sessionId} onNew={() => askAside('')} onReady={onReady} />,
    renderDiff: (onReady, bar) => <div class="flex size-full flex-col">{reviewPage(false, { onReady, bar })}</div>,
  }

  /** Forks a side chat (/btw) in the panel beside this one, asking it `question` if there is one. */
  const askAside = (question: string, attachments: DraftAttachments = NO_ATTACHMENTS) => {
    const w = ws()
    if (!w) return showError("Couldn't start a side chat", 'This chat has no folder to open it beside yet.')
    if (!state.messages.length) return showError("Couldn't start a side chat", 'There’s nothing in this chat to ask about yet.')
    const first = question ? { text: question, ...attachments, mode: mode(), model: model() } : {}
    void startSideChat(w, props.sessionId, first).catch((err: Error) => showError("Couldn't start a side chat", err.message))
  }

  // Read again each time a turn ends too, since that's when commits happen.
  const git = createGitStatus(
    () => (cwd() && !isScratch(cwd()) ? { dir: cwd()!, machine: machine() } : undefined),
    () => !state.loaded || offline(),
  )
  createEffect(on(() => state.running, (running) => !running && void git.refresh(), { defer: true }))
  const actions = () => chatActions(git.status(), cwd())

  const send = (text: string, attachments: DraftAttachments = NO_ATTACHMENTS) => {
    if (state.gone || stranded()) return
    // A side chat's own /btw is just a message: side chats don't have side chats.
    if (!props.embedded && /^\/btw(\s|$)/.test(text)) return askAside(text.slice(4).trim(), attachments)
    chat.send({
      text,
      ...attachments,
      cwd: cwd(),
      machine: machine(),
      mode: mode(),
      model: model(),
      worktree: inWorktree() && canWorktree() ? (worktreeName() ?? '') : undefined,
    })
    if (!started()) {
      setStarted(true)
      props.onStart?.()
    }
    sticky.pin()
  }

  // A card's new chat sends the card with its first message, so it's shown as attached until then.
  const pendingCard = () => (card() && state.loaded && state.messages.length === 0 ? { card: card()! } : undefined)
  const unqueue = (id: string, edit = false) => {
    // Saved first so the server puts the message ahead of what's typed, and the composer takes the result.
    if (edit) composer?.flush()
    chat.unqueue(id, edit)
    if (edit) composer?.focus()
  }

  /** A diff review chat shows the review in place of the conversation, until you switch. */
  const isReview = () => !!session()?.review
  const [showConversation, setShowConversation] = createSignal(false)
  const reviewing = () => isReview() && !showConversation()
  const startReview = () =>
    void api.startReview({ cwd: cwd()!, machine: machine(), from: props.sessionId, card: card()?.id }).then(
      ({ sessionId }) => openChat(sessionId),
      (err: Error) => showError("Couldn't start a guided review", err.message),
    )
  /** The checkout's changes in a panel beside the chat, to read without Claude; a guided review is a step on from there. */
  const openDiff = () => {
    const w = beside()
    if (w) openView(w, diffView(props.sessionId))
    else startReview()
  }
  /** This chat's changes: its own page if it's a review chat, else its diff, whose comments and questions come here. */
  const reviewPage = (guided: boolean, opts: { onReady?: (focus: () => void) => void; bar?: () => HTMLElement | undefined; lead?: JSX.Element } = {}) => (
    <ChildChats.Provider value={children.state}>
      <Checking.Provider value={(id) => state.checking.includes(id)}>
        <ReviewPage
          sessionId={props.sessionId}
          guided={guided}
          cwd={cwd()}
          machine={machine()}
          index={index}
          running={state.running}
          partial={state.partial}
          bashOutput={state.bashOutput}
          children={state.children}
          onSend={state.gone || stranded() ? undefined : (text) => send(text)}
          onGuide={guided ? undefined : startReview}
          onReady={opts.onReady}
          bar={opts.bar}
          lead={opts.lead}
        />
      </Checking.Provider>
    </ChildChats.Provider>
  )

  /** A review chat's two ways of being seen. */
  const reviewTabs = () => (
    <div class="-ml-2 flex shrink-0 items-center gap-1 text-xs">
      <For each={[false, true]}>
        {(conversation) => (
          <button
            onClick={() => setShowConversation(conversation)}
            class={`flex items-center gap-1.5 rounded-md px-2 py-1 ${showConversation() === conversation ? 'bg-surface text-fg' : 'text-fg-3 hover:text-fg-2'}`}
          >
            {conversation ? 'Conversation' : 'Guided review'}
            <Show when={conversation && working()}>
              <span class="size-1.5 animate-pulse rounded-full bg-accent" />
            </Show>
          </button>
        )}
      </For>
    </div>
  )

  /** The end of the turn being forked from, while picking where the fork goes. */
  const [forking, setForking] = createSignal<string>()
  const openChat = (id: string) => navigate({ kind: 'chat', id })

  const body = (
    <div class="flex h-full min-w-0 flex-1 flex-col">
      {/* One header on narrow screens: the page's bar above the chat's own row, divided only below. */}
      <Show when={!props.embedded}>
        <div class={`md:contents ${cwd() ? '' : 'border-b border-line'}`}>{props.bar}</div>
      </Show>
      <Show when={cwd() && !props.embedded}>
        <ChatHeader
          sessionId={props.sessionId}
          session={session()}
          cwd={cwd()}
          machine={machine()}
          ws={ws()}
          git={git.status()}
          fetching={git.fetching()}
          onRefresh={git.refresh}
          actions={actions()}
          onDiff={isReview() || !cwd() || isScratch(cwd()) ? undefined : openDiff}
          onReview={isReview() || !cwd() || isScratch(cwd()) ? undefined : startReview}
          onAsk={picking() ? undefined : (prompt) => send(prompt)}
        />
      </Show>
      <Show when={isReview() && !props.embedded}>
        {/* On the review, the first thing in its toolbar; on the conversation, a row of their own. */}
        <Show when={!reviewing()}>
          <div class="flex h-9 shrink-0 items-center border-b border-line px-3">{reviewTabs()}</div>
        </Show>
        <Show when={reviewing()}>
          {reviewPage(true, { lead: reviewTabs() })}
          {/* Claude asking for something can't wait for you to switch to the conversation. */}
          <Show when={state.permissions.length || state.error}>
            <div class="flex shrink-0 flex-col gap-2 border-t border-line p-3">
              <For each={state.permissions}>{(p) => <PermissionPrompt sessionId={props.sessionId} permission={p} cwd={cwd()} from={p.agent} />}</For>
              <Show when={state.error}>
                <Notice tone="danger">
                  <span class="flex-1">{state.error}</span>
                  <button onClick={chat.clearError} class="opacity-70 hover:opacity-100">Dismiss</button>
                </Notice>
              </Show>
            </div>
          </Show>
        </Show>
      </Show>
      <div
        ref={(el) => {
          scroller = el
          sticky.ref(el)
        }}
        onScroll={sticky.onScroll}
        onWheel={sticky.onWheel}
        // A size container, so prompts above the composer can fit this pane rather than the window.
        class={`min-h-0 flex-1 overflow-y-auto [container-type:size] [overflow-anchor:none] ${reviewing() && !props.embedded ? 'hidden' : ''}`}
      >
        {/* One column for the transcript and the composer. Its padding leaves room for your messages and the
            composer to hang out by their own padding, so the text in them lines up with Claude's. */}
        <div class="mx-auto flex min-h-full max-w-[50rem] flex-col px-6 md:px-9">
          <div ref={content} class="relative flex-1 py-8">
            <QuoteSelection within={() => content} onQuote={(text) => composer?.quote(text)} />
            <Show when={state.loaded} fallback={<Loading class="pt-[22vh]" />}>
              <Show
                when={state.messages.length}
                fallback={
                  <Show
                    when={picking()}
                    fallback={
                      <div class="pt-[22vh] text-center">
                        <p class="text-base text-fg-2">What are we working on?</p>
                        <p class="mt-1.5 font-mono text-xs text-fg-3">
                          {where()}
                          <Show when={onMachine(machine())}>{(name) => <span class="font-sans"> on {name()}</span>}</Show>
                        </p>
                      </div>
                    }
                  >
                    <div class="pt-[10vh] text-center">
                      <p class="text-base text-fg-2">What are we working on?</p>
                      <FolderPicker
                        machine={machine()}
                        selected={cwd()}
                        worktree={inWorktree() && canWorktree()}
                        worktreeName={worktreeName()}
                        onPick={(dir, worktree, picked) => {
                          props.onPickCwd!(dir, picked)
                          setInWorktree(worktree)
                          props.onPickWorktree?.(worktree)
                        }}
                      />
                    </div>
                  </Show>
                }
              >
                <ChildChats.Provider value={children.state}>
                  <Checking.Provider value={(id) => state.checking.includes(id)}>
                    <Transcript
                      sessionId={props.sessionId}
                      index={index}
                      messages={state.messages}
                      partial={state.partial}
                      bashOutput={state.bashOutput}
                      running={working()}
                      working={working() && state.permissions.length === 0 && children.prompts().length === 0}
                      cwd={cwd()}
                      children={state.children}
                      onFork={setForking}
                      onOpenAttachment={beside() ? openAttachment : undefined}
                      compacting={state.compacting}
                      onLogin={() => {
                        const w = ws()
                        const dir = cwd()
                        if (w && dir) void openTerminal(w, props.sessionId, dir, undefined, 'claude auth login').catch((e: Error) => showError("Couldn't open a terminal", e.message))
                      }}
                      onRetry={(retry) =>
                        void api.fork(props.sessionId, { at: retry.at, draft: retry.text }).then(
                          ({ sessionId }) => openChat(sessionId),
                          (err: Error) => showError("Couldn't fork the chat", err.message),
                        )
                      }
                    />
                  </Checking.Provider>
                </ChildChats.Provider>
                <Show when={forking()}>
                  {(at) => (
                    <ForkDialog
                      sessionId={props.sessionId}
                      at={at()}
                      machine={machine()}
                      cwd={cwd()}
                      onForked={(id) => {
                        setForking()
                        openChat(id)
                      }}
                      onClose={() => setForking()}
                    />
                  )}
                </Show>
                <Show when={state.makingWorktree}>
                  <div class="mt-4 flex h-6 items-center gap-2 text-ui text-fg-3">
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
            ref={bottom}
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
                    onOpenPlan={beside() ? openPlan : undefined}
                    planShown={planShown()}
                  />
                )}
              </For>
              <For each={children.prompts()}>
                {({ child, tool, permission }) => (
                  <PermissionPrompt sessionId={child.id} permission={permission} cwd={child.state.cwd} from={toolLabel(tool) || 'Another chat'} />
                )}
              </For>
              <Show when={tasks().length}>
                <TaskTray sessionId={props.sessionId} items={tasks} onOpen={openTask} />
              </Show>
              <Show when={state.error}>
                <Notice tone="danger">
                  <span class="flex-1">{state.error}</span>
                  <button onClick={chat.clearError} class="opacity-70 hover:opacity-100">Dismiss</button>
                </Notice>
              </Show>
              <Show when={state.loaded && !connected()}>
                <Notice icon={WifiOff}>
                  <span class="flex-1">Can’t reach the server. Retrying… What you send goes out once it’s back.</span>
                </Notice>
              </Show>
              {/* A folder on a machine that's offline can't be looked at, so it's only gone once the machine's back. */}
              <Show when={state.gone && !offline()}>
                <Notice icon={FolderX}>
                  <span class="flex-1">
                    This chat's folder is gone or can't be opened, so it can't take messages. <span class="text-fg-3 break-all">{cwd()}</span>
                  </span>
                </Notice>
              </Show>
              <Show when={state.loaded && stranded()}>
                <Notice icon={MonitorOff}>
                  <span class="flex-1">
                    <Show
                      when={isRemoved(machine())}
                      fallback={
                        picking()
                          ? `${machineName(machine())} is offline. Pick another runner above, or wait for it to come back.`
                          : `${machineName(machine())} is offline. This chat runs there, so it can't take messages until it's back.`
                      }
                    >
                      {knownName(machine()) ?? 'The runner this chat was on'} was removed.{' '}
                      {picking() ? 'Pick another runner above to start this chat.' : 'This chat ran there, so it can only be read now.'}
                    </Show>
                  </span>
                </Notice>
              </Show>
              <Composer
                ref={(c) => (composer = c)}
                chat={chat}
                machine={machine()}
                cwd={cwd()}
                disabled={state.gone || stranded()}
                working={working()}
                mode={mode()}
                onMode={changeMode}
                model={models()?.length ? modelValue(model(), models()!) : undefined}
                models={modelOptions()}
                onModel={changeModel}
                pendingCard={pendingCard()}
                canBackground={() => state.running && waitingOnTask(index())}
                onSubmit={send}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
  if (props.embedded) return body
  return (
    <Workspace
      ws={ws()}
      cwd={cwd()}
      sessionId={props.sessionId}
      panes={panes}
      onFocusChat={() => composer?.focus()}
      onOpenPage={(id) => navigate({ kind: 'terminal', id })}
    >
      {body}
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
 * Offers "Quote" once the mouse lets go of text selected in the transcript, to add it to the composer as a quote. It
 * goes inside `within` and is placed against it, so it scrolls along with what's selected.
 */
function QuoteSelection(props: { within: () => HTMLElement; onQuote: (text: string) => void }) {
  const [offer, setOffer] = createSignal<{ text: string; x: number; y: number }>()
  const selected = () => {
    const sel = getSelection()
    const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : undefined
    const el = props.within()
    return range && el.contains(range.startContainer) && el.contains(range.endContainer) ? range : undefined
  }
  const onSelected = () => {
    const range = selected()
    const text = range?.toString().trim()
    const end = range && [...range.getClientRects()].filter((b) => b.width).at(-1)
    if (!range || !text || !end) return setOffer(undefined)
    const at = props.within().getBoundingClientRect()
    setOffer({ text, x: end.right - at.left, y: end.bottom - at.top })
  }
  const onSelectionChange = () => offer() && !selected() && setOffer(undefined)
  onMount(() => {
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('pointerup', onSelected)
    onCleanup(() => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('pointerup', onSelected)
    })
  })
  return (
    <Show when={offer()}>
      {(o) => (
        <button
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            const text = o().text
            getSelection()?.removeAllRanges()
            setOffer(undefined)
            props.onQuote(text)
          }}
          style={{ left: `${Math.max(0, o().x - 40)}px`, top: `${o().y + 4}px` }}
          title="Add it to your message as a quote"
          class="absolute z-10 flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs text-on-primary shadow-(--shadow-pop)"
        >
          <TextQuote class="size-3" /> Quote
        </button>
      )}
    </Show>
  )
}
