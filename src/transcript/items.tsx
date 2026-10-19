import { For, Show, createSignal, onCleanup, type JSX } from 'solid-js'
import { BookOpen, ChevronRight, CircleAlert, Columns3, FileText, KeyRound, Scissors, Webhook } from '../icons'
import type { CardContext } from '../../shared/cardContext.ts'
import type { Move } from '../../shared/forkNote.ts'
import type { CardStatus } from '../../shared/protocol.ts'
import { basename } from '../folders.ts'
import type { ShownImage } from '../images.ts'
import { Link } from '../router.tsx'
import { STATUS_LABELS } from '../stores/cards.ts'
import { Attachments, type ContextChip } from '../components/Attachments.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { Disclosure, splitSkill } from '../components/ToolCard.tsx'
import { LiveDot, compact, plural } from '../components/ui.tsx'
import { duration, type Chip, type Item } from './model.ts'

/* The pieces a transcript is drawn from, other than tool calls and subagents. */

/** Compacting now: how much is going in, and for how long so far. Claude Code says nothing in between. */
export function CompactingLine(props: { since: number; tokens?: number }) {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  return (
    <div class="my-8 flex items-center gap-3 text-xs text-fg-3">
      <div class="h-px flex-1 bg-line" />
      <span class="flex items-center gap-2 tabular-nums">
        <LiveDot />
        Compacting{props.tokens ? ` ${compact(props.tokens)} tokens` : ''} · {duration(Math.max(0, Math.round((now() - props.since) / 1000)))}
      </span>
      <div class="h-px flex-1 bg-line" />
    </div>
  )
}

/**
 * Where the conversation was compacted: how and how much, opening to the
 * summary Claude carries on from in place of everything above.
 */
export function CompactDivider(props: { item: Extract<Item, { kind: 'compact' }>; summary?: string }) {
  const [open, setOpen] = createSignal(false)
  const label = () => {
    const how = props.item.trigger === 'manual' ? 'Compacted with /compact' : props.item.trigger === 'auto' ? 'Compacted automatically' : 'Compacted'
    const size = props.item.preTokens ? `${compact(props.item.preTokens)}${props.item.postTokens ? ` → ${compact(props.item.postTokens)}` : ''} tokens` : ''
    return [how, size, props.item.seconds ? duration(props.item.seconds) : ''].filter(Boolean).join(' · ')
  }
  return (
    <div class="my-8">
      <button
        type="button"
        disabled={!props.summary}
        onClick={() => setOpen(!open())}
        class="flex w-full items-center gap-3 text-xs text-fg-3 enabled:hover:text-fg-2"
      >
        <div class="h-px flex-1 bg-line" />
        <span class="flex items-center gap-1 tabular-nums">
          {label()}
          <Show when={props.summary}>
            <ChevronRight class={`size-3.5 transition-transform ${open() ? 'rotate-90' : ''}`} />
          </Show>
        </span>
        <div class="h-px flex-1 bg-line" />
      </button>
      <Show when={open() && props.summary}>
        {(summary) => (
          <div class="mt-3 max-h-[32rem] overflow-auto rounded-lg border border-edge px-4 py-3 text-[13px] text-fg-2">
            <p class="mb-2 text-xs text-fg-3">What Claude carries on from, in place of the conversation above:</p>
            <Markdown text={summary()} />
          </div>
        )}
      </Show>
    </div>
  )
}

/** Something Claude Code did to the conversation: a quiet line where it happened, opening to its details if it has any. */
export function Notice(props: { icon: typeof Scissors; text: string; danger?: boolean; action?: { label: string; run: () => void }; children?: JSX.Element }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="my-3 text-xs">
      <div class={`flex items-center gap-1.5 ${props.danger ? 'text-danger' : 'text-fg-3'}`}>
        <props.icon class="size-3.5 shrink-0" />
        <Show when={props.children} fallback={<span>{props.text}</span>}>
          <button type="button" class="flex min-w-0 items-center gap-1 text-left hover:text-fg-2" onClick={() => setOpen(!open())}>
            {props.text}
            <ChevronRight class={`size-3.5 shrink-0 transition-transform ${open() ? 'rotate-90' : ''}`} />
          </button>
        </Show>
        <Show when={props.action}>
          {(action) => (
            <>
              <span>·</span>
              <button type="button" onClick={() => action().run()} class="-mx-1 shrink-0 rounded px-1 py-0.5 text-fg-2 transition-colors hover:bg-surface hover:text-fg">
                {action().label}
              </button>
            </>
          )}
        </Show>
      </div>
      <Show when={open()}>
        <div class="mt-2 pl-5">{props.children}</div>
      </Show>
    </div>
  )
}

