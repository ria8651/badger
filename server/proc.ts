import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

/** A command's output, without a shell. */
export const run = promisify(execFile)

/** Each process's children, through the parent links in `ps`. */
function childrenOf(ps: string): Map<number, number[]> {
  const children = new Map<number, number[]>()
  for (const line of ps.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (child && parent) children.set(parent, [...(children.get(parent) ?? []), child])
  }
  return children
}

const PS_ARGS = ['-A', '-o', 'pid=,ppid=']

/** Each root, then every process under it, breadth first. */
function trees(children: Map<number, number[]>, roots: number[]): Map<number, number[]> {
  const out = new Map<number, number[]>()
  for (const root of roots) {
    const pids = [root]
    for (let i = 0; i < pids.length; i++) pids.push(...(children.get(pids[i]) ?? []))
    out.set(root, pids)
  }
  return out
}

/** Each root with every process under it. With `ps` unavailable, each is on its own. */
export async function processTrees(roots: number[]): Promise<Map<number, number[]>> {
  const ps = await run('ps', PS_ARGS).then((r) => r.stdout, () => '')
  return trees(childrenOf(ps), roots)
}

/** Every process under pid, not counting it. Synchronous, for shutting down. */
export function descendants(pid: number): number[] {
  let ps = ''
  try {
    ps = execFileSync('ps', PS_ARGS, { encoding: 'utf8' })
  } catch {}
  return trees(childrenOf(ps), [pid]).get(pid)!.slice(1)
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Sends a signal, if the process is still there to get it. */
export function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch {}
}
