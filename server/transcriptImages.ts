import type { WireMessage } from '../shared/protocol.ts'

type Block = { type?: string; source?: { type?: string; media_type?: string; data?: string; url?: string }; content?: unknown }
type Base64Image = Block & { source: { type: 'base64'; media_type?: string; data: string } }

export const IMAGE_PATH = /^\/api\/chats\/([0-9a-f-]{36})\/images\/([0-9a-f-]{36})\/(\d+)$/

/**
 * A message's content with each base64 image passed through `swap`, numbered
 * in order, tool results' images included. Content without images comes back as it was.
 */
function mapImages(content: unknown, swap: (image: Base64Image, n: number) => Block): unknown {
  let n = 0
  const walk = (content: unknown): unknown => {
    if (!Array.isArray(content)) return content
    const out = content.map((b: Block) => {
      if (b?.type === 'tool_result') {
        const inner = walk(b.content)
        return inner === b.content ? b : { ...b, content: inner }
      }
      return b?.type === 'image' && b.source?.type === 'base64' && b.source.data ? swap(b as Base64Image, n++) : b
    })
    return out.some((b, i) => b !== content[i]) ? out : content
  }
  return walk(content)
}

/**
 * Chat history with its images as URLs rather than inline. A chat that took a
 * lot of screenshots holds megabytes of base64, which would all have to arrive
 * before the chat shows; as URLs, the browser fetches each one when it's on
 * screen. A URL names the message and which of its images it is, so the image
 * is read from the hub's copy of the transcript when it's asked for.
 *
 * @param served whether the hub has a message's line to serve its images from.
 * Without it, as for a message only just sent, they stay inline.
 */
export function externalizeImages(sessionId: string, messages: WireMessage[], served: (uuid: string) => boolean = () => true): WireMessage[] {
  return messages.map((m) => {
    const message = m.message as { content?: unknown } | undefined
    let inline: boolean | undefined
    const content = mapImages(message?.content, (b, n) => {
      inline ??= !m.uuid || !served(m.uuid)
      return inline ? b : { ...b, source: { type: 'url', media_type: b.source.media_type, url: `/api/chats/${sessionId}/images/${m.uuid}/${n}` } }
    })
    // A Read of an image has it again in the structured result, which the client doesn't use.
    const result = m.tool_use_result as { file?: { base64?: string } } | undefined
    const stripped = result?.file?.base64 ? { ...result, file: { ...result.file, base64: undefined } } : undefined
    if (content === message?.content && !stripped) return m
    return { ...m, message: { ...message, content }, ...(stripped ? { tool_use_result: stripped } : {}) }
  })
}

/** The nth image in a transcript entry, as externalizeImages numbered them. */
export function entryImage(
  entry: { message?: { content?: unknown }; attachment?: { prompt?: unknown } },
  n: number,
): { mediaType: string; data: Buffer } | undefined {
  let found: Base64Image | undefined
  // A message sent while Claude was busy is a queued_command attachment, which the SDK's reader turns into a message.
  mapImages(entry.message?.content ?? entry.attachment?.prompt, (b, i) => {
    if (i === n) found = b
    return b
  })
  return found && { mediaType: found.source.media_type ?? '', data: Buffer.from(found.source.data, 'base64') }
}
