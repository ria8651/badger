import { For, Show, createEffect, createMemo, createSignal, on, onMount, untrack, type JSX } from 'solid-js'
import { Check, ChevronDown, ChevronRight, MessageSquarePlus, RotateCw, Sparkles, Trash2, X } from '../icons'
import type { ReviewDiff, ReviewFile } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { ago, plural } from '../format.ts'
import type { Index } from '../transcript/model.ts'
import { resultText } from './ToolCard.tsx'
import { Button, DiffCount, GhostButton, Select, inputClass, type Option } from './ui.tsx'

/*
 * SPIKE: a review module. The changes in a chat's checkout, file by file, to read,
 * tick off and comment on line by line; the comments go back to the chat as one
 * message. Claude's own review (review_changes) shows inline beside yours, and
 * "since you sent" shows only what changed after your last round of comments.
 * Everything kept is in localStorage, per chat.
 */

// ── What's kept, per chat ──

export interface ReviewComment {
  id: string
  path: string
  /** Rows by anchor (n<line> on the new side, o<line> for a removed line); from = to for one line. */
  from: string
  to: string
  /** e.g. "line 12" or "lines 12–18", for the message. */
  where: string
  /** The rows it's on, as the diff showed them, so the message quotes what was seen. */
  code: string
  text: string
  /** Taken from Claude's review, by its severity. */
  claude?: string
}

interface Saved {
  comments: ReviewComment[]
  /** A note on the whole thing, sent with the comments. */
  general: string
  /** The blob each file was at when ticked as viewed; a later change unticks it. */
  viewed: Record<string, string>
  /** The working tree when comments were last sent, to see what changed after. */
  sent?: { snapshot: string; at: number; count: number }
  /** Claude's findings put aside, by key. */
  dismissed: string[]
}

const EMPTY: Saved = { comments: [], general: '', viewed: {}, dismissed: [] }
const stores = new Map<string, ReturnType<typeof createSignal<Saved>>>()
const storeKey = (session: string) => `badger.review.${session}`

function store(session: string) {
  let s = stores.get(session)
  if (!s) {
    let initial = EMPTY
    try {
      initial = { ...EMPTY, ...JSON.parse(localStorage.getItem(storeKey(session)) ?? '{}') }
    } catch {}
    s = createSignal<Saved>(initial)
    stores.set(session, s)
  }
  return s
}

function useReview(session: string) {
  const [saved, setSaved] = store(session)
  const update = (f: (s: Saved) => Saved) => {
    const next = setSaved(f)
    localStorage.setItem(storeKey(session), JSON.stringify(next))
  }
  return { saved, update }
}

/** Comments waiting to be sent, for the tab. */
export const reviewDrafts = (session: string) => {
  const s = store(session)[0]()
  return s.comments.length + (s.general.trim() ? 1 : 0)
}

// ── The diff, as rows ──

type Line = { kind: 'ctx' | 'add' | 'del'; old?: number; new?: number; text: string; /** The part that changed, against its pair. */ mark?: [number, number] }
type Row = { kind: 'hunk'; text: string } | Line

const anchorOf = (r: Line) => (r.kind === 'del' ? `o${r.old}` : `n${r.new}`)
const SIGN = { ctx: ' ', add: '+', del: '-' } as const

function rowsOf(patch: string): Row[] {
  const rows: Row[] = []
  let o = 0
  let n = 0
  for (const l of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l)
    if (h) {
      o = Number(h[1])
      n = Number(h[2])
      rows.push({ kind: 'hunk', text: h[3] })
    } else if (l.startsWith('+')) rows.push({ kind: 'add', new: n++, text: l.slice(1) })
    else if (l.startsWith('-')) rows.push({ kind: 'del', old: o++, text: l.slice(1) })
    else if (l.startsWith(' ')) rows.push({ kind: 'ctx', old: o++, new: n++, text: l.slice(1) })
  }
  markPairs(rows)
  return rows
}

