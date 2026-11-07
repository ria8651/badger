import { For, Show, createMemo, createSignal, onCleanup, type Component, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { Archive, ArchiveRestore, Bell, BellOff, Bot, ChevronDown, ChevronRight, Columns3, FolderInput, MessagesSquare, Pencil, Plus, Radar as RadarIcon, Search, Settings as SettingsIcon, Trash2, X } from '../icons'
import type { Card, NestedChat, SessionSummary } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { attention, needsYou, notifications, toggleNotifications } from '../attention.ts'
import { searchChats } from '../chatSearch.ts'
import { basename } from '../folders.ts'
import { focus, focusId, inFocus, setFocusId, unfiled } from '../focus.ts'
import { mac, openView, viewKey, viewShown } from '../layout.ts'
import { LOCAL, onMachine } from '../machines.ts'
import { navigate, route } from '../router.tsx'
import { cardOf, cards, cardsLoaded, projects } from '../stores/cards.ts'
import { discardDraft, parentOf, sessions, sessionsLoaded, toggleArchived } from '../stores/sessions.ts'
import { terminalLabel, terminalTooltip, terminalWs, terminals, wsKey } from '../terminals.ts'
import { accountUsage } from '../usage.ts'
import { ChatSummary, MachineName } from './ChatSummary.tsx'
import { FileChat } from './FileChat.tsx'
import { confirmBy, showError } from './Popover.tsx'
import { RenameChat } from './RenameChat.tsx'
import { StatusDot } from './Terminals.tsx'
import { AccountLimits } from './Usage.tsx'
import { GhostButton, LiveDot, Menu, ghostClass, inputClass, modalOpen } from './ui.tsx'

/**
 * What's in the sidebar: the project switcher and pages, terminals, and the chats in focus, or every chat that
 * matches a search.
 */
export function Sidebar(props: {
  /** The chat on screen, if it's a chat. */
  current: string | null
  onSettings: () => void
  onNewChat: () => void
}) {
  const currentTerminal = () => {
    const r = route()
    return r.kind === 'terminal' ? r.id : null
  }
  // Grouped by workspace (the hub's own first), oldest first within each, so a workspace's terminals sit together.
  const sortedTerminals = createMemo(() =>
    [...terminals()].sort((a, b) => wsKey(terminalWs(a)).localeCompare(wsKey(terminalWs(b))) || a.createdAt - b.createdAt),
  )

  const unfiledCount = createMemo(() => sessions().filter((s) => !s.archived && !cardOf(s.id)).length)
  /** The chat on screen is listed wherever it is, or for a side or child chat, the chat it's under. */
  const currentRow = createMemo(() => (props.current && parentOf(props.current)?.parent) || props.current)
  const shown = (s: SessionSummary) => !s.sideOf && (s.id === currentRow() || inFocus(s.id))
  const active = createMemo(() => sessions().filter((s) => !s.archived && shown(s)))
  const archived = createMemo(() => sessions().filter((s) => s.archived && shown(s)))
  const [showArchived, setShowArchived] = createSignal(false)
  /** What the search box has in it, and the chats that match it: see searchChats. */
  const [query, setQuery] = createSignal('')
  const found = createMemo(() => searchChats(query()))
  const openBoard = () => navigate(focus() ? { kind: 'card', id: focus()!.id } : { kind: 'board' })

  // ── Keyboard: Alt+↑/↓ steps through what's listed, and with Shift, through the chats that need you ──

  /** The chats as listed, top to bottom, leaving out the nested ones under them. */
  const listed = () => found() ?? [...active(), ...(showArchived() ? archived() : archived().filter((s) => s.id === currentRow()))]
  /** Everything listed to go to, top to bottom: the pages, the terminals, then the chats. */
  const stops = (): { here: boolean; go: () => void }[] => {
    const r = route().kind
    return [
      { here: r === 'radar', go: () => navigate({ kind: 'radar' }) },
      { here: r === 'board' || r === 'card', go: openBoard },
      { here: r === 'home', go: props.onNewChat },
      ...sortedTerminals().map((t) => ({ here: t.id === currentTerminal(), go: () => navigate({ kind: 'terminal', id: t.id }) })),
      ...listed().map((s) => ({ here: s.id === currentRow(), go: () => navigate({ kind: 'chat', id: s.id }) })),
    ]
  }
  const step = (by: 1 | -1) => {
    const list = stops()
    const i = list.findIndex((s) => s.here)
    // From somewhere not listed, down starts at the top and up at the bottom.
    list[i < 0 ? (by > 0 ? 0 : list.length - 1) : i + by]?.go()
  }
  /** On to the next chat along that needs you, in any project, wrapping round. */
  const nextNeedingYou = (by: 1 | -1) => {
    const list = sessions().filter((s) => !s.archived)
    const n = list.length
    const i = list.findIndex((s) => s.id === currentRow())
    const from = i >= 0 ? i : by > 0 ? -1 : n
    for (let k = 1; k <= n; k++) {
      const s = list[(((from + by * k) % n) + n) % n]
      if (attention()[s.id] && s.id !== currentRow()) return navigate({ kind: 'chat', id: s.id })
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !e.altKey || e.metaKey || e.ctrlKey || modalOpen()) return
    const by = e.key === 'ArrowDown' ? 1 : -1
    if (!keysFree(e.target, by)) return
    // Caught on the way down, so the composer doesn't move its cursor too.
    e.preventDefault()
    e.stopPropagation()
    if (e.shiftKey) nextNeedingYou(by)
    else step(by)
  }
  addEventListener('keydown', onKey, true)
  onCleanup(() => removeEventListener('keydown', onKey, true))

  /** The chat whose project picker or rename box is open, so its row keeps its buttons showing. */
  const [filing, setFiling] = createSignal<string>()
  const keepOpen = (id: string) => (open: boolean) => setFiling(open ? id : (current) => (current === id ? undefined : current))

  /** For the switcher: how far along a project is. */
  const projectSummary = (p: Card) => {
    const inside = cards().filter((c) => c.parentId === p.id)
    return inside.length ? `${inside.filter((c) => c.status === 'done').length}/${inside.length} cards done` : 'No cards yet'
  }
  const switchable = createMemo(() => [null, 'none' as const, ...projects().filter((c) => c.status !== 'done' || c.id === focusId())])

  return (
    <>
      <div class="bar flex h-12 shrink-0 items-center gap-2 px-4">
        <img src="/favicon.svg" alt="" class="size-5" />
        <span class="font-medium tracking-tight">Badger</span>
        <button
          onClick={toggleNotifications}
          disabled={notifications() === 'blocked'}
          title={
            notifications() === 'on'
              ? 'Notifications on: chats that finish or need you while you’re away'
              : notifications() === 'blocked'
                ? 'Notifications are blocked in this browser, or need https'
                : 'Turn on notifications'
          }
          class="ml-auto grid size-7 place-items-center rounded-button-md text-fg-3 transition-colors hover:bg-surface hover:text-fg disabled:opacity-40 pointer-coarse:size-10"
        >
          <Show when={notifications() === 'on'} fallback={<BellOff class="size-4" />}>
            <Bell class="size-4" />
          </Show>
        </button>
        <button
          onClick={() => props.onSettings()}
          title="Settings"
          class="grid size-7 place-items-center rounded-button-md text-fg-3 transition-colors hover:bg-surface hover:text-fg pointer-coarse:size-10"
        >
          <SettingsIcon class="size-4" />
        </button>
      </div>
      <div class="px-2 pt-2 pb-3">
        <Menu
          items={switchable().map((c) =>
            c === 'none'
              ? {
                  label: 'No project',
                  description: unfiledCount() ? `${unfiledCount()} chat${unfiledCount() === 1 ? '' : 's'} to put in a project` : 'Every chat is in a project',
                  selected: unfiled(),
                }
              : c
                ? { label: c.title, description: projectSummary(c), selected: c.id === focus()?.id }
                : { label: 'All projects', description: 'Everything', selected: !focus() && !unfiled() },
          )}
          onPick={(i) => {
            const c = switchable()[i]
            // There's no page for chats on no card; the sidebar is the list.
            if (c === 'none') return setFocusId('none')
            navigate(c ? { kind: 'card', id: c.id } : { kind: 'board' })
          }}
          placement="bottom"
          class="w-60"
          title="Which project this tab is working in"
          triggerClass={(open) =>
            `mb-1 flex h-8 w-full items-center gap-2 rounded-lg border pointer-coarse:h-10 border-line px-2 text-ui transition-colors hover:border-edge ${open ? 'border-edge' : ''}`
          }
          trigger={(open) => (
            <>
              <span class={`min-w-0 flex-1 truncate text-left ${focus() || unfiled() ? 'text-fg' : 'text-fg-2'}`}>
                {unfiled() ? 'No project' : (focus()?.title ?? 'All projects')}
              </span>
              <Show when={unfiled() && unfiledCount()}>
                <span class="text-meta text-fg-3 tabular-nums">{unfiledCount()}</span>
              </Show>
              <ChevronDown class={`size-3.5 text-fg-3 transition-transform ${open() ? 'rotate-180' : ''}`} />
            </>
          )}
        />
        <NavItem icon={RadarIcon} onClick={() => navigate({ kind: 'radar' })} active={route().kind === 'radar'} title="Everything on your radar, across projects" class="mb-px">
          Radar
          <Show when={needsYou()}>
            <span class="ml-auto text-meta text-accent tabular-nums">{needsYou()}</span>
          </Show>
        </NavItem>
        <NavItem
          icon={Columns3}
          onClick={openBoard}
          active={route().kind === 'board' || route().kind === 'card'}
          class="mb-px"
        >
          {focus() ? 'Board' : 'Projects'}
        </NavItem>
        <NavItem icon={Plus} onClick={props.onNewChat} active={route().kind === 'home'} title={focus() ? `A chat on ${focus()!.title}` : undefined}>
          New chat
        </NavItem>
      </div>
      <Show when={sortedTerminals().length}>
        <div class="px-2 pb-3">
          <div class="px-2 pb-1 text-meta text-fg-3">Terminals</div>
          <For each={sortedTerminals()}>
            {(t) => (
              <div class="group relative mb-px">
                <button
                  onClick={() => navigate({ kind: 'terminal', id: t.id })}
                  title={`${terminalTooltip(t)}\n${t.cwd}`}
                  class={`flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors pointer-coarse:h-9 ${
                    t.id === currentTerminal() ? 'bg-surface' : 'hover:bg-surface/60'
                  }`}
                >
                  <StatusDot terminal={t} />
                  <span
                    class={`min-w-0 flex-1 truncate text-ui ${
                      t.id === currentTerminal() ? 'text-fg' : 'text-fg-2 group-hover:text-fg'
                    }`}
                  >
                    {terminalLabel(t)}
                  </span>
                  <span
                    class={`flex max-w-[40%] min-w-0 shrink-0 items-center gap-2 group-hover:invisible ${t.id === currentTerminal() ? 'pointer-coarse:invisible' : ''}`}
                  >
                    <span class="min-w-0 truncate text-meta text-fg-3">{basename(t.root)}</span>
                    <Show when={onMachine(t.machine)}>{(name) => <MachineName machine={t.machine} name={name()} class="text-meta text-fg-3" />}</Show>
                  </span>
                </button>
                {/* Touch has no hover, so there the open terminal's row shows it instead. */}
                <button
                  onClick={() => api.closeTerminal(t.id).then(() => t.id === currentTerminal() && props.onNewChat())}
                  title="Delete terminal: stops it and everything it started"
                  class={`absolute top-1/2 right-1.5 hidden size-5 -translate-y-1/2 place-items-center rounded-button-sm text-fg-3 transition-colors group-hover:grid hover:bg-surface hover:text-fg pointer-coarse:size-6 ${
                    t.id === currentTerminal() ? 'pointer-coarse:grid' : ''
                  }`}
                >
                  <Trash2 class="size-3.5" />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="relative mx-2">
        <Search class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
        <input
          type="search"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            setQuery('')
            e.currentTarget.blur()
          }}
          placeholder="Search chats"
          aria-label="Search chats"
          class={`${inputClass} border-line pr-7 pl-8 hover:border-edge focus:border-edge pointer-coarse:h-10 [&::-webkit-search-cancel-button]:hidden`}
        />
        <Show when={query()}>
          <button
            onClick={() => setQuery('')}
            title="Clear"
            class="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-button-sm text-fg-3 transition-colors hover:bg-surface hover:text-fg pointer-coarse:size-7"
          >
            <X class="size-3.5" />
          </button>
        </Show>
      </div>
      <nav class="flex-1 overflow-y-auto px-2 py-2">
        <Show
          when={found()}
          fallback={
            <>
              <For each={active()}>{(s) => <SessionRow session={s} current={s.id === props.current} onScreen={props.current} filing={filing() === s.id} onOpenChange={keepOpen(s.id)} />}</For>
              <Show when={unfiled() && sessionsLoaded() && cardsLoaded() && !active().length}>
                <p class="px-2 py-1.5 text-ui text-fg-3">Every chat is in a project.</p>
              </Show>
              <Show when={archived().length}>
                <button
                  onClick={() => setShowArchived((v) => !v)}
                  class="mt-2 flex h-7 w-full items-center gap-1 rounded-lg px-2 text-meta text-fg-3 transition-colors hover:text-fg-2"
                >
                  <ChevronRight class={`size-3 transition-transform ${showArchived() ? 'rotate-90' : ''}`} />
                  Archived ({archived().length})
                </button>
                <For each={showArchived() ? archived() : archived().filter((s) => s.id === currentRow())}>
                  {(s) => <SessionRow session={s} current={s.id === props.current} onScreen={props.current} filing={filing() === s.id} onOpenChange={keepOpen(s.id)} />}
                </For>
              </Show>
            </>
          }
        >
          {(found) => (
            <>
              <For each={found()}>{(s) => <SessionRow session={s} current={s.id === props.current} onScreen={props.current} filing={filing() === s.id} onOpenChange={keepOpen(s.id)} />}</For>
              <Show when={!found().length}>
                <p class="px-2 py-1.5 text-ui text-fg-3">No chats match.</p>
              </Show>
            </>
          )}
        </Show>
      </nav>
      <Show when={accountUsage()}>{(u) => <AccountLimits usage={u()} />}</Show>
    </>
  )
}

/**
 * Whether Alt+↑/↓ is free for going between chats where it was pressed. A terminal has its own use for it. On a
 * Mac it moves through text, so in a box with text in it, it's only free once there's nowhere further to go.
 */
function keysFree(target: EventTarget | null, by: 1 | -1): boolean {
  if (!(target instanceof Element)) return true
  if (target.closest('.xterm')) return false
  if (!mac) return true
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return by < 0 ? target.selectionEnd === 0 : target.selectionStart === target.value.length
  }
  const editable = target.closest<HTMLElement>('[contenteditable="true"]')
  const sel = getSelection()
  if (!editable || !sel?.rangeCount) return true
  // What's between the cursor and that end of the box.
  const caret = sel.getRangeAt(0)
  const rest = document.createRange()
  rest.selectNodeContents(editable)
  if (by < 0) rest.setEnd(caret.startContainer, caret.startOffset)
  else rest.setStart(caret.endContainer, caret.endOffset)
  return !rest.toString().trim()
}

