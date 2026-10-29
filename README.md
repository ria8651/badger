<h1 align="center">
  <img src="public/favicon.svg" alt="" width="72"><br>
  Badger
</h1>

<p align="center">
  Claude Code in your browser, running on your own machine.<br>
  Chats, terminals, dev server previews and a project board in one tab.
</p>

<p align="center">
  <img src="docs/screenshots/chat.png" alt="A chat beside a terminal running a dev server, with the dev server previewed in a panel (Badger, inside Badger)" width="900">
</p>

Badger is a web UI for [Claude Code](https://claude.com/claude-code) that runs on a server: your laptop, a NAS or a box in the cupboard. Start a chat from your phone, close the tab, and pick it up at your desk. Every chat is a real Claude Code session, so your `CLAUDE.md`, settings, hooks, skills and MCP servers all work.

## Features

- **The full Claude Code.** Driven through the [Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), not a reimplementation. Plan mode, auto mode, model picker, images, queued messages.
- **Terminals beside the chat.** Tiled around the conversation. Claude can start, read and restart them, and wait for a dev server to come up.
- **Previews.** Anything listening on a port opens in a panel at `<port>.your-host`, hot reload included. Claude can look into the page you have open, run code in it, read its console and screenshot it, so "this bit's broken" is enough to go on. It can also check pages itself in a headless Chromium (in the Docker image).
- **A project board.** Cards hold chats from any repo. Claude can read and update the board, and the radar shows what needs you across every project.
- **Runners on other machines.** One Badger (the hub, e.g. on a NAS) can run chats and terminals on your laptops too, next to their files, so everyone shares one board while big builds stay local.
- **Tools and scripts.** Everything Claude can do in Badger is both a tool and a function it can script with the `run_script` tool: `await badger.cards.list({ status: "review" })`, so bulk changes are one loop instead of dozens of calls.
- **Worktrees.** Run several chats on one repo side by side, each in its own git worktree, and merge one back with a button.
- **Subagents and background tasks.** Each subagent is a chat nested in yours: watch it work, open it beside the chat to message it, and stop or background it. Running ones are listed under their chat in the sidebar.
- **Permissions in the browser.** Approve tool calls, answer Claude's questions and review plans from any tab or your phone, with notifications when something's waiting.

## Screenshots

| | |
|---|---|
| <img src="docs/screenshots/agents.png" alt="Three subagents running in the background, one open in a pane with its report"> | <img src="docs/screenshots/question.png" alt="Claude asking a multiple-choice question in the chat"> |
| **Subagents**: watch them work, open one in a pane | **Questions and permissions**: answer from any tab |

<p align="center">
  <img src="docs/screenshots/board.png" alt="A project board with backlog, to do, in progress, review and done columns" width="900"><br>
  <b>Projects</b>: a board of cards, each holding its chats. Claude can read and update it too.
</p>

## Quick start

### Docker / Podman

```bash
mkdir badger && docker compose up -d   # on :3001
```

That pulls `ghcr.io/ria8651/badger` (amd64 and arm64). Open a terminal in Badger and log in once with `claude`, `gh auth login` and `git config --global …`. Everything persists in `./badger`: logins, transcripts, the database and your repos (in `~/code`).

### From source

```bash
cp .env.example .env   # set WORKSPACE_DIR
pnpm install
pnpm dev               # server on :3001, Vite on :5173
```

Production: `pnpm build && pnpm start`. Claude auth comes from `ANTHROPIC_API_KEY` if set, otherwise from the server user's `claude` login.

### Runners on other machines

Chats and terminals can run on other machines too, next to their files, while the board, chat list and terminals stay in the one Badger (the **hub**). In Settings (the gear in the sidebar) → Runners, click **Add runner** and run the command it shows from a Badger checkout on the other machine:

```bash
pnpm remote --hub https://badger.example.com --token badger_… [--workspace ~/code]
```

It connects out to the hub (so NAT is fine), reconnects whenever the connection drops, and uses that machine's own `claude` login. New chats pick a runner and a folder on it; a chat stays on the runner it started on. While a runner is offline its chats can still be read but not run. Previews of a runner's ports open at `localhost` there, so only a browser on that machine shows them, and Claude can't drive those pages. Runner data (the PTY host's socket) goes in `~/.badger/runner`.