/** A run of removed lines then as many added: each pair's changed middle, when it's a small edit rather than a new line. */
function markPairs(rows: Row[]) {
  for (let i = 0; i < rows.length; ) {
    let d = i
    while (d < rows.length && rows[d].kind === 'del') d++
    let a = d
    while (a < rows.length && rows[a].kind === 'add') a++
    const dels = d - i
    if (dels && a - d === dels) {
      for (let k = 0; k < dels; k++) {
        const x = rows[i + k] as Line
        const y = rows[d + k] as Line
        let p = 0
        while (p < x.text.length && p < y.text.length && x.text[p] === y.text[p]) p++
        let s = 0
        while (s < x.text.length - p && s < y.text.length - p && x.text[x.text.length - 1 - s] === y.text[y.text.length - 1 - s]) s++
        const same = p + s
        if (same && same > Math.max(x.text.length, y.text.length) * 0.3) {
          x.mark = [p, x.text.length - s]
          y.mark = [p, y.text.length - s]
        }
      }
    }
    i = Math.max(a, i + 1)
  }
}

// ── Claude's review ──

export interface Finding {
  key: string
  file: string
  line?: number
  severity?: string
  note: string
}

/**
 * What the chat's latest review_changes call found, from the ```findings block the reviewer is
 * asked to end with. Tools are named mcp__<server>__review_changes, so only the end is matched.
 */
