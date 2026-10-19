import { Show, type Accessor } from 'solid-js'
import { FileText } from '../icons'
import { PasteBody, type ContextChip } from '../components/Attachments.tsx'
import { plural } from '../format.ts'
import { NONE } from './context.ts'
import { contextChip } from './items.tsx'
import { buildView, type Index } from './model.ts'

/* What went in with a prompt, looked up by reference for a panel beside the chat. */

/** The chat's own conversation's view, built once per index for the panels that look into it. */
const ownViews = new WeakMap<Index, ReturnType<typeof buildView>>()

/** Something that went in with a prompt, by the prompt's message and `part`: `paste:<n>` or `context:<n>`. */
export function attachmentOf(index: Index, prompt: string, part: string): ContextChip | undefined {
  let view = ownViews.get(index)
  if (!view) ownViews.set(index, (view = buildView(index.groups.get('') ?? NONE, false)))
  const item = [...view.promptIds].find(([, id]) => id === prompt)?.[0]
  if (item?.kind !== 'user') return
  const [type, n] = part.split(':')
  if (type === 'paste') {
    const text = item.pastes?.[Number(n)]
    return text === undefined ? undefined : pasteChip(text)
  }
  const chip = view.extras.get(item)?.chips[Number(n)]
  return chip && contextChip(chip)
}

const pasteChip = (text: string): ContextChip => ({
  icon: FileText,
  label: 'Pasted text',
  meta: plural(text.split('\n').length, 'line'),
  body: () => <PasteBody text={text} />,
})

/** Something sent with a prompt, in a panel of its own. */
export function AttachmentPane(props: { index: Accessor<Index>; prompt: string; part: string; onReady: (focus: () => void) => void }) {
  const attachment = () => attachmentOf(props.index(), props.prompt, props.part)
  return (
    <div ref={(el) => props.onReady(() => el.focus({ preventScroll: true }))} tabIndex={-1} class="size-full overflow-y-auto outline-none">
      <div class="mx-auto max-w-[46rem] px-6 pt-3 pb-8 text-ui text-fg-2">
        <Show when={attachment()} fallback={<p class="text-xs text-fg-3">This isn’t in the chat any more.</p>}>
          {(a) => a().body()}
        </Show>
      </div>
    </div>
  )
}
