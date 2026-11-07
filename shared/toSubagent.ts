/**
 * A message the user once typed to a subagent from its panel, which Claude was asked to pass on with SendMessage,
 * taken apart again; undefined for any other message. Badger no longer sends these, but older chats have them.
 */
export function sentToSubagentBy(text: string): { description: string; id: string; text: string } | undefined {
  const m = text.match(/^The user sent this to your subagent "(.*)" \(agentId: ([\w-]+)\) from Badger\. [^\n]*\n\n<message>\n([\s\S]*)\n<\/message>$/)
  return m ? { description: m[1], id: m[2], text: m[3] } : undefined
}
