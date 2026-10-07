import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, FolderOpen, Square } from 'lucide-react'
import type { PermissionMode } from '../../shared/protocol.ts'
import { socket } from '../api.ts'
import { useChat } from '../useChat.ts'
import { PermissionPrompt } from './PermissionPrompt.tsx'
import { Transcript } from './Transcript.tsx'

const MODES: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Ask before edits' },
  { value: 'acceptEdits', label: 'Auto-accept edits' },
  { value: 'plan', label: 'Plan mode' },
  { value: 'bypassPermissions', label: 'Bypass permissions' },
]

export function Chat({ sessionId, draftCwd }: { sessionId: string; draftCwd?: string }) {
  const { state, clearError } = useChat(sessionId)
  const [text, setText] = useState('')
  const [mode, setMode] = useState<PermissionMode>('default')
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const cwd = state.cwd ?? draftCwd

  useEffect(() => setMode(state.mode), [state.mode])

  // Follow new output only while the user is already at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [state.messages, state.partial, state.permissions])

  const submit = () => {
    const value = text.trim()
    if (!value) return
    socket.send({ type: 'send', sessionId, text: value, cwd, mode })
    setText('')
    pinned.current = true
  }

  const changeMode = (next: PermissionMode) => {
    setMode(next)
    socket.send({ type: 'set_mode', sessionId, mode: next })
  }

  const empty = state.loaded && state.messages.length === 0

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 text-sm dark:border-zinc-800">
        <FolderOpen className="size-4 shrink-0 text-zinc-400" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-500">{cwd ?? '…'}</span>
        {state.running && <span className="text-xs text-accent">Working…</span>}
      </header>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="flex-1 overflow-y-auto"
      >
        <div className="mx-auto max-w-3xl px-4 py-6">
          {empty ? (
            <div className="pt-[20vh] text-center text-zinc-400">
              <p className="text-lg">What are we working on?</p>
              <p className="mt-1 font-mono text-xs">{cwd}</p>
            </div>
          ) : (
            <Transcript messages={state.messages} partial={state.partial} running={state.running} cwd={cwd} />
          )}
          {state.running && !state.partial && state.permissions.length === 0 && (
            <div className="mt-3 flex gap-1">
              {[0, 150, 300].map((d) => (
                <span key={d} className="size-1.5 animate-bounce rounded-full bg-accent" style={{ animationDelay: `${d}ms` }} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl space-y-2 px-4 pb-4">
        {state.permissions.map((p) => (
          <PermissionPrompt key={p.requestId} sessionId={sessionId} permission={p} cwd={cwd} />
        ))}
        {state.error && (
          <div className="flex items-start justify-between gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            <span>{state.error}</span>
            <button onClick={clearError} className="text-xs underline">Dismiss</button>
          </div>
        )}
        <div className="rounded-2xl border border-zinc-300 bg-white shadow-sm focus-within:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
              if (e.key === 'Escape' && state.running) socket.send({ type: 'interrupt', sessionId })
            }}
            rows={Math.min(10, Math.max(2, text.split('\n').length))}
            placeholder={state.running ? 'Queue a message for Claude…' : 'Message Claude…'}
            className="block w-full resize-none bg-transparent px-4 pt-3 outline-none placeholder:text-zinc-400"
            autoFocus
          />
          <div className="flex items-center gap-2 px-2 pb-2">
            <select
              value={mode}
              onChange={(e) => changeMode(e.target.value as PermissionMode)}
              className="rounded-md bg-transparent px-2 py-1 text-xs text-zinc-600 outline-none hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <div className="flex-1" />
            {state.running && (
              <button
                onClick={() => socket.send({ type: 'interrupt', sessionId })}
                title="Stop (Esc)"
                className="rounded-full border border-zinc-300 p-2 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            )}
            <button
              onClick={submit}
              disabled={!text.trim()}
              title="Send (Enter)"
              className="rounded-full bg-accent p-2 text-white disabled:opacity-30"
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
