import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * Single-consumer async queue used as the streaming-input prompt for `query()`.
 * Keeping it open keeps the Claude Code process alive between turns, and
 * messages pushed mid-turn are picked up at the agent's next break.
 */
export class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  closed = false

  push(message: SDKUserMessage): boolean {
    if (this.closed) return false
    this.buffer.push(message)
    this.wake?.()
    return true
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = null
          resolve()
        }
      })
    }
  }
}
