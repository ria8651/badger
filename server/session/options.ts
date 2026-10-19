import type { CanUseTool, McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionMode } from '../../shared/protocol.ts'
import { streamEnv } from '../bashStream.ts'

/**
 * Claude Code won't start at all with the flag that allows switching to bypass
 * permissions when it runs as root, unless IS_SANDBOX=1 says it's sandboxed.
 * Without the flag it refuses bypass itself, with its own message.
 */
const CAN_BYPASS = process.getuid?.() !== 0 || process.env.IS_SANDBOX === '1'

/** What a chat's process tells it, through Claude Code's hooks. */
export interface ProcessHooks {
  /** The user's next message is going in: the context to add to it, if any. */
  promptContext: () => Promise<string | undefined>
  /** A tool call is about to run (or be asked about). */
  toolStarting: (toolUseId: string, toolName: string) => void
  /** A Bash command is about to run (or be asked about). */
  bashStarting: (toolUseId: string, command: string) => void
  toolFinished: (toolUseId: string) => void
  /** Claude moved into or out of a worktree. */
  moved: (cwd: string) => void
}

/** How a chat's Claude Code process is started: where, as which chat, and with which tools and hooks. */
export function sdkOptions(o: {
  id: string
  cwd: string
  mode: PermissionMode
  model?: string
  resume: boolean
  /** Start in this new worktree (Claude Code's --worktree); empty lets Claude name it. */
  worktree?: string
  mcpServers: Record<string, McpServerConfig>
  /** Tools that skip the permission prompt, allowed from PreToolUse. */
  allowedTools: string[]
  env?: Record<string, string>
  canUseTool: CanUseTool
  hooks: ProcessHooks
}): Options {
  const { hooks } = o
  return {
    cwd: o.cwd,
    ...(o.resume ? { resume: o.id } : { sessionId: o.id }),
    permissionMode: o.mode,
    ...(o.model && o.model !== 'default' ? { model: o.model } : {}),
    // So the chat can switch to bypass later.
    allowDangerouslySkipPermissions: CAN_BYPASS,
    includePartialMessages: true,
    // Subagents' text and thinking too, not just their tool calls, so they show live as the chat's own do.
    // Claude Code streams only the chat's own messages token by token; a subagent's arrive a block at a time.
    forwardSubagentText: true,
    // A one-line "what it's doing" for each running subagent, every ~30s.
    agentProgressSummaries: true,
    // Each task has its own Stop, so stopping the turn leaves background work running.
    perTaskStopAffordance: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
    canUseTool: o.canUseTool,
    mcpServers: o.mcpServers,
    // Newer models omit thinking text by default; ask for summaries so it can stream.
    thinking: { type: 'adaptive', display: 'summarized' },
    env: { ...streamEnv(), ...o.env },
    ...(o.worktree !== undefined ? { extraArgs: { worktree: o.worktree || null } } : {}),
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            async () => {
              const additionalContext = await hooks.promptContext()
              if (!additionalContext) return { continue: true }
              return { continue: true, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }
            },
          ],
        },
      ],
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              if (input.hook_event_name !== 'PreToolUse') return { continue: true }
              hooks.toolStarting(input.tool_use_id, input.tool_name)
              // Allowed here, not with allowedTools: that would skip canUseTool too, and the SDK warns about it every start.
              if (o.allowedTools.includes(input.tool_name)) {
                return { continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
              }
              return { continue: true }
            },
          ],
        },
        {
          matcher: 'Bash',
          hooks: [
            async (input) => {
              if (input.hook_event_name === 'PreToolUse') {
                const command = (input.tool_input as { command?: unknown })?.command
                if (typeof command === 'string') hooks.bashStarting(input.tool_use_id, command)
              }
              return { continue: true }
            },
          ],
        },
      ],
      // Claude can move itself into a worktree mid-chat; follow it so terminals do too.
      PostToolUse: [
        {
          hooks: [
            async (input) => {
              if (input.hook_event_name === 'PostToolUse') hooks.toolFinished(input.tool_use_id)
              return { continue: true }
            },
          ],
        },
        {
          matcher: 'EnterWorktree|ExitWorktree',
          hooks: [
            async (input) => {
              hooks.moved(input.cwd)
              return { continue: true }
            },
          ],
        },
      ],
    },
  }
}
