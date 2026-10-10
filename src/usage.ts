import { createSignal } from 'solid-js'
import type { AccountUsage } from '../shared/protocol.ts'
import { socket } from './api.ts'

/** The account's plan limits, kept current over the socket. */
const [account, setAccount] = createSignal<AccountUsage>()
export const accountUsage = account

socket.on((e) => {
  if (e.type === 'account_usage') setAccount(e.usage)
})

/** 2152 → 2.2k, 100420 → 100k, 1000000 → 1M. */
export function tokens(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`
  if (n >= 1e3) return `${+(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`
  return String(n)
}

/** When a limit resets: a time today, else a weekday this week, else a date. */
export function resets(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.getTime() - now.getTime() < 6 * 24 * 60 * 60 * 1000) {
    return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  }
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
