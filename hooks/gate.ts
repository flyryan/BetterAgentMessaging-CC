import type { Hold } from '../types'

import { holdDenial } from './protocol'

/**
 * The tools whose `command` a ship hold reads: Bash, and on Windows the
 * PowerShell tool, which can push, merge and delete just as well.
 */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])

/**
 * Shell commands a ship hold always refuses, in Bash or PowerShell (either can
 * start the other); a configured pattern adds to these.
 */
export const DEFAULT_SHIP = [
  // `git.exe` and a quoted path to it (`& 'C:\...\git.exe' push`) are git too.
  String.raw`\bgit(?:\.exe)?['"]?\s+(?:\S+\s+)*push\b`,
  String.raw`\b(?:gh|gh-axi)(?:\.exe)?['"]?\s+pr\s+merge\b`,
  String.raw`\b(?:gh|gh-axi)(?:\.exe)?['"]?\s+release\s+(?:create|upload|edit)\b`,
  String.raw`\b(?:npm|pnpm|yarn)(?:\.cmd)?\s+publish\b`,
  String.raw`\bPublish-(?:Module|Script|PSResource)\b`,
  String.raw`\b(?:twine\s+upload|cargo\s+publish|gem\s+push|poetry\s+publish)\b`,
  String.raw`\b(?:kubectl\s+(?:apply|delete|rollout)|helm\s+(?:install|upgrade|uninstall)|terraform\s+(?:apply|destroy))\b`,
  String.raw`\b(?:deploy|wrangler\s+deploy|vercel\s+--prod|fly\s+deploy)\b`,
  String.raw`\brm\s+(?:-\S*\s+)*-\S*[rR]\S*\s`,
  // PowerShell's Remove-Item and its aliases take -Recurse (or any prefix of
  // it) anywhere on the line, before or after the path.
  String.raw`\b(?:Remove-Item|rm|ri|del|erase|rd|rmdir)\b[^;|&\n]*\s--?r`,
  // cmd's recursive deletes, also reachable as `cmd /c` from either shell.
  String.raw`\b(?:rd|rmdir|del|erase)\b[^;|&\n]*\s/s\b`,
  String.raw`\[(?:System\.)?IO\.Directory\]::Delete\(`,
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
  return SHELL_TOOLS.has(tool) && command !== undefined && ship.test(command) ? holdDenial(hold) : undefined
}
