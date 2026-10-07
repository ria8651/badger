# Badger

A web chat interface for Claude Code running on a server. The browser talks to a Node server over a WebSocket; the server drives Claude Code through the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

## Running

```bash
cp .env.example .env   # set WORKSPACE_DIR
pnpm install
pnpm dev               # server on :3001, Vite on :5173
```

Production: `pnpm build && pnpm start` (the server serves `dist/` itself).

Claude auth comes from `ANTHROPIC_API_KEY` if set, otherwise from the server user's existing `claude` login.

## How it works

- **One live Claude Code process per chat** (`server/session.ts`). `query()` is fed by an async queue (`server/queue.ts`), so the process persists between turns and messages sent mid-turn are delivered at the next break. Idle processes close after 15 minutes; the next message resumes the session from disk.
- **Transcripts stay with Claude Code.** They live where Claude Code puts them (`~/.claude/projects`). The session list and history come from the SDK's `listSessions` / `getSessionMessages`, so CLI sessions show up too.
- **Cards in SQLite.** Project management (a board of cards, each holding chats from any repo) lives in `DATA_DIR/badger.db` via `node:sqlite` (`server/db.ts`). Cards sit above repos, so nothing is committed to one. Writes broadcast `cards_changed` so every tab refetches.
- **Claude can use the board.** Every chat gets an in-process MCP server (`server/boardTools.ts`) with tools to list, read, create and update cards and to link itself to a card. These are pre-approved; `delete_card` goes through the normal permission flow. When a chat is on a card, a `UserPromptSubmit` hook also adds the card's current state to the next turn, but only when it has changed since that chat last saw it (tracked by hash in the database, so restarts don't repeat it). It goes into the conversation rather than the system prompt, so it never invalidates the prompt cache.
- **Permissions in the browser.** `canUseTool` parks each request until a client answers. In auto mode Claude Code's classifier approves or denies calls itself and only the ones it can't decide reach the browser. `AskUserQuestion` and `ExitPlanMode` get dedicated UIs. Pending prompts survive reloads via the snapshot sent on subscribe.
- **Multi-tab.** Any number of sockets can view a session; all receive the same stream.

Protocol types: `shared/protocol.ts`.

## Security

The server can run arbitrary commands as its user. It binds to `127.0.0.1` by default and has no authentication yet, so don't expose it beyond localhost.
