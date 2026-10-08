import { createSignal } from 'solid-js'

/** Where folderless chats run, from the server's config. */
const [scratch, setScratch] = createSignal<string>()
export { setScratch }

export const isScratch = (cwd?: string) => !!cwd && cwd === scratch()

export const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

/** How a chat's directory is shown: its last segment, or "No folder" for scratch. */
export const folderLabel = (cwd: string) => (isScratch(cwd) ? 'No folder' : basename(cwd))

/** For directory pickers: scratch gets a description instead of its path. */
export const folderItem = (cwd: string) => ({
  label: folderLabel(cwd),
  description: isScratch(cwd) ? 'Quick questions, not tied to a repo' : cwd,
  mono: !isScratch(cwd),
})
