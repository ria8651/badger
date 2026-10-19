import { Show } from 'solid-js'
import type { Card, SessionSummary } from '../../shared/protocol.ts'
import { attention } from '../attention.ts'
import { folderLabel } from '../folders.ts'
import { isOnline, onMachine } from '../machines.ts'
import { ChatDot } from './ui.tsx'

/**
 * A chat as the sidebar lists it: its title and state, then its folder, card and when it last changed. Anywhere else
 * that lists chats uses it too, so they read the same everywhere.
 */
export function ChatSummary(props: {
  session: SessionSummary
  card?: Card
  /** The title's colour, which depends on where it's shown. */
  titleClass: string
  timeClass?: string
  /** The folder, card and time line's, e.g. to leave room for buttons over its end. */
  metaClass?: string
}) {
  const s = () => props.session
  return (
    <>
      <div class="flex items-center gap-2">
        <span class={`min-w-0 flex-1 truncate text-ui ${props.titleClass}`}>{s().title}</span>
        <ChatDot running={s().running} attention={attention()[s().id]} />
      </div>
      <div class={`mt-0.5 flex gap-1.5 text-meta text-fg-3 tabular-nums ${props.metaClass ?? ''}`}>
        <span class="truncate">{s().cwd && folderLabel(s().cwd!)}</span>
        <Show when={onMachine(s().machine)}>{(name) => <MachineName machine={s().machine} name={name()} />}</Show>
        <Show when={props.card}>{(c) => <span class="shrink-0">#{c().id}</span>}</Show>
        <span class={`ml-auto shrink-0 ${props.timeClass ?? ''}`}>{when(s().lastModified)}</span>
      </div>
    </>
  )
}

/** Which runner something's on, struck through while it's offline. */
export function MachineName(props: { machine?: string; name: string; class?: string }) {
  return (
    <span class={`shrink-0 ${isOnline(props.machine) ? '' : 'line-through'} ${props.class ?? ''}`} title={isOnline(props.machine) ? undefined : 'Offline'}>
      {props.name}
    </span>
  )
}

/** Time today, day and month this year, full date otherwise. */
function when(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
