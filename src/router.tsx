import { createSignal, splitProps, type JSX } from 'solid-js'

/** Where the page is. Each has its own URL, so it can be reloaded, linked and opened in another tab. */
export type Route =
  | { kind: 'home' }
  | { kind: 'chat'; id: string }
  | { kind: 'board' }
  | { kind: 'radar' }
  | { kind: 'card'; id: number }
  | { kind: 'terminal'; id: string }

function parse(path: string): Route {
  const chat = path.match(/^\/s\/([0-9a-f-]{36})/)
  if (chat) return { kind: 'chat', id: chat[1] }
  const card = path.match(/^\/c\/(\d+)/)
  if (card) return { kind: 'card', id: Number(card[1]) }
  // `<machine>.<hex id>`; bare hex from before there were other machines.
  const terminal = path.match(/^\/t\/((?:[a-z0-9-]+\.)?[0-9a-f]+)/)
  // Links from before there were other machines are to the hub's own.
  if (terminal) return { kind: 'terminal', id: terminal[1].includes('.') ? terminal[1] : `local.${terminal[1]}` }
  if (path === '/board') return { kind: 'board' }
  if (path === '/radar') return { kind: 'radar' }
  return { kind: 'home' }
}

export function pathFor(r: Route): string {
  switch (r.kind) {
    case 'chat':
      return `/s/${r.id}`
    case 'card':
      return `/c/${r.id}`
    case 'terminal':
      return `/t/${r.id}`
    case 'board':
      return '/board'
    case 'radar':
      return '/radar'
    case 'home':
      return '/'
  }
}

const [route, setRoute] = createSignal<Route>(parse(location.pathname))
addEventListener('popstate', () => setRoute(parse(location.pathname)))

/** The page's route, as a signal. */
export { route }

/** Goes somewhere, as a new history entry, without reloading. */
export function navigate(r: Route) {
  history.pushState(null, '', pathFor(r))
  setRoute(r)
}

/** Says the page is somewhere else now, in place of where it was, e.g. a new chat getting its own URL. */
export function replace(r: Route) {
  history.replaceState(null, '', pathFor(r))
  setRoute(r)
}

/**
 * A click on a link to a route, to navigate in place. One with a modifier, or not with the main button, goes by the
 * link's href instead, into a new tab or window; says whether it was handled.
 */
export function followLink(e: MouseEvent, to: Route): boolean {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return false
  e.preventDefault()
  navigate(to)
  return true
}

/** A link to a route: navigates in place, or with a modifier opens a new tab or window like any link. */
export function Link(props: Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'> & { to: Route }) {
  const [local, rest] = splitProps(props, ['to'])
  return <a {...rest} href={pathFor(local.to)} onClick={(e) => followLink(e, local.to)} />
}
