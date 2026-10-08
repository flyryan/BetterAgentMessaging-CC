import { describe, expect, test } from 'claude-code/testing'

import { gateVerdict, shipMatcher } from '../hooks/gate'
import { arrivalLine, controllerAlias, deliveryNotice, deliveryText, heldLine, extractStanding, isProtocolJson, NOTICE_MARK, noticeColor, parseNotice, parseVerb, spawnProtocol } from '../hooks/protocol'
import { parseRole } from '../hooks/role'
import { alertLines, staleness } from '../hooks/table'

describe('directives', () => {
  test('reads each directive off the first line only', () => {
    expect(parseVerb('hold: CI is red')).toEqual({ kind: 'hold', scope: 'all', reason: 'CI is red' })
    expect(parseVerb('HOLD SHIP: release freeze\nuntil Monday')).toEqual({
      kind: 'hold', scope: 'ship', reason: 'release freeze\nuntil Monday',
    })
    expect(parseVerb('hold')).toEqual({ kind: 'hold', scope: 'all', reason: 'no reason given' })
    expect(parseVerb('release')).toEqual({ kind: 'release', note: '' })
    expect(parseVerb('release: carry on')).toEqual({ kind: 'release', note: 'carry on' })
    expect(parseVerb('standing: run tests before every commit')).toEqual({
      kind: 'standing', rule: 'run tests before every commit',
    })
    expect(parseVerb('standing clear')).toEqual({ kind: 'standing-clear' })
  })

  test('leaves plain messages alone', () => {
    expect(parseVerb('holding pattern: keep going')).toBeUndefined()
    expect(parseVerb('please release the lock when done')).toBeUndefined()
    expect(parseVerb('standing:')).toBeUndefined()
    expect(parseVerb('Status?\nhold: not on the first line')).toBeUndefined()
  })

  test('knows the engine\'s own team messages from words', () => {
    expect(isProtocolJson('{"type":"idle_notification","from":"w"}')).toBe(true)
    expect(isProtocolJson('{"type":"shutdown_request"}')).toBe(true)
    expect(isProtocolJson('{ not json')).toBe(false)
    expect(isProtocolJson('Final report: done')).toBe(false)
  })
})

describe('briefs', () => {
  test('a teammate brief carries the protocol and its standing orders, and gives them back', () => {
    const brief = `Do the work.\n${spawnProtocol('team-lead', true, ['no force pushes', 'tests first'])}`
    expect(brief).toContain('Messages while you work')
    expect(brief).toContain('SendMessage (to: "team-lead")')
    expect(extractStanding(brief)).toEqual(['no force pushes', 'tests first'])
    expect(extractStanding('Do the work.')).toEqual([])
  })

  test('a delivery reads as the engine\'s own teammate message', () => {
    const text = deliveryText('team-lead', 'stop at step 4')
    expect(text).toContain('<teammate-message teammate_id="team-lead">\nstop at step 4\n</teammate-message>')
    expect(text).toContain('outranks your original brief')
    expect(deliveryText('worker', 'done')).not.toContain('outranks')
  })
})

describe('gate', () => {
  const ship = shipMatcher('')
  const all = { scope: 'all' as const, reason: 'review', by: 'team-lead', at: 0 }
  const shipOnly = { scope: 'ship' as const, reason: 'freeze', by: 'team-lead', at: 0 }

  test('a full hold refuses everything but SendMessage', () => {
    expect(gateVerdict(all, 'Read', undefined, ship)).toContain('On hold by team-lead: review')
    expect(gateVerdict(all, 'SendMessage', undefined, ship)).toBeUndefined()
    expect(gateVerdict(undefined, 'Bash', 'git push', ship)).toBeUndefined()
  })

  test('a reason ending in its own period reads once', () => {
    expect(gateVerdict({ ...all, reason: 'wait for review.' }, 'Read', undefined, ship)).toContain('team-lead: wait for review. Every')
  })

  test('a ship hold refuses shipping commands only', () => {
    for (const command of ['git push origin main', 'git -C repo push', 'gh pr merge 12 --squash', 'gh-axi pr merge 3',
      'npm publish', 'kubectl apply -f x.yaml', 'rm -rf build ', 'gh release create v1']) {
      expect(gateVerdict(shipOnly, 'Bash', command, ship)).toContain('ship hold')
    }
    for (const command of ['git status', 'git commit -m x', 'npm test', 'gh pr view 3', 'rm notes.txt', 'ls -la']) {
      expect(gateVerdict(shipOnly, 'Bash', command, ship)).toBeUndefined()
    }
    expect(gateVerdict(shipOnly, 'Edit', undefined, ship)).toBeUndefined()
  })

  test('a configured pattern adds to the list; a bad one leaves the list alone', () => {
    expect(shipMatcher('make\\s+release').test('make release')).toBe(true)
    expect(shipMatcher('make\\s+release').test('git push origin main')).toBe(true)
    expect(shipMatcher('make\\s+release').test('make test')).toBe(false)
    expect(shipMatcher('(').test('git push')).toBe(true)
    expect(shipMatcher('(').test('git status')).toBe(false)
  })
})

