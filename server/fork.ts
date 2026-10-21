import { forkSession, type SessionStore, type SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import type { ImportedFile } from './runnerProtocol.ts'

/** Most bytes of lines sent to a runner in one call, well inside a frame. */
const BATCH_BYTES = 8 * 1024 * 1024

/**
 * A copy of a chat's transcript as a new chat, made from the hub's copy so
 * the machine it ran on needn't be there. Up to and including the entry
 * `at`, or all of it. The SDK gives the copy fresh message ids and the title;
 * subagents' files come along whole, since their calls keep their ids. With
 * `cwd`, every entry says it ran there, which is where Claude Code resumes it.
 */
export async function forkTranscript(
  store: SessionStore,
  subagents: { subpath: string; lines: string[]; meta?: Record<string, unknown> }[],
  sessionId: string,
  opts: { at?: string; title: string; cwd?: string },
): Promise<{ sessionId: string; files: ImportedFile[] }> {
  const main: SessionStoreEntry[] = []
  const times = new Map<string, unknown>()
  const fork = await forkSession(sessionId, {
    sessionStore: {
      ...store,
      load: async (key) => {
        const entries = await store.load(key)
        if (!key.subpath) for (const e of entries ?? []) if (typeof e.uuid === 'string') times.set(e.uuid, e.timestamp)
        return entries
      },
      append: async (key, entries) => {
        if (!key.subpath) main.push(...entries)
      },
    },
    upToMessageId: opts.at,
    title: opts.title,
  })
  // The SDK stamps the message it forks at with the time of the fork, which would make its turn look that long.
  const original = (e: SessionStoreEntry) => {
    const from = (e.forkedFrom as { messageUuid?: string } | undefined)?.messageUuid
    return from && times.get(from) ? { timestamp: times.get(from) } : {}
  }
  const retarget = (e: SessionStoreEntry) => ({
    ...e,
    ...original(e),
    ...(typeof e.sessionId === 'string' ? { sessionId: fork.sessionId } : {}),
    ...(opts.cwd && typeof e.cwd === 'string' ? { cwd: opts.cwd } : {}),
  })
  const files = [
    ...batches('', main.map((e) => JSON.stringify(retarget(e)))),
    ...subagents.flatMap((f) =>
      batches(
        f.subpath,
        f.lines.flatMap((line) => {
          try {
            return [JSON.stringify(retarget(JSON.parse(line)))]
          } catch {
            return []
          }
        }),
        f.meta,
      ),
    ),
  ]
  return { sessionId: fork.sessionId, files }
}

/**
 * Where to fork a chat that's mid-turn: the end of the last request Claude
 * sent, so a fork's first request starts with what's already cached. That's
 * after a prompt or tool result with no tool call left waiting on its result,
 * along with the context Claude Code attached to it (its environment, skills
 * and the like, each an entry of its own), up to the reply. Assistant entries
 * after it may be part of a reply still coming in, so they're left out.
 */
export function busyForkPoint(entries: SessionStoreEntry[]): string | undefined {
  const open = new Set<string>()
  let at: string | undefined
  /** Whether the entries since the last reply would make a request: they end a prompt or the last tool result. */
  let complete = false
  for (const e of entries) {
    const content = (e.message as { content?: unknown } | undefined)?.content
    const blocks = Array.isArray(content) ? (content as { type?: string; id?: string; tool_use_id?: string }[]) : []
    if (e.type === 'assistant') {
      for (const b of blocks) if (b.type === 'tool_use' && b.id) open.add(b.id)
      complete = false
      continue
    }
    if (e.type === 'user') {
      for (const b of blocks) if (b.type === 'tool_result' && b.tool_use_id) open.delete(b.tool_use_id)
      complete = !open.size
    }
    if (complete && typeof e.uuid === 'string') at = e.uuid
  }
  return at
}

/** A file's lines in parts small enough to send, the metadata with the last. */
function batches(subpath: string, lines: string[], meta?: Record<string, unknown>): ImportedFile[] {
  const out: ImportedFile[] = []
  let part: string[] = []
  let size = 0
  for (const line of lines) {
    if (part.length && size + line.length > BATCH_BYTES) {
      out.push({ subpath, lines: part, append: out.length > 0 })
      part = []
      size = 0
    }
    part.push(line)
    size += line.length
  }
  out.push({ subpath, lines: part, append: out.length > 0, ...(meta ? { meta } : {}) })
  return out
}