/** An error in place of Claude's reply, said once, with the fix where Badger can do it. */
export function ApiError(props: { item: Extract<Item, { kind: 'api_error' }>; onLogin?: () => void }) {
  const login = () => props.item.error === 'authentication_failed'
  return (
    <div class="my-4 flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-[13px]">
      {login() ? <KeyRound class="mt-0.5 size-4 shrink-0 text-danger" /> : <CircleAlert class="mt-0.5 size-4 shrink-0 text-danger" />}
      <div class="min-w-0 flex-1">
        <div class="text-fg">{login() ? 'Claude Code’s login has expired' : props.item.text || 'Claude Code couldn’t reach Claude'}</div>
        <Show when={login()}>
          <div class="text-xs text-fg-3">Log in again, then send your message again.</div>
        </Show>
      </div>
      <Show when={login() && props.onLogin}>
        <button
          type="button"
          onClick={() => props.onLogin!()}
          class="shrink-0 rounded-md border border-edge px-2.5 py-1 text-xs text-fg-2 transition-colors hover:bg-surface hover:text-fg"
        >
          Log in in a terminal
        </button>
      </Show>
    </div>
  )
}

/** A prompt's context as a chip. */
export function contextChip(chip: Chip): ContextChip {
  switch (chip.type) {
    case 'skill': {
      const { dir, body } = splitSkill(chip.text)
      return {
        icon: BookOpen,
        label: `${dir ? basename(dir) : 'Skill'} skill`,
        meta: `${compact(body.length)} chars`,
        body: () => (
          <>
            <Show when={dir}>
              <div class="mb-1.5 font-mono text-xs text-fg-3">{dir}</div>
            </Show>
            <Markdown text={body} />
          </>
        ),
      }
    }
    case 'instructions': {
      const names = [...new Set(chip.files.map((f) => (f.type === 'AutoMem' ? 'memory' : basename(f.path))))]
      return {
        icon: FileText,
        label: names.join(', '),
        meta: chip.files.length > 1 ? plural(chip.files.length, 'file') : undefined,
        body: () => (
          <For each={chip.files}>
            {(f) => (
              <div class="mb-3 last:mb-0">
                <div class="mb-1 font-mono text-xs text-fg-3">{f.path}</div>
                <Markdown text={f.content} />
              </div>
            )}
          </For>
        ),
      }
    }
    case 'hook':
      return { icon: Webhook, label: `${chip.hook ?? 'A'} hook`, body: () => <p class="whitespace-pre-wrap">{chip.text}</p> }
    case 'hook_error':
      return {
        icon: CircleAlert,
        label: `${chip.hook ?? 'A'} hook failed`,
        danger: true,
        body: () => (
          <p class="whitespace-pre-wrap">
            {chip.command ? <span class="font-mono text-xs">{chip.command}</span> : 'It'} failed
            {chip.error && chip.error !== 'No stderr output' ? `: ${chip.error}` : ''}. Claude carried on.
          </p>
        ),
      }
  }
}

export function WorkingLine(props: { detail?: string }) {
  return (
    <div class="mt-4 flex h-6 items-center gap-2 text-[13px] text-fg-3">
      <LiveDot /> Working
      <Show when={props.detail}>
        <span class="min-w-0 truncate font-mono text-xs">{props.detail}</span>
      </Show>
    </div>
  )
}

const badge = 'inline-flex max-w-[80%] items-center gap-2 rounded-full border border-line px-3 py-1 text-[13px]'

