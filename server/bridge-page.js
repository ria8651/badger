// Runs in every page a preview serves (see server/bridge.ts). It connects
// back to Badger so Claude can look at and drive the page the user has open:
// run code in it, read its console, and render it to an image.
;(() => {
  // Only the preview's own top document: frames the page makes of its own origin are part of it.
  try {
    if (window.parent !== window && window.parent.location.origin === location.origin) return
  } catch {}
  if (window.__badgerBridge) return
  window.__badgerBridge = true

  const BRIDGE_FILE = '/__badger/bridge.js'
  const LOG_LIMIT = 500
  const MAX_TEXT = 60_000

  // ── Console ──

  const logs = []
  let logSeq = 0
  const record = (level, args) => {
    logs.push({ n: ++logSeq, at: Date.now(), level, text: args.map((a) => (typeof a === 'string' ? a : brief(a))).join(' ') })
    if (logs.length > LOG_LIMIT) logs.shift()
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level]
    console[level] = function (...args) {
      record(level, args)
      return original.apply(this, args)
    }
  }
  addEventListener(
    'error',
    (e) => {
      // A script, image or stylesheet that failed to load fires here too, on the element.
      if (e.target instanceof Element) record('error', [`Failed to load <${e.target.localName}> ${e.target.src || e.target.href || ''}`])
      else record('error', [e.error ?? e.message])
    },
    true,
  )
  addEventListener('unhandledrejection', (e) => record('error', ['Unhandled rejection:', e.reason]))

  // ── Values, as JSON Claude can read ──

  function plain(value, depth = 0, seen = new WeakSet()) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
    if (value === undefined) return '(undefined)'
    if (typeof value === 'bigint') return `${value}n`
    if (typeof value === 'symbol') return value.toString()
    if (typeof value === 'function') return `(function ${value.name || 'anonymous'})`
    if (value instanceof Element) return element(value)
    if (value instanceof Node) return value.textContent
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
    if (value instanceof Date) return value.toISOString()
    if (seen.has(value)) return '(circular)'
    if (depth > 6) return '(…)'
    seen.add(value)
    const list = Array.isArray(value) || value instanceof NodeList || value instanceof HTMLCollection || value instanceof Set
    if (list || value instanceof Map) {
      const items = [...(value instanceof Map ? value.entries() : value)]
      const out = items.slice(0, 200).map((v) => plain(v, depth + 1, seen))
      if (items.length > 200) out.push(`(${items.length - 200} more)`)
      return out
    }
    const out = {}
    let n = 0
    for (const key in value) {
      if (++n > 100) {
        out['…'] = 'more keys'
        break
      }
      try {
        out[key] = plain(value[key], depth + 1, seen)
      } catch (err) {
        out[key] = `(threw ${err})`
      }
    }
    return out
  }

  /** An element as its opening tag and text, which is usually how one is recognised. */
  function element(el) {
    const tag = el.outerHTML.slice(0, el.outerHTML.indexOf('>') + 1).slice(0, 300)
    const text = (el.innerText ?? el.textContent ?? '').trim().replace(/\s+/g, ' ')
    return text ? `${tag} ${text.length > 120 ? text.slice(0, 120) + '…' : text}` : tag
  }

  function brief(value) {
    try {
      const p = plain(value, 4)
      return typeof p === 'string' ? p : JSON.stringify(p)
    } catch {
      return String(value)
    }
  }

  function render(value) {
    const p = plain(value)
    const text = typeof p === 'string' ? p : JSON.stringify(p, null, 2)
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[cut: ${text.length} characters in all]` : text
  }

  // ── Helpers for code Claude runs ──

  const $ = (target, root = document) => (typeof target === 'string' ? root.querySelector(target) : target)
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
  const need = (target) => {
    const el = $(target)
    if (!el) throw new Error(`Nothing matches ${target}`)
    return el
  }
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

  /** Until test (a selector, or a function) finds something, or fails after timeout ms. */
  async function waitFor(test, timeout = 5000) {
    const end = Date.now() + timeout
    for (;;) {
      const found = typeof test === 'function' ? await test() : document.querySelector(test)
      if (found) return found
      if (Date.now() > end) throw new Error(`Timed out after ${timeout}ms waiting for ${typeof test === 'function' ? 'the condition' : test}`)
      await sleep(50)
    }
  }

  /** A click as a pointer would make it, so handlers listening for pointer or mouse events see one too. */
  function click(target) {
    const el = need(target)
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    const at = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }
    const pointer = { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true }
    el.dispatchEvent(new PointerEvent('pointerdown', pointer))
    el.dispatchEvent(new MouseEvent('mousedown', at))
    el.focus?.()
    el.dispatchEvent(new PointerEvent('pointerup', pointer))
    el.dispatchEvent(new MouseEvent('mouseup', at))
    el.dispatchEvent(new MouseEvent('click', at))
    return el
  }

  /**
   * Types text into a field, replacing what's there. The value goes in through
   * the element's own setter, so frameworks that track it (React) see the change.
   */
  function fill(target, text) {
    const el = need(target)
    el.focus()
    if (el.isContentEditable) {
      el.textContent = text
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement
      Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, text)
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return el
  }

  /** Presses a key on the focused element, or target. Enter in a form's field submits it, as a real one would. */
  function press(key, target) {
    const el = target ? need(target) : document.activeElement ?? document.body
    const init = { key, bubbles: true, cancelable: true, composed: true }
    const go = el.dispatchEvent(new KeyboardEvent('keydown', init))
    el.dispatchEvent(new KeyboardEvent('keyup', init))
    if (go && key === 'Enter' && el instanceof HTMLInputElement && el.form) el.form.requestSubmit()
    return el
  }

  /** What an element (the page, by default) reads as, without markup. */
  const text = (target = document.body) => need(target).innerText

  const helpers = { $, $$, waitFor, sleep, click, fill, press, text }
  const AsyncFunction = (async () => {}).constructor

  async function run(code) {
    let fn
    try {
      // An expression gives its value; anything else runs as a function body, so it can return one.
      fn = new AsyncFunction(...Object.keys(helpers), `return (${code}\n)`)
    } catch (err) {
      if (err instanceof EvalError) throw new Error("The page's Content-Security-Policy doesn't allow running code (no 'unsafe-eval')")
      fn = new AsyncFunction(...Object.keys(helpers), code)
    }
    return fn(...Object.values(helpers))
  }

  // ── Screenshots ──

  /** The page as the user sees it, or one element, or (full) the whole page, as a PNG data URL. */
  async function screenshot(selector, full) {
    const { domToPng } = await import('/__badger/screenshot.js')
    const el = selector ? need(selector) : document.documentElement
    const viewport = !selector && !full
    return domToPng(el, {
      scale: Math.min(devicePixelRatio, 2),
      timeout: 10_000,
      ...(viewport
        ? { width: innerWidth, height: innerHeight, style: { transform: `translate(${-scrollX}px, ${-scrollY}px)` } }
        : {}),
    })
  }

  // ── Connection to Badger ──

  let ws
  let retry = 0
  const state = (active) => ({ type: 'state', url: location.href, title: document.title, visible: document.visibilityState === 'visible', active })
  const send = (message) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(message))

  async function handle(message) {
    const { id, op } = message
    try {
      let value
      if (op === 'run') value = render(await run(message.code))
      else if (op === 'logs') value = logs.filter((l) => l.n > (message.after ?? 0))
      else if (op === 'clear_logs') value = void logs.splice(0)
      else if (op === 'screenshot') value = await screenshot(message.selector, message.full)
      else if (op === 'goto') value = void setTimeout(() => location.assign(new URL(message.url, location.href)))
      else throw new Error(`Unknown request ${op}`)
      send({ type: 'result', id, ok: true, value })
    } catch (err) {
      // The bridge's own frames are noise: what matters is the code that was run, and the page's.
      const stack = err instanceof Error && err.stack ? err.stack.split('\n').filter((l) => !l.includes(BRIDGE_FILE)).join('\n') : undefined
      send({ type: 'result', id, ok: false, error: stack || (err instanceof Error ? err.message : brief(err)) })
    }
  }

  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__badger/bridge`)
    ws.onopen = () => {
      retry = 0
      send(state(document.hasFocus()))
    }
    ws.onmessage = (e) => handle(JSON.parse(e.data))
    ws.onclose = () => {
      ws = undefined
      // Badger restarting; the browser logs each failed attempt, so they're kept sparse.
      setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++))
    }
  }
  connect()

  // Which page Claude acts on, when there are several: the one the user was last in.
  let lastSent = 0
  const touched = () => Date.now() - lastSent > 1000 && ((lastSent = Date.now()), send(state(true)))
  for (const type of ['pointerdown', 'keydown', 'focus']) addEventListener(type, touched, true)
  document.addEventListener('visibilitychange', () => send(state(false)))
  // Single-page apps move without loading a page.
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method]
    history[method] = function (...args) {
      const result = original.apply(this, args)
      send(state(false))
      return result
    }
  }
  addEventListener('popstate', () => send(state(false)))
  addEventListener('hashchange', () => send(state(false)))
})()
