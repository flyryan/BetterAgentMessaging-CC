import type { Hold } from '../types'

// The words the mod puts in front of models: the controller's system-prompt
// section, the paragraph every spawn's brief gains, and the envelopes of what
// it delivers. Pure text; the hooks module sends it.

export type Verb =
  | { kind: 'hold'; scope: 'all' | 'ship'; reason: string }
  | { kind: 'release'; note: string }
  | { kind: 'standing'; rule: string }
  | { kind: 'standing-clear' }

/** Reads a directive off a message's first line; undefined for a plain message. */
export function parseVerb(text: string): Verb | undefined {
  const lines = text.trim().split('\n')
  const first = (lines[0] ?? '').trim()
  const rest = lines.slice(1).join('\n').trim()
  const tail = (head: string | undefined) => [head?.trim() ?? '', rest].filter(s => s.length > 0).join('\n')

  const ship = /^hold\s+ship\s*(?::\s*(.*))?$/i.exec(first)
  if (ship) return { kind: 'hold', scope: 'ship', reason: tail(ship[1]) || 'no reason given' }
  const hold = /^hold\s*(?::\s*(.*))?$/i.exec(first)
  if (hold) return { kind: 'hold', scope: 'all', reason: tail(hold[1]) || 'no reason given' }
  const release = /^release\s*(?::\s*(.*))?$/i.exec(first)
  if (release) return { kind: 'release', note: tail(release[1]) }
  if (/^standing\s+clear\s*$/i.test(first)) return { kind: 'standing-clear' }
  const standing = /^standing\s*:\s*(.*)$/i.exec(first)
  if (standing) {
    const rule = tail(standing[1])
    return rule.length > 0 ? { kind: 'standing', rule } : undefined
  }
  return undefined
}

// SendMessage itself refuses "*" before any hook runs, so a broadcast is
// addressed to a name no agent carries, which the mod fans out.
const BROADCAST = new Set(['all', 'everyone', '@all', '*'])

/** Whether a recipient means every live agent of the session. */
export function isBroadcast(to: string): boolean {
  return BROADCAST.has(to.trim().toLowerCase())
}

/** The engine's own team messages that are data, not words: idle notices, shutdown and plan requests. */
export function isProtocolJson(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return false
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === 'object' && parsed !== null && typeof (parsed as { type?: unknown }).type === 'string'
  } catch {
    return false
  }
}

