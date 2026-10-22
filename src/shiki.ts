import { createHighlighterCore, createCssVariablesTheme } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages, bundledLanguagesAlias } from 'shiki/langs'

/*
 * Shiki, kept out of the main bundle: src/highlight.ts loads this once the
 * page is idle. Colours come from the palette as --code-token-* variables
 * (see index.css), so code follows the theme.
 */

const theme = createCssVariablesTheme({ name: 'badger', variablePrefix: '--code-', fontStyle: true })

const highlighter = await createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) })

type Grammar = () => Promise<{ default: Parameters<typeof highlighter.loadLanguage>[0] }>
const grammars: Record<string, Grammar> = { ...bundledLanguages, ...bundledLanguagesAlias } as never
const loading = new Map<string, Promise<void>>()

/** Code as HTML: spans for its tokens and a <br> between lines, or undefined for a language Shiki doesn't know. */
export async function toHtml(code: string, lang: string): Promise<string | undefined> {
  if (!grammars[lang]) return
  if (!loading.has(lang)) loading.set(lang, grammars[lang]().then((m) => highlighter.loadLanguage(m.default)))
  await loading.get(lang)
  return highlighter.codeToHtml(code, { lang, theme: 'badger', structure: 'inline' })
}
