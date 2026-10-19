import { createEffect, createMemo, createRoot, createSignal, untrack } from 'solid-js'
import type { SessionSummary } from '../shared/protocol.ts'
import { isScratch, scratchDir } from './folders.ts'
import { LOCAL, machineOf, machines } from './machines.ts'
import { linkSession } from './stores/cards.ts'
import { config } from './stores/config.ts'
import { sessions, sessionsLoaded } from './stores/sessions.ts'

/**
 * Blank chats: ones with an id but no first message yet, so the server doesn't know them. Home is one; each card
 * can have one too, kept until its first message so leaving it doesn't lose what's typed there. Where each will
 * run (runner, folder, whether in a new worktree) is picked here, and kept in this browser until it starts.
 */

const HOME_KEY = 'badger.homeId'
const BLANKS_KEY = 'badger.blankChats'
const DRAFTS_KEY = 'badger.draftCwds'
const MACHINES_KEY = 'badger.draftMachines'
const LAST_MACHINE_KEY = 'badger.lastMachine'
const WORKTREES_KEY = 'badger.draftWorktrees'

/** A JSON record from localStorage, or an empty one. */
function loadRecord<T>(key: string): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}')
  } catch {
    return {} as T
  }
}

/** crypto.randomUUID needs a secure context; fall back for plain-http hosts. */
function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const TEMP = /^\/(private\/)?(tmp|var\/folders)\//

/** The folder each blank chat will start in. */
const [cwds, setCwds] = createSignal<Record<string, string>>(loadRecord(DRAFTS_KEY))
/** The runner each blank chat will run on, picked along with its folder. */
const [runners, setRunners] = createSignal<Record<string, string>>(loadRecord(MACHINES_KEY))
/** The runner this browser last picked for a chat, which new ones default to while it's online. */
const [lastMachine, setLastMachine] = createSignal(localStorage.getItem(LAST_MACHINE_KEY) ?? undefined)
/** Blank chats that should start with "In a worktree" ticked, e.g. a card whose work is already in one. */
const [worktrees, setWorktrees] = createSignal<Record<string, boolean>>(loadRecord(WORKTREES_KEY))
/** Each card's blank chat. */
const [blanks, setBlanks] = createSignal<Record<number, string>>(loadRecord(BLANKS_KEY))
// Home gets a real URL once its first message is sent. Its id is kept until then so a draft typed there survives reloads.
const [homeId, setHomeId] = createSignal(localStorage.getItem(HOME_KEY) ?? uuid())
/** The blank chat home shows. */
export { homeId }

/** The most recent chat a new one could start where it ran: temp dirs and ones that are gone (removed worktrees) don't count. */
const latestChat = (machine?: string) =>
  sessions()
    .filter((s) => s.cwd && !s.gone && (isScratch(s.cwd) || !TEMP.test(s.cwd)) && (!machine || (s.machine || LOCAL) === machine))
    .reduce<SessionSummary | undefined>((a, s) => (!a || s.lastModified > a.lastModified ? s : a), undefined)

const { defaultMachine, defaultCwd } = createRoot(() => {
  /** New chats run on the runner this browser last picked while it's online, else where the most recently active chat ran if that's online. */
  const defaultMachine = createMemo(() => {
    const online = (m?: string) => !!m && !!machineOf(m)?.online
    const picked = lastMachine()
    const latest = latestChat()?.machine
    return online(picked) ? picked! : online(latest) ? latest! : LOCAL
  })
  /** And start where that runner's most recently active chat ran, or with no folder there. */
  const defaultCwd = createMemo(() => {
    const m = defaultMachine()
    return latestChat(m)?.cwd ?? scratchDir(m) ?? (m === LOCAL ? config()?.defaultCwd : machineOf(m)?.workspaceDir)
  })

  createEffect(() => lastMachine() && localStorage.setItem(LAST_MACHINE_KEY, lastMachine()!))
  createEffect(() => localStorage.setItem(HOME_KEY, homeId()))
  // Only blank chats' runner, folder and worktree picks are kept; once a chat starts, the server has them.
  createEffect(() => {
    const blank = new Set([homeId(), ...Object.values(blanks())])
    const keep = <T>(all: Record<string, T>) => Object.fromEntries(Object.entries(all).filter(([id]) => blank.has(id)))
    localStorage.setItem(BLANKS_KEY, JSON.stringify(blanks()))
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(keep(cwds())))
    localStorage.setItem(MACHINES_KEY, JSON.stringify(keep(runners())))
    localStorage.setItem(WORKTREES_KEY, JSON.stringify(keep(worktrees())))
  })

  // Home's defaults are pinned, so activity elsewhere doesn't move the folder while you type.
  createEffect(() => {
    const id = homeId()
    // Not until the runners are known, so the one last picked isn't passed over for seeming offline; and a runner
    // that's only just connected may not have said where its folders are yet.
    if (!sessionsLoaded() || !machines().length || untrack(cwds)[id]) return
    const cwd = defaultCwd()
    if (!cwd) return
    setCwds((d) => ({ ...d, [id]: cwd }))
    setRunners((d) => ({ ...d, [id]: untrack(defaultMachine) }))
  })

  // Blank chats that have started, here or in another tab, make way for fresh ones.
  createEffect(() => {
    const started = new Set(sessions().map((s) => s.id))
    if (started.has(untrack(homeId))) setHomeId(uuid())
    const left = Object.entries(untrack(blanks)).filter(([, id]) => !started.has(id))
    if (left.length < Object.keys(untrack(blanks)).length) setBlanks(Object.fromEntries(left))
  })

  return { defaultMachine, defaultCwd }
})

/** Where a blank chat will run, as picked so far. A folder picked without a runner was picked before there were any but the hub's. */
export const draftFor = (id: string) => ({
  cwd: cwds()[id] ?? defaultCwd(),
  machine: runners()[id] ?? (cwds()[id] ? LOCAL : defaultMachine()),
  worktree: worktrees()[id],
})

const pin = (id: string, cwd: string | undefined, machine: string) => {
  if (cwd) setCwds((d) => ({ ...d, [id]: cwd }))
  setRunners((d) => ({ ...d, [id]: machine }))
}

/** The user picked where a blank chat runs. The runner is remembered for the next new chat too. */
export function pick(id: string, cwd: string, machine: string) {
  pin(id, cwd, machine)
  setLastMachine(machine)
}

export const pickWorktree = (id: string, on: boolean) => setWorktrees((w) => ({ ...w, [id]: on }))

/**
 * A blank chat to start, from somewhere if given, else from the defaults; returns its id. A card's is the blank one
 * it has if it has one, so a draft left there is still there; otherwise the new one goes on the card.
 */
export function newBlank(from: { cwd: string; machine: string; worktree: boolean } | undefined, cardId?: number): string {
  const kept = cardId === undefined ? undefined : untrack(blanks)[cardId]
  if (kept) return kept
  const id = uuid()
  untrack(() => pin(id, from?.cwd ?? defaultCwd(), from?.machine ?? defaultMachine()))
  if (from?.worktree) pickWorktree(id, true)
  if (cardId !== undefined) {
    setBlanks((b) => ({ ...b, [cardId]: id }))
    void linkSession(cardId, id)
  }
  return id
}

/**
 * The home chat's first message went out: it keeps where it was going to run, and home gets a fresh blank chat.
 * Called once the page is on the chat's own URL, so it isn't remounted as home moves on.
 */
export function promoteHome(id: string) {
  const { cwd, machine } = draftFor(id)
  pin(id, cwd, machine)
  setHomeId(uuid())
}
