// Self-check for the task parser and the internal adapter against a fake bridge. Run: npm run check
import assert from 'node:assert/strict'
import { endedBuilds, errorLine, loadAll, loadProject, parseTask, readHandoff, sessionFor, taskDir } from '../src/shared/tasks.js'

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
console.log('tasks-check ok')
