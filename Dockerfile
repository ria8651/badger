# syntax=docker/dockerfile:1

# Pinned by digest: the floating tag moves every day or two, and each move
# rebuilds (and re-pushes) the big apt layer below. Dependabot bumps it.
ARG NODE_IMAGE=node:26-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4

# ── Build the client ──
FROM ${NODE_IMAGE} AS build
# Node 25+ no longer ships corepack.
RUN npm install -g pnpm@11.21.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# The commit it's built from, recorded with analytics; CI passes it in.
ARG BADGER_VERSION
RUN pnpm build

# ── Runtime ──
# This image is also the machine Claude Code and the terminals work on, so it
# carries the tools they'll reach for. Add your projects' toolchains here.
# Chromium (with fonts, or pages render without text) and Playwright are
# for Claude to check pages itself, headless.
FROM ${NODE_IMAGE}
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tini bash git openssh-client ca-certificates curl procps less ripgrep jq \
    chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.21.0 playwright-core@1.64.0

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
    WORKSPACE_DIR=/badger/code \
    BADGER_CHROMIUM=/usr/bin/chromium \
    NODE_PATH=/usr/local/lib/node_modules
USER node
VOLUME /badger
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS http://localhost:3001/api/config > /dev/null || exit 1

ARG BADGER_VERSION
ENV BADGER_VERSION=${BADGER_VERSION}

# tini reaps the many processes Claude Code and the terminals leave behind.
ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "tsx", "server/index.ts"]
