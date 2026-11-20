import { createEffect, createMemo, on } from 'solid-js'
import { createStore } from 'solid-js/store'
import { api } from './api.ts'
import { listVersion, remember, sessions } from './stores/sessions.ts'

/** How many archived chats are fetched at a time. */
const PAGE = 50

/**
 * Archived chats as the sidebar lists them, newest first: in a project, or on no card, and matching a search, if asked.
 * They're the server's to find and count, so only what's been scrolled to is fetched: a page once they're showing, and
 * the next each time `loadMore` is called. Each time the list changes they're fetched again from the top, as far as
 * they'd got, so the count stays right and ones archived since show up.
 */
export function createArchivedList(params: () => { project?: number | 'none'; query?: string; showing: boolean }) {
  /** `growing`: what's on its way adds rows, rather than checking the ones there are still right. */
  const [state, setState] = createStore<{ ids: string[]; total: number; next?: string; loading: boolean; growing: boolean }>({
    ids: [],
    total: 0,
    loading: false,
    growing: false,
  })
  /** Each fetch's number: an answer to one that's been overtaken is dropped. */
  let latest = 0
  /** How many are wanted: those listed, and a page more while one's on its way, which a fetch that overtakes it gets too. */
  let wanted = 0

  const fetch = (limit: number, growing: boolean, after?: string) => {
    const { project, query } = params()
    const n = ++latest
    setState({ loading: true, growing })
    return api
      .archivedSessions({ project, q: query, limit, after })
      .then((page) => {
        if (n !== latest) return
        remember(page.sessions)
        const ids = page.sessions.map((s) => s.id)
        setState({ ids: after ? [...state.ids, ...ids] : ids, total: page.total, next: page.next, loading: false, growing: false })
        wanted = state.ids.length
      })
      .catch(() => n === latest && setState({ loading: false, growing: false }))
  }

  const key = () => JSON.stringify([params().project, params().query])
  // A different project or search starts again; otherwise it's fetched again as far as it had got, or a page once showing.
  createEffect(
    on([key, () => params().showing, listVersion], ([k, showing, version], before) => {
      // Not before the list is in: it brings the first.
      if (!version) return
      const fresh = !before || before[0] !== k
      if (fresh) {
        setState({ ids: [], next: undefined, total: 0 })
        wanted = 0
      }
      // It adds rows if it's the first page showing, or there's a page more wanted; otherwise it only checks them.
      const growing = showing && (fresh || !before?.[1] || wanted > state.ids.length)
      void fetch(Math.max(wanted, showing ? PAGE : 0), growing)
    }),
  )

  const byId = createMemo(() => new Map(sessions().map((s) => [s.id, s])))
  return {
    /** The ones fetched so far, less any brought back since. */
    sessions: createMemo(() => state.ids.flatMap((id) => byId().get(id) ?? []).filter((s) => s.archived)),
    /** How many there are in all. */
    total: () => state.total,
    /** A page is on its way. */
    loading: () => state.loading,
    /** A page that adds rows is on its way: the first, or the next. */
    growing: () => state.loading && state.growing,
    /** Fetches the next page, if there is one and nothing's on its way. */
    loadMore: () => {
      if (!state.next || state.loading) return
      wanted = state.ids.length + PAGE
      void fetch(PAGE, true, state.next)
    },
  }
}
