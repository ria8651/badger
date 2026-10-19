import { isAbsolute, resolve } from 'node:path'

/** A failure that's the caller's fault, which they should read: a 400 over HTTP, re-thrown as one across a Peer. */
export class BadRequest extends Error {}

/** For `.catch`: the failure, as the caller's to read. */
export const badRequest = (err: unknown): never => {
  throw new BadRequest(message(err))
}

/** What went wrong, for a log line or a reply. */
export const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** A path from a caller, which must be absolute; normalised. */
export function absolutePath(path: unknown): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new BadRequest('path must be an absolute path')
  return resolve(path)
}
