import { Show, onMount } from 'solid-js'
import { Trash2 } from '../icons'
import { Button } from './ui.tsx'

/*
 * Comments on something Claude wrote, kept to send together: the diff's lines (Review.tsx), and Claude's replies and
 * plans (replyComments.tsx). What's commented on is drawn as one shape behind the text, and the comment under it.
 */

// ── Marks drawn as one shape ──

export type Box = { l: number; r: number; t: number; b: number }

/**
 * Boxes as rounded shapes, the way an editor draws a selection: boxes on the same line that touch become one, a box that
 * overlaps one on the line straight above joins it, and each shape is traced around its outline with every corner rounded,
 * outward where it sticks out and inward where it steps in, as one SVG path.
 */
export function blobs(boxes: Box[], radius: number): string {
  boxes.sort((p, q) => p.t - q.t || p.l - q.l)
  const lines: Box[] = []
  for (const b of boxes) {
    const last = lines.at(-1)
    if (last && Math.abs(last.t - b.t) < 1 && b.l <= last.r + 1) last.r = Math.max(last.r, b.r)
    else lines.push({ ...b })
  }
  // A chain of boxes, one per line, each overlapping the one above; a box that would join two starts a chain of its own.
  const chains: Box[][] = []
  for (const b of lines) {
    const chain = chains.find((c) => {
      const above = c.at(-1)!
      return Math.abs(above.b - b.t) < 1 && b.l < above.r && b.r > above.l
    })
    if (chain) chain.push(b)
    else chains.push([b])
  }
  return chains
    .map((c) => {
      // Edges only a little apart on lines next to each other line up, as the wider: a step too short to round would wiggle.
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i + 1 < c.length; i++) {
          if (Math.abs(c[i].r - c[i + 1].r) < radius * 2) c[i].r = c[i + 1].r = Math.max(c[i].r, c[i + 1].r)
          if (Math.abs(c[i].l - c[i + 1].l) < radius * 2) c[i].l = c[i + 1].l = Math.min(c[i].l, c[i + 1].l)
        }
      }
      // Down the right side, then back up the left.
      const pts: [number, number][] = [[c[0].l, c[0].t]]
      c.forEach((b) => pts.push([b.r, b.t], [b.r, b.b]))
      for (let i = c.length - 1; i >= 0; i--) pts.push([c[i].l, c[i].b], [c[i].l, c[i].t])
      return roundedPath(outline(pts), radius)
    })
    .join(' ')
}

/** A polygon without repeated points or points in the middle of a straight edge. */
function outline(pts: [number, number][]): [number, number][] {
  const same = (p: [number, number], q: [number, number]) => Math.abs(p[0] - q[0]) < 0.5 && Math.abs(p[1] - q[1]) < 0.5
  let out = pts.filter((p, i) => !same(p, pts[(i + 1) % pts.length]))
  const straight = (p: [number, number], v: [number, number], q: [number, number]) =>
    (Math.abs(p[0] - v[0]) < 0.5 && Math.abs(v[0] - q[0]) < 0.5) || (Math.abs(p[1] - v[1]) < 0.5 && Math.abs(v[1] - q[1]) < 0.5)
  for (let changed = true; changed && out.length > 3; ) {
    changed = false
    out = out.filter((v, i) => {
      const keep = !straight(out[(i - 1 + out.length) % out.length], v, out[(i + 1) % out.length])
      if (!keep) changed = true
      return keep
    })
  }
  return out
}

/** A polygon traced with each corner rounded: cut back along both edges by up to `radius`, and joined by a curve through it. */
function roundedPath(pts: [number, number][], radius: number): string {
  const n = pts.length
  if (n < 3) return ''
  let d = ''
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n]
    const v = pts[i]
    const q = pts[(i + 1) % n]
    const d1 = Math.hypot(p[0] - v[0], p[1] - v[1])
    const d2 = Math.hypot(q[0] - v[0], q[1] - v[1])
    const r = Math.min(radius, d1 / 2, d2 / 2)
    const a = [v[0] + ((p[0] - v[0]) / d1) * r, v[1] + ((p[1] - v[1]) / d1) * r]
    const b = [v[0] + ((q[0] - v[0]) / d2) * r, v[1] + ((q[1] - v[1]) / d2) * r]
    d += `${i ? 'L' : 'M'}${a[0].toFixed(1)},${a[1].toFixed(1)}Q${v[0].toFixed(1)},${v[1].toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)}`
  }
  return d + 'Z'
}

// ── The boxes ──

const boxClass = 'my-1.5 rounded-lg border px-3 py-2 font-sans text-ui'

/** A comment being written: added to the others, or with `onAsk`, asked now. */
export function DraftBox(props: {
  text: string
  editing: boolean
  placeholder: string
  onText: (t: string) => void
  onComment: () => void
  /** Given, it can be asked as a question now instead; Claude's answer shows where it was asked. */
  onAsk?: () => void
  canAsk?: boolean
  onCancel: () => void
  /** Kept with the others until when, for the add button's title. */
  sentWith?: string
  class?: string
}) {
  let el!: HTMLTextAreaElement
  onMount(() => {
    el.focus({ preventScroll: true })
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
  return (
    <div class={`${boxClass} border-accent/40 bg-bg ${props.class ?? ''}`}>
      <textarea
        ref={el}
        value={props.text}
        onInput={(e) => props.onText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) props.onComment()
          if (e.key === 'Escape') props.onCancel()
        }}
        placeholder={props.placeholder}
        // Grows with what's typed, as the composer does.
        class="block max-h-[12lh] min-h-[3lh] w-full resize-none bg-transparent text-ui outline-none [field-sizing:content] placeholder:text-fg-3"
      />
      <div class="mt-1 flex flex-wrap items-center gap-2">
        <Button primary onClick={props.onComment} class="h-7 text-xs" title={`Kept with your other comments, to send together ${props.sentWith ?? 'for Claude to act on'}`}>
          {props.editing ? 'Save' : 'Add comment'}
        </Button>
        <Show when={!props.editing && props.onAsk}>
          <Button onClick={props.onAsk} disabled={!props.canAsk} class="flex h-7 items-center gap-1 text-xs" title="Sent now; Claude's answer shows here">
            Ask Claude
          </Button>
        </Show>
        <Button onClick={props.onCancel} class="h-7 text-xs">
          Cancel
        </Button>
        <span class="text-xs text-fg-3">⌘/Ctrl+Enter to add</span>
      </div>
    </div>
  )
}

/** A comment kept to send. `label` says what it's on, if that isn't plain from where it is. */
export function CommentBox(props: { label?: string; text: string; onEdit?: () => void; onRemove: () => void; class?: string }) {
  return (
    <div class={`${boxClass} group/c border-line bg-surface ${props.class ?? ''}`}>
      <div class="mb-0.5 flex items-center gap-2 text-xs text-fg-3">
        <span class="min-w-0 truncate">{props.label ?? 'Your comment'}</span>
        <div class="flex-1" />
        <Show when={props.onEdit}>
          <button onClick={props.onEdit} class="opacity-0 group-hover/c:opacity-100 hover:text-fg-2 pointer-coarse:opacity-100">
            Edit
          </button>
        </Show>
        <button onClick={props.onRemove} title="Delete" class="opacity-0 group-hover/c:opacity-100 hover:text-danger pointer-coarse:opacity-100">
          <Trash2 class="size-3" />
        </button>
      </div>
      <p class="whitespace-pre-wrap text-fg">{props.text}</p>
    </div>
  )
}
