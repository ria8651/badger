import { existsSync, readFileSync } from 'node:fs'

/** Drops what running under pnpm and Badger adds, so terminals behave like the user's own. */
export function shellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (/^(npm_|PNPM_|CLAUDE_CODE_|CLAUDECODE$|INIT_CWD$|FORCE_COLOR$|NODE$|COLUMNS$|LINES$)/.test(key)) continue
    clean[key] = value
  }
  // pnpm puts this project's node_modules/.bin dirs at the front of PATH.
  clean.PATH = env.PATH?.split(':')
    .filter((p) => !/\/node_modules\/(\.bin|\.pnpm\/)|node-gyp-bin/.test(p))
    .join(':')
  return clean
}

/** Fills in what `.env` sets that the environment doesn't already. */
export function loadDotEnv(): void {
  if (!existsSync('.env')) return
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
