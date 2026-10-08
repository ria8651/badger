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
- **Chats without a folder.** Claude Code always needs a working directory, so "No folder" chats run in `SCRATCH_DIR` (default `~/.badger/scratch`, outside any repo). It's created on startup with a `CLAUDE.md` saying there's no codebase. It's the default for new chats, and these chats get no terminals.
- **Cards in SQLite.** Project management (a board of cards, each holding chats from any repo) lives in `DATA_DIR/badger.db` via `node:sqlite` (`server/db.ts`). Cards sit above repos, so nothing is committed to one. Writes broadcast `cards_changed` so every tab refetches.
- **Claude can use the board.** Every chat gets an in-process MCP server (`server/boardTools.ts`) with tools to list, read, create and update cards and to link itself to a card. These are pre-approved; `delete_card` goes through the normal permission flow. When a chat is on a card, a `UserPromptSubmit` hook also adds the card's current state to the next turn, but only when it has changed since that chat last saw it (tracked by hash in the database, so restarts don't repeat it). It goes into the conversation rather than the system prompt, so it never invalidates the prompt cache.
- **Permissions in the browser.** `canUseTool` parks each request until a client answers. In auto mode Claude Code's classifier approves or denies calls itself and only the ones it can't decide reach the browser. `AskUserQuestion` and `ExitPlanMode` get dedicated UIs. Pending prompts survive reloads via the snapshot sent on subscribe.
- **Multi-tab.** Any number of sockets can view a session; all receive the same stream.
- **Terminals outlive the server.** PTYs live in a separate detached process (`server/ptyHost.ts`, reached over `DATA_DIR/pty.sock`, log in `DATA_DIR/pty-host.log`), so shells and dev servers keep running when the Badger server restarts. The server starts the host when there isn't one; the host exits once it has neither terminals nor a server. A headless xterm per terminal tracks the screen, so a viewer that attaches or reloads gets an exact repaint (`term_snapshot`) before live output, and Claude reads output as plain text. Terminals get the environment Badger started with, minus what pnpm and `.env` add.
- **Terminals belong to a workspace, not a chat.** Each is grouped by the git root of its directory (each worktree is its own), and every chat in that workspace shows the same dock (Ctrl+`). The sidebar lists all of them; `/t/:id` shows one full page. Closing a tab or restarting kills the process tree, not just the shell.
- **Claude can use the terminals.** A second in-process MCP server (`server/terminalTools.ts`) lists, reads, starts, types into, restarts and stops terminals, with an optional `wait_for` regex so Claude can restart a dev server and wait until it's up. Reading is pre-approved; the rest goes through the normal permission flow.

Protocol types: `shared/protocol.ts`.

## Security

The server can run arbitrary commands as its user. It binds to `127.0.0.1` by default and has no authentication yet, so don't expose it beyond localhost.
