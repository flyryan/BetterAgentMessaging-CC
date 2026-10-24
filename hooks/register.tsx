import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, SessionSendResult } from 'claude-code'

import type { AgentRow, Delivery, Hold, TeammateStatus } from '../types'
import { gateVerdict, SHELL_TOOLS, shipMatcher } from './gate'
import {
  arrivalLine,
  CONTROLLER_NOTE,
  CONTROLLER_SECTION,
  controllerAlias,
  deliveryNotice,
  deliveryText,
  extractStanding,
  forwardedAnswer,
  heldLine,
  idleNotice,
  isBroadcast,
  isProtocolJson,
  parseVerb,
  spawnProtocol,
  standingBlock,
  staleText,
  teammateFrame,
  type Verb,
  wakeText,
} from './protocol'
import { homeDir, isWindows, parseRole, ROLE_WALK, type Role } from './role'
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
const heldAtom = atom({ plugin: 'better-agent-messaging', key: 'held' } as const, [])
// An idle notice older than this, from a teammate no longer running, is the
// engine's late hand-over of a stopped teammate's last notice: dropped.
const STALE_IDLE_MS = 2 * 60_000
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
let pending: Delivery[] = []
// Where the main loop's turn stands: a model request in flight, or the last
// response asked for no tool, so no request may follow. A message arriving
// then is held until the response shows whether another request carries it.
let isRequesting = false
let isLastStep = false
let held: Delivery[] = []
// The prompt turn.complete submitted for what no request carried, until the
// turn it starts begins: the band keeps those messages unread until then.
let wakePrompt: string | undefined
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
  // Windows has no `ps -o` (Git Bash's ps is MSYS's), and agent teammates run
  // there in Claude Code's own process, never a pane: this process is the lead.
  if (isWindows(await $.env.get('OS'))) return { kind: 'lead', chain: [] }
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
    home = homeDir({
      os: await $.env.get('OS'),
      home: await $.env.get('HOME'),
      userProfile: await $.env.get('USERPROFILE'),
    })
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
    unseen: pending.length + held.length,
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

/**
 * Puts a team message into the running turn, where the next model request
 * carries it, and gives the person a notice of it: the model's row is hidden
 * from the transcript view, as every row a plugin adds for the model is.
 */
async function deliverNow($: EngineInterface, d: Delivery): Promise<boolean> {
  const { from, text } = d
  // An engine notice held behind a message goes in as the engine frames it, unannounced.
  const isNotice = isProtocolJson(text)
  const appended = await $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text: isNotice ? teammateFrame(from, text) : deliveryText(from, text) }] } })
    .catch(() => undefined)
  if (appended === undefined || appended.deny !== undefined) return false
  if (isNotice) return true
  await $.session
    .append({ message: { type: 'system', content: [{ type: 'text', text: deliveryNotice(from, text) }] } })
    .catch(() => undefined)
  pending = [...pending, d]
  isDirty = true
  trace($, 'delivered', { from, length: text.length })
  return true
}

/** Whether a held delivery is a message, not one of the engine's own notices. */
const isMessage = (d: Delivery) => !isProtocolJson(d.text)

/**
 * Delivers the messages held for a step's end, now that another request will
 * carry them. The engine's notices held behind them keep waiting for the turn's
 * end, where the engine would deliver them and the person sees them drawn;
 * `withNotices` puts them in too, unseen, for a turn the person stopped.
 */
async function deliverHeld($: EngineInterface, withNotices = false): Promise<void> {
  const waiting = held
  held = []
  for (const d of waiting) {
    // An append the engine refuses goes back to wait for the turn's end.
    if ((!withNotices && !isMessage(d)) || !(await deliverNow($, d))) held = [...held, d]
  }
  await update($, heldAtom, () => held)
}

const colorCache = new Map<string, { mtimeMs: number; colors: Record<string, string> }>()

/**
 * A teammate's colour in its team (`blue`), as its team's config names it;
 * none for team-lead. Read when its message arrives: a stopped teammate leaves
 * the config.
 */