export function latestFindings(index: Index): { id: string; findings: Finding[] } | undefined {
  const ids = [...index.uses].filter(([id, u]) => u.name.endsWith('__review_changes') && !index.parents.get(id) && index.results.has(id)).map(([id]) => id)
  const id = ids.at(-1)
  if (!id) return
  const text = resultText(index.results.get(id)!.content)
  const block = /```findings\s*\n([\s\S]*?)```/.exec(text)
  if (!block) return { id, findings: [] }
  try {
    const list = JSON.parse(block[1]) as { file?: string; line?: number; severity?: string; note?: string }[]
    return {
      id,
      findings: list
        .filter((f) => f.file && f.note)
        .map((f, i) => ({ key: `${id}:${i}`, file: f.file!.replace(/^\.?\//, ''), line: Number(f.line) || undefined, severity: f.severity, note: f.note! })),
    }
  } catch {
    return { id, findings: [] }
  }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The calls in which Claude edited each file, by path in the checkout. */
function claudeEdits(index: Index, root?: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!root) return out
  for (const [id, u] of index.uses) {
    if (!EDIT_TOOLS.has(u.name)) continue
    const file = String(u.input.file_path ?? u.input.notebook_path ?? '')
    if (!file.startsWith(root + '/')) continue
    const rel = file.slice(root.length + 1)
    out.set(rel, [...(out.get(rel) ?? []), id])
  }
  return out
}

// ── The message ──

function message(comments: ReviewComment[], general: string, scope: string): string {
  const byFile = new Map<string, ReviewComment[]>()
  for (const c of comments) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c])
  const parts = [`I reviewed the changes (${scope}) and left ${plural(comments.length, 'comment')}. Work through them, and say if you disagree with any.`]
  if (general.trim()) parts.push(general.trim())
  for (const [path, list] of byFile) {
    parts.push(`### ${path}`)
    for (const c of list) parts.push([`${c.where}${c.claude ? ' (the reviewer’s, and I agree)' : ''}:`, c.code && `\`\`\`diff\n${c.code}\n\`\`\``, c.text.trim()].filter(Boolean).join('\n'))
  }
  return parts.join('\n\n')
}

// ── The pane ──

/** Where a new comment is going: rows from..to of one file, by index into its rows. */
interface Draft {
  path: string
  from: number
  to: number
  /** Editing this comment, rather than adding one. */
  id?: string
}

export function ReviewPane(props: {
  sessionId: string
  /** The chat's folder: where git runs. */
  cwd?: string
  /** The checkout's root, to find which files Claude edited. */
  root?: string
  machine: string
  index: () => Index
  /** Read again when a turn ends, since that's when files change. */
  running: boolean
  /** Sends a message to the chat; absent when it can't take one. */
  onSend?: (text: string) => void
  onJump: (toolUseId: string) => void
  onReady: (focus: () => void) => void
}) {
  const { saved, update } = useReview(untrack(() => props.sessionId))
  const [scope, setScope] = createSignal('base')
  const [context, setContext] = createSignal(3)
  const [diff, setDiff] = createSignal<ReviewDiff>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  /** Files opened or folded by hand, overriding viewed/generated. */
  const [open, setOpen] = createSignal<Record<string, boolean>>({})
  const [draft, setDraft] = createSignal<Draft>()
  const [draftText, setDraftText] = createSignal('')
  const [filesShown, setFilesShown] = createSignal(false)

  let seq = 0
  const load = async () => {
    const dir = props.cwd
    if (!dir) return
    const mine = ++seq
    setLoading(true)
    try {
      const next = await api.review(dir, scope(), context(), props.machine)
      if (mine !== seq) return
      setDiff(next)
      setError(undefined)
    } catch (e) {
      if (mine === seq) setError((e as Error).message)
    } finally {
      if (mine === seq) setLoading(false)
    }
  }
  createEffect(on([() => props.cwd, scope, context], () => void load()))
  createEffect(on(() => props.running, (r) => !r && void load(), { defer: true }))

  const files = () => diff()?.files ?? []
  const edits = createMemo(() => claudeEdits(props.index(), props.root))
  const claude = createMemo(() => latestFindings(props.index()))
  const findings = () => (claude()?.findings ?? []).filter((f) => !saved().dismissed.includes(f.key))
  const isViewed = (f: ReviewFile) => saved().viewed[f.path] === (f.blob ?? 'deleted')
  const isOpen = (f: ReviewFile) => open()[f.path] ?? !(isViewed(f) || f.generated)
  const viewedCount = () => files().filter(isViewed).length

  const setViewed = (f: ReviewFile, on: boolean) => {
    update((s) => {
      const viewed = { ...s.viewed }
      if (on) viewed[f.path] = f.blob ?? 'deleted'
      else delete viewed[f.path]
      return { ...s, viewed }
    })
    setOpen((o) => ({ ...o, [f.path]: !on }))
  }

  const scopeOptions = (): Option<string>[] => {
    const d = diff()
    const s = saved().sent
    const opts: Option<string>[] = [
      d?.base
        ? { value: 'base', label: `Not on ${d.base} yet`, description: `${plural(d.commits.length, 'commit')} and anything uncommitted.` }
        : { value: 'base', label: 'All changes', description: 'No base to compare with, so what’s uncommitted.' },
      { value: 'uncommitted', label: 'Uncommitted', description: 'Against the last commit.' },
    ]
    if (s) opts.push({ value: `since:${s.snapshot}`, label: 'Since you sent comments', description: `What changed after your ${plural(s.count, 'comment')}, ${ago(s.at)}.` })
    for (const c of d?.commits ?? []) opts.push({ value: `commit:${c.sha}`, label: `${c.sha.slice(0, 7)} ${c.subject}`, description: `${c.author}, ${ago(c.date)}` })
    if (scope().startsWith('commit:') && !opts.some((o) => o.value === scope())) opts.push({ value: scope(), label: scope().slice(7, 14) })
    return opts
  }
  const scopeLabel = () => scopeOptions().find((o) => o.value === scope())?.label ?? scope()

  // ── Comments ──

  let fileEls = new Map<string, HTMLElement>()
  const jumpTo = (path: string) => {
    setOpen((o) => ({ ...o, [path]: true }))
    setFilesShown(false)
    requestAnimationFrame(() => fileEls.get(path)?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }

  const startDraft = (path: string, at: number, extend: boolean, text = '') => {
    const d = draft()
    if (extend && d && d.path === path && !d.id) {
      setDraft({ path, from: Math.min(d.from, at), to: Math.max(d.to, at) })
      return
    }
    setDraft({ path, from: at, to: at })
    setDraftText(text)
  }
  const saveDraft = (rows: Row[]) => {
    const d = draft()
    const text = draftText().trim()
    if (!d) return
    if (!text) return setDraft(undefined)
    const span = rows.slice(d.from, d.to + 1).filter((r): r is Line => r.kind !== 'hunk')
    if (!span.length) return setDraft(undefined)
    const first = span[0]
    const last = span[span.length - 1]
    const num = (r: Line) => r.new ?? r.old
    const where = span.length === 1 ? `Line ${num(first)}${first.kind === 'del' ? ' (removed)' : ''}` : `Lines ${num(first)}–${num(last)}`
    const comment: ReviewComment = {
      id: d.id ?? crypto.randomUUID(),
      path: d.path,
      from: anchorOf(first),
      to: anchorOf(last),
      where,
      code: span.map((r) => SIGN[r.kind] + r.text).join('\n'),
      text,
    }
    update((s) => ({ ...s, comments: d.id ? s.comments.map((c) => (c.id === d.id ? { ...c, text } : c)) : [...s.comments, comment] }))
    setDraft(undefined)
    setDraftText('')
  }
  const removeComment = (id: string) => update((s) => ({ ...s, comments: s.comments.filter((c) => c.id !== id) }))

  const adopt = (f: Finding, rows: Row[]) => {
    const at = rows.findIndex((r) => r.kind !== 'hunk' && r.new === f.line)
    const row = at < 0 ? undefined : (rows[at] as Line)
    // Not on a line shown: a comment on the whole file.
    const comment: ReviewComment = row
      ? { id: crypto.randomUUID(), path: f.file, from: anchorOf(row), to: anchorOf(row), where: `Line ${row.new}`, code: SIGN[row.kind] + row.text, text: f.note }
      : { id: crypto.randomUUID(), path: f.file, from: '', to: '', where: f.line ? `Around line ${f.line}` : 'The file', code: '', text: f.note }
    update((s) => ({ ...s, comments: [...s.comments, { ...comment, claude: f.severity ?? 'note' }] }))
    dismiss(f)
  }
  const dismiss = (f: Finding) => update((s) => ({ ...s, dismissed: [...s.dismissed, f.key] }))

  const send = () => {
    const s = saved()
    const d = diff()
    if (!props.onSend || (!s.comments.length && !s.general.trim())) return
    props.onSend(message(s.comments, s.general, scopeLabel().toLowerCase()))
    update((x) => ({ ...x, comments: [], general: '', sent: d ? { snapshot: d.snapshot, at: Date.now(), count: s.comments.length } : x.sent }))
  }
  const askClaude = () => props.onSend?.('Have the changes here reviewed.')

  const commentsIn = (path: string) => saved().comments.filter((c) => c.path === path)
  const findingsIn = (path: string) => findings().filter((f) => f.file === path)

  let scroller!: HTMLDivElement
  onMount(() => props.onReady(() => scroller.focus({ preventScroll: true })))

  return (
    <div class="@container flex size-full flex-col text-ui">
      {/* Toolbar */}
      <div class="relative z-20 flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-3 py-1.5">
        <Select value={scope()} options={scopeOptions()} onChange={setScope} title="What to review" placement="bottom" />
        <Select
          value={String(context())}
          options={[
            { value: '3', label: '3 lines around' },
            { value: '25', label: '25 lines around' },
            { value: '100000', label: 'Whole files' },
          ]}
          onChange={(v) => setContext(Number(v))}
          title="How much of each file to show"
          placement="bottom"
        />
        <div class="flex-1" />
        <Show when={files().length}>
          <span class="text-xs text-fg-3 tabular-nums">
            {viewedCount()}/{files().length} viewed
          </span>
        </Show>
        <GhostButton title="Read again" onClick={() => void load()}>
          <RotateCw class={`size-3.5 ${loading() ? 'animate-spin' : ''}`} />
        </GhostButton>
      </div>

      <div class="flex min-h-0 flex-1">
        {/* Files, beside the diffs when there's room. */}
        <nav class="hidden w-56 shrink-0 overflow-y-auto border-r border-line py-1 @3xl:block">
          <FileList files={files()} viewed={isViewed} comments={(p) => commentsIn(p).length} findings={(p) => findingsIn(p).length} onPick={jumpTo} />
        </nav>

        <div ref={scroller} tabIndex={-1} class="min-w-0 flex-1 overflow-y-auto outline-none">
          <Show when={error()}>
            <p class="m-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error()}</p>
          </Show>
          <Show when={diff()} fallback={<p class="p-4 text-xs text-fg-3">{loading() ? 'Reading the changes…' : ''}</p>}>
            {(d) => (
              <>
                <Summary diff={d()} files={files()} claude={claude()} findings={findings().length} onAsk={props.onSend && askClaude} />
                {/* Files, above the diffs when there isn't room beside them. */}
                <Show when={files().length > 1}>
                  <div class="border-b border-line @3xl:hidden">
                    <button onClick={() => setFilesShown(!filesShown())} class="flex w-full items-center gap-1 px-3 py-1.5 text-xs text-fg-3 hover:text-fg-2">
                      {filesShown() ? <ChevronDown class="size-3" /> : <ChevronRight class="size-3" />}
                      {plural(files().length, 'file')}
                    </button>
                    <Show when={filesShown()}>
                      <div class="pb-1">
                        <FileList files={files()} viewed={isViewed} comments={(p) => commentsIn(p).length} findings={(p) => findingsIn(p).length} onPick={jumpTo} />
                      </div>
                    </Show>
                  </div>
                </Show>
                <Show when={!files().length && !loading()}>
                  <p class="p-6 text-center text-xs text-fg-3">Nothing changed{scope().startsWith('since:') ? ' since you sent your comments' : ''}.</p>
                </Show>
                <For each={files()}>
                  {(f) => {
                    const rows = createMemo(() => rowsOf(f.patch))
                    return (
                      <FileDiff
                        ref={(el) => fileEls.set(f.path, el)}
                        file={f}
                        rows={rows()}
                        open={isOpen(f)}
                        viewed={isViewed(f)}
                        edits={edits().get(f.path) ?? []}
                        comments={commentsIn(f.path)}
                        findings={findingsIn(f.path)}
                        draft={draft()?.path === f.path ? draft() : undefined}
                        draftText={draftText()}
                        onToggle={() => setOpen((o) => ({ ...o, [f.path]: !isOpen(f) }))}
                        onViewed={(on) => setViewed(f, on)}
                        onJump={props.onJump}
                        onComment={(at, extend) => startDraft(f.path, at, extend)}
                        onDraftText={setDraftText}
                        onSave={() => saveDraft(rows())}
                        onCancel={() => setDraft(undefined)}
                        onEdit={(c) => {
                          const from = rows().findIndex((r) => r.kind !== 'hunk' && anchorOf(r) === c.from)
                          const to = rows().findIndex((r) => r.kind !== 'hunk' && anchorOf(r) === c.to)
                          setDraft({ path: f.path, from: Math.max(from, 0), to: Math.max(to, 0), id: c.id })
                          setDraftText(c.text)
                        }}
                        onRemove={removeComment}
                        onAdopt={(x) => adopt(x, rows())}
                        onDismiss={dismiss}
                      />
                    )
                  }}
                </For>
              </>
            )}
          </Show>
        </div>
      </div>

      {/* What goes back to the chat */}
      <div class="shrink-0 space-y-2 border-t border-line px-3 py-2.5">
        <textarea
          value={saved().general}
          onInput={(e) => {
            const general = e.currentTarget.value
            update((s) => ({ ...s, general }))
          }}
          rows={saved().general ? 3 : 1}
          placeholder="Overall comment (optional)"
          class={`${inputClass} h-auto resize-none py-1.5`}
        />
        <div class="flex flex-wrap items-center gap-2">
          <Button primary disabled={!props.onSend || (!saved().comments.length && !saved().general.trim())} onClick={send}>
            {saved().comments.length ? `Send ${plural(saved().comments.length, 'comment')}` : 'Send to Claude'}
          </Button>
          <span class="text-xs text-fg-3">
            <Show when={saved().sent} fallback="Click a line’s + to comment; shift-click another to cover the lines between.">
              {(s) => `Last sent ${ago(s().at)}. “Since you sent comments” shows what changed after.`}
            </Show>
          </span>
        </div>
      </div>
    </div>
  )
}

function Summary(props: { diff: ReviewDiff; files: ReviewFile[]; claude?: { id: string; findings: Finding[] }; findings: number; onAsk?: () => void }) {
  const added = () => props.files.reduce((n, f) => n + f.added, 0)
  const removed = () => props.files.reduce((n, f) => n + f.removed, 0)
  return (
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-xs text-fg-3">
      <span class="font-mono text-fg-2">{props.diff.branch || 'detached'}</span>
      <DiffCount files={props.files.length} added={added()} removed={removed()} />
      <span>{plural(props.files.length, 'file')}</span>
      <div class="flex-1" />
      <Show when={props.claude}>
        <span>
          Claude’s review: {props.claude!.findings.length ? `${plural(props.findings, 'finding')} left` : 'no line findings'}
        </span>
      </Show>
      <Show when={props.onAsk}>
        <button onClick={props.onAsk} class="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-surface hover:text-fg-2">
          <Sparkles class="size-3" />
          {props.claude ? 'Review again' : 'Ask Claude to review'}
        </button>
      </Show>
    </div>
  )
}

const STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const
const STATUS_TONE = { added: 'text-ok', modified: 'text-fg-3', deleted: 'text-danger', renamed: 'text-accent' } as const

function FileList(props: { files: ReviewFile[]; viewed: (f: ReviewFile) => boolean; comments: (path: string) => number; findings: (path: string) => number; onPick: (path: string) => void }) {
  return (
    <For each={props.files}>
      {(f) => {
        const name = f.path.split('/').pop()!
        const dir = f.path.slice(0, -name.length)
        return (
          <button onClick={() => props.onPick(f.path)} title={f.path} class="flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs hover:bg-surface">
            <span class={`w-3 shrink-0 font-mono ${STATUS_TONE[f.status]}`}>{STATUS_LETTER[f.status]}</span>
            <span class={`min-w-0 flex-1 truncate ${props.viewed(f) ? 'text-fg-3 line-through decoration-fg-3/40' : 'text-fg-2'}`}>
              <span class="text-fg-3">{dir}</span>
              {name}
            </span>
            <Show when={props.findings(f.path)}>
              <span class="shrink-0 text-accent" title="Claude's findings">
                {props.findings(f.path)}
              </span>
            </Show>
            <Show when={props.comments(f.path)}>
              <span class="flex shrink-0 items-center gap-0.5 text-fg-2" title="Your comments">
                <MessageSquarePlus class="size-3" />
                {props.comments(f.path)}
              </span>
            </Show>
            <Show when={props.viewed(f)}>
              <Check class="size-3 shrink-0 text-fg-3" />
            </Show>
          </button>
        )
      }}
    </For>
  )
}

function FileDiff(props: {
  ref: (el: HTMLElement) => void
  file: ReviewFile
  rows: Row[]
  open: boolean
  viewed: boolean
  edits: string[]
  comments: ReviewComment[]
  findings: Finding[]
  draft?: Draft
  draftText: string
  onToggle: () => void
  onViewed: (on: boolean) => void
  onJump: (toolUseId: string) => void
  onComment: (at: number, extend: boolean) => void
  onDraftText: (text: string) => void
  onSave: () => void
  onCancel: () => void
  onEdit: (c: ReviewComment) => void
  onRemove: (id: string) => void
  onAdopt: (f: Finding) => void
  onDismiss: (f: Finding) => void
}) {
  const f = () => props.file
  const anchors = createMemo(() => new Set(props.rows.filter((r): r is Line => r.kind !== 'hunk').map(anchorOf)))
  const newLines = createMemo(() => new Set(props.rows.filter((r): r is Line => r.kind !== 'hunk' && r.new !== undefined).map((r) => r.new!)))
  /** Comments and findings with no row here to sit under: shown at the top of the file. */
  const loose = () => [
    ...props.comments.filter((c) => !anchors().has(c.to)).map((c) => ({ comment: c })),
    ...props.findings.filter((x) => !x.line || !newLines().has(x.line)).map((x) => ({ finding: x })),
  ]
  const [extra, setExtra] = createSignal(false)

  return (
    <section ref={props.ref} class="border-b border-line">
      <header class="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-bg px-2 py-1.5">
        <button onClick={props.onToggle} class="grid size-5 shrink-0 place-items-center rounded text-fg-3 hover:bg-surface hover:text-fg-2">
          {props.open ? <ChevronDown class="size-3.5" /> : <ChevronRight class="size-3.5" />}
        </button>
        <span class={`shrink-0 font-mono text-xs ${STATUS_TONE[f().status]}`}>{STATUS_LETTER[f().status]}</span>
        <button onClick={props.onToggle} class="min-w-0 truncate text-left font-mono text-xs text-fg" title={f().path} dir="rtl">
          {/* rtl so a long path loses its start, not its file name. */}
          <bdi>{f().oldPath ? `${f().oldPath} → ${f().path}` : f().path}</bdi>
        </button>
        <DiffCount files={1} added={f().added} removed={f().removed} class="shrink-0 text-xs" />
        <div class="flex-1" />
        <Show when={props.edits.length}>
          <button
            onClick={() => props.onJump(props.edits[props.edits.length - 1])}
            title="Show Claude's last edit to this file in the chat"
            class="hidden shrink-0 rounded px-1.5 py-0.5 text-xs text-fg-3 hover:bg-surface hover:text-fg-2 @md:block"
          >
            {props.edits.length === 1 ? 'Edited in chat' : `Edited ${props.edits.length}× in chat`}
          </button>
        </Show>
        <label class="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-3 hover:bg-surface hover:text-fg-2">
          <input type="checkbox" checked={props.viewed} onChange={(e) => props.onViewed(e.currentTarget.checked)} class="accent-(--color-primary)" />
          Viewed
        </label>
      </header>

      <Show when={props.open}>
        <For each={loose()}>
          {(x) =>
            'comment' in x ? (
              <CommentBox comment={x.comment} onEdit={() => props.onEdit(x.comment)} onRemove={() => props.onRemove(x.comment.id)} />
            ) : (
              <FindingBox finding={x.finding} loose onAdopt={() => props.onAdopt(x.finding)} onDismiss={() => props.onDismiss(x.finding)} />
            )
          }
        </For>
        <Show
          when={!f().binary && !f().truncated && (!f().generated || extra())}
          fallback={
            <p class="px-4 py-3 text-xs text-fg-3">
              {f().binary ? 'Binary file.' : f().truncated ? 'Too big to show here.' : 'Generated file, folded. '}
              <Show when={f().generated && !f().binary && !f().truncated}>
                <button onClick={() => setExtra(true)} class="underline-offset-2 hover:text-fg-2 hover:underline">
                  Show it
                </button>
              </Show>
            </p>
          }
        >
          <div class="font-mono text-xs leading-5">
            <For each={props.rows}>
              {(r, i) => {
                if (r.kind === 'hunk')
                  return <div class="bg-surface/60 px-3 py-0.5 text-fg-3 select-none">{r.text ? `@@ ${r.text}` : '⋯'}</div>
                const anchor = anchorOf(r)
                const inDraft = () => !!props.draft && i() >= props.draft.from && i() <= props.draft.to
                const here = () => props.comments.filter((c) => c.to === anchor)
                const found = () => (r.kind !== 'del' ? props.findings.filter((x) => x.line === r.new) : [])
                const editing = () => props.draft && props.draft.to === i()
                return (
                  <>
                    <div
                      class={`group relative flex ${r.kind === 'add' ? 'bg-ok/10' : r.kind === 'del' ? 'bg-danger/10' : ''} ${inDraft() ? 'outline outline-1 -outline-offset-1 outline-accent/60' : ''}`}
                    >
                      <span class="w-10 shrink-0 select-none pr-1.5 text-right text-fg-3/70 tabular-nums">{r.old ?? ''}</span>
                      <span class="w-10 shrink-0 select-none pr-1.5 text-right text-fg-3/70 tabular-nums">{r.new ?? ''}</span>
                      <button
                        onClick={(e) => props.onComment(i(), e.shiftKey)}
                        title="Comment on this line (shift-click to cover from the last one)"
                        class="absolute left-0.5 top-0.5 grid size-4 place-items-center rounded bg-primary text-on-primary opacity-0 group-hover:opacity-100 pointer-coarse:opacity-40"
                      >
                        <MessageSquarePlus class="size-2.5" />
                      </button>
                      <span class={`w-4 shrink-0 select-none text-center ${r.kind === 'add' ? 'text-ok' : r.kind === 'del' ? 'text-danger' : 'text-fg-3'}`}>{SIGN[r.kind]}</span>
                      <span class="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3 text-fg">
                        <Code line={r} />
                      </span>
                    </div>
                    <Show when={editing()}>
                      <DraftBox text={props.draftText} editing={!!props.draft?.id} lines={props.draft!.to - props.draft!.from + 1} onText={props.onDraftText} onSave={props.onSave} onCancel={props.onCancel} />
                    </Show>
                    <For each={found()}>{(x) => <FindingBox finding={x} onAdopt={() => props.onAdopt(x)} onDismiss={() => props.onDismiss(x)} />}</For>
                    <For each={here()}>
                      {(c) => (
                        <Show when={props.draft?.id !== c.id}>
                          <CommentBox comment={c} onEdit={() => props.onEdit(c)} onRemove={() => props.onRemove(c.id)} />
                        </Show>
                      )}
                    </For>
                  </>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>
    </section>
  )
}

/** A line, with the part that changed against its pair picked out. */
function Code(props: { line: Line }) {
  const m = () => props.line.mark
  const tone = () => (props.line.kind === 'add' ? 'bg-ok/25' : 'bg-danger/25')
  return (
    <Show when={m()} fallback={props.line.text || ' '}>
      {(m) => (
        <>
          {props.line.text.slice(0, m()[0])}
          <span class={`rounded-sm ${tone()}`}>{props.line.text.slice(m()[0], m()[1])}</span>
          {props.line.text.slice(m()[1])}
        </>
      )}
    </Show>
  )
}

const boxClass = 'mx-3 my-1.5 rounded-lg border px-3 py-2 font-sans text-ui'

function DraftBox(props: { text: string; editing: boolean; lines: number; onText: (t: string) => void; onSave: () => void; onCancel: () => void }) {
  let el!: HTMLTextAreaElement
  onMount(() => el.focus())
  return (
    <div class={`${boxClass} border-accent/40 bg-bg`}>
      <textarea
        ref={el}
        value={props.text}
        onInput={(e) => props.onText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) props.onSave()
          if (e.key === 'Escape') props.onCancel()
        }}
        rows={3}
        placeholder={props.lines > 1 ? `On these ${props.lines} lines…` : 'On this line…'}
        class="w-full resize-y bg-transparent text-ui outline-none placeholder:text-fg-3"
      />
      <div class="mt-1 flex items-center gap-2">
        <Button primary onClick={props.onSave} class="h-7 text-xs">
          {props.editing ? 'Save' : 'Add comment'}
        </Button>
        <Button onClick={props.onCancel} class="h-7 text-xs">
          Cancel
        </Button>
        <span class="text-xs text-fg-3">⌘/Ctrl+Enter</span>
      </div>
    </div>
  )
}

function CommentBox(props: { comment: ReviewComment; onEdit: () => void; onRemove: () => void }) {
  return (
    <div class={`${boxClass} group/c border-line bg-surface`}>
      <div class="mb-0.5 flex items-center gap-2 text-xs text-fg-3">
        <span>
          {props.comment.claude ? `From Claude’s review (${props.comment.claude})` : 'You'} · {props.comment.where}
        </span>
        <div class="flex-1" />
        <button onClick={props.onEdit} class="opacity-0 hover:text-fg-2 group-hover/c:opacity-100">
          Edit
        </button>
        <button onClick={props.onRemove} title="Delete" class="opacity-0 hover:text-danger group-hover/c:opacity-100">
          <Trash2 class="size-3" />
        </button>
      </div>
      <p class="whitespace-pre-wrap text-fg">{props.comment.text}</p>
    </div>
  )
}

const SEVERITY: Record<string, string> = { high: 'bg-danger', medium: 'bg-accent', low: 'bg-fg-3' }

function FindingBox(props: { finding: Finding; loose?: boolean; onAdopt: () => void; onDismiss: () => void }): JSX.Element {
  return (
    <div class={`${boxClass} border-accent/30 bg-accent/5`}>
      <div class="mb-0.5 flex items-center gap-2 text-xs text-fg-3">
        <span class={`size-1.5 rounded-full ${SEVERITY[props.finding.severity ?? ''] ?? 'bg-fg-3'}`} />
        <span>
          Claude’s review{props.finding.severity ? ` · ${props.finding.severity}` : ''}
          {props.loose && props.finding.line ? ` · line ${props.finding.line}, not shown` : ''}
        </span>
        <div class="flex-1" />
        <button onClick={props.onAdopt} class="hover:text-fg-2" title="Add it to your comments, to send with them">
          Add to my comments
        </button>
        <button onClick={props.onDismiss} title="Dismiss" class="hover:text-fg-2">
          <X class="size-3" />
        </button>
      </div>
      <p class="whitespace-pre-wrap text-fg-2">{props.finding.note}</p>
    </div>
  )
}
