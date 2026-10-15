import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type Component } from 'solid-js'
import { Dynamic, Portal } from 'solid-js/web'
import { Check, CircleCheck, Copy, Ellipsis, Laptop, Loader2, Pencil, Plus, Server, TriangleAlert, X } from '../icons'
import type { Machine } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { machines } from '../machines.ts'
import { Button, Menu, inputClass, ltr, plural, setModalOpen } from './ui.tsx'

interface Section {
  id: string
  label: string
  icon: typeof Server
  view: Component
}

const SECTIONS: Section[] = [{ id: 'runners', label: 'Runners', icon: Server, view: Runners }]

const toolButton = 'grid size-8 shrink-0 place-items-center rounded-lg text-fg-3 transition-colors hover:bg-surface hover:text-fg pointer-coarse:size-10'

/** Badger's settings in a modal: sections listed on the left, or across the top on narrow screens. */
export function Settings(props: { onClose: () => void }) {
  const [section, setSection] = createSignal(SECTIONS[0].id)
  const current = () => SECTIONS.find((s) => s.id === section()) ?? SECTIONS[0]
  const before = document.activeElement as HTMLElement | null
  let dialog!: HTMLDivElement
  // Only a click that starts and ends on the backdrop closes, so selecting text out past the edge doesn't.
  let downOnBackdrop = false

  // Escape inside goes to what has focus first (an open menu, a name being edited), which marks it handled.
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && props.onClose()
  // From outside, say with focus left in the composer, it's caught first so it closes this rather than also stopping Claude.
  const onKeyOutside = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || dialog.contains(e.target as Node)) return
    e.stopPropagation()
    props.onClose()
  }
  addEventListener('keydown', onKey)
  addEventListener('keydown', onKeyOutside, true)
  setModalOpen(true)
  onCleanup(() => {
    setModalOpen(false)
    removeEventListener('keydown', onKey)
    removeEventListener('keydown', onKeyOutside, true)
    before?.focus()
  })
  onMount(() => dialog.focus())

  return (
    <Portal>
      <div
        class="fixed inset-0 z-50 flex animate-[fade-in_120ms_ease-out] items-center justify-center bg-black/40 sm:p-6"
        onPointerDown={(e) => (downOnBackdrop = e.target === e.currentTarget)}
        onClick={(e) => e.target === e.currentTarget && downOnBackdrop && props.onClose()}
      >
        <div
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          tabindex={-1}
          class="flex h-full w-full flex-col overflow-hidden border-edge bg-bg shadow-[0_24px_64px_-16px_rgb(0_0_0/0.45)] outline-none sm:h-[min(42rem,90vh)] sm:max-w-3xl sm:rounded-xl sm:border"
        >
          <div class="flex items-center gap-2 border-b border-line px-4 py-3">
            <h2 class="flex-1 text-sm font-medium text-fg">Settings</h2>
            <button type="button" title="Close" onClick={props.onClose} class={toolButton}>
              <X class="size-4" />
            </button>
          </div>
          <div class="flex min-h-0 flex-1 flex-col sm:flex-row">
            <nav class="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 py-2 sm:w-48 sm:flex-col sm:border-r sm:border-b-0 sm:py-3">
              <For each={SECTIONS}>
                {(s) => (
                  <button
                    type="button"
                    aria-current={s.id === section() ? 'page' : undefined}
                    onClick={() => setSection(s.id)}
                    class={`flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors pointer-coarse:h-10 ${
                      s.id === section() ? 'bg-surface text-fg' : 'text-fg-2 hover:bg-surface hover:text-fg'
                    }`}
                  >
                    <s.icon class="size-4 text-fg-3" />
                    {s.label}
                  </button>
                )}
              </For>
            </nav>
            <div class="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
              <Dynamic component={current().view} />
            </div>
          </div>
        </div>
      </div>
    </Portal>
  )
}

/** A token just issued, shown with the command to run until its runner connects. */
interface Setup {
  machine: Machine
  token: string
  /** Seen in the list, so its leaving it means it was removed. */
  listed: boolean
  /** Seen offline since the token was issued: connecting after that is with the new token. */
  sawOffline: boolean
  connected: boolean
}

