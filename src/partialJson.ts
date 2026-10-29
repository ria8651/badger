/**
 * JSON that's still arriving, e.g. a tool call's input as Claude writes it, read
 * as far as it goes: a string cut off part way is kept as far as it got, and a
 * key with no value yet, or a number or literal that may not be finished, is
 * left out. Undefined when there's nothing to read yet, or it isn't JSON.
 */
export function parsePartialJson(text: string): unknown {
  let i = 0
  /** The text ran out: whatever is being read stops where it is. */
  const done = () => i >= text.length
  const MISSING = Symbol()

  const space = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++
  }

  /** A string, from its opening quote; cut off, as far as it got, without a dangling escape. */
  const string = (): string => {
    let out = ''
    i++
    while (i < text.length) {
      const c = text[i]
      if (c === '"') {
        i++
        return out
      }
      if (c !== '\\') {
        // Plain runs in one go: Edit and Write inputs are long.
        const next = text.slice(i).search(/["\\]/)
        const run = next < 0 ? text.slice(i) : text.slice(i, i + next)
        out += run
        i += run.length
        continue
      }
      const e = text[i + 1]
      if (e === undefined) break
      if (e === 'u') {
        const hex = text.slice(i + 2, i + 6)
        if (hex.length < 4) break
        out += String.fromCharCode(parseInt(hex, 16))
        i += 6
        continue
      }
      out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[e] ?? e
      i += 2
    }
    i = text.length
    return out
  }

  /** A value, or MISSING when the text runs out before any of it can be read. */
  const value = (): unknown => {
    space()
    const c = text[i]
    if (c === undefined) return MISSING
    if (c === '"') return string()
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']'
      const out: Record<string, unknown> | unknown[] = c === '{' ? {} : []
      i++
      for (;;) {
        space()
        if (done()) return out
        if (text[i] === close) {
          i++
          return out
        }
        if (text[i] === ',') {
          i++
          continue
        }
        if (Array.isArray(out)) {
          const v = value()
          if (v !== MISSING) out.push(v)
          continue
        }
        if (text[i] !== '"') throw new SyntaxError()
        const key = string()
        space()
        if (done()) return out
        if (text[i] !== ':') throw new SyntaxError()
        i++
        const v = value()
        if (v !== MISSING) out[key] = v
      }
    }
    // A number or literal is only whole once something follows it.
    const m = text.slice(i).match(/^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)(?=[\s,\]}])/)
    if (m) {
      i += m[0].length
      return JSON.parse(m[0])
    }
    if (/^[-+.\deEtrufalsn]*$/.test(text.slice(i))) {
      i = text.length
      return MISSING
    }
    throw new SyntaxError()
  }

  try {
    const v = value()
    return v === MISSING ? undefined : v
  } catch {
    return undefined
  }
}
