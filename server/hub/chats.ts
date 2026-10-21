import type { WebSocket } from 'ws'
import { SIDE_NOTE, renderMoveNote } from '../../shared/forkNote.ts'
import {
  LOCAL_MACHINE,
  type ChatCommand,
  type ChatCommandReply,
  type ClientEvent,
  type DraftAttachments,
  type ImageAttachment,
  type PermissionMode,
  type ServerEvent,
  type SessionSummary,
} from '../../shared/protocol.ts'
import type { Attention } from '../attention.ts'
import type { ChatInfo } from '../boardTools.ts'
import type { Board } from '../board.ts'
import type { ChatMeta, Draft } from '../chatMeta.ts'
import type { Actor, Database } from '../db.ts'
import { BadRequest, absolutePath, badRequest, message } from '../errors.ts'
import { busyForkPoint, forkTranscript } from '../fork.ts'
import type { Connection, Machines } from '../machines.ts'
import type { ChatPlacement } from '../placement.ts'
import { IDLE, type LiveSnapshot, type TranscriptLines } from '../runnerProtocol.ts'
import { suggestTitle } from '../titles.ts'
import { externalizeImages } from '../transcriptImages.ts'
import { titleOf, transcriptModel, type Transcripts } from '../transcripts.ts'
import { CHAT_ID, type Route } from './http.ts'
import { debounced, type Viewers } from './viewers.ts'

/** How long the chat list waits on a machine to say which folders are gone, or which git roots they're in. */
const GONE_TIMEOUT_MS = 3000
/** How long a machine's answer about a folder being gone is used for, rather than asking again on every list. */
const GONE_TTL_MS = 30 * 1000
/** A running chat's transcript changes the list (its time, now and then its title) at most this often; starting and stopping show at once. */
const LIVE_LIST_MS = 15 * 1000
/**
 * How long opening a chat waits on its machine before showing what the hub
 * has. A laptop gone to sleep can leave its connection half-open, answering
 * nothing until the ping drops it.
 */
const QUICK_TIMEOUT_MS = 10 * 1000
/** How many chats the sidebar lists. */
const LIST_LIMIT = 200

/** Changes made through the REST API and WebSocket, i.e. by someone in the browser. */
const UI: Actor = { source: 'ui' }

/** What a browser asks of one chat. */
export type ChatEvent = Extract<
  ClientEvent,
  { type: 'send' | 'draft' | 'unqueue' | 'interrupt' | 'stop_task' | 'background_task' | 'set_mode' | 'set_model' | 'permission' | 'answer_draft' | 'plan_draft' }
>

export interface ChatDeps {
  db: Database
  board: Board
  meta: ChatMeta
  transcripts: Transcripts
  machines: Machines
  placement: ChatPlacement
  viewers: Viewers
  attention: Attention
  /** Where one-off model calls, like suggesting a title, run. */
  scratchDir: string
  /** Tells every tab to fetch the chat list again, shortly; each fetch asks every machine about its folders. */
  listChanged: () => void
  cardsChanged: () => void
}

/**
 * Chats as browsers see them: the list, what a viewer is shown when it opens
 * one and as it changes, and what they ask of it. Each chat runs on its
 * machine's runner, which has its live process; the hub has its transcript,
 * its draft and its place on the board, so a chat can be read, and its draft
 * kept, while its machine is away.
 */
export class Chats {
  /** Per tab and chat, the number of the last snapshot asked for. */
  private snapshotsAsked = new WeakMap<WebSocket, Map<string, number>>()
  /** Per runner connection, which folders it said were gone, and when. */
  private goneAnswers = new WeakMap<Connection, Map<string, { gone: boolean; at: number }>>()
  /** Per live chat, how many of its turns had ended when the hub last heard. */
  private turnsSeen = new Map<string, number>()
  /**
   * By machine, the git root of each folder it was asked about: what it said, kept while it's offline so
   * its chats' panels still have a home; or the question, while it's out, so a folder is asked once.
   */
  private rootAnswers = new Map<string, Map<string, string | Promise<string | undefined>>>()
  /** By machine, folders it didn't answer for lately, and when: not waited on again for GONE_TTL_MS. */
  private rootMisses = new Map<string, Map<string, number>>()
  /** Chats whose history grew with no live process, whose viewers get it again. */
  private stale = new Set<string>()
  private readonly soonListChanged: () => void
  private readonly liveListChanged: () => void
  private readonly resendStale: () => void

