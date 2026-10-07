import { For, Show, createSignal, onCleanup, onMount } from 'solid-js'
import { Plus } from 'lucide-solid'
import type { SessionSummary } from '../shared/protocol.ts'
import { api, getToken, setToken, socket } from './api.ts'
import { Chat } from './components/Chat.tsx'
import { Button } from './components/PermissionPrompt.tsx'

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
  const [newCwd, setNewCwd] = createSignal('')
  const [connected, setConnected] = createSignal(false)

  const refresh = () => {
    api.sessions().then(setSessions, (e) => e.status === 401 && setNeedsToken(true))
  }

  onMount(() => {
    api.config().then((c) => {
      setConfig(c)
      setNewCwd(c.defaultCwd)
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

  const newChat = () => {
    const id = uuid()
    setDrafts((d) => ({ ...d, [id]: newCwd().trim() || config()?.defaultCwd || '' }))
    open(id)
  }

  return (
    <Show
      when={!needsToken()}
      fallback={
        <form
          class="mx-auto mt-[25vh] flex max-w-sm flex-col gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault()
            setToken(new FormData(e.currentTarget).get('token') as string)
            location.reload()
          }}
        >
          <h1 class="text-lg font-semibold">Badger</h1>
          <input name="token" type="password" placeholder="Access token" autofocus class="rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700" />
          <Button primary type="submit">Continue</Button>
        </form>
      }
    >
      <div class="flex h-full">
        <aside class="hidden w-72 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 md:flex dark:border-zinc-800 dark:bg-zinc-900/50">
          <div class="space-y-2 p-3">
            <div class="flex items-center justify-between">
              <span class="font-semibold">Badger</span>
              <span
                title={connected() ? 'Connected' : 'Reconnecting…'}
                class={`size-2 rounded-full ${connected() ? 'bg-emerald-500' : 'bg-amber-500'}`}
              />
            </div>
            <button
              onClick={newChat}
              class="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
            >
              <Plus class="size-4" /> New chat
            </button>
            <input
              value={newCwd()}
              onInput={(e) => setNewCwd(e.currentTarget.value)}
              title="Working directory for new chats"
              class="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 font-mono text-xs text-zinc-600 outline-none focus:border-accent dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400"
            />
          </div>
          <nav class="flex-1 overflow-y-auto px-2 pb-3">
            <For each={sessions()}>
              {(s) => (
                <button
                  onClick={() => open(s.id)}
                  class={`mb-0.5 block w-full rounded-md px-2 py-1.5 text-left text-sm ${
                    s.id === current() ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
                  }`}
                >
                  <div class="flex items-center gap-1.5">
                    <Show when={s.running}>
                      <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
                    </Show>
                    <span class="truncate">{s.title}</span>
                  </div>
                  <div class="truncate font-mono text-[11px] text-zinc-400">
                    {s.cwd?.split('/').pop()} · {new Date(s.lastModified).toLocaleDateString()}
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
            <div class="flex flex-1 flex-col items-center justify-center gap-3 text-zinc-400">
              <p>Start a chat with Claude Code on this server.</p>
              <Button primary onClick={newChat}>New chat</Button>
            </div>
          }
        >
          {(id) => <Chat sessionId={id} draftCwd={drafts()[id] ?? newCwd()} />}
        </Show>
      </div>
    </Show>
  )
}
