import { For, Show } from 'solid-js'
import { FRAMES, PALETTES, setTheme, themeChoice, type Frame, type Mode, type Palette } from '../theme.ts'

/**
 * Settings' theme picker: a section per frame with a tile per everyday palette
 * in it, then the fun ones, which bring their own frame. Each tile is drawn in its own theme.
 */
export function Appearance() {
  const everyday: { id: Mode; label: string }[] = [...PALETTES.filter((p) => !p.frame), { id: 'system', label: 'System' }]
  const sections = [
    ...FRAMES.map((frame) => ({ ...frame, themes: everyday.map((mode) => ({ mode: mode.id, frame: frame.id, label: mode.label })) })),
    {
      label: 'Fun',
      description: 'A whole look, frame and all',
      themes: PALETTES.flatMap((p) => (p.frame ? [{ mode: p.id as Mode, frame: p.frame, label: p.label }] : [])),
    },
  ]
  const selected = (mode: Mode, frame: Frame) => themeChoice().mode === mode && themeChoice().frame === frame

  return (
    <div>
      <h3 class="text-sm font-medium text-fg">Theme</h3>
      <p class="mt-1 text-[13px] leading-relaxed text-fg-2">Saved in this browser, so a phone and a laptop can each have their own.</p>

      <For each={sections}>
        {(section) => (
          <div class="mt-5">
            <div class="mb-2 flex items-baseline gap-2 text-[13px]">
              <span class="font-medium text-fg">{section.label}</span>
              <span class="text-fg-3">{section.description}</span>
            </div>
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <For each={section.themes}>
                {(theme) => (
                  <button
                    type="button"
                    aria-pressed={selected(theme.mode, theme.frame)}
                    onClick={() => setTheme({ mode: theme.mode, frame: theme.frame })}
                    class="group text-left"
                  >
                    <div
                      class={`relative aspect-[8/5] overflow-hidden rounded-lg ring-offset-2 ring-offset-bg transition-shadow ${
                        selected(theme.mode, theme.frame) ? 'ring-2 ring-fg-2' : 'ring-1 ring-line group-hover:ring-edge'
                      }`}
                    >
                      <Show when={theme.mode === 'system'} fallback={<Preview palette={theme.mode as Palette} frame={theme.frame} />}>
                        <Preview palette="light" frame={theme.frame} />
                        <Preview palette="dark" frame={theme.frame} class="[clip-path:polygon(100%_0,100%_100%,0_100%)]" />
                      </Show>
                    </div>
                    <div class={`mt-1.5 text-[13px] ${selected(theme.mode, theme.frame) ? 'text-fg' : 'text-fg-2 group-hover:text-fg'}`}>{theme.label}</div>
                  </button>
                )}
              </For>
            </div>
          </div>
        )}
      </For>
    </div>
  )
}

/**
 * A small drawing of Badger: sidebar, a chat and a panel beside it. It carries
 * its own data-palette and data-frame, so the tokens in index.css draw it in
 * that theme whatever the page is in.
 */
function Preview(props: { palette: Palette; frame: Frame; class?: string }) {
  // The frame's gutters, margin and corners, scaled down with everything else; a hairline stays one.
  const tile = { 'border-radius': 'calc(var(--pane-radius) / 2.5)' }
  const bar = (w: string, color = 'bg-fg-3') => <div class={`h-1 rounded-full opacity-60 ${color}`} style={{ width: w }} />

  return (
    <div
      data-palette={props.palette}
      data-frame={props.frame}
      class={`absolute inset-0 flex bg-canvas ${props.class ?? ''}`}
      style={{ gap: 'max(1px, var(--pane-gutter) / 2)', padding: 'calc(var(--pane-margin) / 2)' }}
    >
      <div class="pane sidebar relative z-10 flex w-[28%] shrink-0 flex-col gap-1.5 p-1.5" style={tile}>
        <div class="mb-0.5 flex items-center gap-1">
          <div class="size-1.5 rounded-full bg-accent" />
          {bar('45%', 'bg-fg')}
        </div>
        <div class="rounded-sm bg-surface px-1 py-[3px]">{bar('70%', 'bg-fg-2')}</div>
        <div class="px-1">{bar('55%')}</div>
        <div class="px-1">{bar('65%')}</div>
        <div class="px-1">{bar('40%')}</div>
      </div>
      <div class="pane flex min-w-0 flex-1 flex-col gap-1.5 p-1.5" style={tile}>
        <div class="bar -mx-1.5 -mt-1.5 px-1.5 py-1">{bar('35%', 'bg-fg')}</div>
        <div class="ml-auto w-[55%] rounded-sm bg-surface px-1 py-[3px]">{bar('80%', 'bg-fg-2')}</div>
        {bar('85%', 'bg-fg-2')}
        {bar('70%', 'bg-fg-2')}
        {bar('50%', 'bg-fg-2')}
        <div class="mt-auto flex h-3 items-center justify-end rounded-sm border border-edge px-0.5">
          <div class="size-1.5 rounded-full bg-primary" />
        </div>
      </div>
      <div class="pane flex w-[30%] shrink-0 flex-col gap-1 p-1.5" style={tile}>
        {bar('60%', 'bg-ok')}
        {bar('80%')}
        {bar('45%')}
        {bar('70%', 'bg-danger')}
      </div>
      <div class="pointer-events-none absolute inset-0" style={{ background: 'var(--screen)' }} />
    </div>
  )
}