  constructor(private d: ChatDeps) {
    this.soonListChanged = debounced(d.listChanged, 1000)
    this.liveListChanged = debounced(d.listChanged, LIVE_LIST_MS)
    this.resendStale = debounced(() => {
      for (const id of this.stale) for (const ws of d.viewers.of(id)) void this.snapshot(ws, id)
      this.stale.clear()
    }, 500)
  }

  // ── The list ──

  async list(): Promise<SessionSummary[]> {
    const { meta, transcripts, machines, placement } = this.d
    // Children show inside the chat that started them.
    const childIds = meta.childIds()
    const side = meta.sideChats()
    const under = (id: string) => {
      const s = side.get(id)
      return s ? { sideOf: s.parent, forkedAt: s.at } : {}
    }
    const listed = await transcripts.list(LIST_LIMIT, childIds)
    const archived = meta.archivedIds()
    const where = placement.machinesOf(listed.map((s) => s.sessionId))
    const gone = await this.goneFolders(listed.flatMap((s) => (s.cwd && !machines.live(s.sessionId) ? [{ machine: where.get(s.sessionId), cwd: s.cwd }] : [])))
    const summaries: SessionSummary[] = listed.map((s) => {
      const machine = where.get(s.sessionId)
      const live = machines.live(s.sessionId)
      return {
        id: s.sessionId,
        title: titleOf(s) || 'Untitled',
        // A live chat may have moved into a worktree since its transcript was last written.
        cwd: live?.cwd ?? s.cwd,
        machine,
        lastModified: s.lastModified,
        running: !!live?.running,
        archived: archived.has(s.sessionId),
        gone: !live && !!s.cwd && !!gone.get(machine ?? '')?.has(s.cwd),
        ...under(s.sessionId),
      }
    })
    // A brand-new live session may not have a transcript here yet.
    for (const runner of machines.online()) {
      for (const live of runner.live.values()) {
        if (childIds.has(live.id) || summaries.some((s) => s.id === live.id)) continue
        summaries.unshift({
          id: live.id,
          title: 'New chat',
          cwd: live.cwd,
          machine: runner.id,
          lastModified: Date.now(),
          running: live.running,
          archived: false,
          ...under(live.id),
        })
      }
    }
    // Sent with the list so a chat's panels are known before it's opened, not looked up after.
    // A chat with no machine on record is the hub's, as the browser takes it to be.
    const roots = await Promise.all(summaries.map((s) => s.cwd && this.workspaceRoot(s.machine ?? LOCAL_MACHINE, s.cwd)))
    return summaries.map((s, i) => ({ ...s, root: roots[i] || undefined }))
  }

  /** The workspace (git root) of a folder on a machine, if it has said. */
  private async workspaceRoot(machine: string, cwd: string): Promise<string | undefined> {
    let answers = this.rootAnswers.get(machine)
    if (!answers) this.rootAnswers.set(machine, (answers = new Map()))
    let misses = this.rootMisses.get(machine)
    if (!misses) this.rootMisses.set(machine, (misses = new Map()))
    const known = answers.get(cwd)
    if (known !== undefined) return known
    const runner = this.d.machines.get(machine)
    if (!runner || Date.now() - (misses.get(cwd) ?? 0) < GONE_TTL_MS) return undefined
    const asking = runner
      .within(GONE_TIMEOUT_MS)
      .workspaceRoot(cwd)
      .catch(() => undefined)
      .then((root) => {
        if (root) answers.set(cwd, root)
        else (answers.delete(cwd), misses.set(cwd, Date.now()))
        return root
      })
    answers.set(cwd, asking)
    return asking
  }

