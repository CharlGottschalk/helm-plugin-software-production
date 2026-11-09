// Self-check for the task parser and the internal adapter against a fake bridge. Run: npm run check
import assert from 'node:assert/strict'
import { endedBuilds, errorLine, loadAll, loadProject, moveOutcome, parseTask, planMove, readHandoff, sessionFor, setStatus, taskDir } from '../src/shared/tasks.js'

const t = parseTask('004', 'p', '# 004 — TaskSource, live Kanban\n\nStatus: blocked\nBlocked: waiting on 003.\nPriority: High\nDependencies: 002, 003\n')
assert.equal(t.title, 'TaskSource, live Kanban')
assert.equal(t.status, 'blocked')
assert.equal(t.priority, 'high')
assert.deepEqual(t.dependencies, ['002', '003'])
assert.equal(t.blocked, 'waiting on 003.')
const n = parseTask('x1', 'p', '# x1 - Something\nStatus: Weird\nDependencies: none\n')
assert.ok(n.title === 'Something' && n.status === 'draft' && n.dependencies.length === 0)

const SP = '.tdt-project/tdt-software-production'
assert.equal(taskDir(undefined), `${SP}/tasks`)
assert.equal(taskDir(`${SP}/work/`), `${SP}/work`)
for (const bad of ['/etc', `${SP}/../src`, 'src/tasks', `./${SP}/./x`]) assert.equal(taskDir(bad), null, bad)

const P = 'a'.repeat(64)
const fake = (files, calls = []) => ({
  call: async (conn, op, args) => {
    calls.push(`${conn}.${op}`)
    if (conn === 'tdt') return { ok: true, data: { items: [{ id: P, path: '/x/helm', availability: 'available' }, { id: 'b'.repeat(64), path: '/x/other', availability: 'available' }], next_cursor: null } }
    if (args.project && args.project !== P) return { ok: false, data: null, error: { code: 'not_found', message: 'nope' } }
    if (op === 'list') return { ok: true, data: { files: Object.keys(files).filter((p) => p.startsWith(SP)).map((path) => ({ path, size: 1 })) } }
    if (args.paths) return { ok: true, data: { files: args.paths.map((p) => (p in files ? { path: p, text: files[p] } : { path: p, error: { code: 'not_found' } })) } }
    return args.path in files ? { ok: true, data: { path: args.path, text: files[args.path] } } : { ok: false, data: null, error: { code: 'not_found', message: 'missing' } }
  },
})
const files = {
  [`${SP}/config.json`]: '{"task_system":{"kind":"internal"}}',
  [`${SP}/tasks/001.md`]: '# 001 — One\nStatus: ready\nPriority: high\n',
  [`${SP}/tasks/002.md`]: '# 002 — Two\nStatus: done\n',
  [`${SP}/tasks/sub/003.md`]: '# 003 — nested, not a task\n',
  [`${SP}/brief.md`]: '# brief',
  [`.tdt/state/software-production/${P}/tasks/001.md`]: '# handoff',
}
const calls = []
const list = await loadProject(fake(files, calls), P)
assert.deepEqual(list.map((x) => `${x.id}:${x.status}`), ['001:ready', '002:done'])
assert.deepEqual(calls, ['sp.read', 'sp.list', 'sp.read'], 'config, list, one batch read')

// external sources and overrides
const jira = { ...files, [`${SP}/config.json`]: '{"task_system":{"kind":"external","provider":"jira"}}' }
await assert.rejects(loadProject(fake(jira), P), (e) => e.code === 'later' && /Jira.*023/.test(e.message))
assert.equal((await loadProject(fake(jira), P, 'internal')).length, 2)
await assert.rejects(loadProject(fake(files), P, 'linear'), (e) => e.code === 'later')
await assert.rejects(loadProject(fake({ ...files, [`${SP}/config.json`]: '{' }), P), /not valid JSON/)

// all projects: the one without setup is skipped silently
const all = await loadAll(fake(files), [{ id: P, availability: 'available' }, { id: 'b'.repeat(64), availability: 'available' }, { id: 'c', availability: 'missing or moved' }])
assert.equal(all.tasks.length, 2)
assert.deepEqual(all.errors, [])

assert.equal(errorLine([{ code: 'later', message: 'Tasks live in Jira.' }, { code: 'later', message: 'Tasks live in Jira.' }, { code: 'error', message: 'x' }]), 'Tasks live in Jira. 1 project could not be read.')
assert.equal((await loadAll(fake(files), [{ id: P, availability: 'available' }], 'jira')).errors[0].code, 'later')
assert.equal(await readHandoff(fake(files), P, '001'), '# handoff')
assert.equal(errorLine([{ code: 'later', message: 'Tasks live in Jira.' }, { code: 'later', message: 'Tasks live in Jira.' }, { code: 'error', message: 'x' }]), 'Tasks live in Jira. 1 project could not be read.')
assert.equal((await loadAll(fake(files), [{ id: P, availability: 'available' }], 'jira')).errors[0].code, 'later')
assert.equal(await readHandoff(fake(files), P, '002'), null)
assert.equal(errorLine([{ code: 'later', message: 'Tasks live in Jira.' }, { code: 'later', message: 'Tasks live in Jira.' }, { code: 'error', message: 'x' }]), 'Tasks live in Jira. 1 project could not be read.')
assert.equal((await loadAll(fake(files), [{ id: P, availability: 'available' }], 'jira')).errors[0].code, 'later')
assert.equal(await readHandoff(fake(files), 'not-an-id', '001'), null)

