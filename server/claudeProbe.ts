import { homedir } from 'node:os'
import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk'
import type { ModelOption } from '../shared/protocol.ts'

/**
 * Starts a Claude Code process just to ask it something, then closes it.
 * Nothing is sent to the model and nothing is saved. Settings aren't loaded
 * unless asked for, so the user's hooks don't run.
 */
export async function oneOff<T>(options: Options, fn: (q: Query) => Promise<T>): Promise<T> {
  const idle: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }
  const q = query({ prompt: idle, options: { settingSources: [], ...options, persistSession: false } })
  try {
    return await fn(q)
  } finally {
    q.close()
  }
}

/** How full a chat's context is, as /context counts it. */
export const readContext = (q: Query) => q.getContextUsage({ detail: 'summary' })

/** The account's plan limits. Skips the scan of local transcripts that says what's using them; only the limits are wanted. */
export const readLimits = (q: Query) => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })

let models: Promise<ModelOption[]> | undefined

/** The models Claude Code offers this account, asked once. */
export function listModels(): Promise<ModelOption[]> {
  models ??= oneOff({ cwd: homedir(), settingSources: ['user'] }, async (q) => {
    const { models } = await q.initializationResult()
    return models.map(({ value, resolvedModel, displayName, description }) => ({ value, resolvedModel, displayName, description }))
  })
  // Ask again next time rather than keep a failure.
  models.catch(() => (models = undefined))
  return models
}
