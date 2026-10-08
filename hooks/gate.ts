import type { Hold } from '../types'

import { holdDenial } from './protocol'

/** Shell commands a ship hold always refuses; a configured pattern adds to these. */
export const DEFAULT_SHIP = [
  String.raw`\bgit\s+(?:\S+\s+)*push\b`,
  String.raw`\b(?:gh|gh-axi)\s+pr\s+merge\b`,
  String.raw`\b(?:gh|gh-axi)\s+release\s+(?:create|upload|edit)\b`,
  String.raw`\b(?:npm|pnpm|yarn)\s+publish\b`,
  String.raw`\b(?:twine\s+upload|cargo\s+publish|gem\s+push|poetry\s+publish)\b`,
  String.raw`\b(?:kubectl\s+(?:apply|delete|rollout)|helm\s+(?:install|upgrade|uninstall)|terraform\s+(?:apply|destroy))\b`,
  String.raw`\b(?:deploy|wrangler\s+deploy|vercel\s+--prod|fly\s+deploy)\b`,
  String.raw`\brm\s+(?:-\S*\s+)*-\S*[rR]\S*\s`,
].join('|')

export function shipMatcher(pattern: string): RegExp {
  if (pattern.trim().length > 0) {
    try {
      new RegExp(pattern)
      return new RegExp(`${DEFAULT_SHIP}|(?:${pattern})`, 'i')
    } catch {
      // a bad pattern is ignored; the built-in list still applies
    }
  }
  return new RegExp(DEFAULT_SHIP, 'i')
}

/** The refusal for a held loop's tool call, or undefined to let it run. */
export function gateVerdict(
  hold: Hold | undefined,
  tool: string,
  command: string | undefined,
  ship: RegExp,
): string | undefined {
  if (hold === undefined || tool === 'SendMessage') return undefined
  if (hold.scope === 'all') return holdDenial(hold)
  return tool === 'Bash' && command !== undefined && ship.test(command) ? holdDenial(hold) : undefined
}
