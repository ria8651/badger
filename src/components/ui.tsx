import { For, Show, createSignal, createUniqueId, onCleanup, splitProps, type JSX } from 'solid-js'
import { Check, ChevronDown } from 'lucide-solid'
import type { AttentionState } from '../../shared/protocol.ts'

/** Ink-filled when primary; otherwise a hairline outline. */
export function Button(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  const [local, rest] = splitProps(props, ['primary', 'class'])
  return (
    <button
      {...rest}
      class={`h-8 px-3 text-[13px] font-medium transition-colors rounded-lg disabled:pointer-events-none disabled:opacity-40 ${
        local.primary ? 'bg-fg text-bg hover:bg-fg/85' : 'border border-edge text-fg-2 hover:bg-surface hover:text-fg'
      } ${local.class ?? ''}`}
    />
  )
}

/** Round, ink-filled, icon only. Goes quiet when disabled rather than fading out. */
export function IconButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <button
      {...rest}
      class={`grid size-8 shrink-0 place-items-center rounded-full bg-fg text-bg transition-colors hover:bg-fg/85 disabled:bg-surface disabled:text-fg-3 ${local.class ?? ''}`}
    />
  )
}

/** A touch screen is the main pointer, so there's no hover and no physical keyboard to assume. */
export const touch = matchMedia('(pointer: coarse)')

export const inputClass =
  'h-8 w-full border border-edge bg-transparent px-3 text-[13px] outline-none transition-colors rounded-lg placeholder:text-fg-3 focus:border-fg-3 pointer-coarse:text-base'

/** A pulsing dot in the accent colour: something is live. */
export function LiveDot(props: { class?: string }) {
  return <span class={`inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-accent ${props.class ?? ''}`} />
}

/**
 * A chat's state at a glance: a ringed dot when it's waiting on the user,
 * pulsing while it works, an ink dot when it finished and hasn't been looked at.
 */
export function ChatDot(props: { running?: boolean; attention?: AttentionState; class?: string }) {
  return (
    <Show
      when={props.attention !== 'waiting'}
      fallback={<span title="Needs your input" class={`inline-block size-2 shrink-0 rounded-full bg-accent ring-2 ring-accent/25 ${props.class ?? ''}`} />}
    >
      <Show when={!props.running} fallback={<LiveDot class={props.class} />}>
        <Show when={props.attention === 'unread'}>
          <span title="Finished" class={`inline-block size-1.5 shrink-0 rounded-full bg-fg ${props.class ?? ''}`} />
        </Show>
      </Show>
    </Show>
  )
}

/**
 * For paths shown with text-left [direction:rtl] so they truncate from the start: the
 * left-to-right mark keeps the leading slash where it belongs.
 */
export const ltr = (text: string) => '\u200E' + text

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** A count in few characters, e.g. 12.3K. */
export const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)

export interface MenuItem {
  label: string
  description?: string
  /** Set on every item to show a check column; true marks the current one. */
  selected?: boolean
  tone?: 'danger'
  /** Monospace description, truncated from the start (for paths). */
  mono?: boolean
}

/**
 * A trigger that opens a list above or below it. Arrow keys move, Enter picks,
 * Escape closes; focus returns to the trigger either way.
 */