describe('roles and rows', () => {
  test('a pane teammate is read off its claude process\'s flags', () => {
    expect(parseRole('10\tzsh\n11\t/x/claude --agent-id w@t --agent-name w --team-name t --model opus\n')).toMatchObject({
      kind: 'teammate', name: 'w', team: 't',
    })
    expect(parseRole('11\tclaude --dangerously-skip-permissions\n')).toMatchObject({ kind: 'lead' })
  })

  test('the lead sees only agents that are paused or stuck, in plain words', () => {
    const base = { kind: 'teammate' as const, standing: 0, unseen: 0 }
    const ship = { scope: 'ship' as const, reason: 'QA first', by: 'team-lead', at: 0 }
    const all = { scope: 'all' as const, reason: 'wait for review', by: 'team-lead', at: 0 }
    expect(alertLines([
      { ...base, key: '1', name: 'impl', status: 'running', tool: 'Bash', toolSince: 0 },
      { ...base, key: '2', name: 'docs', status: 'idle' },
    ], 12_000)).toEqual([])
    expect(alertLines([
      { ...base, key: '1', name: 'impl', status: 'running', stale: 'in Bash for 47m' },
      { ...base, key: '2', name: 'review', status: 'running', hold: ship },
      { ...base, key: '3', name: 'docs', status: 'idle', hold: all },
      { ...base, key: '4', name: 'qa', status: 'idle' },
    ], 0)).toEqual([
      'impl looks stuck: in Bash for 47m',
      "review can't ship: QA first",
      'docs is paused: wait for review',
    ])
    expect(alertLines([], 0)).toEqual([])
  })

  test('more than three alerts fold into a count', () => {
    const base = { kind: 'teammate' as const, standing: 0, unseen: 0, status: 'running' }
    const hold = { scope: 'all' as const, reason: 'r', by: 'team-lead', at: 0 }
    const rows = ['a', 'b', 'c', 'd', 'e'].map(name => ({ ...base, key: name, name, hold }))
    expect(alertLines(rows, 0)).toEqual(['a is paused: r', 'b is paused: r', 'and 3 more paused or stuck: see /agent-status'])
  })

  test('a delivery notice names its sender for the drawing and reads plainly without it', () => {
    const text = deliveryNotice('team-lead', 'stop after step 4\nthanks')
    expect(text.startsWith(NOTICE_MARK)).toBe(true)
    expect(text.slice(NOTICE_MARK.length)).toBe('@team-lead sent:\nstop after step 4\nthanks')
    expect(parseNotice(text)).toEqual({ from: 'team-lead', body: 'stop after step 4\nthanks' })
    expect(parseNotice('@impl sent:\nnot this mod\'s notice')).toBeUndefined()
  })

  test('a sender is drawn in its team color; team-lead in Claude\'s', () => {
    expect(noticeColor('team-lead')).toBe('claude')
    expect(noticeColor('impl', 'green')).toBe('green')
    expect(noticeColor('impl', 'purple')).toBe('magenta')
    expect(noticeColor('impl', 'orange')).toMatch(/^#/)
    expect(noticeColor('impl', undefined)).toBe('cyan')
  })

  test('arrival and hold lines are one short line each', () => {
    expect(arrivalLine('team-lead', 'hold ship: QA first\nmore detail')).toBe('team-lead sent: hold ship: QA first')
    expect(arrivalLine('impl', 'x'.repeat(300)).length).toBeLessThan(220)
    expect(heldLine({ scope: 'ship', reason: 'QA first', by: 'team-lead', at: 0 })).toBe('team-lead blocked shipping: QA first')
    expect(heldLine({ scope: 'all', reason: 'QA first', by: 'team-lead', at: 0 })).toBe('team-lead paused this agent: QA first')
  })

  test('knows what a teammate calls its controller', () => {
    for (const to of ['main', 'lead', 'Lead', '@team-lead@t1', 'controller', 'team lead']) {
      expect(controllerAlias(to, 't1')).toBe(true)
    }
    for (const to of ['team-lead', 'peer-2', 'mainline', 'worker@t1']) expect(controllerAlias(to, 't1')).toBe(false)
  })

  test('only a working agent goes stale', () => {
    const t = { staleMs: 60_000, toolStaleMs: 120_000 }
    const base = { key: 'a', name: 'a', kind: 'subagent' as const, standing: 0, unseen: 0 }
    expect(staleness({ ...base, status: 'running', lastActivity: 0 }, 61_000, t)).toContain('no step or tool')
    expect(staleness({ ...base, status: 'idle', lastActivity: 0 }, 61_000, t)).toBeUndefined()
    expect(staleness({ ...base, status: 'running', tool: 'Bash', toolSince: 0, lastActivity: 0 }, 61_000, t)).toBeUndefined()
    expect(staleness({ ...base, status: 'running', tool: 'Bash', toolSince: 0, lastActivity: 0 }, 121_000, t)).toContain('in Bash')
  })
})