  /** What the board says about these chats, wherever they run. */
  async info(ids: string[]): Promise<ChatInfo[]> {
    const { transcripts, machines, placement } = this.d
    const where = placement.machinesOf(ids)
    return Promise.all(
      [...new Set(ids)].map(async (id) => {
        const info = await transcripts.info(id)
        const machine = where.get(id)
        return { id, title: titleOf(info), cwd: machines.live(id)?.cwd ?? info?.cwd, machine, machineName: machine && machines.name(machine) }
      }),
    )
  }

  /**
   * Which of these folders are gone, by machine, asking each connected machine
   * once about those it hasn't answered for lately. Offline machines' folders
   * can't be checked, so they aren't.
   */
  private async goneFolders(folders: { machine?: string; cwd: string }[]): Promise<Map<string, Set<string>>> {
    const byMachine = new Map<string, Set<string>>()
    for (const f of folders) if (f.machine) byMachine.set(f.machine, (byMachine.get(f.machine) ?? new Set()).add(f.cwd))
    const out = new Map<string, Set<string>>()
    const now = Date.now()
    await Promise.all(
      [...byMachine].map(async ([machine, dirs]) => {
        const runner = this.d.machines.get(machine)
        if (!runner) return
        let answers = this.goneAnswers.get(runner)
        if (!answers) this.goneAnswers.set(runner, (answers = new Map()))
        for (const [dir, a] of answers) if (now - a.at > GONE_TTL_MS) answers.delete(dir)
        const ask = [...dirs].filter((d) => !answers.has(d))
        if (ask.length) {
          const gone = await runner.within(GONE_TIMEOUT_MS).inaccessible(ask).catch(() => undefined)
          // No answer isn't an answer: asked again next time.
          if (gone) for (const d of ask) answers.set(d, { gone: gone.includes(d), at: now })
        }
        out.set(machine, new Set([...dirs].filter((d) => answers.get(d)?.gone)))
      }),
    )
    return out
  }

  // ── Viewing ──

  async subscribe(ws: WebSocket, sessionId: string): Promise<void> {
    this.d.viewers.watch(ws, sessionId)
    await this.snapshot(ws, sessionId)
    // After the snapshot: it can mean starting a process, which shouldn't hold up the transcript.
    this.sendContext(sessionId, ws)
  }

  /** A machine's runner connected or went: its chats' viewers start again from a snapshot, running, read-only, or back again. */
  machineChanged(machine: string): void {
    for (const sessionId of this.d.viewers.watched()) {
      if (this.d.placement.machineOf(sessionId) !== machine) continue
      for (const ws of this.d.viewers.of(sessionId)) void this.snapshot(ws, sessionId)
    }
  }

  /** Tells one viewer, or all of them, how full the chat's context is. */
  sendContext(sessionId: string, ws?: WebSocket): void {
    this.d.machines
      .runnerFor(sessionId)
      ?.remote.contextUsage(sessionId)
      .then((u) => {
        if (!u) return
        const event: ServerEvent = { type: 'context', sessionId, usage: u }
        if (ws) this.d.viewers.send(ws, event)
        else this.d.viewers.publish(event)
      })
      .catch((err) => console.error(`Reading context usage for ${sessionId} failed:`, message(err)))
  }

