import { createEffect, on, onCleanup, onMount } from 'solid-js'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { socket } from '../api.ts'
import { palette, type Palette } from '../theme.ts'

/** ANSI colours tuned to sit on the palette in index.css; the rest of the theme comes from its variables. */
const ANSI = {
  light: {
    black: '#1b1a18', red: '#a7463e', green: '#1d7d3e', yellow: '#905d00', blue: '#1f6cb0', magenta: '#9b467a', cyan: '#007d86', white: '#9a9892',
    brightBlack: '#6f6d68', brightRed: '#c65a51', brightGreen: '#319751', brightYellow: '#ad7300', brightBlue: '#3284d0', brightMagenta: '#b95a93', brightCyan: '#0097a1', brightWhite: '#5f5d58',
  },
  dark: {
    black: '#45443f', red: '#e6867b', green: '#69ba7c', yellow: '#cc9c42', blue: '#67aaed', magenta: '#da85b6', cyan: '#14bbc2', white: '#c9c7c2',
    brightBlack: '#6f6d68', brightRed: '#feaba1', brightGreen: '#95d7a2', brightYellow: '#e6bd77', brightBlue: '#92c9ff', brightMagenta: '#f3aad3', brightCyan: '#6bd8de', brightWhite: '#e9e7e2',
  },
  // Phosphor-bright, so colour output still reads on green-on-black.
  terminal: {
    black: '#24502f', red: '#ff5f4f', green: '#6bff8f', yellow: '#ffb000', blue: '#5fafff', magenta: '#e07cff', cyan: '#5fffd7', white: '#45c867',
    brightBlack: '#2f8a49', brightRed: '#ff8a7d', brightGreen: '#b4ffc6', brightYellow: '#ffd060', brightBlue: '#8cc8ff', brightMagenta: '#eda6ff', brightCyan: '#9dffe6', brightWhite: '#d8ffe2',
  },
}
const ansi: Record<Palette, ITheme> = { light: ANSI.light, dark: ANSI.dark, black: ANSI.dark, terminal: ANSI.terminal, oms: ANSI.light, win95: ANSI.light }

/**
 * Highlight, worked out to a colour xterm can take: it can't read system colours itself. The text keeps its own
 * colour, as on the review's drawn selection: xterm fades an opaque Highlight, which HighlightText wouldn't read on.
 */
function systemSelection(): Pick<ITheme, 'selectionBackground'> {
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;background:Highlight'
  document.documentElement.append(probe)
  const selectionBackground = getComputedStyle(probe).backgroundColor
  probe.remove()
  return { selectionBackground }
}

function theme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(`--color-${name}`).trim()
  return {
    background: v('bg'),
    foreground: v('fg'),
    cursor: v('fg'),
    cursorAccent: v('bg'),
    // The system's selection, as everywhere else on the page.
    ...systemSelection(),
    // xterm parses colours itself, so alpha goes on as hex rather than color-mix().
    scrollbarSliderBackground: v('fg-3') + '4d',
    scrollbarSliderHoverBackground: v('fg-3') + '80',
    ...ansi[palette()],
  }
}

/**
 * One terminal on screen. Subscribing gets a snapshot of the screen (which
 * replaces whatever was shown) and then live output; keystrokes and size go
 * back to the server, where the process keeps running whether or not anyone
 * is watching.
 */
export function TerminalView(props: {
  id: string
  /** Hidden views keep their content but don't measure or resize the terminal. */
  visible: boolean
  /** Called with a way to focus this view once it's mounted. */
  onReady?: (focus: () => void) => void
  class?: string
}) {
  let el!: HTMLDivElement
  // Read once: a view shows one terminal for life, and callers pass the id through a <Show> that's gone by cleanup.
  const id = props.id

  onMount(() => {
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5000,
      cursorBlink: true,
      macOptionIsMeta: true,
      theme: theme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')))
    term.open(el)
    muteQueryReplies(term)

    let size = ''
    const resize = () => {
      if (!props.visible || !el.offsetWidth || !el.offsetHeight) return
      fit.fit()
      const next = `${term.cols}x${term.rows}`
      if (next === size) return
      size = next
      socket.send({ type: 'term_resize', id, cols: term.cols, rows: term.rows })
    }

    const off = socket.on((e) => {
      if (e.type === 'term_snapshot' && e.id === id) {
        term.reset()
        term.write(e.data)
      } else if (e.type === 'term_output' && e.id === id) term.write(e.data)
    })
    // Size first, so the snapshot comes back already laid out for this view.
    resize()
    socket.send({ type: 'term_subscribe', id })
    const input = term.onData((data) => socket.send({ type: 'term_input', id, data }))

    let timer: ReturnType<typeof setTimeout>
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(resize, 50)
    })
    observer.observe(el)
    createEffect(() => props.visible && queueMicrotask(resize))

    // A tick late, so the page's colours have switched before they're read.
    createEffect(on(palette, () => queueMicrotask(() => (term.options.theme = theme())), { defer: true }))

    props.onReady?.(() => term.focus())

    onCleanup(() => {
      clearTimeout(timer)
      observer.disconnect()
      off()
      input.dispose()
      socket.send({ type: 'term_unsubscribe', id })
      term.dispose()
    })
  })

  // Padding goes on the wrapper: the fit addon measures el and would count padding on it as room for rows.
  return (
    <div class={`min-h-0 ${props.class ?? ''}`}>
      <div ref={el} class="size-full overflow-hidden" />
    </div>
  )
}

/**
 * Swallow the queries a program sends to learn about its terminal. The PTY
 * host's screen answers them; a browser answering too would type a second
 * reply into the shell, once per open view.
 */
function muteQueryReplies(term: Terminal): void {
  const swallow = () => true
  for (const id of [
    { final: 'c' }, // primary device attributes
    { prefix: '>', final: 'c' }, // secondary device attributes
    { final: 'n' }, // status and cursor position reports
    { prefix: '?', final: 'n' },
    { prefix: '>', final: 'q' }, // terminal version
    { intermediates: '$', final: 'p' }, // mode reports
    { prefix: '?', intermediates: '$', final: 'p' },
  ])
    term.parser.registerCsiHandler(id, swallow)
  term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow) // setting reports
  // Colour queries go unanswered (the host doesn't know the theme); colour changes still apply.
  for (const osc of [4, 10, 11, 12]) term.parser.registerOscHandler(osc, (data) => data.includes('?'))
}
