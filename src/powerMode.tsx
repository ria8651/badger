import { Show, batch, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js'

// ── Power mode: sparks fly from the caret, the screen shakes and a combo counts up as you type ──

const KEY = 'badger.powerMode'
const [powerMode, setPowerModeSignal] = createSignal(localStorage.getItem(KEY) === '1')
export { powerMode }

/** Kept in this browser, like the theme. */
export function setPowerMode(on: boolean): void {
  setPowerModeSignal(on)
  localStorage.setItem(KEY, on ? '1' : '0')
}

/** A combo ends this long after the last keystroke. */
const COMBO_MS = 6000

/**
 * What a combo is worth as it grows. Reaching one is shouted, with fireworks and a jolt; each also keeps
 * what the ones before it brought: bigger sparks that last longer, the screen's edges pulsing, fireworks as you
 * type, and the whole app cycling through colours.
 */
const LEVELS = [
  { at: 0, shout: '', shake: 2 },
  { at: 10, shout: 'Nice!', shake: 3 },
  { at: 25, shout: 'Great!', shake: 4 },
  { at: 50, shout: 'Unstoppable!', shake: 6 },
  { at: 100, shout: 'Godlike!', shake: 8 },
  { at: 200, shout: 'Power overwhelming!', shake: 11 },
]

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  /** Taken off life each frame. */
  decay: number
  gravity: number
  size: number
  hue: number
  /** Drawn as this picture instead of a square. */
  picture?: { image: HTMLImageElement; aspect: number }
  angle: number
  /** Turned by this much each frame. */
  spin: number
}

/** Who might fly out once in a while, picked by weight. */
interface Guest {
  /** The picture for the page's colours now. */
  image: () => HTMLImageElement
  /** Height over width. */
  aspect: number
  size: number
  weight: number
}

// In public/power-mode: Ferris from rustacean.net, Bevy's birds from bevy.org (theirs come pale, for dark
// backgrounds; bevy-light.svg is the same in darker greys), and Rick from the video. Credits in CREDITS.md there.
// Fetched the first time something asks for them, so nobody with power mode off downloads them.
const pictures = new Map<string, HTMLImageElement>()
const picture = (name: string) => {
  let image = pictures.get(name)
  if (!image) pictures.set(name, (image = Object.assign(new Image(), { src: `/power-mode/${name}` })))
  return image
}
const dark = () => getComputedStyle(document.documentElement).colorScheme === 'dark'
/** Drawable: loaded, and not broken. */
const ready = (image: HTMLImageElement) => image.complete && image.naturalWidth > 0

const GUESTS: Guest[] = [
  { image: () => picture('ferris.svg'), aspect: 150 / 225, size: 80, weight: 1 },
  { image: () => picture(dark() ? 'bevy.svg' : 'bevy-light.svg'), aspect: 130 / 176, size: 72, weight: 1 },
]
const RICK = 'rick.gif'
/** The odds of a guest on any one keystroke, once a combo is going. */
const GUEST_CHANCE = 1 / 40
/** And of Rick instead, rarer. */
const RICK_CHANCE = 1 / 1000
const RICK_MS = 4000

/** A shout in the middle of the screen; big for a level reached, smaller for a combo that's ended. */
interface Shout {
  text: string
  hue: number
  small?: boolean
}

/** Where the caret is on screen: the selection's, or for a textarea or input, measured on a copy of it. */
function caret(target: EventTarget | null): { x: number; y: number } | undefined {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    // Number fields and the like have no caret to ask about: their right end, where the typing goes, will do.
    if (target.selectionStart !== null) return fieldCaret(target)
    const box = target.getBoundingClientRect()
    return { x: box.right - 8, y: box.top + box.height / 2 }
  }
  const sel = getSelection()
  if (!sel?.rangeCount) return
  const range = sel.getRangeAt(0)
  // A collapsed range has no box of its own at the start of a line; its parent's does.
  const rect = range.getClientRects()[0] ?? (range.startContainer instanceof Element ? range.startContainer.getBoundingClientRect() : undefined)
  // Nothing from a caret in something hidden, rather than sparks from the corner of the screen.
  if (!rect || (!rect.width && !rect.height && !rect.left && !rect.top)) return
  return { x: rect.left, y: rect.top + rect.height / 2 }
}

