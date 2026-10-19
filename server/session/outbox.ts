import type { QueuedMessage, WireMessage } from '../../shared/protocol.ts'

/** A queued message, with what was sent to Claude Code so it can join the transcript once taken in. */
export interface Held extends QueuedMessage {
  message: WireMessage
}

/**
 * Messages sent while Claude was busy and not taken in yet: Claude Code holds
 * them until its next break or turn, and they can be withdrawn until then.
 * Every change goes to `changed`.
 */
export class Outbox {
  private held: Held[] = []

  constructor(private changed: (messages: QueuedMessage[]) => void) {}

  get size(): number {
    return this.held.length
  }

  list(): QueuedMessage[] {
    return this.held.map(publicQueued)
  }

  get(id: string): Held | undefined {
    return this.held.find((m) => m.id === id)
  }

  hold(message: Held): void {
    this.held.push(message)
    this.changed(this.list())
  }

  /** Takes a message off, e.g. once Claude Code has taken it in or dropped it. Undefined if it isn't here. */
  take(id: string): Held | undefined {
    const message = this.held.find((m) => m.id === id)
    if (!message) return
    this.held = this.held.filter((m) => m !== message)
    this.changed(this.list())
    return message
  }
}

export function publicQueued({ message: _, ...rest }: Held): QueuedMessage {
  return rest
}
