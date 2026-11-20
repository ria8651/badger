import type { Component } from 'solid-js'
import {
  File,
  FileArchive,
  FileBraces,
  FileCode,
  FileCog,
  FileImage,
  FileKey,
  FileLock,
  FileMusic,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
} from './icons'

/**
 * How a file looks in a tree: a shape for its kind and a colour for its language, so a folder can be scanned by eye.
 * The colours are mid-tones, to read on light palettes and dark ones alike.
 */
export interface FileIcon {
  icon: Component<{ class?: string; style?: string | Record<string, string> }>
  color?: string
}

const code = (color: string): FileIcon => ({ icon: FileCode, color })
const TS = code('#3f87d6')
const JS = code('#d1a520')
const CSS = code('#9a6ad6')
const SHELL: FileIcon = { icon: FileTerminal, color: '#4f9d5b' }
const CONFIG: FileIcon = { icon: FileCog, color: '#8a8f99' }
const DATA: FileIcon = { icon: FileBraces, color: '#c9922e' }
const DOC: FileIcon = { icon: FileText, color: '#6f8fae' }
const IMAGE: FileIcon = { icon: FileImage, color: '#c0569c' }
const LOCK: FileIcon = { icon: FileLock, color: '#8a8f99' }

/** By extension, lower case. */
const BY_EXTENSION: Record<string, FileIcon> = {
  ts: TS,
  tsx: TS,
  mts: TS,
  cts: TS,
  js: JS,
  jsx: JS,
  mjs: JS,
  cjs: JS,
  css: CSS,
  scss: CSS,
  sass: CSS,
  less: CSS,
  html: code('#e06b3c'),
  htm: code('#e06b3c'),
  vue: code('#41b883'),
  svelte: code('#f0603a'),
  py: code('#3f7fb8'),
  rs: code('#ce7d4a'),
  go: code('#2fa6c4'),
  java: code('#d0733a'),
  kt: code('#8f6ae0'),
  swift: code('#f05138'),
  c: code('#6a8caf'),
  h: code('#6a8caf'),
  cpp: code('#5a7fc0'),
  hpp: code('#5a7fc0'),
  cs: code('#7a5fc0'),
  rb: code('#d0453a'),
  php: code('#7a86b8'),
  lua: code('#4a5fc0'),
  sql: code('#d08a2e'),
  graphql: code('#e535ab'),
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  fish: SHELL,
  ps1: SHELL,
  json: DATA,
  jsonc: DATA,
  json5: DATA,
  yaml: DATA,
  yml: DATA,
  toml: DATA,
  xml: DATA,
  csv: { icon: FileSpreadsheet, color: '#4f9d5b' },
  tsv: { icon: FileSpreadsheet, color: '#4f9d5b' },
  xlsx: { icon: FileSpreadsheet, color: '#4f9d5b' },
  md: DOC,
  mdx: DOC,
  markdown: DOC,
  txt: { icon: FileText },
  rst: DOC,
  pdf: { icon: FileText, color: '#d0453a' },
  png: IMAGE,
  jpg: IMAGE,
  jpeg: IMAGE,
  gif: IMAGE,
  webp: IMAGE,
  svg: IMAGE,
  ico: IMAGE,
  avif: IMAGE,
  mp4: { icon: FileVideo, color: '#c0569c' },
  webm: { icon: FileVideo, color: '#c0569c' },
  mov: { icon: FileVideo, color: '#c0569c' },
  mp3: { icon: FileMusic, color: '#c0569c' },
  wav: { icon: FileMusic, color: '#c0569c' },
  ogg: { icon: FileMusic, color: '#c0569c' },
  woff: { icon: FileType },
  woff2: { icon: FileType },
  ttf: { icon: FileType },
  otf: { icon: FileType },
  zip: { icon: FileArchive },
  gz: { icon: FileArchive },
  tar: { icon: FileArchive },
  tgz: { icon: FileArchive },
  lock: LOCK,
  pem: { icon: FileKey, color: '#c9922e' },
  key: { icon: FileKey, color: '#c9922e' },
  env: { icon: FileKey, color: '#c9922e' },
  ini: CONFIG,
  conf: CONFIG,
  cfg: CONFIG,
}

/** By whole name, before the extension's looked at: files whose name says more than their extension. */
const BY_NAME: Record<string, FileIcon> = {
  dockerfile: { icon: FileCog, color: '#2f8fd6' },
  makefile: SHELL,
  'package.json': { icon: FileBraces, color: '#cb3837' },
  'pnpm-lock.yaml': LOCK,
  'package-lock.json': LOCK,
  'yarn.lock': LOCK,
  'cargo.lock': LOCK,
  '.gitignore': CONFIG,
  '.gitattributes': CONFIG,
  '.dockerignore': CONFIG,
  '.editorconfig': CONFIG,
  '.npmrc': CONFIG,
  '.prettierrc': CONFIG,
  license: { icon: FileText, color: '#c9922e' },
  'claude.md': { icon: FileText, color: '#c15f3c' },
}

const PLAIN: FileIcon = { icon: File }

/** How a changed file changed, the same wherever one's shown: its letter, and the colour of it (and of its name). */
export const STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const
export const STATUS_TONE = { added: 'text-ok', modified: 'text-changed', deleted: 'text-danger', renamed: 'text-accent' } as const

/** The icon for a file, by its name. */
export function fileIcon(name: string): FileIcon {
  const lower = name.toLowerCase()
  const named = BY_NAME[lower]
  if (named) return named
  if (lower.startsWith('.env')) return BY_EXTENSION.env
  if (/^(tsconfig|jsconfig)(\..*)?\.json$/.test(lower) || /\.config\.[cm]?[jt]s$/.test(lower)) return CONFIG
  const dot = lower.lastIndexOf('.')
  return (dot > 0 && BY_EXTENSION[lower.slice(dot + 1)]) || PLAIN
}
