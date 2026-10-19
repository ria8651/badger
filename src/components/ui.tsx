import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, splitProps, type Component, type JSX } from 'solid-js'
import { Dynamic, Portal } from 'solid-js/web'
import { Check, ChevronDown, X } from '../icons'
import type { AttentionState } from '../../shared/protocol.ts'
import { connected } from '../api.ts'
import { compact, plural } from '../format.ts'

/** Open modals, innermost last. A dialog can open over another, and a modal popover over either. */
const [modals, setModals] = createSignal<symbol[]>([])

/** A modal, like Settings, is open. Its keys are its own: shortcuts and Escape behind it leave them be. */
export const modalOpen = () => modals().length > 0

/**
 * Counts a modal as open until the returned release is called, which is safe to call twice. `top` says
 * whether it's the innermost, so of stacked ones only that one answers Escape.
 */
export function openModal(): { top: () => boolean; release: () => void } {
  const me = Symbol()
  setModals((m) => [...m, me])
  return { top: () => modals().at(-1) === me, release: () => setModals((m) => m.filter((x) => x !== me)) }
}

/** A popover is open. Escape is its to close, so dialogs behind it leave Escape be. */
const [popoverOpen, setPopoverOpen] = createSignal(false)
export { popoverOpen, setPopoverOpen }

/**
 * Closes something floating, like a menu, on a press anywhere outside it (and its trigger), while it's
 * open. Optionally on Escape too, unless a modal has the keys, or on the window resizing.
 */
export function createDismiss(
  open: () => boolean,
  inside: () => (Node | undefined)[],
  close: () => void,
  opts: { escape?: boolean; resize?: boolean } = {},
) {
  const onOutside = (e: PointerEvent) => open() && !inside().some((el) => el?.contains(e.target as Node)) && close()
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && open() && !modalOpen() && close()
  const onResize = () => open() && close()
  document.addEventListener('pointerdown', onOutside)
  if (opts.escape) document.addEventListener('keydown', onKey)
  if (opts.resize) addEventListener('resize', onResize)
  onCleanup(() => {
    document.removeEventListener('pointerdown', onOutside)
    document.removeEventListener('keydown', onKey)
    removeEventListener('resize', onResize)
  })
}

/**
 * A modal panel over a dimmed page, for its owner's lifetime. It takes focus (unless something in it already
 * has), gives it back when it goes, and counts as a modal. Escape closes the innermost one: inside it, only
 * if nothing in it (an open menu, a name being edited) handled the key first; from outside, say with focus left
 * in the composer, it's caught first so it closes this rather than also stopping Claude. Only a click that
 * starts and ends on the backdrop closes it, so selecting text out past the edge doesn't.
 */
export function Dialog(props: {
  label: string
  onClose: () => void
  /** The panel's size from sm up; below that it fills the screen. */
  size: string
  children: JSX.Element
}) {
  const before = document.activeElement as HTMLElement | null
  const modal = openModal()
  let panel!: HTMLDivElement
  let downOnBackdrop = false

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && modal.top() && !e.defaultPrevented && panel.contains(e.target as Node)) props.onClose()
  }
  const onKeyOutside = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !modal.top() || popoverOpen() || panel.contains(e.target as Node)) return
    e.stopPropagation()
    props.onClose()
  }
  addEventListener('keydown', onKey)
  addEventListener('keydown', onKeyOutside, true)
  onCleanup(() => {
    modal.release()
    removeEventListener('keydown', onKey)
    removeEventListener('keydown', onKeyOutside, true)
    before?.focus()
  })
  onMount(() => !panel.contains(document.activeElement) && panel.focus())

  return (
    <Portal>
      <div
        class="fixed inset-0 z-50 flex animate-[fade-in_120ms_ease-out] items-center justify-center bg-black/40 sm:p-6"
        onPointerDown={(e) => (downOnBackdrop = e.target === e.currentTarget)}
        onClick={(e) => e.target === e.currentTarget && downOnBackdrop && props.onClose()}
      >
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-label={props.label}
          tabindex={-1}
          class={`flex h-full w-full flex-col overflow-hidden border-edge bg-bg p-(--inset) shadow-(--shadow-modal) outline-none sm:rounded-xl sm:border-(length:--dialog-border) ${props.size}`}
        >
          {props.children}
        </div>
      </div>
    </Portal>
  )
}