/** A chat in the sidebar's list, with buttons to file, rename and archive it on hover. */
function SessionRow(props: {
  session: SessionSummary
  /** It's the chat on screen. */
  current: boolean
  /** The chat on screen, which may be one nested under this. */
  onScreen: string | null
  /** Its project picker or rename box is open, so its buttons keep showing. */
  filing: boolean
  onOpenChange: (open: boolean) => void
}) {
  const s = () => props.session
  const discard = async (from: Element) => {
    props.onOpenChange(true)
    const sure = await confirmBy(from, { message: 'Discard this draft?', notes: ['What’s typed and attached in it is gone for good.'], action: 'Discard' })
    props.onOpenChange(false)
    if (sure) discardDraft(s().id).catch((e: Error) => showError("Couldn't discard it", e.message))
  }
  return (
    <>
      <div class="group relative mb-px">
        <button
          onClick={() => navigate({ kind: 'chat', id: s().id })}
          class={`block w-full rounded-lg px-2 py-1.5 text-left transition-colors pointer-coarse:py-2.5 ${
            props.current ? 'bg-surface' : 'hover:bg-surface/60'
          }`}
        >
          <ChatSummary
            session={s()}
            card={cardOf(s().id)}
            titleClass={
              props.current || attention()[s().id]
                ? 'text-fg'
                : s().archived
                  ? 'text-fg-3 group-hover:text-fg'
                  : 'text-fg-2 group-hover:text-fg'
            }
            // The buttons sit over the end of this line, so while they show it stops short of them rather than running under.
            timeClass={`group-hover:hidden ${props.filing ? 'hidden' : ''} ${props.current ? 'pointer-coarse:hidden' : ''}`}
            metaClass={`group-hover:pr-17 ${props.filing ? 'pr-17 pointer-coarse:pr-20' : props.current ? 'pointer-coarse:pr-20' : ''}`}
          />
        </button>
        {/* Touch has no hover, so there the open chat's row shows them instead. */}
        <div
          class={`absolute right-1.5 bottom-1 gap-0.5 group-hover:flex ${props.current ? 'pointer-coarse:flex' : ''} ${
            props.filing ? 'flex' : 'hidden'
          }`}
        >
          <FileChat
            session={s()}
            title={cardOf(s().id) ? 'Move to another project or card' : 'Put in a project'}
            onOpenChange={props.onOpenChange}
            triggerClass={(open) => ghostClass('sm', open)}
            trigger={() => <FolderInput class="size-3.5" />}
          />
          {/* A draft has no transcript to rename or archive: it's thrown away instead. */}
          <Show
            when={!s().unstarted}
            fallback={
              <GhostButton size="sm" onClick={(e) => discard(e.currentTarget)} title="Discard draft">
                <Trash2 class="size-3.5" />
              </GhostButton>
            }
          >
            <RenameChat
              session={s()}
              title="Rename"
              onOpenChange={props.onOpenChange}
              triggerClass={(open) => ghostClass('sm', open)}
              trigger={() => <Pencil class="size-3.5" />}
            />
            <GhostButton size="sm" onClick={() => toggleArchived(s()).catch((e: Error) => showError("Couldn't change it", e.message))} title={s().archived ? 'Unarchive' : 'Archive'}>
              <Show when={s().archived} fallback={<Archive class="size-3.5" />}>
                <ArchiveRestore class="size-3.5" />
              </Show>
            </GhostButton>
          </Show>
        </div>
      </div>
      <NestedRows session={s()} current={props.current} onScreen={props.onScreen} />
    </>
  )
}

