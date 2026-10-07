# Badger

A web chat interface for Claude Code running on a server. The browser talks to a Node server over a WebSocket; the server drives Claude Code through the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

## Running

```bash
cp .env.example .env   # set WORKSPACE_DIR, and AUTH_TOKEN if exposing beyond localhost
pnpm install
pnpm dev               # server on :3001, Vite on :5173
```

Production: `pnpm build && pnpm start` (the server serves `dist/` itself).

Claude auth comes from `ANTHROPIC_API_KEY` if set, otherwise from the server user's existing `claude` login.

## How it works

- **One live Claude Code process per chat** (`server/session.ts`). `query()` is fed by an async queue (`server/queue.ts`), so the process persists between turns and messages sent mid-turn are delivered at the next break. Idle processes close after 15 minutes; the next message resumes the session from disk.
- **No database.** Transcripts live where Claude Code puts them (`~/.claude/projects`). The session list and history come from the SDK's `listSessions` / `getSessionMessages`, so CLI sessions show up too.
- **Permissions in the browser.** `canUseTool` parks each request until a client answers. `AskUserQuestion` and `ExitPlanMode` get dedicated UIs. Pending prompts survive reloads via the snapshot sent on subscribe.
- **Multi-tab.** Any number of sockets can view a session; all receive the same stream.

Protocol types: `shared/protocol.ts`.

## Security

The server can run arbitrary commands as its user. It binds to `127.0.0.1` by default; set `AUTH_TOKEN` and put it behind TLS before exposing it.
