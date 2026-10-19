import { z, type ZodType } from 'zod'
import { PERMISSION_MODES, type ClientEvent, type DraftAttachments } from '../shared/protocol.ts'
import { BadRequest } from './errors.ts'
import { UUID, imageAttachment } from './runnerProtocol.ts'

// What the hub takes from browsers, checked before it's acted on. The types
// are shared/protocol.ts's; these say the same in zod, which the browser's
// bundle needn't carry.

const sessionId = z.string()
const mode = z.enum(PERMISSION_MODES)

const attachments = z.object({
  pastes: z.array(z.string()).default([]),
  images: z.array(imageAttachment).default([]),
}) satisfies ZodType<DraftAttachments, unknown>

const CLIENT_EVENT = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), sessionId }),
  z.object({ type: z.literal('unsubscribe'), sessionId }),
  z.object({
    type: z.literal('send'),
    sessionId: z.string().regex(UUID, 'sessionId must be a UUID'),
    text: z.string(),
    ...attachments.shape,
    cwd: z.string().optional(),
    machine: z.string().optional(),
    mode: mode.optional(),
    model: z.string().optional(),
    worktree: z.string().optional(),
  }),
  z.object({ type: z.literal('interrupt'), sessionId }),
  z.object({ type: z.literal('unqueue'), sessionId, id: z.string(), edit: z.boolean().optional() }),
  z.object({ type: z.literal('stop_task'), sessionId, taskId: z.string() }),
  z.object({ type: z.literal('background_task'), sessionId, toolUseId: z.string().optional() }),
  z.object({ type: z.literal('draft'), sessionId, text: z.string().optional(), attachments: attachments.optional() }),
  z.object({ type: z.literal('set_mode'), sessionId, mode }),
  z.object({ type: z.literal('set_model'), sessionId, model: z.string() }),
  z.object({
    type: z.literal('permission'),
    sessionId,
    requestId: z.string(),
    decision: z.enum(['allow', 'allow_always', 'deny']),
    message: z.string().optional(),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('answer_draft'),
    sessionId,
    requestId: z.string(),
    answers: z
      .object({ picked: z.record(z.string(), z.array(z.string())).default({}), other: z.record(z.string(), z.string()).default({}) })
      .default({ picked: {}, other: {} }),
  }),
  z.object({ type: z.literal('plan_draft'), sessionId, requestId: z.string(), plan: z.string() }),
  // Logged however odd it is: it's what went wrong in the page.
  z.object({
    type: z.literal('client_error'),
    message: z.string().catch(''),
    stack: z.string().optional().catch(undefined),
    url: z.string().catch(''),
  }),
  z.object({ type: z.literal('seen'), sessionId }),
  z.object({ type: z.literal('term_subscribe'), id: z.string() }),
  z.object({ type: z.literal('term_unsubscribe'), id: z.string() }),
  z.object({ type: z.literal('term_input'), id: z.string(), data: z.string() }),
  z.object({ type: z.literal('term_resize'), id: z.string(), cols: z.number(), rows: z.number() }),
  z.object({ type: z.literal('preview_url'), url: z.string() }),
]) satisfies ZodType<ClientEvent, unknown>

const TYPES = new Set<string>(CLIENT_EVENT.options.map((o) => o.shape.type.value))

/**
 * A browser's event, checked. Undefined for a type this hub doesn't know,
 * e.g. from a page newer than it, which is ignored; a known one that's
 * malformed is refused, saying why.
 */
export function parseClientEvent(raw: unknown): ClientEvent | undefined {
  const type = (raw as { type?: unknown } | null)?.type
  if (typeof type !== 'string' || !TYPES.has(type)) return undefined
  const parsed = CLIENT_EVENT.safeParse(raw)
  if (!parsed.success) throw new BadRequest(`Bad ${type}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'event'}: ${i.message}`).join('; ')}`)
  return parsed.data
}
