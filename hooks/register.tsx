import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, SessionSendResult } from 'claude-code'

import type { AgentRow, Hold, TeammateStatus } from '../types'
import { gateVerdict, shipMatcher } from './gate'
import {
  arrivalLine,
  CONTROLLER_NOTE,
  CONTROLLER_SECTION,
  controllerAlias,
  deliveryNotice,
  noticeColor,
  parseNotice,
  deliveryText,
  extractStanding,
  forwardedAnswer,
  heldLine,
  isBroadcast,
  isProtocolJson,
  nudgeText,
  parseVerb,
  spawnProtocol,
  standingBlock,
  staleText,
  type Verb,
} from './protocol'
import { parseRole, ROLE_WALK, type Role } from './role'
import { agentTable, alertLines, rowLine, staleness } from './table'
import { traceLine } from './trace'

// Every process of an agent team loads this module: the lead and each pane
// teammate (the engine hands teammates the session's plugin folders). Each one
// fixes delivery for its own main loop, enforces the directives aimed at the
// loops it runs, and the lead gathers the teammates' status files into its
// view. In-process subagents need no delivery fix: the engine already hands
// them a message at their next tool round.

const PANE = 'better-agent-messaging'
const COMMAND = 'agent-status'
// An agent's status that still takes messages.
const LIVE = new Set(['pending', 'running', 'waiting', 'idle'])

const holdsAtom = atom({ plugin: 'better-agent-messaging', key: 'holds' } as const, {})
const standingAtom = atom({ plugin: 'better-agent-messaging', key: 'standing' } as const, {})
const rowsAtom = atom({ plugin: 'better-agent-messaging', key: 'rows' } as const, [])
const turnAtom = atom({ plugin: 'better-agent-messaging', key: 'isTurnRunning' } as const, false)
const arrivalAtom = atom({ plugin: 'better-agent-messaging', key: 'arrival' } as const, null)
// How long a read arrival stays in the band; an unread one stays until it is read.
const READ_MS = 15_000

type Activity = { tool?: string; toolSince?: number; lastActivity: number; inFlight: number }

let role: Role = { kind: 'lead', chain: [] }
let home = ''
let sessionId = ''
// A pane teammate's first mailbox deliveries can arrive before its
// session.start has run, so every hook that needs the role waits on this.
let identity: Promise<void> | undefined
let tracePath: string | undefined
let traceWrites: Promise<void> = Promise.resolve()
// Mirrors of the host-held state, read back at every session.start (a reload).
let holds: Record<string, Hold> = {}
let standing: Record<string, string[]> = {}
// This process's main loop: whether a turn runs, and who sent what it has
// not yet carried in a model request.
let isTurnRunning = false
let pending: string[] = []
// Whether this turn reached team-lead with a SendMessage (a pane teammate).
let hasReportedThisTurn = false
// How the lead learns the directives: its system-prompt section, or, where
// Claude Code's security default skips this mod there, a note in its conversation.
let hasComposed = false
// A system prompt composed only to see whether this mod's hook runs; the text is dropped.
const COMPOSE_PROBE = {
  model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [],
} as const
let teaching: 'prompt' | 'note' | undefined
const activity = new Map<string, Activity>()
// Which loop spawned each agent of this process, so a hold reaches helpers.
const parents = new Map<string, string>()
let isDirty = true
let lastStatusWrite = 0
let lastRows = ''
const alerted = new Set<string>()
const statusCache = new Map<string, { mtimeMs: number; status: TeammateStatus }>()

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_')
const statusPath = (team: string, name: string) =>
  `${home}/.claude/better-agent-messaging/${safe(team)}/agents/${safe(name)}.json`
const isPane = (a: AgentInfo) => a.teammateId !== undefined && a.id === a.teammateId
const controllerOf = (a: AgentInfo) => (a.teammateId !== undefined ? 'team-lead' : 'main')

function trace($: EngineInterface, ev: string, data: Record<string, unknown> = {}): void {
  const file = tracePath
  if (file === undefined) return
  const snapshot = traceLine(ev, data)
  traceWrites = traceWrites.then(() => $.fs.write(file, snapshot)).catch(() => undefined)
}

