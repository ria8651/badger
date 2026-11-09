import { For, Show, createMemo, onCleanup, untrack, useContext, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { File, Folder, SquareSlash } from '../icons'
import { fileLink, useOpenFile } from '../fileLinks.ts'
import { highlightWhenSeen } from '../highlight.ts'
import { chipText, segments, spans, type Chip } from '../prompt.ts'
import { TranscriptIndex } from '../transcript/context.ts'

const CHIP = 'rounded-md bg-well px-1 py-px box-decoration-clone text-fg'

/** A file or command as a chip, with its full path or name. */
export function PromptChip(props: { chip: Chip; onClick?: () => void }) {
  const icon = () => (props.chip.kind === 'command' ? SquareSlash : props.chip.value.endsWith('/') ? Folder : File)
  const body = () => (
    <>
      <Dynamic component={icon()} class="mr-1 inline-block size-[0.9em] align-[-0.1em] text-fg-3" />
      {props.chip.kind === 'command' ? `/${props.chip.value}` : props.chip.value}
    </>
  )
  return (
    <Show when={props.onClick} fallback={<span class={CHIP} title={chipText(props.chip)}>{body()}</span>}>
      <button type="button" class={`${CHIP} cursor-pointer text-left hover:bg-surface`} title={`Open ${props.chip.value}`} onClick={props.onClick}>
        {body()}
      </button>
    </Show>
  )
}

/**
 * A sent prompt's text, its mentioned files as chips that open them and, if it was one, the command it starts with as
 * one too; its links open and its code is shown as code.
 */
export function PromptText(props: { text: string; command?: boolean }) {
  const files = useOpenFile()
  const open = (chip: Chip) => {
    if (!files || chip.kind !== 'file' || chip.value.endsWith('/')) return
    const link = fileLink(chip.value, files.cwd())
    return link && (() => files.open(link.path, link.line))
  }
  // Only Claude Code knows which `/name`s are skills, so one past the start is a chip once Claude has called it.
  const index = useContext(TranscriptIndex)
  const called = createMemo(() => index?.().skills.size ?? 0)
  const skill = (name: string) => (called(), untrack(() => !!index?.().skills.has(name)))
  /** The text from `at` to `to`; only a run that starts the prompt can start with its command. */
  const plain = (at: number, to: number) => {
    const glued = at > 0 && !/\s/.test(props.text[at - 1])
    return (
      <For each={segments(props.text.slice(at, to), { command: at === 0 && !!props.command, skill, glued })}>
        {(s) => (typeof s === 'string' ? s : <PromptChip chip={s} onClick={open(s)} />)}
      </For>
    )
  }
  /** The text between its code and links, which can still have chips in, then each span. */
  const parts = () => {
    const out: JSX.Element[] = []
    let at = 0
    for (const span of spans(props.text)) {
      // A block's own line breaks, so it doesn't leave a blank line on either side.
      out.push(plain(at, span.kind === 'fence' && props.text[span.from - 1] === '\n' ? span.from - 1 : span.from))
      const text = props.text.slice(span.from, span.to)
      if (span.kind === 'url')
        out.push(
          <a href={text} target="_blank" rel="noreferrer" class="prompt-url">
            {text}
          </a>,
        )
      else if (span.kind === 'code') out.push(<code class="prompt-code">{text}</code>)
      else {
        // Its fences faint, and the code between them highlighted when it says what it's in.
        const lines = text.split('\n')
        const body = lines.slice(1, span.closed ? -1 : undefined)
        const lang = span.lang
        out.push(
          <code class="prompt-fence block">
            <span class="prompt-fence-mark">{lines[0]}</span>
            <Show when={body.length}>
              {'\n'}
              <span
                ref={(el) => {
                  // The code's put in here, not as a child: Solid inserts children after the ref runs, which would
                  // write over a highlight that was already cached and so put in straight away.
                  const code = body.join('\n')
                  el.textContent = code
                  onCleanup(highlightWhenSeen(el, code, lang))
                }}
              />
            </Show>
            <Show when={span.closed}>
              {'\n'}
              <span class="prompt-fence-mark">{lines.at(-1)}</span>
            </Show>
          </code>,
        )
      }
      at = span.kind === 'fence' && props.text[span.to] === '\n' ? span.to + 1 : span.to
    }
    out.push(plain(at, props.text.length))
    return out
  }
  return <>{parts()}</>
}
