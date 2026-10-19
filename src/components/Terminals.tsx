import { For, Show, createSignal } from 'solid-js'
import { Globe, RotateCw, SquareTerminal, Trash2 } from '../icons'
import type { TerminalInfo } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { LEADER, panelsShown, togglePanels } from '../layout.ts'
import { previewUrl, previewsAvailable } from '../previews.ts'
import { LOCAL, isOnline, isRemoved, knownName, machineName, onMachine } from '../machines.ts'
import { inWs, terminalLabel, terminalState, terminalTooltip, terminals, terminalsListed, type Ws } from '../terminals.ts'
import { TerminalView } from './TerminalView.tsx'
import { showError } from './Popover.tsx'
import { Loading, ltr } from './ui.tsx'

/** Green while running, red if it failed or was killed, grey once it exited cleanly. */
export function StatusDot(props: { terminal: TerminalInfo }) {
  const tone = () => (props.terminal.running ? 'bg-ok' : props.terminal.signal || props.terminal.exitCode ? 'bg-danger' : 'bg-fg-3')
  return <span title={terminalState(props.terminal)} class={`inline-block size-1.5 shrink-0 rounded-full ${tone()}`} />
}

const inWorkspace = (ws: Ws) => terminals().filter((t) => inWs(t, ws))

export const ghost = (active = false) =>
  `grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-surface hover:text-fg ${active ? 'text-fg' : 'text-fg-3'}`

/** For the composer: shows or hides the panels and says how many terminals are running here. */
export function TerminalButton(props: { ws: Ws; session: string; cwd: string }) {
  const running = () => inWorkspace(props.ws).filter((t) => t.running).length
  const open = () => panelsShown(props.ws, props.session)
  return (
    <button
      type="button"
      onClick={() => togglePanels(props.ws, props.session, props.cwd)}
      title={`${open() ? 'Hide' : 'Show'} terminals (${LEADER} P)`}
      class={`flex h-7 items-center gap-1 rounded-button-md px-2 text-xs tabular-nums transition-colors hover:bg-surface hover:text-fg-2 pointer-coarse:h-9 ${
        open() ? 'bg-surface text-fg-2' : 'text-fg-3'
      }`}
    >
      <SquareTerminal class="size-3.5" />
      <Show when={running()}>{running()}</Show>
    </button>
  )
}

/** Runs a terminal's command again. Shells don't get one: restarting a shell is just closing it and opening another. */
export function RestartButton(props: { terminal: TerminalInfo }) {
  return (
    <Show when={props.terminal.command}>
      <button onClick={() => api.restartTerminal(props.terminal.id)} title="Restart: stop it and run the command again" class={ghost()}>
        <RotateCw class="size-3.5" />
      </button>
    </Show>
  )
}

/**
 * A button per port the terminal is listening on, to preview it: onOpen, or
 * without it a link to the preview in a new browser tab.
 */
export function PortButtons(props: { terminal: TerminalInfo; onOpen?: (port: number) => void }) {
  return (
    <Show when={previewsAvailable(props.terminal.machine || LOCAL)}>
      <For each={props.terminal.ports ?? []}>
        {(port) => {
          const cls = 'flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs tabular-nums text-fg-3 transition-colors hover:bg-surface hover:text-fg'
          const label = (
            <>
              <Globe class="size-3.5" />:{port}
            </>
          )
          return props.onOpen ? (
            <button onClick={() => props.onOpen!(port)} title={`Preview port ${port} in a panel`} class={cls}>
              {label}
            </button>
          ) : (
            <a href={previewUrl(port, '/', props.terminal.machine || LOCAL)} target="_blank" rel="noopener" title={`Open port ${port} in a new browser tab`} class={cls}>
              {label}
            </a>
          )
        }}
      </For>
    </Show>
  )
}

/**
 * Edits a terminal's name in place. Enter or clicking away saves, Escape
 * cancels; saving it empty puts the default back: the command, or "bash 2".
 */