/** A card as a pill linking to it. */
export function CardBadge(props: { card: { id: number; title: string; status: CardStatus } }) {
  return (
    <Link to={{ kind: 'card', id: props.card.id }} class={`${badge} text-fg-2 transition-colors hover:bg-surface hover:text-fg`}>
      <Columns3 class="size-3.5 shrink-0 text-fg-3" />
      <span class="min-w-0 truncate">
        <span class="text-fg-3">#{props.card.id}</span>{' '}
        {props.card.title}
      </span>
      <span class="shrink-0 text-xs text-fg-3">{STATUS_LABELS[props.card.status]}</span>
    </Link>
  )
}

/** Card context with no prompt to attach to, as a badge under the user's message linking to the card. */
export function CardContextBadge(props: { context: CardContext }) {
  return (
    <div class="-mt-2 mb-4 -ml-3 flex justify-start">
      <Show when={props.context.card} fallback={<span class={`${badge} text-fg-3`}><Columns3 class="size-3.5" />No longer on a card</span>}>
        {(card) => <CardBadge card={card()} />}
      </Show>
    </div>
  )
}

/**
 * A user's message; long ones (big pastes) are clamped with a fade until expanded. Left-aligned, hanging
 * its padding into the margin so the text lines up with Claude's. Children go beside it, e.g. a queued one's buttons.
 */
export function UserMessage(props: {
  text: string
  pastes?: string[]
  images?: ShownImage[]
  card?: CardContext
  /** Where a fork moved to, as Claude was told with this message. */
  move?: Move
  /** Other context Claude was given with it. */
  context?: ContextChip[]
  /** Replaces the spacing it has in the transcript. */
  class?: string
  /** How tall it gets before it's clamped. */
  maxHeight?: string
  children?: JSX.Element
}) {
  const [overflows, setOverflows] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const clamped = () => overflows() && !expanded()
  return (
    <div class={`flex items-center justify-start gap-1 ${props.class ?? 'mt-8 mb-4 first:mt-0'}`}>
      <div class="-ml-4 max-w-[80%] min-w-0 bg-surface rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed">
        <Show when={props.pastes?.length || props.images?.length || props.card || props.move || props.context?.length}>
          <Attachments
            pastes={props.pastes ?? []}
            images={props.images ?? []}
            card={props.card}
            move={props.move}
            context={props.context}
            class={props.text ? 'mb-2' : ''}
          />
        </Show>
        <Show when={props.text}>
          <div
            ref={(el) => {
              // Re-measured on resize: width changes rewrap the text, and hidden chats measure as 0.
              const observer = new ResizeObserver(() => !expanded() && setOverflows(el.scrollHeight > el.clientHeight))
              observer.observe(el)
              onCleanup(() => observer.disconnect())
            }}
            class="overflow-hidden whitespace-pre-wrap"
            style={{
              'max-height': expanded() ? undefined : (props.maxHeight ?? '18rem'),
              'mask-image': clamped() ? 'linear-gradient(to bottom, black 70%, transparent)' : undefined,
            }}
          >
            {props.text}
          </div>
          <Show when={overflows()}>
            <button class="mt-1 text-xs text-fg-3 hover:text-fg-2" onClick={() => setExpanded(!expanded())}>
              {expanded() ? 'Show less' : 'Show more'}
            </button>
          </Show>
        </Show>
      </div>
      {props.children}
    </div>
  )
}

export function Thinking(props: { text: string; live?: boolean }) {
  return (
    <Disclosure label={props.live ? 'Thinking' : 'Thought'} trailing={props.live && <LiveDot />} live={props.live}>
      <div class="text-[13px] leading-relaxed whitespace-pre-wrap text-fg-2">{props.text}</div>
    </Disclosure>
  )
}

/** Ticks once a minute for every <Idle> on the page. */
const [now, setNow] = createSignal(Date.now())
setInterval(() => setNow(Date.now()), 60_000)

/** How long the chat sat idle after a turn: until the next prompt, or until now. */
export function Idle(props: { from: number; until?: number }) {
  const label = () => {
    const minutes = Math.floor(((props.until ?? now()) - props.from) / 60_000)
    if (minutes < 1) return props.until ? '' : ' · just now'
    if (minutes < 60) return ` · ${minutes}m idle`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return ` · ${hours}h idle`
    return ` · ${Math.floor(hours / 24)}d idle`
  }
  return <span title={new Date(props.from).toLocaleString()}>{label()}</span>
}