  /**
   * Sends a viewer the chat's history and, if it's live, its process's state.
   * The history comes from the hub's copy of the transcript; the process adds
   * its own turns, which may be newer. The live part is taken last and sent the
   * moment it arrives, so the chat's events after it reach the viewer after it.
   * Only the newest snapshot asked for is sent: an older one can finish later,
   * e.g. failing on a connection its runner has just replaced.
   */
  private async snapshot(ws: WebSocket, sessionId: string): Promise<void> {
    const { meta, transcripts, machines, placement, viewers } = this.d
    let asked = this.snapshotsAsked.get(ws)
    if (!asked) this.snapshotsAsked.set(ws, (asked = new Map()))
    const n = (asked.get(sessionId) ?? 0) + 1
    asked.set(sessionId, n)
    const { text: draft, attachments: draftAttachments } = meta.draft(sessionId)
    const children = meta.children(sessionId)
    const machine = placement.machineOf(sessionId)
    const [history, info] = machine ? await Promise.all([transcripts.transcript(sessionId), transcripts.info(sessionId)]) : [[], undefined]
    const runner = machine ? machines.get(machine) : undefined
    const base = { type: 'snapshot' as const, sessionId, machine, draft, draftAttachments, children }
    const done = (live: LiveSnapshot | null, gone: boolean) => {
      if (asked.get(sessionId) !== n) return
      if (!live) {
        return viewers.send(ws, { ...IDLE, ...base, messages: externalizeImages(sessionId, history), model: transcriptModel(history), cwd: info?.cwd, gone })
      }
      // History holds earlier processes' turns; the live list holds this process's, in order.
      const seen = new Set(live.messages.map((m) => m.uuid))
      const messages = [...history.filter((m) => !seen.has(m.uuid) && !seen.has(m.after_uuid as string)), ...live.messages]
      // The runner's answer goes first, so it can't say which chat this is.
      // The process's newest messages may not have been copied here yet, and their images can't be served until they are.
      viewers.send(ws, { ...live, ...base, messages: externalizeImages(sessionId, messages, (uuid) => transcripts.hasImageEntry(sessionId, uuid)) })
    }
    if (!runner) return done(null, false)
    const gone = info?.cwd ? (await runner.within(QUICK_TIMEOUT_MS).inaccessible([info.cwd]).catch(() => [])).length > 0 : false
    // A runner slow to answer doesn't hold up the history; its answer, when it comes, puts the live part right.
    let shown = false
    const slow = setTimeout(() => ((shown = true), done(null, gone)), QUICK_TIMEOUT_MS)
    runner.liveSnapshot(sessionId, (err, live) => {
      clearTimeout(slow)
      if (!err) done(live ?? null, gone)
      else if (!shown) done(null, gone)
    })
  }

  // ── What browsers ask of a chat ──

  async handle(ws: WebSocket, event: ChatEvent): Promise<void> {
    const { meta, viewers } = this.d
    const remote = this.d.machines.runnerFor(event.sessionId)?.remote
    // On the chat's machine. One that's on none has no process to ask.
    const command = <C extends ChatCommand>(sessionId: string, c: C) => remote?.command(sessionId, c) as Promise<ChatCommandReply<C['type']>> | undefined
    switch (event.type) {
      case 'send':
        return this.send(ws, event)
      case 'draft':
        return this.saveDraft(event.sessionId, { text: event.text, attachments: event.attachments }, ws)
      case 'unqueue': {
        const message = await command(event.sessionId, { type: 'unqueue', id: event.id })
        if (!message || !event.edit) return
        // Back into the composer, ahead of anything typed since, in every tab.
        const saved = meta.draft(event.sessionId)
        return this.restoreDraft(event.sessionId, {
          text: [message.text, saved.text].filter(Boolean).join('\n\n'),
          attachments: { pastes: [...message.pastes, ...saved.attachments.pastes], images: [...message.images, ...saved.attachments.images] },
        })
      }
      case 'interrupt':
        // Stopping a chat stops whatever it's waiting on too. Children run on their parent's machine.
        await Promise.all([event.sessionId, ...Object.values(meta.children(event.sessionId))].map((id) => command(id, { type: 'interrupt' })))
        return
      // Drafts of an answer are shown to the chat's other viewers; the one answering already has them.
      case 'answer_draft':
      case 'plan_draft': {
        const { sessionId, ...c } = event
        if (await command(sessionId, c)) viewers.toChat(sessionId, event, { except: ws })
        return
      }
      default: {
        const { sessionId, ...c } = event
        return command(sessionId, c)
      }
    }
  }

