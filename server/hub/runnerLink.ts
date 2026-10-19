import { randomUUID } from 'node:crypto'
import { splitMoveNote } from '../../shared/forkNote.ts'
import { LOCAL_MACHINE, type ServerEvent } from '../../shared/protocol.ts'
import type { Attention } from '../attention.ts'
import { cardContext, contextSeen } from '../boardTools.ts'
import type { Board } from '../board.ts'
import type { ChatMeta } from '../chatMeta.ts'
import type { Database } from '../db.ts'
import { BadRequest } from '../errors.ts'
import type { Connection, MachineEvents, Machines } from '../machines.ts'
import { OpError, parseInput, type Op } from '../ops.ts'
import type { ChatPlacement } from '../placement.ts'
import { SESSION_EVENTS, isUuid, type HubApi, type RunnerEvent } from '../runnerProtocol.ts'
import type { Transcripts } from '../transcripts.ts'
import type { AccountLimits } from '../usage.ts'
import type { Chats } from './chats.ts'
import type { HubTerminals } from './terminals.ts'
import type { Viewers } from './viewers.ts'

export interface RunnerLinkDeps {
  db: Database
  board: Board
  meta: ChatMeta
  transcripts: Transcripts
  machines: Machines
  placement: ChatPlacement
  chats: Chats
  terminals: HubTerminals
  viewers: Viewers
  attention: Attention
  account: AccountLimits
  /**
   * The ops that run on the hub rather than beside Claude: the board, and
   * the bridge into previews of the hub's own machine. Runners' tools and
   * scripts call them through runOp. `hubOnly` are only for chats on the
   * hub's own machine.
   */
  ops: Op[]
  hubOnly: Set<string>
  listChanged: () => void
  machinesChanged: () => void
}

/** The hub's side of every runner's connection: what runners tell it, and what they may ask of it. */
export class RunnerLink implements MachineEvents {
  constructor(private d: RunnerLinkDeps) {}

  onEvent = (machine: Connection, event: RunnerEvent): void => {
    const { placement, chats, attention } = this.d
    switch (event.type) {
      case 'session': {
        const e = this.sessionEvent(machine.id, event.event)
        if (!e) return
        this.d.viewers.publish(e)
        attention.see(e)
        return
      }
      case 'live':
        // Turns that ended while the hub wasn't listening, e.g. with the runner offline, still want reading.
        for (const s of event.sessions) if (placement.owns(machine.id, s.id)) chats.turnsEnded(s.id, s.turns)
        // A chat started, closed, or started or finished working.
        this.d.listChanged()
        this.d.machinesChanged()
        attention.update()
        return
      case 'turn_end':
        if (!placement.owns(machine.id, event.sessionId)) return
        chats.turnEnded(event.sessionId, event.turns, event.queued)
        void this.d.account.refresh()
        return
      case 'terminals':
      case 'term_output':
        return this.d.terminals.runnerEvent(machine, event)
    }
  }

  /**
   * A machine was added, renamed or turned away, or its runner connected or
   * went away. When that last happens, its chats' and terminals' viewers get
   * a fresh snapshot: running, read-only, or back again. So they do whenever
   * a runner says hello, even replacing a connection the hub hadn't seen
   * drop: what the runner did in between never reached them.
   */
  onChange = (id: string, runner?: 'connected' | 'disconnected'): void => {
    this.d.machinesChanged()
    this.d.listChanged()
    if (!runner) return
    this.d.attention.update()
    this.d.terminals.machineChanged(id, runner === 'connected')
    this.d.chats.machineChanged(id)
    if (runner === 'connected') void this.d.account.refresh()
  }

  /**
   * What runners can ask of the hub: the board for Claude's tools, starting
   * children, and taking their transcripts. A runner acts only for chats on
   * its own machine, and anything it says about another chat is refused,
   * including who made a change. The board is everyone's, though: its Claude
   * can change any card, and archive any chat, as Claude can from any chat.
   */
  api = (machine: string): Omit<HubApi, 'hello'> => {
    const { db, board, meta, transcripts, machines, placement, chats, viewers } = this.d
    const own = (sessionId: string): string => {
      if (!placement.owns(machine, sessionId)) throw new BadRequest(`Chat ${sessionId} isn't on this machine`)
      return sessionId
    }
    return {
      runOp: async (chat, script, input) => {
        own(chat)
        const o = this.d.ops.find((o) => o.script === script)
        if (!o) throw new BadRequest(`No badger.${script}`)
        if (this.d.hubOnly.has(script) && machine !== LOCAL_MACHINE) throw new BadRequest(`${script} only works for chats on the hub's own machine`)
        try {
          // Claude in one of this machine's chats is who makes the change; runners never act for the UI.
          return await o.run(parseInput(o, input), { sessionId: chat, cwd: () => machines.live(chat)?.cwd ?? '' })
        } catch (err) {
          if (err instanceof OpError) throw new BadRequest(err.message)
          console.error(`badger.${script} failed for ${chat}:`, err)
          throw err
        }
      },
      chatCard: async (chat) => {
        const card = board.cardOf(own(chat))
        if (!card) return undefined
        const archived = meta.archivedIds()
        const infos = await chats.info(card.sessionIds)
        return { ...card, chats: infos.map(({ id, cwd, machine }) => ({ id, cwd, machine, archived: archived.has(id) })) }
      },
      // A fork that moved is told so first, then about its card.
      cardContext: (chat) => [meta.forkNote(own(chat)), cardContext(board, meta, chat)].filter(Boolean).join('\n\n') || undefined,
      contextSeen: (chat, text) => {
        const { move, rest } = splitMoveNote(text)
        if (move) meta.forkNoteSeen(own(chat))
        if (rest) contextSeen(meta, own(chat), rest)
      },
      openPreview: (chat, { root, port, name, path }) => {
        own(chat)
        viewers.toAll({ type: 'open_preview', root, machine, port, name, path })
        // The hub proxies its own machine's ports; another machine's only open where they are.
        const template = machine === LOCAL_MACHINE ? viewers.previewUrl() : 'http://localhost:{port}'
        return { tabs: viewers.count, url: template?.replace('{port}', String(port)).concat(path) }
      },
      startChild: ({ parentId, toolUseId, kind }) => {
        own(parentId)
        // Children run on their parent's machine. Recorded before the chat exists, so the sidebar never lists it.
        const sessionId = randomUUID()
        db.transaction(() => {
          placement.assign(sessionId, machine)
          meta.addChild({ sessionId, parentId, toolUseId, kind })
        })
        return sessionId
      },
      // Not refused: a chat removed from this machine since it asked mustn't sink the rest of the batch.
      transcriptState: (files) => transcripts.state(files.filter((f) => placement.owns(machine, f.sessionId))),
      transcriptLines: (batch) => (own(batch.sessionId), chats.takeLines(batch)),
    }
  }

  /** A chat's event from a runner (already checked to be a kind a chat emits), if the chat is on that runner's machine. */
  private sessionEvent(machine: string, event: ServerEvent): ServerEvent | undefined {
    if (!('sessionId' in event) || !SESSION_EVENTS.includes(event.type as never) || !this.d.placement.owns(machine, event.sessionId)) return undefined
    if (event.type === 'child_started' && (!isUuid(event.childId) || this.d.meta.parentOf(event.childId) !== event.sessionId)) return undefined
    return event
  }
}
