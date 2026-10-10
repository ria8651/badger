import { IMAGE_TYPES, type ImageAttachment } from '../shared/protocol.ts'

// The API takes images up to 5 MB (base64) and 8000px a side; bigger ones are scaled down to fit.
const MAX_BYTES = 3.75 * 1024 * 1024
const MAX_EDGE = 8000
const SCALED_EDGE = 2000

const isSendable = (type: string): type is ImageAttachment['mediaType'] => (IMAGE_TYPES as readonly string[]).includes(type)

export const imageUrl = (image: ImageAttachment) => `data:${image.mediaType};base64,${image.data}`

/** A pasted or dropped file as an image Claude can take, or undefined if it isn't an image. */
export async function readImage(file: File): Promise<ImageAttachment | undefined> {
  if (!file.type.startsWith('image/')) return undefined
  const bitmap = await createImageBitmap(file).catch(() => undefined)
  if (!bitmap) return undefined
  const fits = isSendable(file.type) && file.size <= MAX_BYTES && Math.max(bitmap.width, bitmap.height) <= MAX_EDGE
  if (fits) {
    bitmap.close()
    return { mediaType: file.type as ImageAttachment['mediaType'], data: await toBase64(file) }
  }
  // Too big, or a type the API doesn't take (like HEIC): redraw smaller, as PNG unless that's still too big.
  const scale = Math.min(1, SCALED_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  let blob = await canvas.convertToBlob({ type: 'image/png' })
  if (blob.size > MAX_BYTES) blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  return { mediaType: blob.type as ImageAttachment['mediaType'], data: await toBase64(blob) }
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).slice((reader.result as string).indexOf(',') + 1))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
