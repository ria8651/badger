import { Show, createEffect, on } from 'solid-js'
import type { PreviewView } from '../layout.ts'
import { LOCAL, machineName } from '../machines.ts'
import { previewUrl } from '../previews.ts'

/**
 * A port's preview in a frame. It's on an origin of its own, so the page
 * can't reach Badger. Badger can't see where it navigates either, so reloads
 * start again from the path it was opened at. Another machine's port is at
 * its own localhost, so it only shows in a browser on that machine.
 */
export function PreviewFrame(props: { view: PreviewView; machine: string; onReady: (focus: () => void) => void; class?: string }) {
  const url = () => previewUrl(props.view.id, props.view.path, props.machine)
  return (
    <Show
      when={url()}
      fallback={
        <p class={`${props.class} flex items-center justify-center p-6 text-center text-[13px] text-fg-3`}>
          Previews need Badger on a host name, not an IP address: each port gets its own subdomain.
        </p>
      }
    >
      {(src) => {
        let frame!: HTMLIFrameElement
        // Setting src again reloads even when it's unchanged, which is what nav is for.
        createEffect(on([src, () => props.view.nav], () => (frame.src = src())))
        props.onReady(() => frame.focus())
        return (
          <div class={`${props.class} flex flex-col`}>
            <Show when={props.machine !== LOCAL}>
              <p class="shrink-0 truncate px-3 py-1 text-[11px] text-fg-3" title={src()}>
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