  private async send(ws: WebSocket, event: Extract<ChatEvent, { type: 'send' }>): Promise<void> {
    const { meta, machines, placement, attention } = this.d
    const { sessionId, text, pastes = [], images = [] } = event
    // A chat stays where it started; a new one goes where it was asked to.
    const placed = placement.machineOf(sessionId)
    const machine = placed ?? (event.machine || LOCAL_MACHINE)
    const runner = machines.require(machine)
    // Picking an archived chat back up brings it back to the sidebar.
    meta.setArchived(sessionId, false, UI)
    attention.mark(sessionId, false)
    // Sending empties the composer in every tab, not just the one that sent.
    this.saveDraft(sessionId, { text: '', attachments: { pastes: [], images: [] } }, ws)
    placement.assign(sessionId, machine)
    // A chat that's run before resumes where it was, except a fork going into a new worktree.
    const fork = placed ? meta.forkStart(sessionId) : undefined
    const where = placed ? { cwd: fork?.cwd, worktree: fork?.worktree } : { cwd: event.cwd, worktree: event.worktree }
    try {
      await runner.remote.send(sessionId, { ...where, mode: event.mode, model: event.model }, text, pastes, images)
      if (fork) meta.forkStarted(sessionId)
    } catch (err) {
      // Turned away, so it never started: it can go elsewhere. Anything else, e.g. the connection dropping, it may have.
      if (!placed && err instanceof BadRequest) placement.unassign(sessionId, machine)
      // The message goes back in the composer, unless something's been typed since.
      if (!meta.draft(sessionId).text) this.restoreDraft(sessionId, { text, attachments: { pastes, images } })
      throw err
    }
  }

  /** Stores parts of a chat's draft and shows them to the chat's other viewers; `from`, the one editing it, already has them. */
  private saveDraft(sessionId: string, change: Partial<Draft>, from: WebSocket): void {
    const saved = this.d.meta.draft(sessionId)
    const same = (change.text === undefined || change.text === saved.text) && (!change.attachments || (!hasAttachments(change.attachments) && !hasAttachments(saved.attachments)))
    if (same) return
    this.d.meta.setDraft(sessionId, change)
    this.d.viewers.toChat(sessionId, { type: 'draft', sessionId, ...change }, { except: from })
  }

  /** Puts something back in a chat's composer, in every tab. */
  private restoreDraft(sessionId: string, draft: Draft): void {
    this.d.meta.setDraft(sessionId, draft)
    this.d.viewers.toChat(sessionId, { type: 'draft', sessionId, ...draft })
  }

  /**
   * Copies a chat as a new one, up to the end of the turn `at` (or all of it),
   * on the same card. It can go to another folder or runner, or into a new
   * worktree made when it first runs; then Claude is told it moved, with its
   * first message. Files stay where they are. The copy is made here, so the
   * chat's own machine needn't be online, and written on the one it goes to.
   */
  async fork(id: string, body: { at?: unknown; machine?: unknown; cwd?: unknown; worktree?: unknown; draft?: unknown }): Promise<{ sessionId: string }> {
    if (body.at !== undefined && typeof body.at !== 'string') throw new BadRequest('at must be a message id')
    if (body.draft !== undefined && typeof body.draft !== 'string') throw new BadRequest('draft must be a string')
    if (body.worktree !== undefined && typeof body.worktree !== 'string') throw new BadRequest('worktree must be a string')
    return { sessionId: await this.copy(id, { at: body.at, machine: body.machine, cwd: body.cwd, worktree: body.worktree, draft: body.draft }) }
  }

  /**
   * Starts a side chat (/btw): a fork of the chat in its own folder, on its
   * own machine, kept under it rather than on its card or in the sidebar.
   * What Claude was sent stays the same, so the side chat's first turn reads
   * the chat's cached prompt rather than paying for it again. A chat that's
   * mid-turn is forked where its last request ended. With `text`, that's sent
   * straight away, in the mode and model asked for: the parent's.
   */
  async btw(id: string, body: { text?: unknown; pastes?: unknown; images?: unknown; mode?: unknown; model?: unknown }): Promise<{ sessionId: string }> {
    const { meta, transcripts, machines, placement } = this.d
    if (body.text !== undefined && typeof body.text !== 'string') throw new BadRequest('text must be a string')
    if (meta.sideChats().has(id)) throw new BadRequest("A side chat can't have side chats of its own")
    const at = machines.live(id)?.running ? busyForkPoint((await transcripts.store.load({ projectKey: '', sessionId: id })) ?? []) : undefined
    const text = body.text?.trim()
    // Named for what it asks, so its parent's side chats can be told apart.
    const title = text ? (text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text).replace(/\s+/g, ' ') : 'Side chat'
    const sessionId = await this.copy(id, { at, side: true, title })
    if (text) {
      const pastes = Array.isArray(body.pastes) ? (body.pastes as string[]) : []
      const images = Array.isArray(body.images) ? (body.images as ImageAttachment[]) : []
      const opts = { mode: body.mode as PermissionMode | undefined, model: body.model as string | undefined }
      await machines.require(placement.machineOf(sessionId)!).remote.send(sessionId, opts, text, pastes, images)
    }
    return { sessionId }
  }