async function detectRole($: EngineInterface): Promise<Role> {
  try {
    const ran = await $.process.run(['sh', '-c', ROLE_WALK], { timeoutMs: 5000 })
    return parseRole(ran.stdout)
  } catch {
    return { kind: 'lead', chain: [] }
  }
}

function ensureIdentity($: EngineInterface): Promise<void> {
  identity ??= (async () => {
    role = await detectRole($)
    home = (await $.env.get('HOME')) ?? ''
    sessionId = await $.session.id()
  })()
  return identity
}

function begin(key: string, tool: string): void {
  const now = Date.now()
  const seen = activity.get(key)
  activity.set(key, {
    tool,
    toolSince: seen?.toolSince ?? now,
    lastActivity: now,
    inFlight: (seen?.inFlight ?? 0) + 1,
  })
  isDirty = true
}

function end(key: string): void {
  const seen = activity.get(key)
  const inFlight = Math.max(0, (seen?.inFlight ?? 1) - 1)
  activity.set(key, inFlight === 0
    ? { lastActivity: Date.now(), inFlight }
    : { ...(seen ?? { lastActivity: Date.now() }), lastActivity: Date.now(), inFlight })
  isDirty = true
}

function bump(key: string): void {
  const seen = activity.get(key)
  activity.set(key, { ...(seen ?? { inFlight: 0 }), lastActivity: Date.now() })
  isDirty = true
}

/**
 * The hold over a loop: its own, else the nearest one up the chain of loops
 * that spawned it. In a pane teammate's process every loop is the teammate's
 * own work, so a helper whose parent is unknown (spawned before a reload)
 * still falls under the teammate's hold on `main`.
 */
function holdFor(agentId: string | undefined): Hold | undefined {
  let key = agentId ?? 'main'
  for (let depth = 0; depth < 16; depth += 1) {
    const hold = holds[key]
    if (hold !== undefined || key === 'main') return hold
    key = parents.get(key) ?? 'main'
  }
  return undefined
}

async function applyVerb($: EngineInterface, key: string, verb: Verb, by: string): Promise<void> {
  if (verb.kind === 'hold') {
    holds = { ...holds, [key]: { scope: verb.scope, reason: verb.reason, by, at: Date.now() } }
  } else if (verb.kind === 'release') {
    const { [key]: _released, ...rest } = holds
    holds = rest
  } else if (verb.kind === 'standing') {
    const rules = standing[key] ?? []
    if (!rules.includes(verb.rule)) standing = { ...standing, [key]: [...rules, verb.rule] }
  } else {
    standing = { ...standing, [key]: [] }
  }
  isDirty = true
  trace($, 'verb', { key, verb, by })
  await update($, holdsAtom, () => holds)
  await update($, standingAtom, () => standing)
}

async function resolveAgent($: EngineInterface, to: string): Promise<AgentInfo | undefined> {
  const agents = await $.agent.list()
  return agents.find(a => a.id === to || a.teammateId === to || a.name === to)
}

async function broadcast($: EngineInterface, text: string, verb: Verb | undefined): Promise<SessionSendResult> {
  const agents = (await $.agent.list()).filter(a => LIVE.has(a.status))
  if (verb?.kind === 'standing' || verb?.kind === 'standing-clear') await applyVerb($, '*', verb, 'main')
  let sent = 0
  for (const agent of agents) {
    // A pane teammate enforces a directive in its own process when the
    // message reaches it; an in-process loop is enforced here.
    if (verb !== undefined && !isPane(agent)) await applyVerb($, agent.id, verb, controllerOf(agent))
    try {
      const result = await $.session.send({ to: { agentId: agent.id }, text })
      if (result.isDelivered) sent += 1
    } catch {
      // one agent that cannot take it does not stop the rest
    }
  }
  trace($, 'broadcast', { agents: agents.map(a => a.name ?? a.id), sent })
  if (sent > 0 || verb?.kind === 'standing' || verb?.kind === 'standing-clear') return { isDelivered: true }
  return { isDelivered: false, reason: 'No running or idle agent or teammate to broadcast to.' }
}

async function teammateStatus($: EngineInterface, team: string, name: string): Promise<TeammateStatus | undefined> {
  const path = statusPath(team, name)
  try {
    const stat = await $.fs.stat(path)
    const cached = statusCache.get(path)
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return cached.status
    const status = JSON.parse(String(await $.fs.read(path))) as TeammateStatus
    statusCache.set(path, { mtimeMs: stat.mtimeMs, status })
    return status
  } catch {
    return undefined
  }
}