function fieldCaret(field: HTMLTextAreaElement | HTMLInputElement): { x: number; y: number } {
  const style = getComputedStyle(field)
  const mirror = document.createElement('div')
  // Each side's border on its own: the shorthand reads empty when they differ.
  for (const p of [
    'font',
    'letterSpacing',
    'padding',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'boxSizing',
    'lineHeight',
    'textTransform',
    'tabSize',
  ] as const)
    mirror.style[p] = style[p]
  Object.assign(mirror.style, {
    borderStyle: 'solid',
    position: 'fixed',
    visibility: 'hidden',
    top: '0',
    left: '0',
    width: `${field.offsetWidth}px`,
    whiteSpace: field instanceof HTMLTextAreaElement ? 'pre-wrap' : 'pre',
    overflowWrap: 'break-word',
  })
  mirror.textContent = field.value.slice(0, field.selectionStart ?? field.value.length)
  const mark = mirror.appendChild(document.createElement('span'))
  mark.textContent = '​'
  document.body.appendChild(mirror)
  const box = field.getBoundingClientRect()
  const x = box.left + mark.offsetLeft - field.scrollLeft
  const y = box.top + mark.offsetTop - field.scrollTop + mark.offsetHeight / 2
  mirror.remove()
  return { x: Math.min(x, box.right), y: Math.min(Math.max(y, box.top), box.bottom) }
}

/** Drawn over everything while power mode is on: the sparks, and the combo once it gets going. */
export function PowerMode() {
  return (
    <Show when={powerMode()}>
      <Overlay />
    </Show>
  )
}

