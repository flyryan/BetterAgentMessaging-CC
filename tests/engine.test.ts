import type { AgentInfo, On } from 'claude-code'

import { deliveryNotice } from '../hooks/protocol'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

// The engine beneath the mod, mocked: a lead or a pane teammate process, the
// agents it lists, and records of what the mod sent, submitted and wrote.
type World = {
  sends: { to: string; text: string }[]
  submits: string[]
  spawned: string[]
  writes: Map<string, string>
  ran: { tool: string; agentId?: string }[]
}

const LEAD_PS = '11\tclaude --dangerously-skip-permissions\n'
const TEAMMATE_PS = '11\t/x/claude --agent-id worker@t1 --agent-name worker --team-name t1\n'

function world(on: On, opts: { ps: string; agents?: AgentInfo[] }): World {
  const w: World = { sends: [], submits: [], spawned: [], writes: new Map(), ran: [] }
  mock.env(on, { HOME: '/home/test' })
  mock.clock(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: opts.ps, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'sess-0001' }))
  on('agent.list', () => ({ value: opts.agents ?? [] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.write', ($, e) => {
    w.writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    w.submits.push(e.text)
    return { text: e.text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.receive', ($, e) => ({ text: e.text }))
  on('session.send', ($, e) => {
    w.sends.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('agent.spawn', ($, e) => {
    w.spawned.push(e.prompt)
    return { model: 'claude-opus-5-5', agentId: 'spawned' } as never
  })
  on('tool.call', ($, e) => {
    w.ran.push({ tool: e.tool, agentId: e.agentId })
    return { result: 'ran', text: 'ran' } as never
  })
  return w
}

const start = ($: Engine) =>
  $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

const fromLead = (text: string) => ({ origin: { kind: 'peer' as const, teammate: 'team-lead', isVerified: false }, text })
// The controller model's own SendMessage, as the engine raises it.
const say = (to: string, text: string) => ({ to, text, origin: { kind: 'model' as const } })
const turn = (turnId: string) => ({ text: '', turnId })

// Claude Code's security default, as it stands on a machine with managed
// settings or a Team or Enterprise organization: seated above every plugin a
// person installs, it skips their tier when the system prompt is composed.
const SEC_DEFAULT = {
  name: 'sec-default-standin',
  tier: 'prepend' as const,
  register(on: On) {
    on('prompt.compose', ($, e, next) => next.to(e, 'append'))
  },
}
const done = (turnId: string) => ({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' as const })

describe('a pane teammate', () => {
  test('takes a lead message into its running turn instead of holding it', async ($, on) => {
    world(on, { ps: TEAMMATE_PS })
    const session = mock.session(on)
    await start($)
    await $.turn.start(turn('t-1'))

    const got = await $.session.receive(fromLead('stop after step 4'))
    expect(got.consumed).toContain('running turn')
    const rows = session.appended()
    expect(rows.length).toBe(2)
    expect(rows[0]?.message.type).toBe('user')
    expect(JSON.stringify(rows[0]?.message.content)).toContain('stop after step 4')
    expect(rows[0]?.agentId).toBeUndefined()
    // and the person sees it: a notice the model never reads
    expect(rows[1]?.message.type).toBe('system')
    expect(JSON.stringify(rows[1]?.message.content)).toContain('team-lead sent')
  })

  test('leaves a message to the engine while idle, and the engine\'s own JSON always', async ($, on) => {
    world(on, { ps: TEAMMATE_PS })
    const session = mock.session(on)
    await start($)
    expect((await $.session.receive(fromLead('next task'))).text).toBe('next task')

    await $.turn.start(turn('t-1'))
    const idle = '{"type":"idle_notification","from":"x"}'
    expect((await $.session.receive(fromLead(idle))).text).toBe(idle)
    expect(session.appended().length).toBe(0)
  })

  test('starts a turn for a message that landed after its last step', async ($, on) => {
    const w = world(on, { ps: TEAMMATE_PS })
    mock.session(on)
    await start($)
    await $.turn.start(turn('t-1'))
    await $.session.receive(fromLead('one more thing'))
    await $.turn.complete(done('t-1'))
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]).toContain('team-lead sent you a message')
  })

  test('obeys hold and release from team-lead, and no one else', async ($, on) => {
    const w = world(on, { ps: TEAMMATE_PS })
    mock.session(on)
    await start($)

    await $.session.receive({ origin: { kind: 'peer', teammate: 'peer-2', isVerified: false }, text: 'hold: mine now' })
    expect((await $.tool.call({ tool: 'Read', file_path: '/x' })).deny).toBeUndefined()

    await $.session.receive(fromLead('hold: CI is red'))
    expect((await $.tool.call({ tool: 'Read', file_path: '/x' })).deny).toContain('On hold by team-lead: CI is red')
    expect((await $.tool.call({ tool: 'SendMessage', to: 'team-lead', message: 'holding' } as never)).deny).toBeUndefined()

    await $.session.receive(fromLead('release'))
    expect((await $.tool.call({ tool: 'Read', file_path: '/x' })).deny).toBeUndefined()
    expect(w.ran.filter(r => r.tool === 'Read').length).toBe(2)
  })

  test('a ship hold stops a push and nothing else', async ($, on) => {
    world(on, { ps: TEAMMATE_PS })
    mock.session(on)
    await start($)
    await $.session.receive(fromLead('hold ship: release freeze'))
    expect((await $.tool.call({ tool: 'Bash', command: 'git push origin main' })).deny).toContain('ship hold')
    expect((await $.tool.call({ tool: 'Bash', command: 'npm test' })).deny).toBeUndefined()
  })

  test('applies a hold that arrives before its session.start has run', async ($, on) => {
    world(on, { ps: TEAMMATE_PS })
    mock.session(on)
    await $.session.receive(fromLead('hold ship: freeze'))
    await start($)
    expect((await $.tool.call({ tool: 'Bash', command: 'git push origin main' })).deny).toContain('ship hold')
  })

  test('sends "main" and "lead" to team-lead, and leaves other names alone', async ($, on) => {
    const w = world(on, { ps: TEAMMATE_PS })
    await start($)
    await $.session.send(say('main', 'report'))
    await $.session.send(say('lead@t1', 'report'))
    await $.session.send(say('peer-2', 'hi'))
    expect(w.sends.map(s => s.to)).toEqual(['team-lead', 'team-lead', 'peer-2'])
  })

  test('forwards the whole answer of a turn that reached no one, and only then', async ($, on) => {
    const w = world(on, { ps: TEAMMATE_PS })
    await start($)
    const long = 'x'.repeat(5000)
    await $.turn.start(turn('t-1'))
    await $.turn.complete({ ...done('t-1'), answer: long })
    expect(w.sends.length).toBe(1)
    expect(w.sends[0]?.to).toBe('team-lead')
    expect(w.sends[0]?.text.startsWith(long)).toBe(true)

    await $.turn.start(turn('t-2'))
    await $.session.send(say('team-lead', 'all done'))
    await $.turn.complete({ ...done('t-2'), answer: 'recap' })
    expect(w.sends.map(s => s.text)).toEqual([w.sends[0]?.text, 'all done'])
  })

  test('a hold on the teammate covers the helpers it started', async ($, on) => {
    world(on, { ps: TEAMMATE_PS })
    mock.session(on)
    await start($)
    await $.session.receive(fromLead('hold ship: freeze'))
    // a helper whose spawn this process never saw (one started before a reload)
    const push = { tool: 'Bash', command: 'git push origin main', agentId: 'helper-1' }
    expect((await $.tool.call(push as never)).deny).toContain('ship hold')
    await $.session.receive(fromLead('release'))
    expect((await $.tool.call(push as never)).deny).toBeUndefined()
  })

  test('shows a mid-turn arrival and its own hold in the band, on every surface', async ($, on) => {
    world(on, { ps: TEAMMATE_PS })
    mock.session(on)
    await start($)
    await $.turn.start(turn('t-1'))
    await $.session.receive(fromLead('hold ship: QA has not signed off'))
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({
        plugin: 'better-agent-messaging', surface, component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100 },
      } as never)
      expect(await band.find({ type: 'Text', text: 'team-lead sent: hold ship: QA has not signed off' })).toBeDefined()
      expect(await band.find({ type: 'Text', text: 'team-lead blocked shipping: QA has not signed off' })).toBeDefined()
      await band.unmount()
    }
  })

  test('draws its delivery notice as the sender, in the sender\'s color, on every surface', async ($, on) => {
    world(on, { ps: TEAMMATE_PS })
    mock.session(on)
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const notice = await $.ui.mount({
        plugin: 'better-agent-messaging', surface, component: 'InfoNotice',
        props: { text: deliveryNotice('team-lead', 'stop after step 4'), command: null },
      } as never)
      expect(await notice.find({ type: 'Text', text: '@team-lead' })).toBeDefined()
      expect(await notice.find({ type: 'Text', text: 'stop after step 4' })).toBeDefined()
      await notice.unmount()
    }
  })

  test('writes its status where the lead reads it', async ($, on) => {
    const w = world(on, { ps: TEAMMATE_PS })
    await start($)
    const path = '/home/test/.claude/better-agent-messaging/t1/agents/worker.json'
    expect(JSON.parse(w.writes.get(path) ?? '{}')).toMatchObject({ name: 'worker', team: 't1', turn: 'idle' })
  })
})

describe('the lead', () => {
  const sub: AgentInfo = { id: 'a1', description: 'refactor', type: 'general-purpose', status: 'running' }
  const pane: AgentInfo = {
    id: 'worker@t1', teammateId: 'worker@t1', name: 'worker', description: 'w', type: 'teammate', status: 'running',
  }

  test('holds an in-process subagent in its own process, and releases it', async ($, on) => {
    world(on, { ps: LEAD_PS, agents: [sub] })
    await start($)
    await $.session.send(say('a1', 'hold: wait for review'))
    expect((await $.tool.call({ tool: 'Edit', agentId: 'a1' } as never)).deny).toContain('On hold by main')
    expect((await $.tool.call({ tool: 'Edit' } as never)).deny).toBeUndefined()
    await $.session.send(say('a1', 'release'))
    expect((await $.tool.call({ tool: 'Edit', agentId: 'a1' } as never)).deny).toBeUndefined()
  })

  test('a hold on a subagent covers the agents it spawns, and no one else', async ($, on) => {
    const w = world(on, { ps: LEAD_PS, agents: [sub] })
    await start($)
    await $.session.send(say('a1', 'hold: review first'))
    await $.agent.spawn({
      prompt: 'help', description: 'helper', subagentType: 'general-purpose', background: true, fork: false, parentAgentId: 'a1',
    } as never)
    expect(w.spawned.length).toBe(1)
    expect((await $.tool.call({ tool: 'Edit', agentId: 'spawned' } as never)).deny).toContain('On hold by main')
    expect((await $.tool.call({ tool: 'Edit', agentId: 'stranger' } as never)).deny).toBeUndefined()
  })

  test('broadcasts to "all" and keeps a standing order for later spawns', async ($, on) => {
    const w = world(on, { ps: LEAD_PS, agents: [sub, pane] })
    await start($)
    const sent = await $.session.send(say('all', 'standing: never force-push'))
    expect(sent.isDelivered).toBe(true)
    expect(w.sends.map(s => s.to).sort()).toEqual(['a1', 'worker@t1'])

    await $.agent.spawn({ prompt: 'Fix the bug.', description: 'fix', subagentType: 'general-purpose', background: true, fork: false } as never)
    expect(w.spawned[0]).toContain('Messages while you work')
    expect(w.spawned[0]).toContain('- never force-push')
  })

  test('teaches the controller in its system prompt', async ($, on) => {
    world(on, { ps: LEAD_PS })
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
    await start($)
    const composed = await $.prompt.compose({
      model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'],
      tools: ['SendMessage', 'Agent', 'Bash'], outputStyle: null, traits: [],
    } as never)
    expect(composed.sections.map(s => s.id)).toContain('better-agent-messaging:controller')
  })

  test('teaches the controller in its conversation when the system prompt is out of reach', { plugins: [SEC_DEFAULT] }, async ($, on) => {
    world(on, { ps: LEAD_PS })
    const session = mock.session(on)
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
    const kept = [{ role: 'user', text: 'summary of the work so far', toolUses: [] }]
    on('session.compact', () => ({ messages: kept }) as never)
    await start($)
    const notes = () => session.appended().filter(r => JSON.stringify(r.message.content).includes('hold ship:'))
    await $.turn.start(turn('t-1'))
    expect(notes().length).toBe(1)
    expect(notes()[0]?.agentId).toBeUndefined()
    await $.turn.start(turn('t-2'))
    expect(notes().length).toBe(1)
    await $.session.compact({ trigger: 'auto', messages: kept } as never)
    expect(notes().length).toBe(2)
  })

  test('adds no such note when its system-prompt section is in', async ($, on) => {
    world(on, { ps: LEAD_PS })
    const session = mock.session(on)
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
    await start($)
    await $.turn.start(turn('t-1'))
    expect(session.appended().filter(r => JSON.stringify(r.message.content).includes('hold ship:')).length).toBe(0)
  })

  test('adds live agent state to ListAgents', async ($, on) => {
    world(on, { ps: LEAD_PS, agents: [sub] })
    await start($)
    const listed = await $.tool.call({ tool: 'ListAgents' } as never)
    expect((listed.context ?? []).join('\n')).toContain('refactor (subagent): running')
  })

  test('restates standing orders after an agent compacts', async ($, on) => {
    world(on, { ps: LEAD_PS, agents: [sub] })
    const session = mock.session(on)
    const kept = [{ role: 'user', text: 'summary of the work so far', toolUses: [] }]
    on('session.compact', () => ({ messages: kept }) as never)
    await start($)
    await $.session.send(say('a1', 'standing: keep the API stable'))
    await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: kept } as never)
    const rows = session.appended()
    expect(rows.at(-1)?.agentId).toBe('a1')
    expect(JSON.stringify(rows.at(-1)?.message.content)).toContain('keep the API stable')
  })
})