async function writeStatus($: EngineInterface, turn?: TeammateStatus['turn']): Promise<void> {
  if (role.kind !== 'teammate') return
  const now = Date.now()
  if (turn === undefined && !isDirty && now - lastStatusWrite < 30_000) return
  isDirty = false
  lastStatusWrite = now
  const act = activity.get('main')
  const status: TeammateStatus = {
    name: role.name,
    team: role.team,
    sessionId,
    turn: turn ?? (isTurnRunning ? 'running' : 'idle'),
    tool: act?.tool,
    toolSince: act?.toolSince,
    lastActivity: act?.lastActivity ?? now,
    hold: holds.main,
    standing: standing.main ?? [],
    unseen: pending.length,
    updatedAt: now,
  }
  await $.fs.write(statusPath(role.team, role.name), JSON.stringify(status)).catch(() => undefined)
}

/** Wakes the controller: a note in its running turn, or a turn of its own. */
async function wake($: EngineInterface, text: string): Promise<void> {
  if (isTurnRunning) {
    await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }] } })
      .catch(() => undefined)
  } else {
    void $.prompt.submit({ text }).catch(() => undefined)
  }
}

async function refresh($: EngineInterface, thresholds: { staleMs: number; toolStaleMs: number }): Promise<AgentRow[]> {
  const now = Date.now()
  let agents: AgentInfo[]
  try {
    agents = await $.agent.list()
  } catch {
    return []
  }
  const rows: AgentRow[] = []
  for (const agent of agents) {
    if (!LIVE.has(agent.status)) continue
    if (isPane(agent)) {
      const [name = agent.id, team = ''] = agent.id.split('@')
      const status = await teammateStatus($, team, name)
      const isFresh = status !== undefined && now - status.updatedAt < 120_000
      rows.push({
        key: agent.id,
        name: agent.name ?? name,
        kind: 'teammate',
        status: isFresh ? (status.turn === 'running' ? 'running' : 'idle') : agent.status,
        tool: status?.tool,
        toolSince: status?.toolSince,
        lastActivity: status?.lastActivity,
        hold: status?.hold,
        standing: status?.standing.length ?? 0,
        unseen: status?.unseen ?? 0,
      })
    } else {
      const act = activity.get(agent.id)
      rows.push({
        key: agent.id,
        name: agent.name ?? agent.description,
        kind: agent.teammateId !== undefined ? 'teammate' : 'subagent',
        status: agent.status,
        tool: act?.tool,
        toolSince: act?.toolSince,
        lastActivity: act?.lastActivity,
        hold: holds[agent.id],
        standing: (standing[agent.id] ?? []).length,
        unseen: 0,
      })
    }
  }
  for (const row of rows) row.stale = staleness(row, now, thresholds)

  for (const row of rows) {
    if (row.stale === undefined) {
      alerted.delete(row.key)
      continue
    }
    if (alerted.has(row.key)) continue
    alerted.add(row.key)
    const text = staleText(row.name, row.stale)
    trace($, 'stale', { key: row.key, why: row.stale })
    $.ui.toast(text)
    await wake($, text)
  }

  const serialized = JSON.stringify(rows)
  if (serialized !== lastRows || rows.some(r => r.status === 'running')) {
    lastRows = serialized
    await update($, rowsAtom, () => rows)
  }
  return rows
}

/** The band's arrival, read now that a model request carries it; it clears a little later. */
async function markRead($: EngineInterface): Promise<void> {
  const arrival = await read($, arrivalAtom)
  if (arrival === null || arrival.readAt !== undefined) return
  await update($, arrivalAtom, last => (last !== null && last.at === arrival.at ? { ...last, readAt: Date.now() } : last))
  $.clock.after(READ_MS, () => {
    void update($, arrivalAtom, last => (last !== null && last.at === arrival.at ? null : last))
  })
}

// Each team's colors by member name, as Claude Code records them in the team's config.
const teamColors = new Map<string, Record<string, string>>()

