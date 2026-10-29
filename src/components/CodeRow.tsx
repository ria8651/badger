import { For, Show, splitProps, type JSX } from 'solid-js'
import { SIGN } from '../diffRows.ts'

const TINT = { add: 'bg-ok/10', del: 'bg-danger/10', ctx: '' } as const
const SIGN_TONE = { add: 'text-ok', del: 'text-danger', ctx: 'text-fg-3' } as const

/**
 * A line of code with its numbers down the left: a hunk's, before and after, with its + or −; or a whole file's, its one
 * number, tinted where it's changed. `gutter` goes on the numbers, e.g. what picking a line by them does. The code
 * itself is the children, since how it wraps and what's drawn on it is the caller's.
 */
export function CodeRow(
  props: JSX.HTMLAttributes<HTMLDivElement> & {
    kind?: 'add' | 'del' | 'ctx'
    numbers: (number | undefined)[]
    /** The diff's +, − or space after the numbers. */
    sign?: boolean
    /** Gone to just now, so the eye finds it. */
    lit?: boolean
    gutter?: JSX.HTMLAttributes<HTMLSpanElement>
    children: JSX.Element
  },
) {
  const [local, rest] = splitProps(props, ['kind', 'numbers', 'sign', 'lit', 'gutter', 'children', 'class'])
  return (
    <div {...rest} class={`group relative flex transition-colors ${local.lit ? 'bg-accent/20' : TINT[local.kind ?? 'ctx']} ${local.class ?? ''}`}>
      <span {...local.gutter} class={`flex shrink-0 select-none ${local.gutter?.class ?? ''}`}>
        <For each={local.numbers}>{(n) => <span class="w-10 pr-1.5 text-right text-fg-3/70 tabular-nums">{n ?? ''}</span>}</For>
      </span>
      <Show when={local.sign}>
        <span class={`w-4 shrink-0 select-none text-center ${SIGN_TONE[local.kind ?? 'ctx']}`}>{SIGN[local.kind ?? 'ctx']}</span>
      </Show>
      {local.children}
    </div>
  )
}
