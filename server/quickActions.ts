import type { QuickAction } from '../shared/protocol.ts'
import type { Database } from './db.ts'
import { BadRequest } from './errors.ts'

/** The prompts in every chat's quick actions menu. They're replaced as a whole, as Settings edits them. */
export class QuickActions {
  constructor(
    private db: Database,
    private onChange: (actions: QuickAction[]) => void,
  ) {}

  list(): QuickAction[] {
    return this.db.sql.prepare('SELECT label, prompt FROM quick_actions ORDER BY position').all() as unknown as QuickAction[]
  }

  set(input: unknown): QuickAction[] {
    if (!Array.isArray(input)) throw new BadRequest('Expected a list of quick actions')
    const actions = input.map((a): QuickAction => {
      const label = typeof a?.label === 'string' ? a.label.trim() : ''
      const prompt = typeof a?.prompt === 'string' ? a.prompt.trim() : ''
      if (!label || !prompt) throw new BadRequest('Each quick action needs a label and a prompt')
      return { label, prompt }
    })
    this.db.transaction(() => {
      this.db.sql.exec('DELETE FROM quick_actions')
      const insert = this.db.sql.prepare('INSERT INTO quick_actions (position, label, prompt) VALUES (?, ?, ?)')
      actions.forEach((a, i) => insert.run(i, a.label, a.prompt))
    })
    this.onChange(actions)
    return actions
  }
}
