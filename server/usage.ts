import { getSessionInfo, type SDKControlGetContextUsageResponse, type SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import type { AccountUsage, ContextUsage } from '../shared/protocol.ts'
import { oneOff, readContext, readLimits } from './claudeProbe.ts'
import { message } from './errors.ts'
import type { SessionManager } from './session.ts'
import { inaccessible } from './workspace.ts'

/** Plan limits change slowly; read them again at most this often. */
const ACCOUNT_MAX_AGE_MS = 60 * 1000

/**
 * How full each chat's context is, read from Claude Code itself, on the
 * machine the chat runs on. A chat with a live process is asked directly;
 * otherwise a process is started just to answer and closed again. Neither
 * sends anything to the model.
 */
export class ContextReader {
  /** Context of chats with no live process, until their transcript changes. */
  private contexts = new Map<string, { modified: number; usage: ContextUsage }>()

  constructor(private manager: SessionManager) {}

  async context(sessionId: string): Promise<ContextUsage | undefined> {
    const live = this.manager.get(sessionId)
    if (live) return contextUsage(await live.contextUsage())
    const info = await getSessionInfo(sessionId)
    if (!info?.cwd || inaccessible(info.cwd)) return undefined
    const cached = this.contexts.get(sessionId)
    if (cached?.modified === info.lastModified) return cached.usage
    const usage = contextUsage(await oneOff({ cwd: info.cwd, resume: sessionId }, readContext))
    this.contexts.set(sessionId, { modified: info.lastModified, usage })
    return usage
  }
}

/** The plan's limits, from any live process on this machine or a one-off one. They're the account's, not a chat's. */
export async function readAccount(manager: SessionManager): Promise<AccountUsage> {
  const live = manager.any()
  return accountUsage(live ? await live.planUsage() : await oneOff({ cwd: process.cwd() }, readLimits))
}

/**
 * The plan's limits as the hub last read them from a runner. Every machine
 * may be signed in to a different account; the hub shows its own runner's.
 */
export class AccountLimits {
  private account?: AccountUsage
  private reading?: Promise<AccountUsage | undefined>

  constructor(
    /** Reads them from a runner; undefined when none is connected. */
    private read: () => Promise<AccountUsage> | undefined,
    private onAccount: (usage: AccountUsage) => void,
  ) {}

  latest(): AccountUsage | undefined {
    return this.account
  }

  /** Read again if they're older than a minute. Everyone is told when they change. */
  refresh(): Promise<AccountUsage | undefined> {
    if (this.account && Date.now() - this.account.at < ACCOUNT_MAX_AGE_MS) return Promise.resolve(this.account)
    this.reading ??= (async () => {
      try {
        const reading = this.read()
        if (!reading) return this.account
        this.account = await reading
        this.onAccount(this.account)
        return this.account
      } catch (err) {
        console.error('Reading plan usage failed:', message(err))
        return this.account
      } finally {
        this.reading = undefined
      }
    })()
    return this.reading
  }
}


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
