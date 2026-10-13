import { createEffect, onCleanup, onMount } from 'solid-js'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { socket } from '../api.ts'

/** ANSI colours tuned to sit on the palette in index.css; the rest of the theme comes from its variables. */
const ANSI = {
  light: {
    black: '#1b1a18', red: '#b5382c', green: '#3d7a4a', yellow: '#8a6a10', blue: '#2f5f9e', magenta: '#8a4a8f', cyan: '#2b7a7f', white: '#9a9892',
    brightBlack: '#6f6d68', brightRed: '#c13a2e', brightGreen: '#4a8f57', brightYellow: '#a07d16', brightBlue: '#3b6fb6', brightMagenta: '#a05aa6', brightCyan: '#348e94', brightWhite: '#5f5d58',
  },
  dark: {
    black: '#3a3936', red: '#e26d5f', green: '#7cb08a', yellow: '#d9b866', blue: '#7aa2d9', magenta: '#c597d0', cyan: '#6fb8bb', white: '#c9c7c2',
    brightBlack: '#6f6d68', brightRed: '#f08a7d', brightGreen: '#95c7a2', brightYellow: '#ebcb82', brightBlue: '#97b9e6', brightMagenta: '#d6b0df', brightCyan: '#8dcfd1', brightWhite: '#e9e7e2',
  },
}

const dark = matchMedia('(prefers-color-scheme: dark)')

function theme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(`--color-${name}`).trim()
  return {
    background: v('bg'),
    foreground: v('fg'),
    cursor: v('fg'),
    cursorAccent: v('bg'),
    // xterm parses colours itself, so alpha goes on as hex rather than color-mix().
    selectionBackground: v('accent') + '40',
    scrollbarSliderBackground: v('fg-3') + '4d',
    scrollbarSliderHoverBackground: v('fg-3') + '80',
    ...(dark.matches ? ANSI.dark : ANSI.light),
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
      socket.send({ type: 'term_resize', id: props.id, cols: term.cols, rows: term.rows })
    }

    const off = socket.on((e) => {
      if (e.type === 'term_snapshot' && e.id === props.id) {
        term.reset()
        term.write(e.data)
      } else if (e.type === 'term_output' && e.id === props.id) term.write(e.data)
    })
    // Size first, so the snapshot comes back already laid out for this view.
    resize()
    socket.send({ type: 'term_subscribe', id: props.id })
    const input = term.onData((data) => socket.send({ type: 'term_input', id: props.id, data }))

    let timer: ReturnType<typeof setTimeout>
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(resize, 50)
    })
    observer.observe(el)
    createEffect(() => props.visible && queueMicrotask(resize))

    const retheme = () => (term.options.theme = theme())
    dark.addEventListener('change', retheme)

    props.onReady?.(() => term.focus())

    onCleanup(() => {
      clearTimeout(timer)
      observer.disconnect()
      dark.removeEventListener('change', retheme)
      off()
      input.dispose()
      socket.send({ type: 'term_unsubscribe', id: props.id })
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