/** The color a sender's notice is drawn in: its team color where the team records one. */
async function senderColor($: EngineInterface, from: string): Promise<string> {
  if (from === 'team-lead') return noticeColor(from)
  let team = role.kind === 'teammate' ? role.team : undefined
  if (team === undefined) {
    const agents = await $.agent.list().catch(() => [] as AgentInfo[])
    team = agents.find(a => isPane(a) && a.id.split('@')[0] === from)?.id.split('@')[1]
  }
  if (team === undefined || team === '') return noticeColor(from)
  if (teamColors.get(team)?.[from] === undefined) {
    try {
      const config = JSON.parse(String(await $.fs.read(`${home}/.claude/teams/${team}/config.json`))) as {
        members?: { name?: string; color?: string }[]
      }
      const colors: Record<string, string> = {}
      for (const m of config.members ?? []) if (m.name !== undefined && m.color !== undefined) colors[m.name] = m.color
      teamColors.set(team, colors)
    } catch {
      return noticeColor(from)
    }
  }
  return noticeColor(from, teamColors.get(team)?.[from])
}

/**
 * The lead's directives as a note in its conversation, where its system prompt
 * is out of reach. A conversation that already holds one (this mod reloaded, the
 * session resumed) gets no second; after a compaction it has none, so it gets one.
 */
async function teachByNote($: EngineInterface, isAfterCompaction: boolean): Promise<void> {
  if (!isAfterCompaction) {
    const head = CONTROLLER_NOTE.split('\n')[0] ?? ''
    const messages = await $.session.messages().catch(() => [])
    if (Array.isArray(messages) && messages.some(m => m.role === 'user' && m.text.startsWith(head))) return
  }
  const message = { type: 'user' as const, content: [{ type: 'text' as const, text: CONTROLLER_NOTE }] }
  await $.session.append({ message }).catch(() => undefined)
  trace($, 'taught by note', {})
}