## Security

**Badger runs commands as its user and has no login of its own.** It binds to `127.0.0.1` by default. To reach it from elsewhere, put it behind a proxy that handles auth, such as [bastion](https://github.com/ria8651/bastion).

<details>
<summary>Self-hosting notes</summary>

- Proxies must pass WebSocket upgrades on `/ws` and keep the `Host` header. If runners on other machines connect to it, let `/runner` through without a login too (with WebSocket upgrades): runners authenticate with their own token, which the hub keeps hashed.
- For previews, also send `*.<Badger's host>` to it (a wildcard DNS record, certificate and proxy route, behind the same auth), with WebSocket upgrades on any path. Previews only work when the browser reaches Badger by host name, not by IP address. Badger adds a small script to preview pages (served from `/__badger/`) so Claude can reach them; it loosens the page's Content-Security-Policy just enough for that.
- `latest` follows `spike`, and `v*` tags publish versions. `docker compose up -d --build` builds from your checkout instead, e.g. after adding tools to the `Dockerfile`.
- `BADGER_DIR` (default `./badger`) is mounted at `/badger` and used as the container's `HOME`. Any `user:` works as long as it can write the folder.
- Use git over HTTPS (`gh auth login` sets it up). `ssh` refuses to run as a uid with no passwd entry, which a custom `user:` is.
- The container user can't `apt-get`; install extra tools with `docker exec -u root badger apt-get install …`, or add them to the `Dockerfile`.
- Terminals don't outlive the container: restarting it restarts the server and the PTY host together.

</details>

## How it works

A Node server drives one Claude Code process per chat and streams it to any number of browser tabs over a WebSocket. Badger's own state (cards, attention, child chats) is a SQLite file.

- **Hub and runners** (`server/index.ts`, `server/machines.ts`, `server/runner.ts`). Everything that needs the files runs in a runner: Claude Code processes, the tools beside them, terminals, git and worktrees. The hub has the database, the browsers and the routing. The hub's own runner is in the same process over an in-memory link (`server/peer.ts`); remote ones (`server/remote.ts`) open a WebSocket to `/runner` with a token and a protocol version, which the hub checks, so a stale runner is turned away, with the reason shown in Settings, rather than misunderstood. Both directions are request/response calls plus events (`server/runnerProtocol.ts`), and everything a runner sends is checked against a schema first.
- **The hub alone decides which machine each chat is on.** A chat goes where it was started from the browser; a child chat (a merge or review) is started by the hub on request, on its parent's machine. Anything a runner sends about a chat on another machine is refused, so a lost laptop can't run or read chats elsewhere.
- **Tools run beside Claude, the board on the hub.** Claude's tools are ops (`server/ops.ts`), each defined once. Terminal and preview ops run on the chat's runner; board ops, and the bridge into the hub's previews, run on the hub, and runners call them there. `run_script` (`server/scripts.ts`) runs a script in a worker thread with every op as `badger.*`, so it can be stopped, and asks permission like Bash does.
- **Transcripts are copied to the hub.** Claude Code writes them where it always does (`~/.claude/projects`) on the machine a chat runs on, and resumes from there. Each runner copies them to the hub line by line (`server/sync.ts`), subagents' included, but only for the chats the hub has put on its machine. The local files are the outbox: the hub says how much of each it has and the runner sends the rest, so a dropped connection just picks up where it left off. The hub keeps them in SQLite (`server/transcripts.ts`), and the chat list and history come from the SDK's `listSessions` / `getSessionMessages` reading a `SessionStore` over those tables. That store isn't handed to Claude Code: resuming from a store runs it under a temporary config folder, without the user's skills, plugins and memory. Chats started outside Badger, like CLI sessions, aren't listed, except the hub machine's older chats, brought in once on the first start with runners.
