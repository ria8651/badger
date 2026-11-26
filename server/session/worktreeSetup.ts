import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { WorktreeStep } from '../../shared/protocol.ts'
import { stripAnsi } from '../terminalTools.ts'

/** Hooks that run before a chat started in a new worktree is ready, by event, and what their steps are called. */
const SETUP_HOOKS: Record<string, string> = {
  WorktreeCreate: 'WorktreeCreate hook',
  Setup: 'Setup hook',
  SessionStart: 'SessionStart hook',
}

/** Output is cut to its last line, and that to this. */
const OUTPUT_MAX = 300
/** Hooks past this many don't get steps of their own. The hub takes up to 100. */
const STEPS_MAX = 50

interface Hook {
  /** Claude Code's name for it, e.g. SessionStart:startup. */
  name: string
  event: string
  step: WorktreeStep
}

/**
 * How far Claude Code has got with the worktree a chat starts in. It says nothing until it's ready but for its hook
 * events, so the steps are: making the worktree, each hook that runs before it's ready, as its output comes, then
 * Claude Code starting up in it.
 */
export class WorktreeSetup {
  private steps: WorktreeStep[] = [{ label: 'Creating worktree', state: 'running', started: Date.now() }]
  private hooks = new Map<string, Hook>()
  /** Shown once nothing else is running, until the next hook starts or Claude Code is ready. */
  private starting?: WorktreeStep
  /** A WorktreeCreate hook has taken over the first step. */
  private createdByHook = false

  /** The steps as they stand, to send: they change in place. */
  snapshot(): WorktreeStep[] {
    return this.steps.map((s) => ({ ...s }))
  }

  /** Hooks that failed, with why: a process that ends before it's ready doesn't save them itself. */
  failures(): { hook: string; error: string }[] {
    return [...this.hooks.values()].filter((h) => h.step.state === 'failed').map((h) => ({ hook: h.name, error: h.step.output ?? '' }))
  }

  /** Takes in one of Claude Code's messages. True if the steps changed. */
  take(msg: SDKMessage): boolean {
    if (msg.type !== 'system') return false
    if (msg.subtype === 'hook_started') {
      const label = SETUP_HOOKS[msg.hook_event]
      if (!label) return false
      const first = this.steps[0]
      // A WorktreeCreate hook makes the worktree in git's place, so it's that first step.
      if (msg.hook_event === 'WorktreeCreate' && !this.createdByHook && first.state === 'running') {
        this.createdByHook = true
        first.label = `Creating worktree (${label})`
        this.hooks.set(msg.hook_id, { name: msg.hook_name, event: msg.hook_event, step: first })
        return true
      }
      if (this.steps.length >= STEPS_MAX) return false
      if (this.starting) this.steps = this.steps.filter((s) => s !== this.starting)
      this.starting = undefined
      if (first.state === 'running' && !this.createdByHook) {
        first.state = 'done'
        first.took = Date.now() - first.started
      }
      const step: WorktreeStep = { label, state: 'running', started: Date.now() }
      this.hooks.set(msg.hook_id, { name: msg.hook_name, event: msg.hook_event, step })
      this.steps.push(step)
      return true
    }
    if (msg.subtype === 'hook_progress') {
      const step = this.hooks.get(msg.hook_id)?.step
      const output = lastLine(msg.output)
      if (step?.state !== 'running' || !output || output === step.output) return false
      step.output = output
      return true
    }
    if (msg.subtype === 'hook_response') {
      const hook = this.hooks.get(msg.hook_id)
      if (!hook || hook.step.state !== 'running') return false
      const { step } = hook
      const failed = msg.outcome !== 'success'
      step.state = failed ? 'failed' : 'done'
      step.took = Date.now() - step.started
      // Done, its output is noise; failed, it says why.
      step.output = failed ? lastLine(msg.stderr) || lastLine(msg.output) || step.output : undefined
      // Without its worktree, Claude Code gives up rather than starting.
      const givingUp = failed && hook.event === 'WorktreeCreate'
      if (!givingUp && !this.steps.some((s) => s.state === 'running')) {
        this.starting = { label: 'Starting Claude Code', state: 'running', started: Date.now() }
        this.steps.push(this.starting)
      }
      return true
    }
    return false
  }
}

/** The last line a terminal would show of some output. */
function lastLine(text: string | undefined): string | undefined {
  const lines = stripAnsi(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.at(-1)?.slice(0, OUTPUT_MAX)
}
