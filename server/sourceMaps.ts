import { readFileSync, readdirSync } from 'node:fs'
import { SourceMap } from 'node:module'
import { join } from 'node:path'

/** A frame's place in a bundle: its URL's file under /assets/, then line and column. */
const FRAME = /\bhttps?:\/\/[^\s()@]+\/assets\/([\w.-]+\.js):(\d+):(\d+)/g
/** Maps kept parsed. The biggest is megabytes and takes a tenth of a second to parse, and errors come from few. */
const KEEP = 4

/**
 * Turns a page's minified stack back into source files and lines, with the
 * maps the build leaves beside its bundles (hidden: the page doesn't link to
 * them). Bundles are named by their contents, so a page from another build
 * finds none of its files here and its stack is left as it was.
 */
export class SourceMaps {
  /** The bundles this build has maps for. Only those are read, so a page can't make the hub look for others. */
  private files: Set<string>
  /** The most recently used last. */
  private maps = new Map<string, SourceMap | null>()

  constructor(private dist: string) {
    try {
      this.files = new Set(readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js.map')).map((f) => f.slice(0, -'.map'.length)))
    } catch {
      this.files = new Set()
    }
  }

  /** The stack with every frame this build has a map for in source terms, or undefined if none were. */
  map(stack: string): string | undefined {
    let mapped = false
    const out = stack.replace(FRAME, (frame, file: string, line: string, column: string) => {
      const entry = this.load(file)?.findEntry(Number(line) - 1, Number(column) - 1)
      // Past the end of the file, the last mapping is found, which isn't where it was.
      if (!entry || !('originalSource' in entry) || entry.generatedLine !== Number(line) - 1) return frame
      mapped = true
      return `${entry.originalSource.replace(/^(\.\.\/)+/, '')}:${entry.originalLine + 1}:${entry.originalColumn + 1}`
    })
    return mapped ? out : undefined
  }

  private load(file: string): SourceMap | null {
    if (!this.files.has(file)) return null
    let map = this.maps.get(file)
    this.maps.delete(file)
    if (map === undefined) {
      try {
        map = new SourceMap(JSON.parse(readFileSync(join(this.dist, 'assets', `${file}.map`), 'utf8')))
      } catch {
        map = null
      }
    }
    this.maps.set(file, map)
    if (this.maps.size > KEEP) this.maps.delete(this.maps.keys().next().value!)
    return map
  }
}
