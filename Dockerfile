# syntax=docker/dockerfile:1

# ── Build the client ──
FROM node:26-slim AS build
# Node 25+ no longer ships corepack.
RUN npm install -g pnpm@11.21.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ── Runtime ──
# This image is also the machine Claude Code and the terminals work on, so it
# carries the tools they'll reach for. Add your projects' toolchains here.
FROM node:26-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tini bash git openssh-client ca-certificates curl procps less ripgrep jq \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.21.0

WORKDIR /app
# Only the server's dependencies; the client is already bundled into dist.
# They go in before the source, so a source change doesn't rebuild (and
# re-push) them. pnpm's store and cache are dropped once the files are in.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --store-dir /tmp/pnpm-store && rm -rf /tmp/pnpm-store /root/.cache
# `claude` on PATH for the terminals (logging in, the CLI itself), using the SDK's bundled binary.
RUN ln -s "$(find /app/node_modules/.pnpm -path '*claude-agent-sdk-linux-*/claude' -type f ! -path '*musl*' | head -n1)" /usr/local/bin/claude \
  && claude --version
COPY . .
COPY --from=build /app/dist ./dist

# Everything that persists lives in HOME, so it's the one thing to mount:
# Claude Code's transcripts and login (~/.claude, ~/.claude.json), Badger's
# database (~/data), the scratch dir (~/scratch), git/gh config, and the repos in ~/code.
# HOME is set here rather than looked up, so any `user:` works as long as it
# can write the mount. The server creates its dirs, so an empty folder is fine.
RUN mkdir /badger && chown node:node /badger
ENV NODE_ENV=production \
    HOME=/badger \
    HOST=0.0.0.0 \
    PORT=3001 \
    SHELL=/bin/bash \
    DATA_DIR=/badger/data \
    SCRATCH_DIR=/badger/scratch \
    WORKSPACE_DIR=/badger/code
USER node
VOLUME /badger
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS http://localhost:3001/api/config > /dev/null || exit 1

# tini reaps the many processes Claude Code and the terminals leave behind.
ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "tsx", "server/index.ts"]
