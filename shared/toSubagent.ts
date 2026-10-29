/**
 * A message the user typed to a subagent, as the chat running it is sent it. Nothing but Claude can reach a
 * subagent, so Claude is asked to pass it on with SendMessage, which also wakes one that has finished.
 */
export function toSubagent(agent: { id: string; description: string }, text: string): string {
  return [
    `The user sent this to your subagent "${agent.description.replace(/"/g, "'").replace(/\s+/g, ' ')}" (agentId: ${agent.id}) from Badger. Pass it on word for word with SendMessage, then carry on with what you were doing:`,
    '',
    '<message>',
    text,
    '</message>',
  ].join('\n')
}

/** What toSubagent sent, taken apart again; undefined for any other message. */
export function sentToSubagentBy(text: string): { description: string; id: string; text: string } | undefined {
  const m = text.match(/^The user sent this to your subagent "(.*)" \(agentId: ([\w-]+)\) from Badger\. [^\n]*\n\n<message>\n([\s\S]*)\n<\/message>$/)
  return m ? { description: m[1], id: m[2], text: m[3] } : undefined
}