const escapeAttr = (s: string) => s.replace(/[&"<>]/g, c => `&#${c.charCodeAt(0)};`)

/** A teammate message that arrived while the turn ran, as the turn reads it. */
export function deliveryText(from: string, text: string): string {
  const outranks = from === 'team-lead'
    ? ' It comes from your controller and outranks your original brief where they conflict.'
    : ''
  return [
    `<teammate-message teammate_id="${escapeAttr(from)}">`,
    text,
    '</teammate-message>',
    '<system-reminder>',
    `${from} sent the message above while you were working. Read it now and address it before you finish your current task.${outranks}`,
    '</system-reminder>',
  ].join('\n')
}

// What a pane teammate's model calls its controller. In its own process
// "main" names the teammate itself, so each of these goes to team-lead.
const CONTROLLER_ALIASES = new Set([
  'main', 'lead', 'leader', 'team-lead', 'teamlead', 'team_lead', 'team lead',
  'controller', 'orchestrator', 'coordinator', 'parent', 'manager',
])

/** Whether a teammate's recipient means its controller (and is not already spelled `team-lead`). */
export function controllerAlias(to: string, team: string): boolean {
  const bare = to.trim().toLowerCase().replace(/^@/, '')
  const suffix = `@${team.toLowerCase()}`
  const name = bare.endsWith(suffix) ? bare.slice(0, -suffix.length) : bare
  return to !== 'team-lead' && CONTROLLER_ALIASES.has(name)
}

/** A teammate's whole final answer, sent on when its turn reached no one. */
export function forwardedAnswer(answer: string): string {
  return `${answer}\n\n(My final answer for this turn, forwarded whole: I did not send it to you myself.)`
}

/**
 * The visible line the person sees when a message is put into a running turn.
 * The row the model reads is hidden from the transcript view, as every row a
 * plugin adds for the model is; this notice is the person's copy.
 */
export function deliveryNotice(from: string, text: string): string {
  return `${from} sent:\n${text}`
}

/** The band's line for a message that arrived mid-turn: sender, whether it has been read, its first line. */
export function arrivalLine(from: string, text: string, isRead: boolean): string {
  const first = text.trim().split('\n')[0] ?? ''
  return `${from} sent (${isRead ? 'read' : 'unread'}): ${first.length > 160 ? `${first.slice(0, 159)}…` : first}`
}

/** The band's line in a held teammate's own pane. */
export function heldLine(hold: Hold): string {
  return `${hold.by} ${hold.scope === 'ship' ? 'blocked shipping' : 'paused this agent'}: ${hold.reason.split('\n')[0]}`
}

/** The prompt that starts a turn when a delivery landed after the turn's last step. */
export function nudgeText(froms: readonly string[]): string {
  const who = [...new Set(froms)].join(', ')
  return `${who} sent you a message just as you finished your last step, so you have not read it yet. It is in the conversation above: read it and address it now.`
}

/** Standing orders put back after a compaction, or listed in a brief. */
export function standingBlock(rules: readonly string[], why: 'compacted' | 'spawn'): string {
  const lead = why === 'compacted'
    ? 'Standing orders from your controller, still in force (restated because your context was compacted):'
    : SPAWN_STANDING_HEAD
  return ['<system-reminder>', lead, ...rules.map(r => `- ${r}`), '</system-reminder>'].join('\n')
}

const SPAWN_STANDING_HEAD = 'Standing orders from your controller, in force for your whole task:'

/**
 * The standing orders a brief carries (the block `spawnProtocol` wrote), so a
 * pane teammate can keep them in force past its own compaction.
 */
export function extractStanding(text: string): string[] {
  const at = text.indexOf(SPAWN_STANDING_HEAD)
  if (at < 0) return []
  const rules: string[] = []
  for (const line of text.slice(at + SPAWN_STANDING_HEAD.length).split('\n').slice(1)) {
    if (!line.startsWith('- ')) break
    rules.push(line.slice(2))
  }
  return rules
}

/** What the model reads when the gate refuses a tool call. */
export function holdDenial(hold: Hold): string {
  const reason = hold.reason.replace(/[\s.!?;:,]+$/, '')
  return hold.scope === 'all'
    ? `On hold by ${hold.by}: ${reason}. Every tool but SendMessage is refused until ${hold.by} sends "release". Tell ${hold.by} with SendMessage where you stopped, then end your turn and wait.`
    : `On a ship hold by ${hold.by}: ${reason}. Pushing, merging, releasing, publishing, deploying and rm -rf are refused until ${hold.by} sends "release". Other work may continue.`
}

/** The paragraph a spawned agent's brief gains. */
export function spawnProtocol(controller: string, isTeammate: boolean, standing: readonly string[]): string {
  const report = isTeammate
    ? `Report to ${controller} with SendMessage (to: "${controller}"): progress at milestones, blockers at once, and your final result.`
    : `Your final answer reaches ${controller} by itself; use SendMessage (to: "${controller}") only for a blocker or a question mid-task.`
  const lines = [
    '',
    '## Messages while you work',
    `Messages from ${controller} can arrive in the middle of your task, between your steps. Read each one as it appears and act on it before you continue: it outranks this brief where they conflict.`,
    `- "hold: ..." means stop now. Your tools are refused until "release" arrives; tell ${controller} where you stopped, then end your turn and wait.`,
    '- "hold ship: ..." means do not push, merge, release, publish, deploy or rm -rf until "release"; other work may continue.',
    '- "standing: ..." is a rule that stays in force for the rest of your task.',
    report,
  ]
  if (standing.length > 0) lines.push('', standingBlock(standing, 'spawn'))
  return lines.join('\n')
}

/** The controller's system-prompt section. */
export const CONTROLLER_SECTION = [
  '# Messaging your agents',
  'SendMessage reaches a running subagent or teammate in the middle of its task: it reads the message at its next step, not when its run ends. Messages your teammates send you reach you mid-turn the same way. No inbox files, watches or nudges are needed.',
  'Start the FIRST LINE of a SendMessage with a directive and it is enforced in the agent\'s own process:',
  '- `hold: <reason>`: every tool the agent calls is refused (SendMessage still works) until you send `release`.',
  '- `hold ship: <reason>`: only shipping actions are refused (git push, PR merge, releases, publish, deploy, rm -rf).',
  '- `release` or `release: <note>`: lifts a hold.',
  '- `standing: <rule>`: a rule kept in force; restated to the agent after its context is compacted. Sent to "all", every agent spawned afterwards gets it too. `standing clear` drops them.',
  'Send to "all" to reach every running or idle agent and teammate at once (SendMessage refuses "*").',
  'ListAgents also shows each agent\'s live state: what it is doing, for how long, its last activity, any hold, and whether it looks stale. A stale agent is reported to you without asking.',
].join('\n')

/**
 * The same teaching as a note in the lead's conversation, for a machine where
 * Claude Code's security default keeps installed plugins out of the system
 * prompt (managed settings, Team and Enterprise organizations).
 */
export const CONTROLLER_NOTE = `better-agent-messaging is loaded in this session. Claude Code keeps installed plugins out of the system prompt on this machine, so this note stands in for its section.\n\n${CONTROLLER_SECTION}`

/** The prompt or note that tells the controller an agent looks stale. */
export function staleText(name: string, why: string): string {
  return `${name} looks stale: ${why}. Check what it waits on, then message it or stop it.`
}