/** A dialog's title bar, with its close button. */
export function DialogTitle(props: { title: string; onClose: () => void }) {
  return (
    <div class="bar flex items-center gap-2 border-b border-line px-4 py-3">
      <h2 class="flex-1 text-sm font-medium text-fg">{props.title}</h2>
      <GhostButton size="lg" title="Close" onClick={props.onClose} class="pointer-coarse:size-10">
        <X class="size-4" />
      </GhostButton>
    </div>
  )
}

const GHOST_SIZES = {
  /** On a row, like the sidebar's. */
  sm: 'size-5 rounded-button-sm pointer-coarse:size-6',
  /** In a toolbar, like a panel's. */
  md: 'size-7 rounded-md',
  /** In a dialog. */
  lg: 'size-8 rounded-lg',
}

/** A small icon button with no chrome until hovered: quiet unless active. For triggers that take a class, like Menu's. */
export const ghostClass = (size: keyof typeof GHOST_SIZES = 'md', active = false) =>
  `grid shrink-0 place-items-center transition-colors hover:bg-surface hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent ${GHOST_SIZES[size]} ${
    active ? 'bg-surface text-fg' : 'text-fg-3'
  }`

/** A small icon button with no chrome until hovered. Give it a title, since it has no label. */
export function GhostButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { title: string; size?: keyof typeof GHOST_SIZES; active?: boolean }) {
  const [local, rest] = splitProps(props, ['size', 'active', 'class'])
  return <button type="button" {...rest} class={`${ghostClass(local.size, local.active)} ${local.class ?? ''}`} />
}

/** A strip above the composer saying why things are as they are: offline, gone, an error. */
export function Notice(props: { icon?: Component<{ class?: string }>; tone?: 'danger'; children: JSX.Element }) {
  return (
    <div class={`flex items-start gap-3 rounded-lg px-3 py-2 text-ui ${props.tone === 'danger' ? 'bg-danger/10 text-danger' : 'bg-surface text-fg-2'}`}>
      <Show when={props.icon}>{(icon) => <Dynamic component={icon()} class="size-4 shrink-0 mt-0.5" />}</Show>
      {props.children}
    </div>
  )
}

/** Filled with the primary colour when primary, red when it destroys something; otherwise a hairline outline. */
export function Button(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; danger?: boolean }) {
  const [local, rest] = splitProps(props, ['primary', 'danger', 'class'])
  return (
    <button
      {...rest}
      class={`h-8 px-3 text-ui font-medium transition-colors rounded-button-lg disabled:pointer-events-none disabled:opacity-40 ${
        local.primary
          ? 'bg-primary text-on-primary shadow-(--shadow-control) hover:bg-primary/85'
          : local.danger
            ? 'bg-danger text-white shadow-(--shadow-control) hover:bg-danger/85'
            : 'border border-button-edge text-fg-2 shadow-(--shadow-control) hover:bg-surface hover:text-fg'
      } ${local.class ?? ''}`}
    />
  )
}

/** Round, filled with the primary colour, icon only. Goes quiet when disabled rather than fading out. */
export function IconButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <button
      {...rest}
      class={`grid size-8 shrink-0 place-items-center rounded-button-round bg-primary text-on-primary shadow-(--shadow-control) transition-colors pointer-coarse:size-9 hover:bg-primary/85 disabled:bg-surface disabled:text-fg-3 disabled:shadow-none ${local.class ?? ''}`}
    />
  )
}

/** A touch screen is the main pointer, so there's no hover and no physical keyboard to assume. */
export const touch = matchMedia('(pointer: coarse)')

export const inputClass =
  'h-8 w-full border border-edge bg-transparent px-3 text-ui outline-none transition-colors rounded-lg placeholder:text-fg-3 focus:border-fg-3 pointer-coarse:text-base'

/**
 * Stands in for a page or chat until its data arrives. Says so when the server can't be reached, since then it
 * won't arrive until it's back. Fades in late so a quick load doesn't flash it.
 */
