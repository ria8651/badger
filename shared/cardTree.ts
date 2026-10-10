import type { Card } from './protocol.ts'

/** The cards above this one, outermost first. */
export function ancestors<C extends Pick<Card, 'id' | 'parentId'>>(cards: C[], id: number): C[] {
  const byId = new Map(cards.map((c) => [c.id, c]))
  const path: C[] = []
  // The seen set guards against a cycle, which the store refuses to write but an old database could hold.
  const seen = new Set([id])
  for (let c = byId.get(byId.get(id)?.parentId ?? -1); c && !seen.has(c.id); c = byId.get(c.parentId ?? -1)) {
    seen.add(c.id)
    path.unshift(c)
  }
  return path
}

/** Every card below this one, at any depth. */
export function descendants<C extends Pick<Card, 'id' | 'parentId'>>(cards: C[], id: number): C[] {
  const found: C[] = []
  const seen = new Set([id])
  for (let i = -1; i < found.length; i++) {
    const parent = i < 0 ? id : found[i].id
    for (const c of cards) if (c.parentId === parent && !seen.has(c.id)) seen.add(c.id), found.push(c)
  }
  return found
}

/** The project a card belongs to: its top-level ancestor, or itself if it's top-level. Top-level cards are projects. */
export function projectOf<C extends Pick<Card, 'id' | 'parentId'>>(cards: C[], id: number): C | undefined {
  return ancestors(cards, id)[0] ?? cards.find((c) => c.id === id)
}