function Runners() {
  // Runners connect where this page is; in development Vite passes /runner on to the server.
  const hubUrl = location.origin

  const [error, setError] = createSignal<string>()
  const [adding, setAdding] = createSignal(false)
  const [setup, setSetup] = createSignal<Setup>()
  const [confirming, setConfirming] = createSignal<{ id: string; action: 'token' | 'remove' }>()
  const [acting, setActing] = createSignal(false)
  const [renaming, setRenaming] = createSignal<string>()
  const [copied, setCopied] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 30_000)
  let doneTimer: ReturnType<typeof setTimeout> | undefined
  let copiedTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    clearInterval(tick)
    clearTimeout(doneTimer)
    clearTimeout(copiedTimer)
  })

  /** The hub's own first; a runner just added is shown before the list catches up with it. */
  const rows = createMemo(() => {
    const list = [...machines()].sort((a, b) => Number(b.local) - Number(a.local))
    const s = setup()
    return s && !s.listed && !list.some((m) => m.id === s.machine.id) ? [...list, s.machine] : list
  })
  // By id, so a row (and a name being edited in it) outlives the list being replaced on every change.
  const ids = createMemo(() => rows().map((m) => m.id), [], { equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]) })
  const find = (id: string) => rows().find((m) => m.id === id)

  createEffect(
    on(machines, (list) => {
      const s = setup()
      if (!s || s.connected) return
      const m = list.find((m) => m.id === s.machine.id)
      if (!m) {
        if (s.listed) setSetup()
      } else if (!m.online) {
        if (!s.listed || !s.sawOffline) setSetup({ ...s, listed: true, sawOffline: true })
      } else if (s.sawOffline) {
        setSetup({ ...s, listed: true, connected: true })
        doneTimer = setTimeout(() => setSetup(), 6000)
      } else if (!s.listed) setSetup({ ...s, listed: true })
    }),
  )

  const issue = (r: { machine: Machine; token: string }) => {
    clearTimeout(doneTimer)
    setCopied(false)
    setSetup({
      machine: r.machine,
      token: r.token,
      listed: machines().some((m) => m.id === r.machine.id),
      sawOffline: !r.machine.online,
      connected: false,
    })
  }

  const add = () => {
    setAdding(true)
    setError()
    setConfirming()
    api
      .addMachine()
      .then(issue, (e: Error) => setError(`Couldn’t add a runner: ${e.message}`))
      .finally(() => setAdding(false))
  }

  const rename = (m: Machine, name: string) => {
    // Enter, then the blur as the box goes away, would both get here.
    if (renaming() !== m.id) return
    setRenaming()
    name = name.trim()
    if (!name || name === m.name) return
    setError()
    api.renameMachine(m.id, name).catch((e: Error) => setError(`Couldn’t rename ${m.name}: ${e.message}`))
  }

  const act = async () => {
    const c = confirming()
    const m = c && find(c.id)
    if (!c || !m || acting()) return
    setActing(true)
    setError()
    try {
      if (c.action === 'token') issue(await api.resetMachineToken(m.id))
      else {
        await api.removeMachine(m.id)
        if (setup()?.machine.id === m.id) setSetup()
      }
      setConfirming()
    } catch (e) {
      setError(`Couldn’t ${c.action === 'token' ? 'make a new token for' : 'remove'} ${m.name}: ${(e as Error).message}`)
    } finally {
      setActing(false)
    }
  }

  const command = (token: string) => `pnpm remote --hub ${hubUrl} --token ${token}`

  const copy = async (text: string, box: HTMLElement) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Without https there's no clipboard API: select it, which also leaves it ready to copy by hand.
      getSelection()?.selectAllChildren(box)
      if (!document.execCommand('copy')) return
    }
    setCopied(true)
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => setCopied(false), 2000)
  }

  const status = (m: Machine) =>
    m.online
      ? m.running
        ? `Online · ${plural(m.running, 'chat')} running`
        : 'Online'
      : m.lastSeen
        ? `Last seen ${ago(now() - m.lastSeen)}`
        : 'Waiting to connect…'

  const dot = (m: Machine) => (m.error ? 'bg-danger' : m.online ? 'bg-ok' : 'bg-fg-3')
  const isLaptop = (m: Machine) => m.platform === 'darwin' || m.platform === 'win32'

  return (
    <div>
      <div class="flex items-start gap-4">
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-medium text-fg">Runners</h3>
          <p class="mt-1 text-[13px] leading-relaxed text-fg-2">
            Chats run on the runner they started on, next to its files. Other machines connect with{' '}
            <code class="rounded bg-surface px-1 font-mono text-xs">pnpm remote</code> from a Badger checkout. While a runner is offline, its chats can be read but
            not run.
          </p>
        </div>
        <Button primary disabled={adding()} onClick={add} class="flex shrink-0 items-center gap-1.5 pointer-coarse:h-10">
          <Show when={adding()} fallback={<Plus class="size-3.5" />}>
            <Loader2 class="size-3.5 animate-spin" />
          </Show>
          Add runner
        </Button>
      </div>

      <Show when={error()}>
        <p class="mt-4 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          <TriangleAlert class="mt-px size-3.5 shrink-0" />
          <span class="min-w-0 flex-1">{error()}</span>
          <button type="button" title="Dismiss" onClick={() => setError()} class="shrink-0 opacity-70 hover:opacity-100">
            <X class="size-3.5" />
          </button>
        </p>
      </Show>

      <div class="mt-5 divide-y divide-line rounded-xl border border-line">
        <For each={ids()}>
          {(id) => (
            <Show when={find(id)}>
              {(m) => (
                <div class="px-3 py-3 sm:px-4">
                  <div class="flex items-center gap-3">
                    <div class="relative shrink-0 text-fg-3" title={m().online ? 'Online' : 'Offline'}>
                      <Show when={isLaptop(m())} fallback={<Server class="size-5" />}>
                        <Laptop class="size-5" />
                      </Show>
                      <span class={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-bg ${dot(m())}`} />
                    </div>

                    <div class="min-w-0 flex-1">
                      <div class="flex min-w-0 items-center gap-2">
                        <Show
                          when={renaming() === id}
                          fallback={
                            <button
                              type="button"
                              title="Rename"
                              onClick={() => setRenaming(id)}
                              class="group flex min-w-0 items-center gap-1.5 rounded text-left text-[13px] font-medium text-fg"
                            >
                              <span class="truncate">{m().name}</span>
                              <Pencil class="size-3 shrink-0 text-fg-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:opacity-100" />
                            </button>
                          }
                        >
                          <input
                            ref={(el) =>
                              queueMicrotask(() => {
                                el.focus()
                                el.select()
                              })
                            }
                            value={m().name}
                            aria-label="Runner name"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') rename(m(), e.currentTarget.value)
                              if (e.key === 'Escape') {
                                e.preventDefault()
                                setRenaming()
                              }
                            }}
                            onBlur={(e) => rename(m(), e.currentTarget.value)}
                            class={`${inputClass} h-7 max-w-64 px-2`}
                          />
                        </Show>
                        <Show when={m().local}>
                          <span class="shrink-0 rounded-full border border-edge px-1.5 text-[10px] leading-4 text-fg-3">This hub</span>
                        </Show>
                      </div>
                      <div class="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-fg-3">
                        <Show when={m().hostname || m().workspaceDir} fallback={<span>Not connected yet</span>}>
                          <Show when={m().hostname && m().hostname !== m().name}>
                            <span class="shrink-0">{m().hostname}</span>
                          </Show>
                          <Show when={m().hostname && m().hostname !== m().name && m().workspaceDir}>
                            <span class="shrink-0">·</span>
                          </Show>
                          <Show when={m().workspaceDir}>
                            <span class="min-w-0 truncate text-left font-mono text-[11px] [direction:rtl]" title="Where its new chats start">
                              {ltr(m().workspaceDir!)}
                            </span>
                          </Show>
                        </Show>
                      </div>
                      {/* Narrow screens have no room beside the name. */}
                      <div class="mt-0.5 text-xs text-fg-3 sm:hidden">{status(m())}</div>
                    </div>

                    <span class="hidden shrink-0 text-right text-xs text-fg-3 sm:block">{status(m())}</span>

                    <Show when={!m().local} fallback={<span class="w-7 shrink-0 pointer-coarse:w-9" />}>
                      <Menu
                        title="More"
                        placement="bottom"
                        class="right-0 left-auto! w-64"
                        items={[
                          { label: 'New token…', description: 'Get a command to connect it again' },
                          { label: 'Remove…', tone: 'danger' },
                        ]}
                        onPick={(i) => setConfirming({ id, action: i === 0 ? 'token' : 'remove' })}
                        triggerClass={(open) =>
                          `grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-surface hover:text-fg pointer-coarse:size-9 ${
                            open ? 'bg-surface text-fg' : 'text-fg-3'
                          }`
                        }
                        trigger={() => <Ellipsis class="size-4" />}
                      />
                    </Show>
                  </div>

                  <Show when={m().error}>
                    <p class="mt-2 ml-8 flex items-start gap-1.5 text-xs text-danger">
                      <TriangleAlert class="mt-px size-3.5 shrink-0" />
                      {m().error}
                    </p>
                  </Show>

                  <Show when={confirming()?.id === id && confirming()}>
                    {(c) => (
                      <div
                        class="mt-3 rounded-lg border border-edge bg-surface/50 p-3 sm:ml-8"
                        onKeyDown={(e) => {
                          if (e.key !== 'Escape') return
                          e.preventDefault()
                          setConfirming()
                        }}
                      >
                        <p class="text-[13px] font-medium text-fg">{c().action === 'token' ? `Make a new token for ${m().name}?` : `Remove ${m().name}?`}</p>
                        <p class="mt-1 text-xs leading-relaxed text-fg-2">
                          {c().action === 'token'
                            ? 'Its old token stops working at once, so its runner disconnects until it’s restarted with the new command. Its chats stay.'
                            : 'It’s disconnected and its token stops working. Its chats stay readable but can never run again: adding the machine again makes a new runner.'}
                        </p>
                        <div class="mt-3 flex justify-end gap-2">
                          <Button ref={(el) => queueMicrotask(() => el.focus())} onClick={() => setConfirming()} class="pointer-coarse:h-10">
                            Cancel
                          </Button>
                          <Show
                            when={c().action === 'remove'}
                            fallback={
                              <Button primary onClick={act} class="pointer-coarse:h-10">
                                Make new token
                              </Button>
                            }
                          >
                            <button
                              type="button"
                              onClick={act}
                              class="h-8 rounded-lg bg-danger px-3 text-[13px] font-medium text-bg transition-colors hover:bg-danger/85 disabled:pointer-events-none disabled:opacity-40 pointer-coarse:h-10"
                            >
                              Remove runner
                            </button>
                          </Show>
                        </div>
                      </div>
                    )}
                  </Show>

                  <Show when={setup()?.machine.id === id && setup()}>
                    {(s) => {
                      let box!: HTMLElement
                      return (
                        <div ref={(el) => queueMicrotask(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))} class="mt-3 sm:ml-8">
                          <div class="rounded-lg border border-edge p-3">
                            <Show
                              when={!s().connected}
                              fallback={
                                <p class="flex items-center gap-2 text-[13px] text-fg">
                                  <CircleCheck class="size-4 shrink-0 text-ok" />
                                  <span class="min-w-0">
                                    Connected as <span class="font-medium">{m().name}</span>
                                  </span>
                                </p>
                              }
                            >
                              <p class="text-[13px] text-fg">Run this in a Badger checkout on the other machine.</p>
                              <p class="mt-0.5 text-xs text-fg-3">
                                Add <code class="font-mono text-[11px] text-fg-2">--workspace ~/code</code> to choose where its new chats start.
                              </p>
                              <div class="mt-2.5 flex items-start gap-2 rounded-lg bg-surface py-1.5 pr-1.5 pl-3">
                                <code ref={box} class="min-w-0 flex-1 py-1 font-mono text-xs leading-relaxed break-all text-fg select-all">
                                  {command(s().token)}
                                </code>
                                <button
                                  type="button"
                                  onClick={() => copy(command(s().token), box)}
                                  class="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-edge bg-bg px-2 text-xs text-fg-2 transition-colors hover:text-fg disabled:opacity-40 pointer-coarse:h-9"
                                >
                                  <Show when={copied()} fallback={<Copy class="size-3.5" />}>
                                    <Check class="size-3.5 text-ok" />
                                  </Show>
                                  {copied() ? 'Copied' : 'Copy'}
                                </button>
                              </div>
                              <p class="mt-2 text-xs text-fg-3">The token is shown only now. If it’s lost, make a new one from the runner’s ⋯ menu.</p>
                              <p class="mt-3 flex items-center gap-2 text-xs text-fg-2">
                                <Loader2 class="size-3.5 shrink-0 animate-spin text-fg-3" />
                                Waiting for it to connect…
                              </p>
                            </Show>
                          </div>
                          <Show when={!s().connected}>
                            <p class="mt-2 text-[11px] leading-relaxed text-fg-3">
                              Behind an auth proxy, let <code class="font-mono">/runner</code> through without a login: the token is the runner’s auth.
                            </p>
                          </Show>
                        </div>
                      )
                    }}
                  </Show>
                </div>
              )}
            </Show>
          )}
        </For>
        <Show when={!rows().length}>
          <p class="px-4 py-6 text-center text-[13px] text-fg-3">Loading runners…</p>
        </Show>
      </div>
    </div>
  )
}

function ago(ms: number): string {
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}
