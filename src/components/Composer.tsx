import { For, Show, createEffect, createSignal, on, onCleanup, type JSX } from 'solid-js'
import { ArrowUp, ListChevronsDownUp, ListChevronsUpDown, Paperclip, SlidersHorizontal, Square } from '../icons'
import { isLongPaste } from '../../shared/pastes.ts'
import { IMAGE_EXTENSIONS, type Card, type DraftAttachments, type PermissionMode } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { isScratch } from '../folders.ts'
import { readImage } from '../images.ts'
import { detail, toggleDetail } from '../prefs.ts'
import type { Chat } from '../useChat.ts'
import { Attachments } from './Attachments.tsx'
import { FileBrowser } from './FileBrowser.tsx'
import { showError } from './Popover.tsx'
import { ContextMeter } from './Usage.tsx'
import { IconButton, Select, createDismiss, touch, type Option } from './ui.tsx'

export const MODES: Option<PermissionMode>[] = [
  { value: 'default', label: 'Ask before edits', description: 'Claude asks before changing files or running commands.' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'File edits go through; commands still ask.' },
  { value: 'auto', label: 'Auto', description: 'A classifier approves safe actions and asks about the rest.' },
  { value: 'plan', label: 'Plan', description: 'Read and propose only. Nothing changes until you approve.' },
  { value: 'bypassPermissions', label: 'Bypass permissions', description: 'Never asks. Anything can run.', tone: 'danger' },
]

/** What a chat's view can ask of its composer. */
export interface ComposerControls {
  focus: () => void
  /** Saves what's typed now rather than after the pause in typing. */
  flush: () => void
  /** Adds this to the end of what's typed as a Markdown quote, with the cursor after it. */
  quote: (text: string) => void
  /** Adds this Markdown to the end of what's typed as it is, e.g. code quoted from a file, with the cursor after it. */
  insert: (markdown: string) => void
}

/**
 * Where a message is written: text, pasted and dropped images, big pastes and files from the server, with the
 * mode and model beside it. What's typed is saved as a draft on the server after a pause in typing, and someone
 * else's edit to the draft never overwrites what's typed here and not yet saved.
 */
