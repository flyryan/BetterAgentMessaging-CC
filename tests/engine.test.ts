import type { AgentInfo, On } from 'claude-code'

import { CONTROLLER_NOTE } from '../hooks/protocol'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

// The engine beneath the mod, mocked: a lead or a pane teammate process, the
// agents it lists, and records of what the mod sent, submitted and wrote.
type World = {
  sends: { to: string; text: string }[]
  submits: string[]
  asUser: boolean[]
  spawned: string[]
  writes: Map<string, string>
  ran: { tool: string; agentId?: string }[]
  processRuns: string[][]
  settle: () => Promise<void>
}

const LEAD_PS = '11\tclaude --dangerously-skip-permissions\n'
const TEAMMATE_PS = '11\t/x/claude --agent-id worker@t1 --agent-name worker --team-name t1\n'

function world(
  on: On,
  opts: { ps: string; agents?: AgentInfo[]; files?: Record<string, string>; env?: Record<string, string> },
): World {
  const clock = mock.clock(on)
  const w: World = {
    sends: [], submits: [], asUser: [], spawned: [], writes: new Map(), ran: [], processRuns: [], settle: clock.settle,
  }
  mock.env(on, opts.env ?? { HOME: '/home/test' })
  on('process.run', ($, e) => {
    w.processRuns.push([...e.argv])
    return { value: { exitCode: 0, stdout: opts.ps, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: 'sess-0001' }))
  on('agent.list', () => ({ value: opts.agents ?? [] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.write', ($, e) => {
    w.writes.set(e.path, e.text)
    return { value: undefined }
  })
  const files = opts.files ?? {}
  on('fs.stat', ($, e) => (e.path in files ? { value: { mtimeMs: 1 } as never } : { deny: 'ENOENT' }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] as never } : { deny: 'ENOENT' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    w.submits.push(e.text)
    w.asUser.push(e.origin.kind === 'plugin' && e.origin.asUser === true)
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

/**
 * The main loop's model requests, each answered when the test says: `begin`
 * puts one in flight, and its `finish` lets the response in, asking for `tools`.
 */
function steps(on: On) {
  let finish: (tools: string[]) => void = () => undefined
  on('turn.step', async function* (_$, e) {
    const tools = await new Promise<string[]>(resolve => (finish = resolve))
    return {
      turnId: e.turnId, index: e.index, answer: tools.length > 0 ? '' : 'done',
      toolUses: tools.map((name, i) => ({ id: `tu-${i}`, name, input: {} })),
      stopReason: tools.length > 0 ? 'tool_use' as const : 'end_turn' as const, usage: null,
    }
  })
  return {
    begin($: Engine, turnId: string, index = 0) {
      const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 1 })
      const drained = (async () => {
        for await (const _chunk of stream) { /* drain */ }
        return stream.result
      })()
      return { finish: async (tools: string[]) => (finish(tools), drained) }
    },
  }
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

  test('starts a turn for a message that landed after its last request', async ($, on) => {
    const w = world(on, { ps: TEAMMATE_PS })
    mock.session(on)
    await start($)
    await $.turn.start(turn('t-1'))
    await $.session.receive(fromLead('one more thing'))
    await $.turn.complete(done('t-1'))
    // given again in the engine's own frame, drawn as the engine draws it
    expect(w.submits).toEqual(['<teammate-message teammate_id="team-lead">\none more thing\n</teammate-message>'])
    expect(w.asUser).toEqual([true])
  })

  test('holds a message that lands while the model writes, and puts it in when tools follow', async ($, on) => {
    const w = world(on, { ps: TEAMMATE_PS })
    const session = mock.session(on)
    const model = steps(on)
    await start($)
    await $.turn.start(turn('t-1'))
    const request = model.begin($, 't-1')
    await w.settle()
    const got = await $.session.receive(fromLead('stop after step 4'))
    expect(got.consumed).toContain('held')
    expect(session.appended().length).toBe(0)
    await request.finish(['Bash'])
    // the tools' results go back in another request, which carries it
    expect(session.appended().length).toBe(2)
    expect(JSON.stringify(session.appended()[0]?.message.content)).toContain('stop after step 4')
    await $.turn.complete(done('t-1'))
    expect(w.submits.length).toBe(1) // the request after the tools never ran here
  })

  test('a message that lands during the last response starts the next turn as the engine would', async ($, on) => {
    const w = world(on, { ps: TEAMMATE_PS })
    const session = mock.session(on)
    const model = steps(on)
    await start($)
    await $.turn.start(turn('t-1'))
    const request = model.begin($, 't-1')
    await w.settle()
    await $.session.receive(fromLead('one more thing'))
    await request.finish([])
    // one arriving after the last response but before the turn ends waits too
    await $.session.receive(fromLead('and another'))
    expect(session.appended().length).toBe(0)
    await $.turn.complete(done('t-1'))
    expect(w.submits.length).toBe(1)
    expect(w.asUser[0]).toBe(true)
    expect(w.submits[0]).toBe(
      '<teammate-message teammate_id="team-lead">\none more thing\n</teammate-message>\n'
      + '<teammate-message teammate_id="team-lead">\nand another\n</teammate-message>',
    )
  })

  test('an engine notice behind a held message waits with it, and the band keeps it unread until the wake turn', async ($, on) => {
    const w = world(on, { ps: TEAMMATE_PS })
    mock.session(on)
    const model = steps(on)
    await start($)
    await $.turn.start(turn('t-1'))
    const request = model.begin($, 't-1')
    await w.settle()
    await $.session.receive(fromLead('one more thing'))
    const idle = '{"type":"idle_notification","from":"team-lead"}'
    expect((await $.session.receive(fromLead(idle))).consumed).toContain('held behind')
    await request.finish([])
    await $.turn.complete(done('t-1'))
    expect(w.submits).toEqual([
      '<teammate-message teammate_id="team-lead">\none more thing\n</teammate-message>\n'
      + `<teammate-message teammate_id="team-lead">\n${idle}\n</teammate-message>`,
    ])
    const band = async () => {
      const mounted = await $.ui.mount({
        plugin: 'better-agent-messaging', surface: 'terminal', component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100 },
      } as never)
      const found = await mounted.find({ type: 'Text', text: /team-lead sent \((un)?read\)/ })
      await mounted.unmount()
      return found?.text
    }
    // another turn runs first (a prompt the person typed): still unread
    await $.turn.start({ text: 'something else', turnId: 't-2' })
    const second = model.begin($, 't-2')
    await w.settle()
    expect(await band()).toContain('(unread)')
    await second.finish([])
    await $.turn.complete(done('t-2'))
    // the wake prompt's own turn carries it
    await $.turn.start({ text: w.submits[0] ?? '', turnId: 't-3' })
    const third = model.begin($, 't-3')
    await w.settle()
    expect(await band()).toContain('(read)')
    await third.finish([])
  })

  test('with tools to follow, a held message goes in and the notice behind it waits for the turn\'s end', async ($, on) => {
    const w = world(on, { ps: TEAMMATE_PS })
    const session = mock.session(on)
    const model = steps(on)
    await start($)
    await $.turn.start(turn('t-1'))
    const request = model.begin($, 't-1')
    await w.settle()
    await $.session.receive(fromLead('one more thing'))
    const idle = '{"type":"idle_notification","from":"team-lead"}'
    await $.session.receive(fromLead(idle))
    await request.finish(['Bash'])
    expect(session.appended().length).toBe(2)
    expect(JSON.stringify(session.appended())).not.toContain('idle_notification')
    // the request after the tools carries the message
    const after = model.begin($, 't-1', 1)
    await w.settle()
    await after.finish([])
    await $.turn.complete(done('t-1'))
    // drawn as the engine draws its notice, after the turn, as it would have
    expect(w.submits).toEqual([`<teammate-message teammate_id="team-lead">\n${idle}\n</teammate-message>`])
  })

  test('a turn the person stopped stays stopped: what waited goes into the conversation', async ($, on) => {
    const w = world(on, { ps: TEAMMATE_PS })
    const session = mock.session(on)
    const model = steps(on)
    await start($)
    await $.turn.start(turn('t-1'))
    const request = model.begin($, 't-1')
    await w.settle()
    await $.session.receive(fromLead('one more thing'))
    await request.finish([])
    await $.turn.complete({ ...done('t-1'), isAborted: true })
    expect(w.submits).toEqual([])
    expect(session.appended().length).toBe(2)
    expect(JSON.stringify(session.appended()[0]?.message.content)).toContain('one more thing')
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
      expect(await band.find({ type: 'Text', text: 'team-lead sent (unread): hold ship: QA has not signed off' })).toBeDefined()
      expect(await band.find({ type: 'Text', text: 'team-lead blocked shipping: QA has not signed off' })).toBeDefined()
      await band.unmount()
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

  test('shows a teammate\'s mid-turn report in the band, its name in the teammate\'s colour', async ($, on) => {
    const config = JSON.stringify({ members: [{ name: 'team-lead' }, { name: 'worker', color: 'green' }] })
    world(on, { ps: LEAD_PS, agents: [pane], files: { '/home/test/.claude/teams/t1/config.json': config } })
    mock.session(on)
    await start($)
    await $.turn.start(turn('t-1'))
    const report = { origin: { kind: 'peer' as const, teammate: 'worker', isVerified: false }, text: 'tests green' }
    expect((await $.session.receive(report)).consumed).toBeDefined()
    const band = await $.ui.mount({
      plugin: 'better-agent-messaging', surface: 'terminal', component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100 },
    } as never)
    expect((await band.find({ type: 'Text', text: /^worker$/ }))?.props.color).toBe('green_FOR_SUBAGENTS_ONLY')
    expect(await band.find({ type: 'Text', text: 'worker sent (unread): tests green' })).toBeDefined()
    await band.unmount()
  })

  test('on Windows it is the lead without walking ps, and reads ~/.claude under USERPROFILE', async ($, on) => {
    const config = JSON.stringify({ members: [{ name: 'team-lead' }, { name: 'worker', color: 'green' }] })
    // A teammate's ps output, so a walk that ran would make this process a teammate.
    // HOME is Git Bash's spelling; USERPROFILE stands in for C:\\Users\\test, which
    // the engine would resolve against the cwd on the Mac or Linux box running this.
    const w = world(on, {
      ps: TEAMMATE_PS, agents: [pane], env: { OS: 'Windows_NT', HOME: '/c/Users/test', USERPROFILE: '/profile/test' },
      files: { '/profile/test/.claude/teams/t1/config.json': config },
    })
    mock.session(on)
    await start($)
    await $.turn.start(turn('t-1'))
    const report = { origin: { kind: 'peer' as const, teammate: 'worker', isVerified: false }, text: 'tests green' }
    expect((await $.session.receive(report)).consumed).toBeDefined()
    const band = await $.ui.mount({
      plugin: 'better-agent-messaging', surface: 'terminal', component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100 },
    } as never)
    expect((await band.find({ type: 'Text', text: /^worker$/ }))?.props.color).toBe('green_FOR_SUBAGENTS_ONLY')
    await band.unmount()
    expect(w.processRuns).toEqual([])
    expect([...w.writes.keys()].some(path => path.includes('/agents/'))).toBe(false)
  })

  test('a held agent on Windows cannot push or delete from the PowerShell tool', async ($, on) => {
    world(on, { ps: LEAD_PS, agents: [sub], env: { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\test' } })
    await start($)
    await $.session.send(say('a1', 'hold ship: release freeze'))
    const ps = (command: string) => $.tool.call({ tool: 'PowerShell', command, agentId: 'a1' } as never)
    expect((await ps('git push origin main')).deny).toContain('ship hold')
    expect((await ps('Remove-Item -Recurse -Force build')).deny).toContain('ship hold')
    expect((await ps('npm test')).deny).toBeUndefined()
    await $.session.send(say('a1', 'hold: wait'))
    expect((await ps('Get-ChildItem')).deny).toContain('On hold by main')
  })

  test('drops a stopped teammate\'s idle notice the engine hands over late, and no other', async ($, on) => {
    const stopped: AgentInfo = { ...pane, id: 'old@t1', teammateId: 'old@t1', name: 'old', status: 'killed' }
    world(on, { ps: LEAD_PS, agents: [pane, stopped] })
    await start($)
    const idle = (from: string, minutesAgo: number) => ({
      origin: { kind: 'peer' as const, teammate: from, isVerified: false },
      text: JSON.stringify({ type: 'idle_notification', from, timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString() }),
    })
    expect((await $.session.receive(idle('old', 116))).consumed).toContain('late')
    expect((await $.session.receive(idle('gone', 116))).consumed).toContain('late')
    // on time, or from a teammate still running: the engine's as ever
    expect((await $.session.receive(idle('old', 0))).text).toBeDefined()
    expect((await $.session.receive(idle('worker', 116))).text).toBeDefined()
  })

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

  test('adds no second note to a conversation that has one (a reload, a resume)', { plugins: [SEC_DEFAULT] }, async ($, on) => {
    world(on, { ps: LEAD_PS })
    const session = mock.session(on)
    on('session.messages', () => ({ value: [{ role: 'user', text: CONTROLLER_NOTE, toolUses: [] }] }) as never)
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
    await start($)
    await $.turn.start(turn('t-1'))
    expect(session.appended().filter(r => JSON.stringify(r.message.content).includes('hold ship:')).length).toBe(0)
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
