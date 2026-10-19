import { readFile, readdir, readlink } from 'node:fs/promises'
import { processTrees, run } from './proc.ts'

/**
 * The TCP ports each process tree is listening on, keyed by its root pid.
 * Only listeners a browser could reach through the preview proxy count:
 * loopback or every interface.
 */
export async function listeningPorts(roots: number[]): Promise<Map<number, number[]>> {
  const found = new Map<number, number[]>()
  if (!roots.length) return found
  const trees = await processTrees(roots)
  const all = [...new Set([...trees.values()].flat())]
  const byPid = process.platform === 'linux' ? await linuxListeners(all) : await lsofListeners(all)
  for (const [root, pids] of trees) {
    const ports = new Set(pids.flatMap((pid) => byPid.get(pid) ?? []))
    if (ports.size) found.set(root, [...ports].sort((a, b) => a - b))
  }
  return found
}


/** macOS and anything else with lsof. */
async function lsofListeners(pids: number[]): Promise<Map<number, number[]>> {
  const byPid = new Map<number, number[]>()
  // lsof exits 1 when none of the pids has a match, with the output still in the error.
  const { stdout } = await run('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', pids.join(','), '-Fpn']).catch((err) => ({
    stdout: String(err.stdout ?? ''),
  }))
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    const m = line.match(/^n(.*):(\d+)$/)
    if (m && reachable(m[1])) byPid.set(pid, [...(byPid.get(pid) ?? []), Number(m[2])])
  }
  return byPid
}

const reachable = (addr: string) => ['*', '127.0.0.1', '[::1]', 'localhost', '[::]', '0.0.0.0'].includes(addr)

/** Linux without lsof (the Docker image): listening sockets from /proc/net, matched to pids by inode. */
async function linuxListeners(pids: number[]): Promise<Map<number, number[]>> {
  const ports = new Map<string, number>()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const text = await readFile(file, 'utf8').catch(() => '')
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/)
      // State 0A is LISTEN. Addresses are hex in host byte order: 0100007F is 127.0.0.1; IPv6 has four such words.
      if (f[3] !== '0A') continue
      const [addr, port] = f[1].split(':')
      if (!/^(0+|0100007F|0{24}01000000|0{16}FFFF00000100007F)$/i.test(addr)) continue
      ports.set(f[9], parseInt(port, 16))
    }
  }
  const byPid = new Map<number, number[]>()
  if (!ports.size) return byPid
  await Promise.all(
    pids.map(async (pid) => {
      const fds = await readdir(`/proc/${pid}/fd`).catch(() => [])
      for (const fd of fds) {
        const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')
        const port = ports.get(link.match(/^socket:\[(\d+)\]$/)?.[1] ?? '')
        if (port) byPid.set(pid, [...(byPid.get(pid) ?? []), port])
      }
    }),
  )
  return byPid
}
