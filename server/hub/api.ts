import { IMAGE_TYPES, LOCAL_MACHINE } from '../../shared/protocol.ts'
import type { Actor, Store } from '../db.ts'
import { BadRequest, absolutePath } from '../errors.ts'
import type { Machines } from '../machines.ts'
import { IMAGE_PATH, entryImage } from '../transcriptImages.ts'
import type { Transcripts } from '../transcripts.ts'
import type { Chats } from './chats.ts'
import { CHAT_ID, type Reply, type Route } from './http.ts'

/** Changes made through the REST API, i.e. by someone in the browser. */
const UI: Actor = { source: 'ui' }

/** Temp dirs, e.g. from tests, aren't worth offering as folders. */
const TEMP_DIR = /^\/(private\/)?(tmp|var\/folders)\//

export interface ApiDeps {
  store: Store
  transcripts: Transcripts
  machines: Machines
  chats: Chats
  cardsChanged: () => void
  listChanged: () => void
  /** What the page needs to know about this hub. */
  config: { defaultCwd: string; scratchCwd: string; port: number }
}

/** The REST API, but for chats' and terminals' own routes, which their modules have. */
export function apiRoutes(d: ApiDeps): Route[] {
  return [['GET', '/api/config', () => [200, d.config]], ...cardRoutes(d), ...machineRoutes(d), ...machineFileRoutes(d), imageRoute(d)]
}

/** The board. Every change tells every open tab to refetch. */
function cardRoutes({ store, cardsChanged }: ApiDeps): Route[] {
  const changed = (result: Reply): Reply => {
    if (Array.isArray(result) && result[0] < 300) cardsChanged()
    return result
  }
  const found = (card: unknown): Reply => (card ? [200, card] : [404, { error: 'No such card' }])
  const CARD = /^\/api\/cards\/(\d+)$/
  const LINKS = /^\/api\/cards\/(\d+)\/sessions$/
  const LINK = new RegExp(`^/api/cards/(\\d+)/sessions/${CHAT_ID}$`)
  const withCard = (fn: (id: number, params: string[], json: () => Promise<any>) => Reply | Promise<Reply>): Route[2] => ({ params, json }) => {
    const id = Number(params[0])
    return store.card(id) ? fn(id, params, json) : [404, { error: 'No such card' }]
  }
  return [
    ['GET', '/api/cards', () => [200, store.cards()]],
    ['POST', '/api/cards', async ({ json }) => changed([201, store.createCard(await json(), UI)])],
    ['GET', CARD, ({ params: [id] }) => found(store.card(Number(id)))],
    ['PATCH', CARD, async ({ params: [id], json }) => changed(found(store.updateCard(Number(id), await json(), UI)))],
    ['DELETE', CARD, ({ params: [id] }) => changed(store.deleteCard(Number(id), UI) ? [204, null] : [404, { error: 'No such card' }])],
    [
      'POST',
      LINKS,
      withCard(async (id, _, json) => {
        const { sessionId } = await json()
        if (typeof sessionId !== 'string' || !new RegExp(`^${CHAT_ID}$`).test(sessionId)) throw new BadRequest('sessionId is required')
        store.linkSession(id, sessionId, UI)
        return changed([200, store.card(id)])
      }),
    ],
    [
      'DELETE',
      LINK,
      withCard((id, [, sessionId]) => {
        store.unlinkSession(id, sessionId, UI)
        return changed([200, store.card(id)])
      }),
    ],
  ]
}

/** Runners: the list, adding one (its token is shown once), renaming, a new token, and removing one. */
function machineRoutes({ machines }: ApiDeps): Route[] {
  const MACHINE = /^\/api\/machines\/([a-z0-9-]+)$/
  return [
    ['GET', '/api/machines', () => [200, machines.list()]],
    ['POST', '/api/machines', () => [201, machines.create()]],
    ['POST', /^\/api\/machines\/([a-z0-9-]+)\/token$/, ({ params: [id] }) => [200, machines.resetToken(id)]],
    ['PATCH', MACHINE, async ({ params: [id], json }) => [200, machines.rename(id, (await json()).name)]],
    ['DELETE', MACHINE, ({ params: [id] }) => (machines.remove(id) ? [204, null] : [404, { error: 'No such runner' }])],
  ]
}

/**
 * What's on a machine, by machine and path: models, git, worktrees, the
 * folders new chats can start in, and the file browser that adds them. Each
 * is its runner's to answer. Making worktrees is Claude Code's job
 * (--worktree); these look and clean up.
 */