/** Nested chats seen running, by chat and call, so one still open beside its chat keeps its row once it's done. */
const seenNested = new Map<string, NestedChat>()

/**
 * A chat's nested chats under it: its subagents, child chats and side chats running, the one on screen if it's one
 * of them, and for the chat on screen, any open in a panel beside it. Each is lit while it's on screen or in view
 * there. A child or side chat opens as a chat of its own; a subagent, which has no page, opens in a panel.
 */
function NestedRows(props: { session: SessionSummary; current: boolean; onScreen: string | null }) {
  const s = () => props.session
  const ws = () => (s().root ? { machine: s().machine ?? LOCAL, root: s().root! } : undefined)
  const viewOf = (n: NestedChat) => ({ kind: 'task' as const, session: s().id, id: n.toolUseId })
  const inPanel = (n: NestedChat) => props.current && !!ws() && viewShown(ws()!, s().id, viewKey(viewOf(n)))
  const rows = createMemo(() => {
    const running = s().nested ?? []
    for (const n of running) seenNested.set(`${s().id}:${n.toolUseId}`, n)
    const open = [...seenNested].filter(([key, n]) => key.startsWith(`${s().id}:`) && !running.some((r) => r.toolUseId === n.toolUseId) && inPanel(n))
    const sides = sessions().filter((c) => c.sideOf === s().id && c.running)
    const rows = [
      ...running.map((n) => ({ n, running: true })),
      ...open.map(([, n]) => ({ n, running: false })),
      ...sides.map((c) => ({ n: { toolUseId: '', title: c.title, sessionId: c.id }, running: true })),
    ]
    // Once it's done it's no longer listed as running, but while it's on screen its row stays.
    const here = props.onScreen ? parentOf(props.onScreen) : undefined
    if (here?.parent === s().id && !rows.some((r) => r.n.sessionId === props.onScreen)) {
      rows.push({ n: { toolUseId: here.toolUseId ?? '', title: here.title, sessionId: props.onScreen! }, running: false })
    }
    return rows
  })
  const lit = (n: NestedChat) => (n.sessionId === props.onScreen && !!n.sessionId) || inPanel(n)
  const open = (n: NestedChat) => {
    if (n.sessionId) return navigate({ kind: 'chat', id: n.sessionId })
    if (!props.current) navigate({ kind: 'chat', id: s().id })
    const w = ws()
    if (w) openView(w, viewOf(n))
  }
  return (
    <For each={rows()}>
      {({ n, running }) => (
        <button
          onClick={() => open(n)}
          title={n.sessionId ? n.title : `Subagent: ${n.title}`}
          class={`mb-px ml-4 flex h-7 w-[calc(100%-1rem)] items-center gap-2 rounded-lg px-2 text-left text-ui transition-colors pointer-coarse:h-9 ${
            lit(n) ? 'bg-surface text-fg' : 'text-fg-3 hover:bg-surface/60 hover:text-fg-2'
          }`}
        >
          <Dynamic component={n.sessionId ? MessagesSquare : Bot} class="size-3.5 shrink-0" />
          <span class="min-w-0 flex-1 truncate">{n.title}</span>
          <Show when={running}>
            <LiveDot />
          </Show>
        </button>
      )}
    </For>
  )
}

/** A row in the sidebar's nav: an icon and a label, filled in while it's where you are. */
function NavItem(props: { icon: Component<{ class?: string }>; onClick: () => void; active: boolean; title?: string; class?: string; children: JSX.Element }) {
  return (
    <button
      onClick={props.onClick}
      title={props.title}
      class={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-ui transition-colors hover:bg-surface hover:text-fg pointer-coarse:h-10 ${
        props.active ? 'bg-surface text-fg' : 'text-fg-2'
      } ${props.class ?? ''}`}
    >
      <Dynamic component={props.icon} class="size-4" />
      {props.children}
    </button>
  )
}
