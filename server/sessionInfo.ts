import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { getSessionInfo, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { projectsDir } from './sync.ts'

/**
 * A chat's info from its transcript on this machine, as getSessionInfo gives
 * it, but with its folder filled in when that misses it: the SDK only looks
 * at the start and end of the file, so a chat whose first message was a big
 * paste comes back with no `cwd`, or, with no title to be found there
 * either, as no chat at all.
 */
export async function sessionInfo(sessionId: string): Promise<SDKSessionInfo | undefined> {
  const info = await getSessionInfo(sessionId)
  if (info?.cwd) return info
  const found = await transcriptCwd(sessionId)
  if (!found) return info
  const { size, mtimeMs } = await stat(found.path)
  return { sessionId, summary: '', lastModified: Math.floor(mtimeMs), fileSize: size, ...info, cwd: found.cwd }
}

/** The folder in the first transcript line that has one, and the transcript it's in. */
async function transcriptCwd(sessionId: string): Promise<{ cwd: string; path: string } | undefined> {
  for (const project of await readdir(projectsDir()).catch(() => [] as string[])) {
    const path = join(projectsDir(), project, `${sessionId}.jsonl`)
    const stream = createReadStream(path, 'utf8')
    const opened = await new Promise<boolean>((resolve) => stream.once('open', () => resolve(true)).once('error', () => resolve(false)))
    if (!opened) continue
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        const cwd = parseCwd(line)
        if (cwd) return { cwd, path }
      }
    } finally {
      lines.close()
      stream.destroy()
    }
  }
  return undefined
}

function parseCwd(line: string): string | undefined {
  if (!line.includes('"cwd":')) return undefined
  try {
    const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd
    return typeof cwd === 'string' && cwd ? cwd : undefined
  } catch {
    return undefined
  }
}