const sessions = [{ status: 'running', kind: 'build', task: { projectId: P, taskId: '001' } }, { status: 'exited', kind: 'build', task: { projectId: P, taskId: '002' } }]
assert.ok(sessionFor(sessions, list[0]) && !sessionFor(sessions, list[1]))
assert.equal(endedBuilds(sessions), 1)

// task 028 moves: which moves write (only the Status line) and which hand off
assert.equal(setStatus('# 1\r\nStatus: ready\r\nPriority: high\r\nStatus: later\r\n', 'blocked'), '# 1\r\nStatus: blocked\r\nPriority: high\r\nStatus: later\r\n')
assert.equal(setStatus('# 1\nno status\n', 'ready'), null)
const text = '# 001 — One\n\nStatus: ready\nPriority: high\n'
const card = { id: '001', projectId: P, status: 'ready', path: `${SP}/tasks/001.md`, text, sha256: 'h' }
assert.equal(planMove(card, 'ready', 'helm').kind, 'none')
assert.equal(planMove(card, 'bogus', 'helm').kind, 'none')
const blocked = planMove(card, 'blocked', 'helm')
assert.equal(blocked.kind, 'write')
assert.deepEqual(blocked.args, { project: P, path: `${SP}/tasks/001.md`, text: text.replace('Status: ready', 'Status: blocked'), expected_sha256: 'h' })
assert.equal(planMove({ ...card, status: 'blocked' }, 'draft', 'helm').kind, 'write')
const doing = planMove(card, 'doing', 'helm')
assert.equal(doing.kind, 'doing')
assert.match(doing.args.text, /^Status: doing$/m)
assert.deepEqual(planMove(card, 'done', 'helm'), { kind: 'close', prompt: '/tdt-software-production-close 001 in helm' })
assert.deepEqual(planMove(card, 'cancelled', 'helm'), { kind: 'close', prompt: '/tdt-software-production-close 001 in helm as cancelled' })
assert.equal(planMove({ ...card, path: undefined, sha256: undefined }, 'blocked', 'helm').kind, 'refused') // external
assert.equal(planMove({ ...card, path: `${SP}/work/001.md` }, 'blocked', 'helm').kind, 'refused') // not tasks/
assert.equal(planMove({ ...card, path: `${SP}/tasks/sub/001.md` }, 'blocked', 'helm').kind, 'refused')
assert.equal(planMove({ ...card, text: 'no status' }, 'blocked', 'helm').kind, 'refused')
// the internal adapter keeps path, text and hash for moves
const hashed = { call: async (c, o, a) => { const r = await fake(files).call(c, o, a); if (a.paths) r.data.files.forEach((f) => (f.sha256 = 'sha-' + f.path)); return r } }
const loaded = (await loadProject(hashed, P))[0]
assert.deepEqual([loaded.path, loaded.sha256, loaded.text], [`${SP}/tasks/001.md`, `sha-${SP}/tasks/001.md`, files[`${SP}/tasks/001.md`]])

// outcomes: moved, building, reverted (cancel, declined, conflict reloads, errors shown)
assert.deepEqual(moveOutcome({ ok: true, data: { sha256: 'n' } }, card), { status: 'moved', sha256: 'n' })
assert.deepEqual(moveOutcome({ ok: true, choice: 'write', write: { ok: true, data: { sha256: 'n' } } }, card), { status: 'moved', sha256: 'n' })
assert.deepEqual(moveOutcome({ ok: true, choice: 'build' }, card), { status: 'building' })
assert.deepEqual(moveOutcome({ ok: false, choice: 'build', error: 'no server' }, card), { status: 'reverted', message: 'no server' })
assert.deepEqual(moveOutcome({ ok: false, choice: 'cancel', error: 'Declined by the user' }, card), { status: 'reverted' })
assert.deepEqual(moveOutcome({ ok: false, data: null, error: { code: 'declined', message: 'x' } }, card), { status: 'reverted' })
const conflict = moveOutcome({ ok: false, choice: 'write', write: { ok: false, error: { code: 'conflict', message: 'changed' } } }, card)
assert.ok(conflict.status === 'reverted' && conflict.reload && /nothing was written/.test(conflict.message))
// a stale hash is refused when Helm confirms the write, before any dialog
assert.ok(moveOutcome({ ok: false, error: 'changed', write: { ok: false, data: null, error: { code: 'conflict', message: 'changed' } } }, card).reload)
assert.equal(moveOutcome({ ok: false, error: 'orWrite must be a declared files write', write: undefined }, card).message, 'orWrite must be a declared files write')
assert.equal(moveOutcome({ ok: false, data: null, error: { code: 'refused', message: 'nope' } }, card).message, 'nope')
console.log('tasks-check ok')