export function Composer(props: {
  chat: Chat
  machine: string
  cwd?: string
  /** It can't take messages: its folder is gone, or its runner offline. */
  disabled: boolean
  /** Claude is working, so a message queues and Escape or the button stops it. */
  working: boolean
  mode: PermissionMode
  onMode: (mode: PermissionMode) => void
  /** Unset until Claude Code has listed its models. */
  model?: string
  models: Option<string>[]
  onModel: (model: string) => void
  /** A card going out with the first message, shown as attached until then. */
  pendingCard?: { card: Card }
  /** Whether something's running that Ctrl+B can leave to the background. */
  canBackground: () => boolean
  onSubmit: (text: string, attachments: DraftAttachments) => void
  ref?: (controls: ComposerControls) => void
}) {
  const state = props.chat.state
  const [text, setText] = createSignal(state.draft)
  const attached = () => state.draftAttachments
  const pastes = () => attached().pastes
  const images = () => attached().images
  const hasInput = () => !!text().trim() || pastes().length > 0 || images().length > 0
  let input!: HTMLTextAreaElement
  let picker!: HTMLInputElement

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let unsaved = false
  const flush = () => {
    clearTimeout(saveTimer)
    if (!unsaved) return
    unsaved = false
    props.chat.saveDraft(text())
  }
  const edit = (value: string) => {
    setText(value)
    unsaved = true
    clearTimeout(saveTimer)
    saveTimer = setTimeout(flush, 300)
  }
  // The draft as saved, here or by another tab; what's typed here and not yet saved stays.
  createEffect(on(() => state.draft, (draft) => !unsaved && setText(draft)))
  addEventListener('pagehide', flush)
  onCleanup(() => {
    flush()
    removeEventListener('pagehide', flush)
  })
  const insert = (block: string) => {
    const before = text().trimEnd()
    edit(`${before ? `${before}\n\n` : ''}${block}\n\n`)
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
    input.scrollTop = input.scrollHeight
  }
  const quote = (quoted: string) =>
    insert(
      quoted
        .trim()
        .replace(/\n{3,}/g, '\n\n')
        .split('\n')
        .map((line) => (line.trim() ? `> ${line}` : '>'))
        .join('\n'),
    )
  props.ref?.({ focus: () => input.focus(), flush, quote, insert })

  const submit = () => {
    if (!hasInput()) return
    props.onSubmit(text().trim(), attached())
    clearTimeout(saveTimer)
    unsaved = false
    setText('')
    props.chat.clearDraft()
  }

  /** Adds the images among these files, and says whether there were any. */
  const addImages = (files: Iterable<File>) => {
    const found = [...files].filter((f) => f.type.startsWith('image/'))
    for (const f of found) void readImage(f).then((image) => image && props.chat.attach((a) => ({ ...a, images: [...a.images, image] })))
    return found.length > 0
  }
  /**
   * Files picked on the server: images go in as images, so Claude sees them straight away; the rest
   * go in the message as @-mentions, relative to the chat's folder, for Claude to read.
   */
  const attachFiles = (paths: string[]) => {
    const isImage = (path: string) => Object.values(IMAGE_EXTENSIONS).flat().some((ext) => path.toLowerCase().endsWith(ext))
    for (const path of paths.filter(isImage)) {
      const name = path.split('/').pop()!
      api
        .fileBlob(path, props.machine)
        .then((blob) => addImages([new File([blob], name, { type: blob.type })]))
        .catch((e: Error) => showError(`Couldn't attach ${name}`, e.message, input))
    }
    const dir = props.cwd && !isScratch(props.cwd) ? `${props.cwd}/` : undefined
    const mentions = paths
      .filter((path) => !isImage(path))
      .map((path) => (dir && path.startsWith(dir) ? path.slice(dir.length) : path))
      .map((path) => `@${/\s/.test(path) ? `"${path}"` : path}`)
    if (!mentions.length) return
    const at = input.selectionStart ?? text().length
    const before = text().slice(0, at)
    const after = text().slice(at)
    edit(`${before}${before && !/\s$/.test(before) ? ' ' : ''}${mentions.join(' ')} ${after.replace(/^ /, '')}`)
  }

  const [dragging, setDragging] = createSignal(false)
  const [browsing, setBrowsing] = createSignal(false)
  /** The panel a narrow composer keeps its mode, model and the rest in. */
  const [more, setMore] = createSignal(false)
  let moreButton!: HTMLButtonElement
  let morePanel: HTMLDivElement | undefined
  createDismiss(more, () => [morePanel, moreButton], () => setMore(false), { escape: true })

  return (
    <div
      inert={props.disabled}
      class={`@container relative border shadow-(--shadow-card) transition-colors rounded-2xl focus-within:border-fg-3 ${dragging() ? 'border-fg-3' : 'border-edge'} ${props.disabled ? 'opacity-50' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={(e) => {
        setDragging(false)
        if (!e.dataTransfer?.files.length) return
        e.preventDefault()
        addImages(e.dataTransfer.files)
        input.focus()
      }}
    >
      <Show when={more()}>
        <ComposerPanel
          ref={(el) => (morePanel = el)}
          mode={props.mode}
          onMode={props.onMode}
          model={props.model}
          models={props.models}
          onModel={props.onModel}
          onClose={() => setMore(false)}
        />
      </Show>
      <Show when={pastes().length || images().length || props.pendingCard}>
        <Attachments
          pastes={pastes()}
          images={images()}
          card={props.pendingCard}
          onRemovePaste={(i) => props.chat.attach((a) => ({ ...a, pastes: a.pastes.filter((_, j) => j !== i) }))}
          onRemoveImage={(i) => props.chat.attach((a) => ({ ...a, images: a.images.filter((_, j) => j !== i) }))}
          class="px-3 pt-3"
        />
      </Show>
      <textarea
        ref={input}
        value={text()}
        onInput={(e) => edit(e.currentTarget.value)}
        onPaste={(e) => {
          // Images and big pastes become attachments, so the composer stays editable.
          // Office apps copy text with a picture of it too; the text is what's wanted then.
          const pasted = e.clipboardData?.getData('text/plain')
          if (!pasted && e.clipboardData && addImages(e.clipboardData.files)) return e.preventDefault()
          if (!pasted || !isLongPaste(pasted)) return
          e.preventDefault()
          props.chat.attach((a) => ({ ...a, pastes: [...a.pastes, pasted] }))
        }}
        onKeyDown={(e) => {
          // Phone keyboards have no Shift+Enter, so there Enter is a newline and the button sends.
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch.matches) {
            e.preventDefault()
            submit()
          }
          if (e.key === 'Escape' && props.working) props.chat.interrupt()
          // Each subagent and command has its own button; this sends every one at once.
          if (e.key === 'b' && e.ctrlKey && !e.metaKey && props.canBackground()) {
            e.preventDefault()
            props.chat.background()
          }
        }}
        rows={Math.min(10, Math.max(2, text().split('\n').length))}
        placeholder={state.running ? 'Queue a message' : 'Message Claude'}
        class="block max-h-[calc(10lh+0.875rem)] min-h-[calc(2lh+0.875rem)] w-full resize-none bg-transparent px-4 pt-3.5 text-message leading-relaxed outline-none pointer-coarse:text-base [field-sizing:content] placeholder:text-fg-3"
      />
      {/* A narrow composer keeps attaching and sending in the bar and puts the rest in a panel; wide ones show it all.
          Measured on the composer, not the screen, so the sidebar squeezing it counts too. */}
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pb-2">
        <div class="hidden items-center gap-2 @md:flex">
          <Select value={props.mode} options={MODES} onChange={props.onMode} title="Permission mode" />
          <Show when={props.model}>{(model) => <Select value={model()} options={props.models} onChange={props.onModel} title="Model" />}</Show>
        </div>
        <button
          type="button"
          onClick={() => setBrowsing(true)}
          title="Attach files"
          class="flex h-7 items-center rounded-button-md px-2 text-fg-3 transition-colors hover:bg-surface hover:text-fg-2 pointer-coarse:h-9"
        >
          <Paperclip class="size-3.5" />
        </button>
        <Show when={browsing()}>
          <FileBrowser
            mode="files"
            title="Attach files"
            machine={props.machine}
            start={props.cwd && !isScratch(props.cwd) ? props.cwd : undefined}
            onClose={() => {
              setBrowsing(false)
              input.focus()
            }}
            onUpload={() => picker.click()}
            onPickFiles={attachFiles}
          />
        </Show>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          class="hidden"
          onChange={(e) => {
            addImages(e.currentTarget.files ?? [])
            e.currentTarget.value = ''
            input.focus()
          }}
        />
        <div class="hidden items-center gap-2 @md:flex">
          <button
            type="button"
            onClick={toggleDetail}
            title={detail() === 'full' ? 'Show results only' : 'Show all work'}
            class="flex h-7 items-center rounded-button-md px-2 text-fg-3 transition-colors hover:bg-surface hover:text-fg-2 pointer-coarse:h-9"
          >
            {/* Shows what a click does, like play/pause: fold the work away or expand it. */}
            <Show when={detail() === 'full'} fallback={<ListChevronsUpDown class="size-3.5" />}>
              <ListChevronsDownUp class="size-3.5" />
            </Show>
          </button>
        </div>
        <button
          ref={moreButton}
          type="button"
          onClick={() => setMore((o) => !o)}
          title="Mode, model and more"
          aria-expanded={more()}
          class={`flex h-7 items-center rounded-button-md px-2 transition-colors hover:bg-surface hover:text-fg-2 pointer-coarse:h-9 @md:hidden ${
            props.mode === 'bypassPermissions' ? 'text-danger' : more() ? 'bg-surface text-fg-2' : 'text-fg-3'
          }`}
        >
          <SlidersHorizontal class="size-3.5" />
        </button>
        <div class="ml-auto flex items-center gap-2">
          <Show when={state.context}>{(u) => <ContextMeter usage={u()} />}</Show>
          {/* One slot: stop while running with nothing typed, otherwise send. */}
          <Show
            when={props.working && !hasInput()}
            fallback={
              <IconButton onClick={submit} disabled={!hasInput()} title="Send (Enter)">
                <ArrowUp class="size-4" />
              </IconButton>
            }
          >
            <IconButton onClick={props.chat.interrupt} title="Stop (Esc)">
              <Square class="size-3 fill-current" />
            </IconButton>
          </Show>
        </div>
      </div>
    </div>
  )
}

/**
 * What a narrow composer's toolbar has no room for, in a panel above it as wide as the composer:
 * mode, model and how much work to show. Terminals and the chat's actions are in the header.
 */
function ComposerPanel(props: {
  ref: (el: HTMLDivElement) => void
  mode: PermissionMode
  onMode: (mode: PermissionMode) => void
  /** Unset until Claude Code has listed its models. */
  model?: string
  models: Option<string>[]
  onModel: (model: string) => void
  onClose: () => void
}) {
  const pick = (f: () => void) => () => {
    f()
    props.onClose()
  }
  return (
    <div
      ref={props.ref}
      class="absolute inset-x-0 bottom-full z-10 mb-2 max-h-[70vh] origin-bottom animate-[pop-in_120ms_ease-out] overflow-y-auto rounded-2xl border border-edge bg-bg p-1 pop shadow-(--shadow-pop)"
    >
      <PanelChoices label="Permission mode" options={MODES} value={props.mode} onPick={props.onMode} />
      <Show when={props.model}>
        {(model) => <PanelChoices label="Model" options={props.models} value={model()} onPick={props.onModel} />}
      </Show>
      <div class="mx-2.5 my-1 border-t border-line" />
      <PanelButton onClick={pick(toggleDetail)}>
        <Show when={detail() === 'full'} fallback={<ListChevronsUpDown class="size-4" />}>
          <ListChevronsDownUp class="size-4" />
        </Show>
        {detail() === 'full' ? 'Show results only' : 'Show all work'}
      </PanelButton>
    </div>
  )
}

/** One setting's options as chips, with what the current one means underneath. Picking one leaves the panel open. */
function PanelChoices<T extends string>(props: { label: string; options: Option<T>[]; value: T; onPick: (value: T) => void }) {
  const current = () => props.options.find((o) => o.value === props.value)
  return (
    <div class="px-2.5 pt-2.5 pb-2">
      <div class="pb-2 text-meta text-fg-3">{props.label}</div>
      <div class="flex flex-wrap gap-1.5">
        <For each={props.options}>
          {(o) => (
            <button
              type="button"
              onClick={() => props.onPick(o.value)}
              aria-pressed={o.value === props.value}
              class={`h-9 rounded-button-round border px-3 text-ui transition-colors ${
                o.value === props.value
                  ? o.tone === 'danger'
                    ? 'border-danger bg-danger/10 text-danger'
                    : 'border-fg-3 bg-surface text-fg'
                  : `border-edge hover:bg-surface ${o.tone === 'danger' ? 'text-danger' : 'text-fg-2 hover:text-fg'}`
              }`}
            >
              {o.label}
            </button>
          )}
        </For>
      </div>
      <Show when={current()?.description}>
        <p class="mt-2 text-xs leading-snug text-fg-3">{current()!.description}</p>
      </Show>
    </div>
  )
}

function PanelButton(props: { onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class="flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left text-ui text-fg-2 transition-colors hover:bg-surface hover:text-fg"
    >
      {props.children}
    </button>
  )
}
