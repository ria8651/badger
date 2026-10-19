import { Show, createEffect, on, onCleanup, untrack } from 'solid-js'
import type { PreviewView } from '../layout.ts'
import { LOCAL, machineName } from '../machines.ts'
import { previewUrl } from '../previews.ts'

/** What the bridge in a preview's page tells the frame around it when it goes somewhere (see server/bridge-page.js). */
const MOVED = 'badger:preview-location'

/**
 * A port's preview in a frame. It's on an origin of its own, so the page
 * can't reach Badger, but the bridge in it says where it's gone, so a reload
 * comes back there. Another machine's port is at its own localhost, without
 * the bridge, so it only shows in a browser on that machine, and reloads
 * start again from where it was opened.
 */
export function PreviewFrame(props: {
  view: PreviewView
  machine: string
  onMove: (path: string) => void
  onReady: (focus: () => void) => void
  class?: string
}) {
  const url = () => previewUrl(props.view.id, props.view.path, props.machine)
  return (
    <Show
      when={url()}
      fallback={
        <p class={`${props.class} flex items-center justify-center p-6 text-center text-ui text-fg-3`}>
          Previews need Badger on a host name, not an IP address: each port gets its own subdomain.
        </p>
      }
    >
      {(src) => {
        let frame!: HTMLIFrameElement
        // Setting src again reloads even when it's unchanged, which is what nav is for. The page
        // going somewhere changes src too, but it's already there.
        createEffect(on(() => props.view.nav, () => (frame.src = untrack(src))))
        const moved = (e: MessageEvent) => {
          if (e.source !== frame.contentWindow || e.data?.type !== MOVED || typeof e.data.path !== 'string') return
          if (e.origin === new URL(src()).origin && e.data.path.startsWith('/')) props.onMove(e.data.path)
        }
        addEventListener('message', moved)
        onCleanup(() => removeEventListener('message', moved))
        props.onReady(() => frame.focus())
        return (
          <div class={`${props.class} flex flex-col`}>
            <Show when={props.machine !== LOCAL}>
              <p class="shrink-0 truncate px-3 py-1 text-meta text-fg-3" title={src()}>
                Served on {machineName(props.machine)}: opens at localhost there
              </p>
            </Show>
            <iframe
              ref={frame}
              title={props.view.name ?? `Port ${props.view.id}`}
              allow="clipboard-write; fullscreen"
              class="block min-h-0 w-full flex-1 border-0 bg-white"
            />
          </div>
        )
      }}
    </Show>
  )
}
