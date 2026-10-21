import { z, type ZodType } from 'zod'
import { PERMISSION_MODES, type ClientEvent, type DraftAttachments } from '../shared/protocol.ts'
import { BadRequest } from './errors.ts'
import { UUID, imageAttachment } from './runnerProtocol.ts'

// What the hub takes from browsers, checked before it's acted on. The types
// are shared/protocol.ts's; these say the same in zod, which the browser's
// bundle needn't carry.

const sessionId = z.string()
const mode = z.enum(PERMISSION_MODES)
/** A browser's or tab's own id. */
const id = z.string().regex(/^[\w-]{8,64}$/)
/** Something a browser says about itself: kept if it's a short enough string, dropped otherwise. */
const text = (max = 128) => z.string().max(max).optional().catch(undefined)

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
  z.object({
    type: z.literal('hello'),
    client: id,
    tab: id,
    info: z
      .object({
        userAgent: text(512),
        platform: text(),
        language: text(),
        timeZone: text(),
        screen: z.object({ width: z.number(), height: z.number(), dpr: z.number() }).optional().catch(undefined),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().catch(undefined),
        touch: z.boolean().optional().catch(undefined),
        standalone: z.boolean().optional().catch(undefined),
        build: text(),
      })
      .catch({}),
  }),
  z.object({
    type: z.literal('activity'),
    reason: z.string().max(32),
    visible: z.boolean(),
    focused: z.boolean(),
    idleMs: z.number().nonnegative().optional(),
    inputs: z.number().int().nonnegative().catch(0),
    keys: z.number().int().nonnegative().catch(0),
    route: z.string().max(32),
    sessionId: z.string().regex(UUID).optional(),
    cardId: z.number().int().optional(),
    views: z.array(z.string().max(256)).max(32).catch([]),
    pane: text(256),
  }),
  z.object({
    type: z.literal('ui_event'),
    name: z.string().max(64),
    sessionId: z.string().regex(UUID).optional(),
    data: z
      .record(z.string(), z.unknown())
      .refine((d) => JSON.stringify(d).length <= 4000, 'data is too big')
      .optional(),
  }),
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
