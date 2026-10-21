import { For, Show, createMemo, createSignal, type Component, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { Archive, ArchiveRestore, Bell, BellOff, ChevronDown, ChevronRight, Columns3, FolderInput, Pencil, Plus, Radar as RadarIcon, Search, Settings as SettingsIcon, Trash2, X } from '../icons'
import type { Card, SessionSummary } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { attention, needsYou, notifications, toggleNotifications } from '../attention.ts'
import { basename, folderLabel } from '../folders.ts'
import { focus, focusId, inFocus, setFocusId, unfiled } from '../focus.ts'
import { onMachine } from '../machines.ts'
import { navigate, route } from '../router.tsx'
import { cardOf, cards, cardsLoaded, projectOfChat, projects } from '../stores/cards.ts'
import { sessions, sessionsLoaded, toggleArchived } from '../stores/sessions.ts'
import { terminalLabel, terminalTooltip, terminalWs, terminals, wsKey } from '../terminals.ts'
import { accountUsage } from '../usage.ts'
import { ChatSummary, MachineName } from './ChatSummary.tsx'
import { FileChat } from './FileChat.tsx'
import { showError } from './Popover.tsx'
import { RenameChat } from './RenameChat.tsx'
import { StatusDot } from './Terminals.tsx'
import { AccountLimits } from './Usage.tsx'
import { GhostButton, Menu, ghostClass, inputClass } from './ui.tsx'

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
  /** The chat on screen is listed wherever it is. */
  const shown = (s: SessionSummary) => !s.sideOf && (s.id === props.current || inFocus(s.id))
  const active = createMemo(() => sessions().filter((s) => !s.archived && shown(s)))
  const archived = createMemo(() => sessions().filter((s) => s.archived && shown(s)))
  const [showArchived, setShowArchived] = createSignal(false)
  /**
   * What the search box has in it. Searching looks through every chat, archived ones and other projects'
   * too, since a chat you can't find is usually one that isn't in front of you: every word has to be in its title,
   * folder, card or project. Archived ones come after the rest.
   */
  const [query, setQuery] = createSignal('')
  const found = createMemo(() => {
    const words = query().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return
    const matches = sessions().filter((s) => {
      const card = cardOf(s.id)
      const text = [s.title, s.cwd && folderLabel(s.cwd), card && `#${card.id} ${card.title}`, projectOfChat(s.id)?.title].join(' ').toLowerCase()
      return words.every((w) => text.includes(w))
    })
    return [...matches.filter((s) => !s.archived), ...matches.filter((s) => s.archived)]
  })

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
          onClick={() => navigate(focus() ? { kind: 'card', id: focus()!.id } : { kind: 'board' })}
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
                    class={`flex shrink-0 items-center gap-2 group-hover:invisible ${t.id === currentTerminal() ? 'pointer-coarse:invisible' : ''}`}
                  >
                    <span class="text-meta text-fg-3">{basename(t.root)}</span>
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
              <For each={active()}>{(s) => <SessionRow session={s} current={s.id === props.current} filing={filing() === s.id} onOpenChange={keepOpen(s.id)} />}</For>
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
                <For each={showArchived() ? archived() : archived().filter((s) => s.id === props.current)}>
                  {(s) => <SessionRow session={s} current={s.id === props.current} filing={filing() === s.id} onOpenChange={keepOpen(s.id)} />}
                </For>
              </Show>
            </>
          }
        >
          {(found) => (
            <>
              <For each={found()}>{(s) => <SessionRow session={s} current={s.id === props.current} filing={filing() === s.id} onOpenChange={keepOpen(s.id)} />}</For>
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

/** A chat in the sidebar's list, with buttons to file, rename and archive it on hover. */
function SessionRow(props: {
  session: SessionSummary
  /** It's the chat on screen. */
  current: boolean
  /** Its project picker or rename box is open, so its buttons keep showing. */
  filing: boolean
  onOpenChange: (open: boolean) => void
}) {
  const s = () => props.session
  return (
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
      </div>
    </div>
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