export const register: Register = (on, options) => {
  const ship = shipMatcher(String(options.shipPattern ?? ''))
  const thresholds = {
    staleMs: Number(options.staleMinutes ?? 20) * 60_000,
    toolStaleMs: Number(options.toolStaleMinutes ?? 45) * 60_000,
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await ensureIdentity($)
    if (options.trace === true && home.length > 0) {
      const label = role.kind === 'teammate' ? `${safe(role.team)}--${safe(role.name)}` : 'lead'
      tracePath = `${home}/.claude/better-agent-messaging/trace/${label}--${sessionId.slice(0, 8)}.jsonl`
    }
    // What the host kept across a reload, under anything applied before this ran.
    holds = { ...(await read($, holdsAtom)), ...holds }
    standing = { ...(await read($, standingAtom)), ...standing }
    // A reload mid-turn: the turn is still running, and its next message must not wait.
    isTurnRunning = isTurnRunning || (await read($, turnAtom))
    trace($, 'session.start', { role })

    if (role.kind === 'lead') {
      // The band above the prompt shows what needs attention; no status-line entry.
      $.ui.status(undefined)
      await $.command.register({
        name: COMMAND,
        description: 'Show every subagent and teammate: what it is doing, holds, standing orders, stale agents',
      })
      $.clock.every(5000, () => {
        void refresh($, thresholds)
      })
    } else {
      $.clock.every(5000, () => {
        void writeStatus($)
      })
      void writeStatus($, 'idle')
    }
    return started
  })

  on('session.end', async ($, e, next) => {
    await writeStatus($, 'ended')
    return next(e)
  })

  // The controller learns the directives from its own system prompt.
  on('prompt.compose', async ($, e, next) => {
    hasComposed = true
    const composed = await next(e)
    await ensureIdentity($)
    if (role.kind !== 'lead' || !e.tools.includes('SendMessage') || !e.tools.includes('Agent')) return composed
    return {
      sections: [...composed.sections, { id: 'better-agent-messaging:controller', text: CONTROLLER_SECTION, scope: 'session' }],
    }
  })

  // Every agent that can take a message mid-task learns how in its brief.
  // Every agent is recorded under the loop that spawned it, for holds.
  on('agent.spawn', async ($, e, next) => {
    const isTeammate = e.isTeammate === true
    let input = e
    if (!e.fork && e.workflow === undefined && (e.background || isTeammate)) {
      await ensureIdentity($)
      const controller = isTeammate ? 'team-lead' : 'main'
      const rules = [...(standing['*'] ?? []), ...(role.kind === 'teammate' ? standing.main ?? [] : [])]
      trace($, 'spawn', { name: e.name, isTeammate, rules: rules.length })
      input = { ...e, prompt: `${e.prompt}\n${spawnProtocol(controller, isTeammate, rules)}` }
    }
    const spawned = await next(input)
    if (spawned.agentId !== undefined) parents.set(spawned.agentId, e.parentAgentId ?? 'main')
    return spawned
  }).catch(($, e, next) => next(e))

  // A pane teammate's own sends: "main", "lead" and the like mean its
  // controller, which in its process is team-lead ("main" would be itself).
  // The controller's sends: directives for in-process loops, and broadcasts.
  on('session.send', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await ensureIdentity($)
    if (role.kind === 'teammate') {
      const to = e.origin.kind === 'model' && controllerAlias(e.to, role.team) ? 'team-lead' : e.to
      if (to !== e.to) trace($, 'readdressed', { from: e.to, to })
      const sent = await next(to === e.to ? e : { ...e, to })
      if (to === 'team-lead' && sent.isDelivered) hasReportedThisTurn = true
      return sent
    }
    const verb = parseVerb(e.text)
    if (isBroadcast(e.to)) return broadcast($, e.text, verb)
    if (verb !== undefined) {
      const target = await resolveAgent($, e.to)
      if (target !== undefined && !isPane(target)) await applyVerb($, target.id, verb, controllerOf(target))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A team message reaching this process's main loop while its turn runs is
  // put in the turn now, where the engine would hold it until the turn ends.
  on('session.receive', async ($, e, next) => {
    if (e.agentId !== undefined || !('teammate' in e.origin) || isProtocolJson(e.text)) return next(e)
    await ensureIdentity($)
    const from = e.origin.teammate
    if (role.kind === 'teammate' && from === 'team-lead') {
      const verb = parseVerb(e.text)
      if (verb !== undefined) await applyVerb($, 'main', verb, from)
      for (const rule of extractStanding(e.text)) await applyVerb($, 'main', { kind: 'standing', rule }, from)
    }
    if (!isTurnRunning) return next(e)
    const appended = await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text: deliveryText(from, e.text) }] } })
      .catch(() => undefined)
    if (appended === undefined || appended.deny !== undefined) return next(e)
    // The person's copies: the model's row is hidden from the transcript view,
    // so the arrival shows in the band above the prompt, and a notice keeps it
    // in the detailed transcript (ctrl+o).
    const at = Date.now()
    await update($, arrivalAtom, () => ({ from, text: e.text, at }))
    await $.session
      .append({ message: { type: 'system', content: [{ type: 'text', text: deliveryNotice(from, e.text) }] } })
      .catch(() => undefined)
    pending = [...pending, from]
    isDirty = true
    trace($, 'delivered', { from, length: e.text.length })
    return { consumed: 'better-agent-messaging: put into the running turn' }
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    hasReportedThisTurn = false
    bump('main')
    await update($, turnAtom, () => true)
    if (teaching === undefined && role.kind === 'lead') {
      // Compose once to learn whether this mod's prompt.compose hook runs here.
      if (!hasComposed) await $.prompt.compose(COMPOSE_PROBE).catch(() => undefined)
      teaching = hasComposed ? 'prompt' : 'note'
      if (teaching === 'note') await teachByNote($, false)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    bump(e.agentId ?? 'main')
    // This request carries every row appended before it.
    if (e.agentId === undefined) {
      pending = []
      await markRead($)
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    isTurnRunning = false
    isDirty = true
    await update($, turnAtom, () => false)
    const unseen = pending
    pending = []
    if (unseen.length > 0 && !e.isAborted) {
      trace($, 'nudge', { from: unseen })
      void $.prompt.submit({ text: nudgeText(unseen) }).catch(() => undefined)
    }
    // A pane teammate whose turn ended without reaching team-lead: the lead
    // would get only the idle notice's cut copy, so the whole answer goes too.
    if (role.kind === 'teammate' && !hasReportedThisTurn && !e.isAborted && e.answer.trim().length > 0) {
      trace($, 'forwarded', { length: e.answer.length })
      void $.session.send({ to: 'team-lead', text: forwardedAnswer(e.answer) }).catch(() => undefined)
    }
    void writeStatus($, 'idle')
    return done
  })

  const verdictFor = (agentId: string | undefined, tool: string, input: unknown) => {
    const command = tool === 'Bash' ? (input as { command?: unknown }).command : undefined
    return gateVerdict(holdFor(agentId), tool, typeof command === 'string' ? command : undefined, ship)
  }
  // One hook per tool call: the hold gate first (a held loop's calls are
  // refused in the process that runs it), then liveness for every loop, and
  // the live table on the controller's ListAgents. The catch fails closed for
  // held loops only.
  on('tool.call', async ($, e, next) => {
    const verdict = verdictFor(e.agentId, e.tool, e)
    if (verdict !== undefined) {
      trace($, 'gate', { agentId: e.agentId, tool: e.tool })
      return { deny: verdict }
    }
    const key = e.agentId ?? 'main'
    begin(key, e.tool)
    try {
      const ran = await next(e)
      if (e.tool !== 'ListAgents' || e.agentId !== undefined || ran.deny !== undefined || role.kind !== 'lead') return ran
      const table = agentTable(await refresh($, thresholds), Date.now())
      return table === undefined ? ran : { ...ran, context: [...(ran.context ?? []), table] }
    } finally {
      end(key)
    }
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    const verdict = verdictFor(e.agentId, e.tool, e)
    return verdict === undefined ? next(e) : { deny: verdict }
  })

  // Standing orders survive an agent's compaction.
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    if (compacted.skip !== undefined || e.trigger === 'precompute') return compacted
    if (e.agentId === undefined && teaching === 'note') await teachByNote($, true)
    const rules = e.agentId === undefined
      ? role.kind === 'teammate' ? standing.main ?? [] : []
      : [...(standing['*'] ?? []), ...(standing[e.agentId] ?? [])]
    if (rules.length > 0) {
      const message = { type: 'user' as const, content: [{ type: 'text' as const, text: standingBlock(rules, 'compacted') }] }
      await $.session.append(e.agentId === undefined ? { message } : { message, agentId: e.agentId }).catch(() => undefined)
      trace($, 'restated', { agentId: e.agentId, rules: rules.length })
    }
    return compacted
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async $ => {
    await refresh($, thresholds)
    await $.ui.open({ id: PANE, title: 'Agents' })
    return { text: 'Agent status is open in a pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const rows = await read($, rowsAtom)
    const now = Date.now()
    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>No running or idle subagents or teammates.</Text>}
        {rows.map(row => (
          <Text
            color={row.stale !== undefined ? 'yellow' : undefined}
            dimColor={row.status === 'idle'}
            wrap="truncate-end"
          >
            {rowLine(row, now)}
          </Text>
        ))}
      </Box>
    )
  })

  // A delivery notice, drawn as Claude Code draws a teammate's message: the
  // sender's name in its color, the message beneath.
  on('ui.render', { component: 'InfoNotice' }, async ($, e, next) => {
    const notice = parseNotice(e.props.text)
    if (notice === undefined) return next(e)
    const color = await senderColor($, notice.from)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text>
          <Text color={color} bold>{`@${notice.from}`}</Text>
          <Text dimColor> sent mid-task</Text>
        </Text>
        <Box paddingLeft={2}>
          <Text>{notice.body}</Text>
        </Box>
      </Box>
    )
  })

  // The band above the prompt, drawn in every pane, and only for what the agent
  // list under the prompt does not show: a message that just arrived mid-turn,
  // a teammate's own hold, and in the lead any agent that is paused or stuck.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const arrival = await read($, arrivalAtom)
    const lines: string[] = []
    if (arrival !== null && (arrival.readAt === undefined || Date.now() - arrival.readAt < READ_MS)) {
      lines.push(arrivalLine(arrival.from, arrival.text, arrival.readAt !== undefined))
    }
    if (role.kind === 'teammate') {
      const hold = (await read($, holdsAtom)).main
      if (hold !== undefined) lines.push(heldLine(hold))
    } else {
      lines.push(...alertLines(await read($, rowsAtom), Date.now()))
    }
    if (lines.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {lines.map(line => <Text dimColor wrap="truncate-end">{line}</Text>)}
      </Box>
    )
  })
}
