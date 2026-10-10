import { For, Show, createSignal, onCleanup } from 'solid-js'
import type { AccountUsage, ContextUsage } from '../../shared/protocol.ts'
import { resets, tokens } from '../usage.ts'

/** Past this much of the window, the meter turns red: autocompact is close. */
const CONTEXT_FULL = 85

/** A ring and a percentage for the composer; click for what's in the window. */
export function ContextMeter(props: { usage: ContextUsage }) {
  const [open, setOpen] = createSignal(false)
  let root!: HTMLDivElement
  const onOutside = (e: PointerEvent) => open() && !root.contains(e.target as Node) && setOpen(false)
  document.addEventListener('pointerdown', onOutside)
  onCleanup(() => document.removeEventListener('pointerdown', onOutside))

  const full = () => props.usage.percent >= CONTEXT_FULL
  const rows = () => props.usage.categories.filter((c) => c.tokens > 0)
  return (
    <div ref={root} class="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        title={`Context: ${tokens(props.usage.tokens)} of ${tokens(props.usage.max)} tokens`}
        aria-expanded={open()}
        class={`flex h-7 items-center gap-1.5 rounded-md px-2 text-xs tabular-nums transition-colors hover:bg-surface hover:text-fg-2 pointer-coarse:h-9 pointer-coarse:px-1.5 ${
          full() ? 'text-danger' : open() ? 'bg-surface text-fg-2' : 'text-fg-3'
        } ${open() ? 'bg-surface' : ''}`}
      >
        <Ring percent={props.usage.percent} />
        {props.usage.percent}%
      </button>
      <Show when={open()}>
        <div class="absolute right-0 bottom-full z-10 mb-1.5 w-72 origin-bottom animate-[pop-in_120ms_ease-out] rounded-xl border border-edge bg-bg p-3 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.35)]">
          <div class="flex items-baseline justify-between text-[13px]">
            <span class="text-fg">Context</span>
            <span class="text-xs text-fg-3 tabular-nums">
              {tokens(props.usage.tokens)} / {tokens(props.usage.max)}
            </span>
          </div>
          <Bar percent={props.usage.percent} danger={full()} class="mt-2" />
          <div class="mt-3 space-y-1">
            <For each={rows()}>
              {(c) => (
                <div class={`flex justify-between text-xs tabular-nums ${c.kind === 'used' ? 'text-fg-2' : 'text-fg-3'}`}>
                  <span>{c.name}</span>
                  <span>{tokens(c.tokens)}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

/** The plan's limits, for the foot of the sidebar. */
export function AccountLimits(props: { usage: AccountUsage }) {
  return (
    <Show when={props.usage.limits.length}>
      <div class="space-y-2.5 border-t border-line px-4 py-3">
        <For each={props.usage.limits}>
          {(l) => {
            const high = () => l.severity !== 'normal' || l.percent >= 90
            return (
              <div title={l.resetsAt ? `Resets ${new Date(l.resetsAt).toLocaleString()}` : undefined}>
                <div class="flex items-baseline gap-2 text-[11px] tabular-nums">
                  <span class="text-fg-2">{l.label}</span>
                  <Show when={l.resetsAt}>{(at) => <span class="min-w-0 flex-1 truncate text-fg-3">resets {resets(at())}</span>}</Show>
                  <span class={`ml-auto ${high() ? 'text-danger' : 'text-fg-3'}`}>{Math.round(l.percent)}%</span>
                </div>
                <Bar percent={l.percent} danger={high()} class="mt-1" />
              </div>
            )
          }}
        </For>
      </div>
    </Show>
  )
}

function Bar(props: { percent: number; danger?: boolean; class?: string }) {
  return (
    <div class={`h-1 overflow-hidden rounded-full bg-surface ${props.class ?? ''}`}>
      <div
        class={`h-full rounded-full transition-[width] ${props.danger ? 'bg-danger' : 'bg-fg-3'}`}
        style={{ width: `${Math.min(100, Math.max(0, props.percent))}%` }}
      />
    </div>
  )
}

function Ring(props: { percent: number }) {
  const r = 5
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 14 14" class="size-3.5 -rotate-90">
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="2" />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-dasharray={`${(c * Math.min(100, props.percent)) / 100} ${c}`}
      />
    </svg>
  )
}