export function Menu(props: {
  items: MenuItem[]
  onPick: (index: number) => void
  /** Called once; read open() inside so the trigger updates in place. */
  trigger: (open: () => boolean) => JSX.Element
  triggerClass: (open: boolean) => string
  title?: string
  placement?: 'top' | 'bottom'
  class?: string
}) {
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  // Stays true through the exit animation so the menu can animate out.
  const [mounted, setMounted] = createSignal(false)
  const [active, setActive] = createSignal(0)
  let root!: HTMLDivElement
  let trigger!: HTMLButtonElement

  const show = () => {
    if (!props.items.length) return
    setActive(Math.max(0, props.items.findIndex((o) => o.selected)))
    setOpen(true)
    setMounted(true)
  }
  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) trigger.focus()
  }
  const pick = (i: number) => {
    close()
    props.onPick(i)
  }

  const onOutside = (e: PointerEvent) => {
    if (open() && !root.contains(e.target as Node)) close(false)
  }
  document.addEventListener('pointerdown', onOutside)
  onCleanup(() => document.removeEventListener('pointerdown', onOutside))

  const onListKey = (e: KeyboardEvent) => {
    const n = props.items.length
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => (i + 1) % n),
      ArrowUp: () => setActive((i) => (i - 1 + n) % n),
      Home: () => setActive(0),
      End: () => setActive(n - 1),
      Enter: () => pick(active()),
      ' ': () => pick(active()),
      Escape: () => close(),
      Tab: () => close(),
    }
    const action = keys[e.key]
    if (!action) return
    if (e.key !== 'Tab') e.preventDefault()
    action()
  }

  const checkable = () => props.items.some((o) => o.selected !== undefined)

  return (
    <div ref={root} class="relative">
      <button
        ref={trigger}
        type="button"
        title={props.title}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => (open() ? close() : show())}
        onKeyDown={(e) => {
          if (['ArrowDown', 'ArrowUp'].includes(e.key) && !open()) {
            e.preventDefault()
            show()
          }
        }}
        class={props.triggerClass(open())}
      >
        {props.trigger(open)}
      </button>
      <Show when={mounted()}>
        <div
          ref={(el) => queueMicrotask(() => el.focus())}
          onAnimationEnd={() => !open() && setMounted(false)}
          role="listbox"
          tabindex={-1}
          aria-activedescendant={`${id}-${active()}`}
          onKeyDown={onListKey}
          class={`absolute left-0 z-10 max-h-[60vh] overflow-y-auto rounded-xl border border-edge bg-bg p-1 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.35)] outline-none ${
            props.placement === 'bottom' ? 'top-full mt-1.5 origin-top' : 'bottom-full mb-1.5 origin-bottom'
          } ${open() ? 'animate-[pop-in_120ms_ease-out]' : 'pointer-events-none animate-[pop-out_80ms_ease-in_forwards]'} ${props.class ?? 'w-72'}`}
        >
          <For each={props.items}>
            {(o, i) => (
              <div
                id={`${id}-${i()}`}
                role="option"
                aria-selected={!!o.selected}
                onPointerMove={() => setActive(i())}
                onClick={() => pick(i())}
                class={`flex cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2 pointer-coarse:py-3 ${active() === i() ? 'bg-surface' : ''}`}
              >
                <div class="min-w-0 flex-1">
                  <div class={`truncate text-[13px] ${o.tone === 'danger' ? 'text-danger' : 'text-fg'}`}>{o.label}</div>
                  <Show when={o.description}>
                    <div class={`mt-0.5 leading-snug text-fg-3 ${o.mono ? 'truncate font-mono text-[11px] text-left [direction:rtl]' : 'text-xs'}`}>
                      {o.mono ? ltr(o.description!) : o.description}
                    </div>
                  </Show>
                </div>
                <Show when={checkable()}>
                  <Check class={`mt-0.5 size-3.5 shrink-0 text-fg-2 ${o.selected ? '' : 'invisible'}`} />
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export interface Option<T extends string> {
  value: T
  label: string
  description?: string
  tone?: 'danger'
}

/** A Menu that picks one value and shows it as the trigger label. */
export function Select<T extends string>(props: {
  value: T
  options: Option<T>[]
  onChange: (value: T) => void
  title?: string
  placement?: 'top' | 'bottom'
}) {
  const current = () => props.options.find((o) => o.value === props.value)
  return (
    <Menu
      items={props.options.map((o) => ({ ...o, selected: o.value === props.value }))}
      onPick={(i) => props.onChange(props.options[i].value)}
      title={props.title}
      placement={props.placement}
      triggerClass={(open) =>
        `flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors hover:bg-surface pointer-coarse:h-9 pointer-coarse:px-1.5 ${
          current()?.tone === 'danger' ? 'text-danger' : open ? 'text-fg-2' : 'text-fg-3 hover:text-fg-2'
        } ${open ? 'bg-surface' : ''}`
      }
      trigger={(open) => (
        <>
          {current()?.label}
          <ChevronDown class={`size-3 transition-transform ${open() ? 'rotate-180' : ''}`} />
        </>
      )}
    />
  )
}