function machineFileRoutes({ store, machines, chats, listChanged }: ApiDeps): Route[] {
  const query = (url: URL) => ({ runner: machines.fromRequest(url.searchParams.get('machine')), path: () => absolutePath(url.searchParams.get('path')) })
  return [
    [
      'GET',
      '/api/models',
      async () => {
        const runner = machines.any()
        return [200, runner ? await runner.remote.models() : []]
      },
    ],
    [
      'GET',
      '/api/workspace',
      async ({ url }) => {
        const cwd = url.searchParams.get('cwd')
        if (!cwd) throw new BadRequest('cwd is required')
        return [200, { root: await query(url).runner.remote.workspaceRoot(cwd) }]
      },
    ],
    [
      'GET',
      '/api/git',
      async ({ url }) => {
        const dir = absolutePath(url.searchParams.get('path'))
        return [200, (await query(url).runner.remote.gitStatus(dir, url.searchParams.get('fetch') === '1')) ?? null]
      },
    ],
    ...(['push', 'pull'] as const).map(
      (action): Route => [
        'POST',
        `/api/git/${action}`,
        async ({ json }) => {
          const body = await json()
          const runner = machines.fromRequest(body.machine)
          const dir = absolutePath(body.path)
          await (action === 'push' ? runner.remote.gitPush(dir) : runner.remote.gitPull(dir))
          return [204, null]
        },
      ],
    ),
    [
      'GET',
      '/api/worktree',
      async ({ url }) => {
        const dir = absolutePath(url.searchParams.get('path'))
        return [200, await query(url).runner.remote.worktreeStatus(dir)]
      },
    ],
    [
      'DELETE',
      '/api/worktree',
      async ({ url }) => {
        const dir = absolutePath(url.searchParams.get('path'))
        await query(url).runner.remote.removeWorktree(dir)
        listChanged()
        return [204, null]
      },
    ],
    [
      'GET',
      '/api/folders',
      async ({ url }) => {
        const { runner } = query(url)
        const used = new Map<string, number>()
        for (const s of await chats.list()) {
          if ((s.machine ?? LOCAL_MACHINE) !== runner.id || !s.cwd || s.gone || TEMP_DIR.test(s.cwd)) continue
          used.set(s.cwd, Math.max(s.lastModified, used.get(s.cwd) ?? 0))
        }
        const { added, hidden } = store.folders(runner.id)
        return [200, await runner.remote.listFolders([...used], [...added], [...hidden])]
      },
    ],
    [
      'POST',
      '/api/folders',
      async ({ json }) => {
        const body = await json()
        const runner = machines.fromRequest(body.machine)
        const dir = absolutePath(body.path)
        if ((await runner.remote.inaccessible([dir])).length) throw new BadRequest(`${dir} isn't a folder Badger can open`)
        store.addFolder(runner.id, dir)
        return [204, null]
      },
    ],
    // Hiding needs no runner, so it works while the machine is offline.
    ['DELETE', '/api/folders', ({ url }) => (store.hideFolder(url.searchParams.get('machine') || LOCAL_MACHINE, absolutePath(url.searchParams.get('path'))), [204, null])],
    [
      'GET',
      '/api/folders/size',
      async ({ url }) => {
        const { runner, path } = query(url)
        return [200, { bytes: await runner.remote.folderSize(path()) }]
      },
    ],
    [
      'GET',
      '/api/fs',
      async ({ url }) => {
        const { runner } = query(url)
        const dir = url.searchParams.get('path')
        return [200, await runner.remote.listDir(dir ? absolutePath(dir) : undefined, url.searchParams.get('hidden') === '1')]
      },
    ],
    [
      'POST',
      '/api/fs/folder',
      async ({ json }) => {
        const body = await json()
        return [201, { path: await machines.fromRequest(body.machine).remote.makeDir(absolutePath(body.path)) }]
      },
    ],
    // A file from the file browser, e.g. an image to attach.
    [
      'GET',
      '/api/fs/file',
      async ({ url }) => {
        const { runner, path } = query(url)
        const file = await runner.remote.readFile(path())
        // Only images keep their type: anything else, like an HTML file from a repo, must never render as Badger's own page.
        const headers = { 'content-type': file.type ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'content-disposition': 'attachment' }
        return { status: 200, headers, data: Buffer.from(file.data, 'base64') }
      },
    ],
  ]
}

/** An image from a chat's transcript, as the hub has it. */
function imageRoute({ transcripts }: ApiDeps): Route {
  return [
    'GET',
    IMAGE_PATH,
    ({ params: [sessionId, uuid, index] }) => {
      const entry = transcripts.imageEntry(sessionId, uuid)
      const found = entry && entryImage(entry, Number(index))
      if (!found) return [404, { error: 'No such image' }]
      // A message never changes once written, so neither does its image. Only image types are served as themselves.
      const type = (IMAGE_TYPES as readonly string[]).includes(found.mediaType) ? found.mediaType : 'application/octet-stream'
      return { status: 200, headers: { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable' }, data: found.data }
    },
  ]
}