export function RenameTerminal(props: { terminal: TerminalInfo; onDone: () => void; class?: string }) {
  let done = false
  let input!: HTMLInputElement
  const finish = (name?: string) => {
    if (done) return
    done = true
    name = name?.trim()
    if (name !== undefined && name !== (props.terminal.name ?? '')) {
      // The tab it's in, since the box goes once it's done.
      const tab = input.parentElement ?? undefined
      api.renameTerminal(props.terminal.id, name).catch((e: Error) => showError("Couldn't rename it", e.message, tab))
    }
    props.onDone()
  }
  return (
    <input
      ref={(el) => {
        input = el
        queueMicrotask(() => (el.focus(), el.select()))
      }}
      value={props.terminal.name ?? ''}
      placeholder={props.terminal.command ?? 'Name'}
      onKeyDown={(e) => {
        // Not the workspace's shortcuts.
        e.stopPropagation()
        if (e.key === 'Enter') finish(e.currentTarget.value)
        if (e.key === 'Escape') finish()
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      onPointerDown={(e) => e.stopPropagation()}
      class={`min-w-0 rounded-sm bg-bg px-1 text-fg ring-1 ring-edge outline-none placeholder:text-fg-3 pointer-coarse:text-base ${props.class ?? ''}`}
    />
  )
}

/** One terminal filling the page, at /t/:id. */
export function TerminalPage(props: { id: string; onClosed: () => void }) {
  const terminal = () => terminals().find((t) => t.id === props.id)
  const [renaming, setRenaming] = createSignal(false)
  /** The machine it runs on, from its id: `<machine>.<id>`. */
  const machine = () => props.id.slice(0, Math.max(0, props.id.lastIndexOf('.'))) || LOCAL
  // Missing from the list while its runner is away, or back but hasn't said what it has: not closed.
  const missing = () =>
    isRemoved(machine())
      ? `${knownName(machine()) ?? 'The runner this terminal ran on'} was removed, so this terminal is gone`
      : !isOnline(machine())
        ? `${machineName(machine())} is offline. This terminal runs there, so it's back when that is`
        : !terminalsListed(machine())
          ? undefined
          : 'This terminal is closed'

  return (
    <div class="flex h-full min-w-0 flex-1 flex-col">
      <Show
        when={terminal()}
        fallback={
          <Show when={missing()} fallback={<Loading />}>
            {(text) => <p class="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-fg-3">{text()}</p>}
          </Show>
        }
      >
        {(t) => (
          <>
            <div class="bar flex h-12 shrink-0 items-center gap-2 px-5 text-[13px]">
              <StatusDot terminal={t()} />
              <Show
                when={renaming()}
                fallback={
                  <span onDblClick={() => setRenaming(true)} title={`${terminalTooltip(t())}\nDouble-click to rename`} class="truncate text-fg">
                    {terminalLabel(t())}
                  </span>
                }
              >
                <RenameTerminal terminal={t()} onDone={() => setRenaming(false)} class="w-48 text-[13px]" />
              </Show>
              <span class="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-fg-3 [direction:rtl]">{ltr(t().cwd)}</span>
              <Show when={onMachine(t().machine)}>{(name) => <span class="shrink-0 text-[11px] text-fg-3">{name()}</span>}</Show>
              <span class="shrink-0 text-xs text-fg-3">{terminalState(t())}</span>
              <PortButtons terminal={t()} />
              <RestartButton terminal={t()} />
              <button
                onClick={() => api.closeTerminal(t().id).then(props.onClosed)}
                title="Delete terminal: stops it and everything it started"
                class={ghost()}
              >
                <Trash2 class="size-3.5" />
              </button>
            </div>
            <TerminalView
              id={t().id}
              visible
              onReady={(focus) => focus()}
              class="min-h-0 flex-1 border-t border-line px-5 py-3"
            />
          </>
        )}
      </Show>
    </div>
  )
}
