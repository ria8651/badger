import { Show, createEffect, on } from 'solid-js'
import type { PreviewView } from '../layout.ts'
import { previewUrl } from '../previews.ts'

/**
 * A port's preview in a frame. It's on an origin of its own, so the page
 * can't reach Badger. Badger can't see where it navigates either, so reloads
 * start again from the path it was opened at.
 */
export function PreviewFrame(props: { view: PreviewView; onReady: (focus: () => void) => void; class?: string }) {
  const url = () => previewUrl(props.view.id, props.view.path)
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
          <iframe
            ref={frame}
            title={props.view.name ?? `Port ${props.view.id}`}
            allow="clipboard-read; clipboard-write; fullscreen"
            class={`${props.class} block border-0 bg-white`}
          />
        )
      }}
    </Show>
  )
}
