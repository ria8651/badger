import DOMPurify from 'dompurify'

/*
 * Mermaid diagrams in rendered Markdown. Mermaid is big, so it loads the first
 * time a diagram scrolls near the screen; the fence shows as code until then,
 * and stays code if it doesn't parse.
 */

/** Past this, a diagram stays code: laying it out would stall the page. */
const MAX = 50_000

type Mermaid = (typeof import('mermaid'))['default']
let mermaid: Promise<Mermaid> | undefined
let colours = ''
let count = 0

/** The palette's colours where the diagram is, which Mermaid needs as values, not variables. */
function paletteAt(el: Element) {
  const style = getComputedStyle(el)
  const v = (name: string) => style.getPropertyValue(`--${name}`).trim()
  return {
    darkMode: style.colorScheme === 'dark',
    background: v('color-bg'),
    primaryColor: v('color-surface'),
    primaryTextColor: v('color-fg'),
    primaryBorderColor: v('color-edge'),
    secondaryColor: v('color-well'),
    tertiaryColor: v('color-bg'),
    lineColor: v('color-fg-3'),
    textColor: v('color-fg'),
    noteBkgColor: v('color-surface'),
    noteTextColor: v('color-fg'),
    noteBorderColor: v('color-edge'),
    fontFamily: v('font-sans'),
    fontSize: '13px',
  }
}

interface Drawn {
  svg: string
  /** The id Mermaid gave it, which its styles and arrowheads refer to. */
  id: string
}

/**
 * Diagrams by the colours they're drawn in and their source, as promises so a
 * message re-rendered while one is drawing doesn't start it again. Undefined
 * for one that didn't parse.
 */
const cache = new Map<string, Promise<Drawn | undefined>>()
const done = new Map<string, Drawn | undefined>()
/** Mermaid's settings are global, so renders go one at a time, each with its own colours. */
let queue: Promise<unknown> = Promise.resolve()

function draw(source: string, theme: ReturnType<typeof paletteAt>): Promise<Drawn | undefined> {
  const next = queue.then(async () => {
    const m = await (mermaid ??= import('mermaid').then((m) => m.default))
    if (colours !== JSON.stringify(theme)) {
      m.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        // Labels as SVG text, not HTML in a foreignObject: plainer to sanitize, and it draws as an image.
        htmlLabels: false,
        theme: 'base',
        themeVariables: theme,
      })
      colours = JSON.stringify(theme)
    }
    const id = `mermaid-${++count}`
    let svg
    try {
      svg = (await m.render(id, source)).svg
    } catch {
      return // Not valid Mermaid: it stays code.
    }
    return { svg: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }), id }
  })
  queue = next.catch(() => {})
  return next
}

function render(source: string, at: Element): Promise<Drawn | undefined> {
  const theme = paletteAt(at)
  const key = `${JSON.stringify(theme)}\0${source}`
  let drawing = cache.get(key)
  if (!drawing) {
    drawing = draw(source, theme).then(
      (d) => {
        done.set(key, d)
        return d
      },
      (e) => {
        // Mermaid didn't load, or broke: the next diagram tries again from scratch.
        console.warn("Couldn't draw a diagram", e)
        mermaid = undefined
        colours = ''
        cache.delete(key)
        return undefined
      },
    )
    if (cache.size > 200) {
      const oldest = cache.keys().next().value!
      cache.delete(oldest)
      done.delete(oldest)
    }
    cache.set(key, drawing)
  }
  return drawing
}

/** The diagram as an image, for the viewer: sized from its viewBox, since an <img> has no width to fill. */
function asImage(svg: SVGSVGElement): string {
  const copy = svg.cloneNode(true) as SVGSVGElement
  const box = svg.viewBox.baseVal
  const size = box && box.width ? box : svg.getBoundingClientRect()
  copy.setAttribute('width', String(size.width))
  copy.setAttribute('height', String(size.height))
  copy.setAttribute('style', `background: ${getComputedStyle(svg).getPropertyValue('--color-bg')}`)
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`
}

/** Fences flipped to their code, which stay that way when their message renders again. */
const showingCode = new Set<string>()

/**
 * Draws a mermaid fence as its diagram once it scrolls near the screen, with a
 * button in its header to flip to the code, which is highlighted (by
 * `highlight`) only once it's shown. Clicking the diagram opens it full size.
 * Returns a function that stops it.
 */
export function diagramWhenSeen(
  block: HTMLElement,
  source: string,
  highlight: () => () => void,
  view: (url: string) => void,
): () => void {
  if (source.length > MAX) return highlight()
  const pre = block.querySelector('pre')!
  let stopped = false
  let stopHighlight: (() => void) | undefined
  const showCode = () => (stopHighlight ??= highlight())
  const show = (drawn: Drawn | undefined) => {
    if (stopped) return
    if (!drawn) return void showCode()
    const figure = document.createElement('div')
    figure.className = 'diagram'
    // A fresh id, so the same diagram twice on a page doesn't share the other's arrowheads.
    figure.innerHTML = drawn.svg.replace(new RegExp(`${drawn.id}(?!\\d)`, 'g'), `mermaid-${++count}`)
    figure.title = 'Open full size'
    figure.onclick = () => view(asImage(figure.querySelector('svg')!))
    pre.before(figure)
    const toggle = document.createElement('button')
    toggle.type = 'button'
    const flip = (code: boolean) => {
      pre.hidden = !code
      figure.hidden = code
      toggle.textContent = code ? 'Diagram' : 'Code'
      if (code) showCode()
    }
    toggle.onclick = () => {
      const code = !showingCode.has(source)
      if (code) showingCode.add(source)
      else showingCode.delete(source)
      flip(code)
    }
    flip(showingCode.has(source))
    block.querySelector('.code-head button')!.before(toggle)
  }
  // Already drawn: show it straight away, so a re-rendered message doesn't flash code.
  const key = `${JSON.stringify(paletteAt(block))}\0${source}`
  const seen = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      seen.disconnect()
      void render(source, block).then(show)
    },
    { rootMargin: '400px' },
  )
  if (done.has(key)) show(done.get(key))
  else seen.observe(block)
  return () => {
    stopped = true
    seen.disconnect()
    stopHighlight?.()
  }
}