  /** Copies a chat as a new one: see fork and btw. */
  private async copy(
    id: string,
    o: { at?: string; machine?: unknown; cwd?: unknown; worktree?: string; draft?: string; side?: boolean; title?: string },
  ): Promise<string> {
    const { db, board, meta, transcripts, machines, placement } = this.d
    const info = await transcripts.info(id)
    const fromMachine = placement.machineOf(id)
    const fromCwd = machines.live(id)?.cwd ?? info?.cwd
    if (!info || !fromMachine || !fromCwd) throw new BadRequest("This chat hasn't been saved yet, so it can't be forked")
    const to = machines.fromRequest(o.machine ?? fromMachine)
    const cwd = o.cwd === undefined ? fromCwd : absolutePath(o.cwd)
    const worktree = o.worktree
    const moved = to.id !== fromMachine || cwd !== fromCwd || worktree !== undefined
    const title = o.title ?? `${(titleOf(info) || 'Untitled').replace(/ \(fork\)$/, '')} (fork)`
    const fork = await forkTranscript(transcripts.store, transcripts.subagentFiles(id), id, { at: o.at, title, cwd: moved ? cwd : undefined }).catch((err) => {
      // The turn's last messages may not have been copied here yet.
      throw new BadRequest(`Couldn't fork it: ${message(err)}`)
    })
    const note = moved
      ? renderMoveNote({ from: { machine: machines.name(fromMachine), cwd: fromCwd }, to: { machine: to.name, cwd, worktree: worktree !== undefined || undefined } })
      : o.side
        ? SIDE_NOTE
        : undefined
    // A side chat is found through its parent, so it isn't put on the card.
    const card = o.side ? undefined : board.cardOf(id)
    db.transaction(() => {
      placement.assign(fork.sessionId, to.id)
      meta.addFork({ sessionId: fork.sessionId, sourceId: id, cwd, worktree, note })
      if (o.side) meta.addSideChat(fork.sessionId, id)
      // e.g. the message to edit and send again.
      if (o.draft) meta.setDraft(fork.sessionId, { text: o.draft })
    })
    try {
      for (const file of fork.files) await to.remote.importTranscript(fork.sessionId, cwd, file)
    } catch (err) {
      db.transaction(() => {
        placement.unassign(fork.sessionId, to.id)
        meta.removeFork(fork.sessionId)
        meta.removeSideChat(fork.sessionId)
      })
      throw err
    }
    if (card) {
      board.linkSession(card.id, fork.sessionId, UI)
      this.d.cardsChanged()
    }
    this.d.listChanged()
    return fork.sessionId
  }

