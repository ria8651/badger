import { For, Show, createSignal } from 'solid-js'
import { Check, Copy, KeyRound, Pencil, Trash2 } from 'lucide-solid'
import type { Machine } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { machines } from '../machines.ts'
import { Button, inputClass, ltr } from './ui.tsx'

/**
 * NOTE: a stopgap. This page's UX needs redoing; don't copy it or use it as a
 * reference for other pages.
 *
 * The machines chats and terminals run on: this hub's own, and any running
 * `badger remote`. Adding one makes the token its runner connects with, shown
 * once along with the command to run. A lost token is replaced rather than
 * shown again: only its hash is kept.
 */
export function Machines() {
  const [name, setName] = createSignal('')
  /** A token just made, for the machine it's shown under. */
  const [issued, setIssued] = createSignal<{ machine: Machine; token: string }>()
  const [error, setError] = createSignal<string>()
  const [copied, setCopied] = createSignal(false)
  const command = () => {
    const i = issued()
    return i ? `pnpm remote --hub ${location.origin} --token ${i.token}` : ''
  }
  const show = (i: { machine: Machine; token: string }) => {
    setIssued(i)
    setCopied(false)
  }

  const add = (e: Event) => {
    e.preventDefault()
    if (!name().trim()) return
    setError()
    api.addMachine(name().trim()).then(
      (i) => {
        show(i)
        setName('')
      },
      (err: Error) => setError(err.message),
    )
  }

  const rename = (m: Machine) => {
    const name = prompt(`Rename ${m.name} to:`, m.name)?.trim()
    if (name && name !== m.name) api.renameMachine(m.id, name).catch((err: Error) => alert(`Couldn't rename ${m.name}: ${err.message}`))
  }

  const resetToken = (m: Machine) => {
    if (!confirm(`Make a new token for ${m.name}? The old one stops working, so its runner disconnects until it's started with the new one. Its chats stay.`)) return
    api.resetMachineToken(m.id).then(show, (err: Error) => alert(`Couldn't make a new token for ${m.name}: ${err.message}`))
  }

  const remove = (m: Machine) => {
    if (!confirm(`Remove ${m.name}? Its runner is disconnected and its token stops working. Its chats stay, but can't run until it's added again.`)) return
    if (issued()?.machine.id === m.id) setIssued()
    api.removeMachine(m.id).catch((err: Error) => alert(`Couldn't remove ${m.name}: ${err.message}`))
  }

  const copy = () => navigator.clipboard?.writeText(command()).then(() => setCopied(true))

  const rowButton = 'grid size-6 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface pointer-coarse:size-9'

  return (
    <div class="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
      <div class="flex h-12 shrink-0 items-center px-5">
        <h1 class="font-medium">Machines</h1>
      </div>
      <div class="mx-auto w-full max-w-3xl px-5 pb-10">
        <p class="mt-2 text-[13px] leading-relaxed text-fg-2">
          Chats run on the machine they started on, next to its files. Other machines connect to this hub with <code class="font-mono text-xs">badger remote</code>,
          from a Badger checkout. While a machine is offline its chats can be read but not run.
        </p>

        <section class="mt-6">
          <h2 class="border-b border-line pb-2 text-[13px] font-medium text-fg-2">Connected and known</h2>
          <For each={machines()}>
            {(m) => (
              <>
                <div class="group -mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-surface/60">
                  <span
                    title={m.online ? 'Online' : 'Offline'}
                    class={`inline-block size-1.5 shrink-0 rounded-full ${m.online ? 'bg-ok' : 'bg-fg-3'}`}
                  />
                  <div class="min-w-0 flex-1">
                    <div class="flex items-baseline gap-2 text-[13px] text-fg">
                      {m.name}
                      <Show when={m.local}>
                        <span class="text-[11px] text-fg-3">This hub</span>
                      </Show>
                    </div>
                    <div class="mt-0.5 truncate text-left font-mono text-[11px] text-fg-3 [direction:rtl]">
                      {m.workspaceDir ? ltr(m.workspaceDir) : 'Not connected yet'}
                    </div>
                  </div>
                  <span class="shrink-0 text-[11px] text-fg-3">{m.online ? 'Online' : m.lastSeen ? `Last seen ${seen(m.lastSeen)}` : 'Never connected'}</span>
                  <button onClick={() => rename(m)} title="Rename" class={`${rowButton} hover:text-fg`}>
                    <Pencil class="size-3.5" />
                  </button>
                  {/* The hub's own row keeps the space empty, so every row's status lines up. */}
                  <Show when={!m.local} fallback={<span class="w-[calc(3rem+0.75rem)] shrink-0 pointer-coarse:w-[calc(4.5rem+0.75rem)]" />}>
                    <button onClick={() => resetToken(m)} title="New token: the old one stops working" class={`${rowButton} hover:text-fg`}>
                      <KeyRound class="size-3.5" />
                    </button>
                    <button onClick={() => remove(m)} title="Remove machine" class={`${rowButton} hover:text-danger`}>
                      <Trash2 class="size-3.5" />
                    </button>
                  </Show>
                </div>
                <Show when={issued()?.machine.id === m.id}>
                  <div class="mb-2 rounded-lg border border-edge p-3">
                    <p class="text-[13px] text-fg-2">
                      Run this on {m.name}, in a Badger checkout. The token is only shown now; if it's lost, make a new one with the key button.
                    </p>
                    <div class="mt-2 flex items-start gap-2">
                      <code class="min-w-0 flex-1 break-all rounded-md bg-surface px-2 py-1.5 font-mono text-[11px] text-fg">{command()}</code>
                      <button onClick={copy} title="Copy" class="grid size-7 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface hover:text-fg">
                        <Show when={copied()} fallback={<Copy class="size-3.5" />}>
                          <Check class="size-3.5" />
                        </Show>
                      </button>
                    </div>
                    <p class="mt-2 text-xs text-fg-3">
                      Add <code class="font-mono">--workspace ~/code</code> to choose where its new chats start. Behind an auth proxy, let <code class="font-mono">/runner</code>{' '}
                      through without a login: the token is its auth.
                    </p>
                  </div>
                </Show>
              </>
            )}
          </For>
        </section>

        <section class="mt-8">
          <h2 class="border-b border-line pb-2 text-[13px] font-medium text-fg-2">Add a machine</h2>
          <form onSubmit={add} class="mt-3 flex gap-2">
            <input
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              placeholder="What to call it, e.g. Work laptop"
              class={inputClass}
            />
            <Button primary type="submit" disabled={!name().trim()}>
              Add
            </Button>
          </form>
          <Show when={error()}>
            <p class="mt-2 text-xs text-danger">{error()}</p>
          </Show>
        </section>
      </div>
    </div>
  )
}

function seen(ms: number): string {
  const d = Date.now() - ms
  if (d < 60 * 1000) return 'just now'
  if (d < 60 * 60 * 1000) return `${Math.round(d / 60000)}m ago`
  if (d < 24 * 60 * 60 * 1000) return `${Math.round(d / 3600000)}h ago`
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
