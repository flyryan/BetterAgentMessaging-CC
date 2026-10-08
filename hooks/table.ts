import type { AgentRow } from '../types'

export type Thresholds = { staleMs: number; toolStaleMs: number }

const minutes = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`)

/** Why a working agent looks stuck, or undefined. Idle and finished agents are never stale. */
export function staleness(row: AgentRow, now: number, t: Thresholds): string | undefined {
  if (row.status !== 'running') return undefined
  if (row.tool !== undefined && row.toolSince !== undefined) {
    const inTool = now - row.toolSince
    return inTool > t.toolStaleMs ? `in ${row.tool} for ${minutes(inTool)}` : undefined
  }
  if (row.lastActivity === undefined) return undefined
  const quiet = now - row.lastActivity
  return quiet > t.staleMs ? `no step or tool for ${minutes(quiet)}` : undefined
}

function describe(row: AgentRow, now: number): string {
  const doing = row.tool !== undefined && row.toolSince !== undefined
    ? `in ${row.tool} for ${minutes(now - row.toolSince)}`
    : row.lastActivity !== undefined ? `last active ${minutes(now - row.lastActivity)} ago` : 'no activity seen'
  const flags = [
    row.hold ? `HELD (${row.hold.scope}): ${row.hold.reason}` : undefined,
    row.standing > 0 ? `${row.standing} standing order${row.standing === 1 ? '' : 's'}` : undefined,
    row.unseen > 0 ? `${row.unseen} message${row.unseen === 1 ? '' : 's'} not yet read` : undefined,
    row.stale ? `STALE: ${row.stale}` : undefined,
  ].filter(f => f !== undefined)
  return `- ${row.name} (${row.kind}): ${row.status}, ${doing}${flags.length > 0 ? `; ${flags.join('; ')}` : ''}`
}

/** The rows ListAgents' result gains, for the controller model. */
export function agentTable(rows: readonly AgentRow[], now: number): string | undefined {
  if (rows.length === 0) return undefined
  return ['Live state of your agents (better-agent-messaging):', ...rows.map(r => describe(r, now))].join('\n')
}

/** At most this many alert lines above the lead's prompt; the rest fold into a count. */
const MAX_ALERTS = 3

/**
 * The lines above the lead's prompt: only what the agent list under the prompt
 * does not show, each led by the agent's name. Nothing while every agent is fine.
 */
export function alertLines(rows: readonly AgentRow[], now: number): string[] {
  const lines: string[] = []
  for (const row of rows) {
    if (row.stale !== undefined) lines.push(`${row.name} looks stuck: ${row.stale}`)
    if (row.hold !== undefined) {
      const reason = row.hold.reason.split('\n')[0]
      lines.push(row.hold.scope === 'ship' ? `${row.name} can't ship: ${reason}` : `${row.name} is paused: ${reason}`)
    }
  }
  if (lines.length <= MAX_ALERTS) return lines
  return [...lines.slice(0, MAX_ALERTS - 1), `and ${lines.length - (MAX_ALERTS - 1)} more paused or stuck: see /agent-status`]
}

export function rowLine(row: AgentRow, now: number): string {
  return describe(row, now).slice(2)
}