async function senderColor($: EngineInterface, name: string): Promise<string | undefined> {
  let team = role.kind === 'teammate' ? role.team : undefined
  if (team === undefined) {
    const agents = await $.agent.list().catch(() => [] as AgentInfo[])
    team = agents.find(a => a.teammateId?.startsWith(`${name}@`) === true)?.teammateId?.split('@')[1]
  }
  if (team === undefined || home.length === 0) return undefined
  const path = `${home}/.claude/teams/${team}/config.json`
  try {
    const stat = await $.fs.stat(path)
    let cached = colorCache.get(path)
    if (cached === undefined || cached.mtimeMs !== stat.mtimeMs) {
      const config = JSON.parse(String(await $.fs.read(path))) as { members?: { name?: unknown; color?: unknown }[] }
      const colors: Record<string, string> = {}
      for (const m of config.members ?? []) {
        if (typeof m.name === 'string' && typeof m.color === 'string') colors[m.name] = m.color
      }
      cached = { mtimeMs: stat.mtimeMs, colors }
      colorCache.set(path, cached)
    }
    return cached.colors[name]
  } catch {
    return undefined
  }
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
    held = [...(await read($, heldAtom)), ...held]
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

  // A team message reaching this process's main loop while its turn runs goes
  // into the turn, where the engine would hold it until the turn ends: now, or
  // once the model's response shows another request follows. In the lead, a
  // stopped teammate's idle notice the engine hands over late is dropped.
  on('session.receive', async ($, e, next) => {
    if (e.agentId !== undefined || !('teammate' in e.origin)) return next(e)
    if (isProtocolJson(e.text)) {
      // Behind a held message, the engine would deliver its own notice (a
      // teammate's idle notice, a moment after its report) first: it waits too.
      if (isTurnRunning && held.length > 0) {
        const from = e.origin.teammate
        held = [...held, { from, text: e.text, color: held.find(d => d.from === from)?.color }]
        await update($, heldAtom, () => held)
        trace($, 'held', { from, notice: true })
        return { consumed: 'better-agent-messaging: held behind a message held for the end of the model\'s response' }
      }
      const idle = idleNotice(e.text, Date.now())
      if (idle === undefined || idle.ageMs < STALE_IDLE_MS) return next(e)
      await ensureIdentity($)
      if (role.kind !== 'lead') return next(e)
      const sender = await resolveAgent($, idle.from)
      if (sender !== undefined && LIVE.has(sender.status)) return next(e)
      trace($, 'stale idle dropped', { from: idle.from, ageMs: idle.ageMs })
      return { consumed: 'better-agent-messaging: a stopped teammate\'s idle notice, delivered late' }
    }
    await ensureIdentity($)
    const from = e.origin.teammate
    if (role.kind === 'teammate' && from === 'team-lead') {
      const verb = parseVerb(e.text)
      if (verb !== undefined) await applyVerb($, 'main', verb, from)
      for (const rule of extractStanding(e.text)) await applyVerb($, 'main', { kind: 'standing', rule }, from)
    }
    if (!isTurnRunning) return next(e)
    const delivery: Delivery = { from, text: e.text, color: await senderColor($, from) }
    // While the model writes, whether another request follows is not known
    // yet: the message waits for the response (turn.step), and if none
    // follows it starts the next turn as the engine would (turn.complete).
    const isHeld = isRequesting || isLastStep
    if (isHeld) {
      held = [...held, delivery]
      await update($, heldAtom, () => held)
      isDirty = true
      trace($, 'held', { from, length: e.text.length })
    } else if (!(await deliverNow($, delivery))) {
      return next(e)
    }
    // The person's copy until the model reads it: the band above the prompt.
    const at = Date.now()
    await update($, arrivalAtom, () => ({ from, text: e.text, at, color: delivery.color }))
    return { consumed: isHeld ? 'better-agent-messaging: held for the end of the model\'s response' : 'better-agent-messaging: put into the running turn' }
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    // The wake prompt's own turn: its first request carries what it held.
    if (wakePrompt !== undefined && e.text === wakePrompt) wakePrompt = undefined
    isTurnRunning = true
    isRequesting = false
    isLastStep = false
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
    if (e.agentId !== undefined) return yield* next(e)
    // This request carries every row appended before it; a message the band
    // shows that is still held, or waits for the wake prompt's turn, is not.
    pending = []
    // The last response asked for no tool and the engine went on anyway (a
    // retry, a continuation): what waited goes in for the request after this.
    if (held.some(isMessage)) await deliverHeld($)
    else if (wakePrompt === undefined) await markRead($)
    isRequesting = true
    isLastStep = false
    let isContinuing = false
    try {
      const response = yield* next(e)
      isContinuing = response.toolUses.length > 0
      return response
    } finally {
      isRequesting = false
      // Tools run next and their results go back in another request, which
      // carries what waited; with no tool asked for, the turn is ending.
      if (isContinuing) {
        if (held.some(isMessage)) await deliverHeld($)
      } else {
        isLastStep = true
      }
    }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    isTurnRunning = false
    isRequesting = false
    isLastStep = false
    isDirty = true
    await update($, turnAtom, () => false)
    // What no request carried starts the next turn, as the engine would have
    // delivered it after the turn: a message held for the last response, and
    // (rarely) one put in the conversation that the turn ended before reading,
    // given again so the turn it starts reads it where the person sees it.
    // A turn the person stopped stays stopped: what was held goes into the
    // conversation, the band shows it unread, and their next prompt carries it.
    if (e.isAborted) {
      await deliverHeld($, true)
      pending = []
      held = []
    }
    const unread = [...pending, ...held]
    held = []
    pending = []
    await update($, heldAtom, () => held)
    if (unread.length > 0) {
      trace($, 'wake', { from: unread.map(d => d.from) })
      const text = wakeText(unread)
      wakePrompt = text
      void $.prompt.submit({ text, asUser: true }).catch(() => {
        if (wakePrompt === text) wakePrompt = undefined
      })
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
    const command = SHELL_TOOLS.has(tool) ? (input as { command?: unknown }).command : undefined
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

  // The band above the prompt, drawn in every pane, and only for what the agent
  // list under the prompt does not show: a message that just arrived mid-turn,
  // a teammate's own hold, and in the lead any agent that is paused or stuck.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const arrival = await read($, arrivalAtom)
    const isShown = arrival !== null && (arrival.readAt === undefined || Date.now() - arrival.readAt < READ_MS)
    const lines: string[] = []
    if (role.kind === 'teammate') {
      const hold = (await read($, holdsAtom)).main
      if (hold !== undefined) lines.push(heldLine(hold))
    } else {
      lines.push(...alertLines(await read($, rowsAtom), Date.now()))
    }
    if (!isShown && lines.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {isShown && (
          // The sender in its team colour, as Claude Code draws a teammate's name.
          <Text wrap="truncate-end">
            <Text color={arrival.color === undefined ? undefined : `${arrival.color}_FOR_SUBAGENTS_ONLY`} dimColor={arrival.color === undefined}>{arrival.from}</Text>
            <Text dimColor>{arrivalLine(arrival.text, arrival.readAt !== undefined)}</Text>
          </Text>
        )}
        {lines.map(line => <Text dimColor wrap="truncate-end">{line}</Text>)}
      </Box>
    )
  })
}