export function Loading(props: { class?: string }) {
  return (
    <div class={`flex flex-1 animate-[fade-in_200ms_ease-out_300ms_both] items-center justify-center gap-2 text-ui text-fg-3 ${props.class ?? ''}`}>
      <Show when={connected()} fallback="Can’t reach the server. Retrying…">
        <LiveDot /> Loading…
      </Show>
    </div>
  )
}

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

export { compact, plural }

/**
 * What's uncommitted in a checkout, as a diff counts it: lines added and removed, and nothing at all when
 * there's nothing. Changes with no lines to count, like a binary file or a rename, show as files.
 */
export function DiffCount(props: { files: number; added: number; removed: number; class?: string }) {
  return (
    <Show when={props.files}>
      <span class={`inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums ${props.class ?? ''}`}>
        <Show when={props.added || props.removed} fallback={<span class="text-accent">{plural(props.files, 'file')} changed</span>}>
          <Show when={props.added}>
            <span class="text-ok">+{compact(props.added)}</span>
          </Show>
          <Show when={props.removed}>
            <span class="text-danger">−{compact(props.removed)}</span>
          </Show>
        </Show>
      </span>
    </Show>
  )
}

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
  /** Which edge of the trigger the list lines up with; left by default. */
  align?: 'left' | 'right'
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

  createDismiss(open, () => [root], () => close(false))

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
          class={`absolute ${props.align === 'right' ? 'right-0' : 'left-0'} z-10 max-h-[60vh] overflow-y-auto rounded-xl border border-edge bg-bg p-1 pop shadow-(--shadow-pop) outline-none ${
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
                  <div class={`truncate text-ui ${o.tone === 'danger' ? 'text-danger' : 'text-fg'}`}>{o.label}</div>
                  <Show when={o.description}>
                    <div class={`mt-0.5 leading-snug text-fg-3 ${o.mono ? 'truncate font-mono text-meta text-left [direction:rtl]' : 'text-xs'}`}>
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
        `flex h-7 items-center gap-1 rounded-button-md px-2 text-xs transition-colors hover:bg-surface pointer-coarse:h-9 ${
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

export interface SearchItem extends MenuItem {
  /** Shown small at the right, e.g. a card number. */
  hint?: string
  /** Sits under the item before it, e.g. a card under its project. */
  indent?: boolean
  /** Draws the item in place of its label and description, e.g. a chat drawn as the sidebar draws it. */
  render?: () => JSX.Element
  pick: () => void
}

/**
 * Where a panel floating over the page goes, as fixed-position styles: lined up with the trigger's left edge
 * and kept on screen, below it if there's room, otherwise on whichever side has more, and no taller than that side.
 */
export function floatBy(trigger: Element | DOMRect, width: number): JSX.CSSProperties {
  const r = trigger instanceof Element ? trigger.getBoundingClientRect() : trigger
  const left = `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`
  const below = innerHeight - r.bottom - 14
  const above = r.top - 14
  return below > 320 || below >= above
    ? { left, top: `${r.bottom + 6}px`, 'max-height': `${Math.min(416, below)}px` }
    : { left, bottom: `${innerHeight - r.top + 6}px`, 'max-height': `${Math.min(416, above)}px` }
}

/**
 * A trigger that opens a list with a search box, for picking from more than fits a Menu. The caller filters,
 * so it can add items for what's typed, like creating something new. The list floats over the page, so a
 * scrolling sidebar doesn't clip it.
 */
export function SearchMenu(props: {
  items: (query: string) => SearchItem[]
  trigger: (open: () => boolean) => JSX.Element
  triggerClass: (open: boolean) => string
  placeholder: string
  title?: string
  /** Shown when nothing matches. */
  empty?: string
  width?: number
  onOpenChange?: (open: boolean) => void
}) {
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [active, setActive] = createSignal(0)
  const [place, setPlace] = createSignal<JSX.CSSProperties>({})
  const items = createMemo(() => (open() ? props.items(query().trim()) : []))
  const checkable = () => items().some((o) => o.selected)
  let trigger!: HTMLButtonElement
  let panel: HTMLDivElement | undefined
  const width = () => props.width ?? 288

  const show = () => {
    setPlace(floatBy(trigger, width()))
    setQuery('')
    setOpen(true)
    props.onOpenChange?.(true)
  }
  const close = (refocus = true) => {
    if (!open()) return
    setOpen(false)
    props.onOpenChange?.(false)
    if (refocus) trigger.focus()
  }
  const pick = (item: SearchItem | undefined) => {
    if (!item) return
    close()
    item.pick()
  }
  // Typing starts at the top match; otherwise it starts at the current one. The list growing or changing underneath
  // leaves it where it is.
  createEffect(on([open, query], () => setActive(query().trim() ? 0 : Math.max(0, items().findIndex((o) => o.selected)))))
  createEffect(on(items, (list) => active() >= list.length && setActive(Math.max(0, list.length - 1))))
  createEffect(on(active, (i) => document.getElementById(`${id}-${i}`)?.scrollIntoView({ block: 'nearest' })))

  createDismiss(open, () => [panel, trigger], () => close(false), { resize: true })
  onCleanup(() => open() && props.onOpenChange?.(false))

  const onKey = (e: KeyboardEvent) => {
    const n = items().length
    const keys: Record<string, () => void> = {
      ArrowDown: () => n && setActive((i) => (i + 1) % n),
      ArrowUp: () => n && setActive((i) => (i - 1 + n) % n),
      Enter: () => !e.isComposing && pick(items()[active()]),
      Escape: () => close(),
      Tab: () => close(),
    }
    const action = keys[e.key]
    if (!action) return
    if (e.key !== 'Tab') e.preventDefault()
    action()
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        title={props.title}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => (open() ? close() : show())}
        class={props.triggerClass(open())}
      >
        {props.trigger(open)}
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={panel}
            style={{ ...place(), width: `${width()}px` }}
            class="fixed z-40 flex animate-[pop-in_120ms_ease-out] flex-col rounded-xl border border-edge bg-bg pop shadow-(--shadow-pop)"
          >
            <input
              ref={(el) => queueMicrotask(() => el.focus())}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onKey}
              placeholder={props.placeholder}
              role="combobox"
              aria-expanded="true"
              aria-controls={id}
              aria-activedescendant={items().length ? `${id}-${active()}` : undefined}
              class="h-10 shrink-0 border-b border-line bg-transparent px-3.5 text-ui outline-none placeholder:text-fg-3 pointer-coarse:h-12 pointer-coarse:text-base"
            />
            <div id={id} role="listbox" class="min-h-0 overflow-y-auto p-1">
              <For each={items()} fallback={<p class="px-2.5 py-2 text-ui text-fg-3">{props.empty ?? 'No matches'}</p>}>
                {(o, i) => (
                  <div
                    id={`${id}-${i()}`}
                    role="option"
                    aria-selected={!!o.selected}
                    onPointerMove={() => setActive(i())}
                    // Keeps focus in the search box.
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => pick(o)}
                    class={`flex cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-2.5 pointer-coarse:py-2.5 ${o.indent ? 'pl-6' : 'pl-2.5'} ${
                      active() === i() ? 'bg-surface' : ''
                    }`}
                  >
                    <div class="min-w-0 flex-1">
                      <Show when={!o.render} fallback={o.render!()}>
                        <div class={`truncate text-ui ${o.tone === 'danger' ? 'text-danger' : o.indent ? 'text-fg-2' : 'text-fg'}`}>{o.label}</div>
                        <Show when={o.description}>
                          <div class={`mt-0.5 truncate leading-snug text-fg-3 ${o.mono ? 'font-mono text-meta text-left [direction:rtl]' : 'text-xs'}`}>
                            {o.mono ? ltr(o.description!) : o.description}
                          </div>
                        </Show>
                      </Show>
                    </div>
                    <Show when={o.hint}>
                      <span class="shrink-0 text-meta text-fg-3 tabular-nums">{o.hint}</span>
                    </Show>
                    {/* Only lists with something picked already need the column. */}
                    <Show when={checkable()}>
                      <Check class={`size-3.5 shrink-0 text-fg-2 ${o.selected ? '' : 'invisible'}`} />
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  )
}