function Overlay() {
  const [combo, setCombo] = createSignal(0)
  const [bump, setBump] = createSignal(0)
  const [shout, setShout] = createSignal<Shout>()
  const [rick, setRick] = createSignal(false)
  const level = createMemo(() => LEVELS.findLastIndex((l) => combo() >= l.at))
  const hue = () => (combo() * 7) % 360
  const canvas = (<canvas class="pointer-events-none fixed inset-0 z-[9999] h-full w-full" />) as HTMLCanvasElement
  const ctx = canvas.getContext('2d')!
  const root = document.getElementById('root')!
  let sparks: Spark[] = []
  let frame = 0
  let shakeUntil = 0
  let jolt = 0
  let comboTimer: ReturnType<typeof setTimeout> | undefined
  let shoutTimer: ReturnType<typeof setTimeout> | undefined
  let rickTimer: ReturnType<typeof setTimeout> | undefined
  /** Fireworks still to go off for a level just reached. */
  const pending = new Set<ReturnType<typeof setTimeout>>()

  let dpr = devicePixelRatio
  const size = () => {
    dpr = devicePixelRatio
    canvas.width = innerWidth * dpr
    canvas.height = innerHeight * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  size()

  const draw = (now: number) => {
    frame = 0
    // Whatever goes wrong drawing, the shake is set and the next frame decided, so the loop can't stop with the app left shifted.
    try {
      paint()
    } finally {
      const shaking = now < shakeUntil
      const amount = shaking ? LEVELS[level()].shake + (now < jolt ? 14 : 0) : 0
      root.style.transform = shaking ? `translate(${(Math.random() - 0.5) * amount}px, ${(Math.random() - 0.5) * amount}px)` : ''
      if (sparks.length || shaking) run()
    }
  }
  const paint = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, innerWidth, innerHeight)
    sparks = sparks.filter((s) => (s.life -= s.decay) > 0)
    for (const s of sparks) {
      s.vy += s.gravity
      s.vx *= 0.99
      s.x += s.vx
      s.y += s.vy
      s.angle += s.spin
      // Turned about its middle: set straight, cheaper than save, translate, rotate and restore for every spark.
      const cos = Math.cos(s.angle) * dpr
      const sin = Math.sin(s.angle) * dpr
      ctx.setTransform(cos, sin, -sin, cos, s.x * dpr, s.y * dpr)
      if (s.picture) {
        const { image, aspect } = s.picture
        if (!ready(image)) continue
        // Solid until near the end, then fading out as it tumbles.
        ctx.globalAlpha = Math.min(1, s.life * 3)
        ctx.drawImage(image, -s.size / 2, (-s.size * aspect) / 2, s.size, s.size * aspect)
        continue
      }
      ctx.globalAlpha = s.life
      ctx.fillStyle = `hsl(${s.hue} 95% 60%)`
      ctx.fillRect(-s.size / 2, -s.size / 2, s.size, s.size)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  const run = () => {
    if (!frame) frame = requestAnimationFrame(draw)
  }

  /** Sparks from the caret: more as the combo grows, bigger and longer-lived from the second level, every colour from the fourth. */
  const spray = (at: { x: number; y: number }) => {
    const base = Math.random() * 360
    const lvl = level()
    for (let i = 0; i < 12 + Math.min(combo() / 2, 60); i++) {
      sparks.push({
        x: at.x,
        y: at.y,
        vx: (Math.random() - 0.5) * (6 + lvl),
        vy: -Math.random() * (6 + lvl) - 1,
        life: 1,
        decay: lvl >= 2 ? 0.015 : 0.02,
        gravity: 0.25,
        size: 2 + Math.random() * (3 + lvl),
        hue: lvl >= 4 ? Math.random() * 360 : base + (Math.random() - 0.5) * 60,
        angle: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.4,
      })
    }
  }

  /** A firework: a ring of sparks bursting out from a point and drifting down. */
  const firework = (x: number, y: number, h = Math.random() * 360) => {
    const n = 96
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2
      const speed = 3 + Math.random() * 4
      sparks.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        decay: 0.012,
        gravity: 0.08,
        size: 3 + Math.random() * 3,
        hue: h + (Math.random() - 0.5) * 40,
        angle: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.3,
      })
    }
    run()
  }
  /** Once in a while a guest is thrown up out of the caret, tumbling. */
  const visit = (at: { x: number; y: number }) => {
    let pick = Math.random() * GUESTS.reduce((sum, g) => sum + g.weight, 0)
    const guest = GUESTS.find((g) => (pick -= g.weight) < 0) ?? GUESTS[0]
    sparks.push({
      x: at.x,
      y: at.y,
      vx: (Math.random() - 0.5) * 8,
      vy: -9 - Math.random() * 5,
      life: 1,
      decay: 0.006,
      gravity: 0.25,
      size: guest.size,
      hue: 0,
      picture: { image: guest.image(), aspect: guest.aspect },
      angle: 0,
      spin: (Math.random() - 0.5) * 0.15,
    })
    run()
  }
  /** Rarer still, Rick pops up in the corner for a few seconds, with his line. */
  const rickroll = () => {
    if (rick()) return
    setRick(true)
    announce({ text: 'Never gonna give you up', hue: hue(), small: true })
    rickTimer = setTimeout(() => setRick(false), RICK_MS)
  }
  const randomFirework = () => firework(innerWidth * (0.15 + Math.random() * 0.7), innerHeight * (0.15 + Math.random() * 0.5))

  const announce = (s: Shout) => {
    setShout(s)
    clearTimeout(shoutTimer)
    shoutTimer = setTimeout(() => setShout(), 1400)
  }

  // A level reached: shouted, with fireworks and a jolt.
  createEffect(
    on(level, (lvl, prev) => {
      if (prev === undefined || lvl <= prev) return
      announce({ text: LEVELS[lvl].shout, hue: hue() })
      for (let i = 0; i <= lvl; i++) {
        const t = setTimeout(() => (pending.delete(t), randomFirework()), i * 150)
        pending.add(t)
      }
      // The guests are fetched once a combo gets going, so none of them turns up blank; Rick's gif especially is big.
      if (lvl === 1) {
        for (const g of GUESTS) g.image()
        picture(RICK)
      }
      jolt = performance.now() + 250
      shakeUntil = jolt
      run()
    }),
  )
  // At the top level the whole app cycles through colours.
  createEffect(() => root.classList.toggle('power-rainbow', level() >= 5))

  const onInput = (e: Event) => {
    const type = (e as InputEvent).inputType ?? ''
    if (!type.startsWith('insert') && !type.startsWith('delete')) return
    // A character still being composed (Japanese, Chinese…) counts once, when it's done: see compositionend below.
    if ((e as InputEvent).isComposing) return
    hit(e.target)
  }

  /** A keystroke: sparks from where it went, the combo up one, and whatever that brings. */
  const hit = (target: EventTarget | null) => {
    const at = caret(target)
    if (at) spray(at)
    batch(() => {
      setCombo((c) => c + 1)
      setBump((b) => b + 1)
    })
    // From the fourth level, fireworks go off as you type.
    if (level() >= 4 && combo() % 8 === 0) randomFirework()
    const roll = Math.random()
    if (level() >= 1 && roll < RICK_CHANCE) rickroll()
    else if (at && level() >= 1 && roll < RICK_CHANCE + GUEST_CHANCE) visit(at)
    shakeUntil = Math.max(shakeUntil, performance.now() + 120)
    clearTimeout(comboTimer)
    comboTimer = setTimeout(() => {
      if (combo() >= LEVELS[1].at) announce({ text: `${combo()} combo`, hue: hue(), small: true })
      setCombo(0)
    }, COMBO_MS)
    run()
  }

  // Capturing, so a field that stops its input events still throws sparks.
  const onComposed = (e: CompositionEvent) => e.data && hit(e.target)
  document.addEventListener('input', onInput, true)
  document.addEventListener('compositionend', onComposed, true)
  addEventListener('resize', size)
  onCleanup(() => {
    document.removeEventListener('input', onInput, true)
    document.removeEventListener('compositionend', onComposed, true)
    removeEventListener('resize', size)
    cancelAnimationFrame(frame)
    frame = 0
    for (const t of pending) clearTimeout(t)
    clearTimeout(comboTimer)
    clearTimeout(shoutTimer)
    clearTimeout(rickTimer)
    root.style.transform = ''
    root.classList.remove('power-rainbow')
  })

  return (
    <>
      {canvas}
      <Show when={rick()}>
        <img
          src={picture(RICK).src}
          alt=""
          class="power-rick pointer-events-none fixed right-8 bottom-8 z-[9999] w-64 rounded-lg shadow-2xl ring-4 ring-white"
          style={{ '--rick-ms': `${RICK_MS}ms` }}
        />
      </Show>
      {/* From the third level the screen's edges pulse in the combo's colour. */}
      <Show when={level() >= 3}>
        <div class="power-pulse pointer-events-none fixed inset-0 z-[9998]" style={{ 'box-shadow': `inset 0 0 ${40 + level() * 20}px hsl(${hue()} 95% 55%)` }} />
      </Show>
      <Show when={shout()} keyed>
        {(s) => (
          <div class="pointer-events-none fixed inset-0 z-[9999] flex items-center justify-center select-none">
            <div
              class={`power-shout text-center font-mono font-black tracking-tight uppercase ${s.small ? 'text-4xl' : 'text-7xl'}`}
              style={{ color: `hsl(${s.hue} 95% 55%)`, 'text-shadow': `0 0 24px hsl(${s.hue} 95% 55% / 0.6)` }}
            >
              {s.text}
            </div>
          </div>
        )}
      </Show>
      <Show when={combo() >= 5}>
        <div class="pointer-events-none fixed top-16 right-8 z-[9999] text-right font-mono text-fg select-none">
          <div class="text-xs tracking-[0.3em] text-fg-3 uppercase">Combo</div>
          {/* Keyed on every keystroke, so the number pops and the time left fills up again each time. */}
          <Show when={bump()} keyed>
            {(_) => (
              <>
                {/* Bigger at each level. */}
                <div class="power-pop font-bold tabular-nums" style={{ color: `hsl(${hue()} 90% 55%)`, 'font-size': `${3 + level() * 0.6}rem`, 'line-height': 1 }}>
                  {combo()}
                </div>
                <div class="mt-2 ml-auto h-1 w-24 overflow-hidden rounded-full bg-fg-3/30">
                  <div class="power-drain h-full rounded-full bg-current" style={{ '--combo-ms': `${COMBO_MS}ms`, color: `hsl(${hue()} 90% 55%)` }} />
                </div>
              </>
            )}
          </Show>
        </div>
      </Show>
    </>
  )
}
