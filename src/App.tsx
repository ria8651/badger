import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { Plus } from 'lucide-solid'
import type { SessionSummary } from '../shared/protocol.ts'
import { api, getToken, setToken, socket } from './api.ts'
import { Chat } from './components/Chat.tsx'
import { Button, LiveDot, Menu, inputClass, ltr } from './components/ui.tsx'

/** crypto.randomUUID needs a secure context; fall back for plain-http hosts. */
function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const sessionFromPath = () => location.pathname.match(/^\/s\/([0-9a-f-]{36})/)?.[1] ?? null

export function App() {
  const [config, setConfig] = createSignal<{ defaultCwd: string; authRequired: boolean } | null>(null)
  const [needsToken, setNeedsToken] = createSignal(false)
  const [sessions, setSessions] = createSignal<SessionSummary[]>([])
  const [current, setCurrent] = createSignal<string | null>(sessionFromPath())
  const [drafts, setDrafts] = createSignal<Record<string, string>>({})
  const [connected, setConnected] = createSignal(false)

  const refresh = () => {
    api.sessions().then(setSessions, (e) => e.status === 401 && setNeedsToken(true))
  }

  onMount(() => {
    api.config().then((c) => {
      setConfig(c)
      if (c.authRequired && !getToken()) return setNeedsToken(true)
      socket.connect()
      refresh()
    })
    const offConn = socket.onConnection(setConnected)
    // Refresh the list when sessions appear, finish a turn, or change state.
    let timer: ReturnType<typeof setTimeout>
    const off = socket.on((e) => {
      if (e.type === 'sessions_changed' || e.type === 'status') {
        clearTimeout(timer)
        timer = setTimeout(refresh, 300)
      }
    })
    const onPop = () => setCurrent(sessionFromPath())
    addEventListener('popstate', onPop)
    onCleanup(() => {
      clearTimeout(timer)
      off()
      offConn()
      removeEventListener('popstate', onPop)
    })
  })

  const open = (id: string | null) => {
    history.pushState(null, '', id ? `/s/${id}` : '/')
    setCurrent(id)
  }

  /** Every directory a session has run in, most recent first, plus the server default. Scratch dirs are skipped. */
  const projects = createMemo(() => {
    const dirs = [...new Set(sessions().flatMap((s) => (s.cwd && !TEMP.test(s.cwd) ? [s.cwd] : [])))]
    const fallback = config()?.defaultCwd
    if (fallback && !dirs.includes(fallback)) dirs.push(fallback)
    return dirs
  })

  const newChat = (cwd: string) => {
    const id = uuid()
    setDrafts((d) => ({ ...d, [id]: cwd }))
    open(id)
  }

  return (
    <Show
      when={!needsToken()}
      fallback={
        <form
          class="mx-auto mt-[28vh] flex max-w-xs flex-col gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault()
            setToken(new FormData(e.currentTarget).get('token') as string)
            location.reload()
          }}
        >
          <h1 class="mb-1 font-medium">Badger</h1>
          <input name="token" type="password" placeholder="Access token" autofocus class={inputClass} />
          <Button primary type="submit">Continue</Button>
        </form>
      }
    >
      <div class="flex h-full">
        <aside class="hidden w-64 shrink-0 flex-col border-r border-line md:flex">
          <div class="flex h-12 shrink-0 items-center gap-2 px-4">
            <span class="font-medium tracking-tight">Badger</span>
            <Show when={!connected()}>
              <span class="text-xs text-fg-3">Reconnecting…</span>
            </Show>
          </div>
          <div class="px-2 pb-3">
            <Menu
              items={projects().map((p) => ({ label: basename(p), description: p, mono: true }))}
              onPick={(i) => newChat(projects()[i])}
              placement="bottom"
              class="w-60"
              triggerClass={(open) =>
                `flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] transition-colors hover:bg-surface hover:text-fg ${
                  open ? 'bg-surface text-fg' : 'text-fg-2'
                }`
              }
              trigger={() => (
                <>
                  <Plus class="size-4" /> New chat
                </>
              )}
            />
          </div>
          <nav class="flex-1 overflow-y-auto border-t border-line px-2 py-2">
            <For each={sessions()}>
              {(s) => (
                <button
                  onClick={() => open(s.id)}
                  class={`group mb-px block w-full rounded-lg px-2 py-1.5 text-left transition-colors ${
                    s.id === current() ? 'bg-surface' : 'hover:bg-surface/60'
                  }`}
                >
                  <div class="flex items-center gap-2">
                    <span
                      class={`min-w-0 flex-1 truncate text-[13px] ${
                        s.id === current() ? 'text-fg' : 'text-fg-2 group-hover:text-fg'
                      }`}
                    >
                      {s.title}
                    </span>
                    <Show when={s.running}>
                      <LiveDot />
                    </Show>
                  </div>
                  <div class="mt-0.5 flex gap-1.5 text-[11px] text-fg-3 tabular-nums">
                    <span class="truncate">{s.cwd && basename(s.cwd)}</span>
                    <span class="ml-auto shrink-0">{when(s.lastModified)}</span>
                  </div>
                </button>
              )}
            </For>
          </nav>
        </aside>

        <Show
          when={current()}
          keyed
          fallback={
            <div class="flex flex-1 items-center justify-center p-5">
              <div class="w-full max-w-sm">
                <p class="mb-3 px-3 text-[13px] text-fg-3">Start a chat in</p>
                <div class="max-h-[60vh] overflow-y-auto">
                  <For each={projects()}>
                    {(p) => (
                      <button
                        onClick={() => newChat(p)}
                        class="group block w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface"
                      >
                        <div class="text-[13px] text-fg-2 group-hover:text-fg">{basename(p)}</div>
                        <div class="truncate font-mono text-[11px] text-fg-3 text-left [direction:rtl]">{ltr(p)}</div>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>
          }
        >
          {(id) => <Chat sessionId={id} draftCwd={drafts()[id]} />}
        </Show>
      </div>
    </Show>
  )
}

const TEMP = /^\/(private\/)?(tmp|var\/folders)\//

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

/** Time today, day and month this year, full date otherwise. */
function when(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
