import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z, type ZodRawShape } from 'zod'

/**
 * Badger's operations, each defined once and reachable two ways: as an MCP
 * tool in each chat, and from scripts, where the `badger` command
 * (bin/badger) calls them over HTTP as `badger.<script name>(input)`. A
 * tool answers in text for Claude to read; a script gets the value as data
 * to filter and loop over.
 */

/** Who's calling: the chat, and where its commands run. */
export interface OpContext {
  sessionId: string
  /** The chat's directory, or a script's own. */
  cwd: () => string
  signal?: AbortSignal
}

export interface OpResult {
  /** What a tool call shows Claude. */
  text: string
  /** What a script gets; the text when absent. */
  value?: unknown
  /** A PNG: inline in a tool's result, a file path for a script. */
  image?: string
}

/** A failure the caller should read, rather than a bug. */
export class OpError extends Error {}

export interface Op<S extends ZodRawShape = ZodRawShape> {
  /** The MCP tool's name, e.g. list_cards. */
  tool: string
  /** The MCP server it's on. */
  server: string
  /** The name in scripts, e.g. cards.list. */
  script: string
  description: string
  input: S
  /** What a script gets back, as a TypeScript-ish type for the help. */
  returns: string
  /** Runs without asking: it only reads, or changes nothing the user would mind. */
  autoAllow?: boolean
  annotations?: SdkMcpToolDefinition['annotations']
  run: (args: z.infer<z.ZodObject<S>>, ctx: OpContext) => Promise<OpResult>
}

export const op = <S extends ZodRawShape>(o: Op<S>): Op => o as unknown as Op

/** The full name Claude Code knows a tool by. */
export const toolName = (o: Op) => `mcp__${o.server}__${o.tool}`

/** One server's tools for a chat. `extra` are tools only a chat can use, e.g. merging, which shows inside its own call. */
export function mcpServer(
  name: string,
  instructions: string,
  ops: Op[],
  ctx: OpContext,
  extra: SdkMcpToolDefinition<any>[] = [],
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name,
    alwaysLoad: true,
    instructions,
    tools: [
      ...ops
        .filter((o) => o.server === name)
        .map((o) =>
          tool(
            o.tool,
            o.description,
            o.input,
            async (args, extra) => {
              try {
                const r = await o.run(args, { ...ctx, signal: (extra as { signal?: AbortSignal } | undefined)?.signal })
                return {
                  content: [
                    ...(r.text ? [{ type: 'text' as const, text: r.text }] : []),
                    ...(r.image ? [{ type: 'image' as const, data: r.image, mimeType: 'image/png' }] : []),
                  ],
                }
              } catch (err) {
                return { content: [{ type: 'text' as const, text: message(err) }], isError: true }
              }
            },
            { annotations: o.annotations },
          ),
        ),
      ...extra,
    ],
  })
}

/** Runs one for a script: the input is checked against its schema, and an image is saved to a file. */
export async function runForScript(o: Op, input: unknown, ctx: OpContext): Promise<unknown> {
  const parsed = z.object(o.input).strict().safeParse(input ?? {})
  if (!parsed.success) throw new OpError(`Bad input for ${o.script}: ${z.prettifyError(parsed.error)}`)
  const r = await o.run(parsed.data, ctx)
  if (!r.image) return r.value === undefined ? r.text : r.value
  const dir = join(tmpdir(), 'badger')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${o.script.replace(/\W+/g, '-')}-${Date.now()}.png`)
  writeFileSync(file, Buffer.from(r.image, 'base64'))
  return r.value === undefined ? file : { ...(r.value as object), file }
}

/** What the `badger` command's help lists. */
export function catalog(ops: Op[]) {
  return ops.map((o) => ({
    name: o.script,
    tool: toolName(o),
    description: o.description,
    input: z.toJSONSchema(z.object(o.input), { io: 'input', unrepresentable: 'any' }),
    returns: o.returns,
  }))
}

export const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
