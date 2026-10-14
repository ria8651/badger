import { For, Show, createSignal } from 'solid-js'
import { TriangleAlert, X } from './icons'
import { socket } from './api.ts'
import { Button } from './components/ui.tsx'

/*
 * Uncaught errors, shown rather than left in the console. An error thrown
 * during a Solid update stops that update partway, so the page can be left
 * showing things that are no longer true; saying so, and offering a reload,
 * beats quietly being wrong. Each is also logged by the server, so whoever is
 * watching its output sees it too.
 */

interface Crash {
  message: string
  stack?: string
  /** The same error again, e.g. on every message from the server. */
  count: number
}

const [crashes, setCrashes] = createSignal<Crash[]>([])

/** Noise the browser reports as errors that breaks nothing. */
const BENIGN = [/^ResizeObserver loop/, /^Script error\.?$/]

function record(error: unknown, fallback = 'Unknown error'): void {
  const err = error instanceof Error ? error : undefined
  const message = err ? `${err.name}: ${err.message}` : error === undefined ? fallback : String(error)
  if (BENIGN.some((re) => re.test(message.replace(/^Error: /, '')))) return
  const stack = err?.stack
  setCrashes((all) => {
    const same = all.find((c) => c.message === message)
    if (same) return all.map((c) => (c === same ? { ...c, count: c.count + 1 } : c))
    socket.send({ type: 'client_error', message, stack, url: location.href })
    return [...all, { message, stack, count: 1 }]
  })
}

addEventListener('error', (e) => record(e.error, e.message))
addEventListener('unhandledrejection', (e) => record(e.reason))

export function Crashes() {
  const [open, setOpen] = createSignal(false)
  const copy = () =>
    void navigator.clipboard.writeText(crashes().map((c) => `${c.stack ?? c.message}${c.count > 1 ? `\n(${c.count} times)` : ''}`).join('\n\n'))
  return (
    <Show when={crashes().length}>
      <div class="fixed right-4 bottom-4 z-50 w-96 max-w-[calc(100vw-2rem)] animate-[pop-in_120ms_ease-out] rounded-2xl border border-danger/40 bg-bg p-4 text-[13px] shadow-[0_12px_32px_-12px_rgb(0_0_0/0.35)]">
        <div class="flex items-start gap-2.5">
          <TriangleAlert class="mt-0.5 size-4 shrink-0 text-danger" />
          <div class="min-w-0 flex-1">
            <p class="font-medium">Something broke in this page</p>
            <p class="mt-0.5 text-xs text-fg-3">What’s on screen may be out of date until you reload.</p>
          </div>
          <button onClick={() => setCrashes([])} title="Dismiss" class="grid size-6 shrink-0 place-items-center rounded text-fg-3 transition-colors hover:text-fg">
            <X class="size-3.5" />
          </button>
        </div>
        <div class="mt-3 max-h-60 space-y-2 overflow-y-auto">
          <For each={crashes()}>
            {(c) => (
              <div class="font-mono text-xs break-words text-danger">
                {c.message}
                <Show when={c.count > 1}>
                  <span class="text-fg-3"> ×{c.count}</span>
                </Show>
                <Show when={open() && c.stack}>
                  <pre class="mt-1 whitespace-pre-wrap text-[11px] text-fg-3">{c.stack}</pre>
                </Show>
              </div>
            )}
          </For>
        </div>
        <div class="mt-3 flex items-center gap-2">
          <Button primary onClick={() => location.reload()}>
            Reload
          </Button>
          <Button onClick={copy}>Copy details</Button>
          <button onClick={() => setOpen((o) => !o)} class="ml-auto text-xs text-fg-3 transition-colors hover:text-fg-2">
            {open() ? 'Hide stacks' : 'Show stacks'}
          </button>
        </div>
      </div>
    </Show>
  )
}
