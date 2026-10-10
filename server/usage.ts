import { getSessionInfo, type Query, type SDKControlGetContextUsageResponse, type SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import type { AccountUsage, ContextUsage } from '../shared/protocol.ts'
import { oneOff, type SessionManager } from './session.ts'
import { inaccessible } from './workspace.ts'

/** Plan limits change slowly; read them again at most this often. */
const ACCOUNT_MAX_AGE_MS = 60 * 1000

/**
 * Context and plan usage, read from Claude Code itself. A chat with a live
 * process is asked directly; otherwise a process is started just to answer
 * and closed again. Neither sends anything to the model.
 */
export class Usage {
  private account?: AccountUsage
  private reading?: Promise<AccountUsage | undefined>
  /** Context of chats with no live process, until their transcript changes. */
  private contexts = new Map<string, { modified: number; usage: ContextUsage }>()

  constructor(
    private manager: SessionManager,
    private onAccount: (usage: AccountUsage) => void,
  ) {}

  latestAccount(): AccountUsage | undefined {
    return this.account
  }

  async context(sessionId: string): Promise<ContextUsage | undefined> {
    const live = this.manager.get(sessionId)
    if (live) return contextUsage(await live.ask((q) => q.getContextUsage({ detail: 'summary' })))
    const info = await getSessionInfo(sessionId)
    if (!info?.cwd || inaccessible(info.cwd)) return undefined
    const cached = this.contexts.get(sessionId)
    if (cached?.modified === info.lastModified) return cached.usage
    const usage = contextUsage(
      await oneOff({ cwd: info.cwd, resume: sessionId }, (q) => q.getContextUsage({ detail: 'summary' })),
    )
    this.contexts.set(sessionId, { modified: info.lastModified, usage })
    return usage
  }

  /** The plan's limits, read again if they're older than a minute. Everyone is told when they change. */
  refreshAccount(): Promise<AccountUsage | undefined> {
    if (this.account && Date.now() - this.account.at < ACCOUNT_MAX_AGE_MS) return Promise.resolve(this.account)
    this.reading ??= (async () => {
      try {
        // Any live process will do; the limits are the account's, not the chat's.
        const live = this.manager.any()
        const raw = live ? await live.ask(readAccount) : await oneOff({ cwd: process.cwd() }, readAccount)
        this.account = accountUsage(raw)
        this.onAccount(this.account)
        return this.account
      } catch (err) {
        console.error('Reading plan usage failed:', err instanceof Error ? err.message : err)
        return this.account
      } finally {
        this.reading = undefined
      }
    })()
    return this.reading
  }
}

/** Skips the scan of local transcripts that says what's using the limits; only the limits are wanted. */
const readAccount = (q: Query) => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })

function contextUsage(raw: SDKControlGetContextUsageResponse): ContextUsage {
  return {
    tokens: raw.totalTokens,
    max: raw.rawMaxTokens,
    percent: Math.round((raw.totalTokens / raw.rawMaxTokens) * 100),
    categories: raw.categories.map(({ name, tokens, kind }) => ({ name, tokens, kind })),
  }
}

type Window = { utilization: number | null; resets_at: string | null } | null | undefined

/** The server's own rows when it sends them, which name each meter; otherwise the fixed windows. */
function accountUsage(raw: SDKControlGetUsageResponse): AccountUsage {
  const rl = raw.rate_limits as (typeof raw.rate_limits & { limits?: Limit[] | null }) | null
  const at = Date.now()
  if (!raw.rate_limits_available || !rl) return { plan: raw.subscription_type, limits: [], at }
  if (rl.limits) {
    return {
      plan: raw.subscription_type,
      limits: rl.limits.map((l) => ({ label: limitLabel(l), percent: l.percent, severity: l.severity, resetsAt: l.resets_at })),
      at,
    }
  }
  const windows: [string, Window][] = [
    ['Session', rl.five_hour],
    ['Week', rl.seven_day],
    ['Week · Opus', rl.seven_day_opus],
    ['Week · Sonnet', rl.seven_day_sonnet],
    ...(rl.model_scoped ?? []).map((m): [string, Window] => [`Week · ${m.display_name}`, m]),
  ]
  return {
    plan: raw.subscription_type,
    limits: windows.flatMap(([label, w]) =>
      w && w.utilization !== null ? [{ label, percent: w.utilization, severity: 'normal', resetsAt: w.resets_at }] : [],
    ),
    at,
  }
}

type Limit = {
  kind: string
  percent: number
  severity: string
  resets_at: string | null
  scope?: { model?: { display_name: string } | null; surface?: { display_name: string } | null } | null
}

function limitLabel(l: Limit): string {
  const scope = l.scope?.model?.display_name ?? l.scope?.surface?.display_name
  const base = l.kind === 'session' ? 'Session' : l.kind.startsWith('weekly') ? 'Week' : l.kind.replace(/_/g, ' ')
  return scope ? `${base} · ${scope}` : base
}
