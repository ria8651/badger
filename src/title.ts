import { createEffect } from 'solid-js'
import { needsYou } from './attention.ts'

/**
 * Keeps the tab's title and icon current: the page first, since tabs cut titles short, after how many chats need
 * the user, and a dot on the icon for when the count is cut off too. Home has no page title.
 */
export function useDocumentTitle(page: () => string) {
  createEffect(() => {
    document.title = `${needsYou() ? `(${needsYou()}) ` : ''}${page() ? `${page()} · ` : ''}Badger`
  })
  createEffect(() => {
    document.querySelector<HTMLLinkElement>('link[rel=icon]')!.href = needsYou() ? '/favicon-alert.svg' : '/favicon.svg'
  })
}