  /** The list, and archive, title, fork and side chat routes. Archiving only hides a chat; its transcript is left alone. */
  routes(): Route[] {
    const { board, meta, transcripts, machines, placement } = this.d
    const path = (action: string) => new RegExp(`^/api/sessions/${CHAT_ID}/${action}$`)
    return [
      ['GET', '/api/sessions', async () => [200, await this.list()]],
      ['POST', path('fork'), async ({ params: [id], json }) => [201, await this.fork(id, await json())]],
      ['POST', path('btw'), async ({ params: [id], json }) => [201, await this.btw(id, await json())]],
      ['POST', path('archive'), ({ params: [id] }) => (meta.setArchived(id, true, UI), [204, null])],
      ['DELETE', path('archive'), ({ params: [id] }) => (meta.setArchived(id, false, UI), [204, null])],
      // The title goes in the transcript, on the chat's machine, where the CLI's /resume sees it too. It comes back with the transcript.
      [
        'PUT',
        path('title'),
        async ({ params: [id], json }) => {
          const { title } = await json()
          if (typeof title !== 'string' || !title.trim()) throw new BadRequest('title is required')
          const machine = placement.machineOf(id)
          if (!machine) return [404, { error: 'No such chat' }]
          await machines.require(machine).remote.rename(id, title.trim())
          return [204, null]
        },
      ],
      [
        'POST',
        path('title/suggest'),
        async ({ params: [id] }) => {
          const info = await transcripts.info(id)
          if (!info) return [404, { error: 'No such chat' }]
          return [200, { title: await suggestTitle(id, titleOf(info) || '', board.cardOf(id), this.d.scratchDir, transcripts.store).catch(badRequest) }]
        },
      ],
    ]
  }

  // ── What runners tell the hub ──

  /** A turn ended. */
  turnEnded(sessionId: string, turns: number, queued: boolean): void {
    this.turnsSeen.set(sessionId, turns)
    this.d.attention.turnEnded(sessionId, queued)
    this.sendContext(sessionId)
  }

  /** A chat's runner says this many of its turns have ended; any the hub missed, e.g. with the runner offline, mark it unread. */
  turnsEnded(sessionId: string, turns: number): void {
    const seen = this.turnsSeen.get(sessionId)
    this.turnsSeen.set(sessionId, turns)
    // Unknown since the hub started; fewer since the runner restarted. Either way there's nothing to compare.
    if (seen !== undefined && turns > seen) this.d.attention.turnEnded(sessionId, false)
  }

  /** A runner's transcript lines, already checked to be for one of its own chats. */
  takeLines(batch: TranscriptLines) {
    // Chats sort by this, so one from the future would sit at the top of the sidebar for good.
    batch.mtime = Math.min(batch.mtime, Date.now())
    const result = this.d.db.transaction(() => this.d.transcripts.append(batch))
    if (result.bytes === batch.bytes && (batch.lines.length || batch.reset)) {
      this.transcriptChanged(batch.sessionId, !!batch.more, !batch.subpath && batch.fromLine === 0)
      if (!batch.subpath) this.sendLiveContext(batch)
    }
    return result
  }

  /** Context in a live chat's new lines that its process doesn't send, e.g. CLAUDE.md files loaded; history has it for everyone else. */
  private sendLiveContext(batch: TranscriptLines): void {
    if (!this.d.machines.live(batch.sessionId) || !this.d.viewers.of(batch.sessionId).length) return
    const lines = batch.lines.filter((l) => l.includes('"attachment"') || l.includes('"isMeta":true'))
    if (!lines.length) return
    const uuids = new Set(
      lines.flatMap((l) => {
        try {
          const uuid = (JSON.parse(l) as { uuid?: unknown }).uuid
          return typeof uuid === 'string' ? [uuid] : []
        } catch {
          return []
        }
      }),
    )
    for (const message of this.d.transcripts.liveContext(batch.sessionId, uuids)) this.d.viewers.publish({ type: 'message', sessionId: batch.sessionId, message })
  }

  /**
   * A chat's transcript grew on the hub. The list may have a new title or time.
   * Viewers of a chat with no live process are watching history arrive, e.g.
   * after its machine reconnects, so they get it again; a live chat's viewers
   * already have it from the process.
   */
  private transcriptChanged(sessionId: string, more: boolean, fresh: boolean): void {
    // Its first lines give a new chat its title, though.
    if (this.d.machines.live(sessionId)) return fresh ? this.soonListChanged() : this.liveListChanged()
    this.soonListChanged()
    // Mid-way through a long transcript: they get it all once the rest is here.
    if (more || !this.d.viewers.of(sessionId).length) return
    this.stale.add(sessionId)
    this.resendStale()
  }
}

const hasAttachments = (a: DraftAttachments) => a.pastes.length > 0 || a.images.length > 0
