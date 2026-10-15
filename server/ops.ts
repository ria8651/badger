import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z, type ZodRawShape } from 'zod'

/**
 * Badger's operations, each defined once and reachable two ways: as an MCP
 * tool in each chat, and from scripts, which the run_script tool runs with
 * them as `badger.<script name>(input)` (server/scripts.ts). A tool answers
 * in text for Claude to read; a script gets the value as data to filter and
 * loop over.
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

/**
 * These ops as tools and scripts here, done somewhere else: on a runner, the
 * hub's board and the bridge into its previews. Only an op's `run` uses what
 * `make` is given, so it's given nothing.
 */
export function forwarded(make: (deps: never) => Op[], run: (o: Op, args: unknown, ctx: OpContext) => Promise<OpResult>): Op[] {
  return make({} as never).map((o) => ({ ...o, run: (args, ctx) => run(o, args, ctx) }))
}

/** How a script calls an op, e.g. `badger.cards.get({ id?: number })`. */
export function signature(o: Op): string {
  const schema = z.toJSONSchema(z.object(o.input), { io: 'input', unrepresentable: 'any' }) as { properties?: Record<string, Schema>; required?: string[] }
  const required = new Set(schema.required ?? [])
  const args = Object.entries(schema.properties ?? {})
    .map(([name, s]) => `${name}${required.has(name) ? '' : '?'}: ${typeName(s)}`)
    .join(', ')
  return `badger.${o.script}(${args ? `{ ${args} }` : ''})`
}

type Schema = { type?: string; enum?: unknown[]; anyOf?: Schema[]; items?: Schema }

function typeName(s: Schema | undefined): string {
  if (!s || typeof s !== 'object') return 'any'
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ')
  if (s.anyOf) return s.anyOf.map(typeName).join(' | ')
  if (s.type === 'integer') return 'number'
  if (s.type === 'array') return `${typeName(s.items)}[]`
  return s.type ?? 'any'
}

export const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
