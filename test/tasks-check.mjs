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
await assert.rejects(loadProject(fake(jira), P), (e) => e.code === 'later' && /jira.*no adapter/.test(e.message))
assert.equal((await loadProject(fake(jira), P, 'internal')).length, 2)
await assert.rejects(loadProject(fake(files), P, 'github'), (e) => e.code === 'setup' && /GitHub needs a repository/.test(e.message))
await assert.rejects(loadProject(fake(files), P, 'linear'), (e) => e.code === 'setup' && /team/.test(e.message)) // no team anywhere
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
assert.deepEqual([blocked.connection, blocked.operation], ['tasks', 'write'])
assert.deepEqual(blocked.args, { project: P, path: `${SP}/tasks/001.md`, text: text.replace('Status: ready', 'Status: blocked'), expected_sha256: 'h' })
assert.equal(planMove({ ...card, status: 'blocked' }, 'draft', 'helm').kind, 'write')
const doing = planMove(card, 'doing', 'helm')
assert.equal(doing.kind, 'doing')
assert.match(doing.args.text, /^Status: doing$/m)
assert.deepEqual(planMove(card, 'done', 'helm'), { kind: 'close', prompt: '/tdt-software-production-close 001 in helm' })
assert.deepEqual(planMove(card, 'cancelled', 'helm'), { kind: 'close', prompt: '/tdt-software-production-close 001 in helm as cancelled' })
assert.equal(planMove({ ...card, path: undefined, sha256: undefined }, 'blocked', 'helm').kind, 'refused') // neither file nor Linear
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

// task 026: the Linear adapter (GraphQL over the `linear` http connection)
const STATES = [
  { id: 's-back', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 's-prog', name: 'In Progress', type: 'started', position: 2 },
  { id: 's-rev', name: 'In Review', type: 'started', position: 3 },
  { id: 's-blk', name: 'Blocked', type: 'unstarted', position: 4 },
  { id: 's-done', name: 'Done', type: 'completed', position: 5 },
  { id: 's-can', name: 'Canceled', type: 'canceled', position: 6 },
]
const issue = (n, state, priority = 0) => ({ id: `uuid-${n}`, identifier: `ENG-${n}`, title: `Issue ${n}`, priority, url: `https://linear.app/x/issue/ENG-${n}`, state })
const linearFake = (config, { profile = true, gqlError } = {}) => {
  const seen = []
  const base = fake({ ...files, [`${SP}/config.json`]: JSON.stringify(config) })
  return {
    seen,
    call: async (c, o, a) => {
      if (c !== 'linear') return base.call(c, o, a)
      seen.push([o, a])
      if (!profile) return { ok: false, status: null, data: null, error: { code: 'not_configured', message: 'No service profile "linear"' } }
      if (gqlError) return { ok: true, status: 200, data: { errors: [{ message: gqlError }] } }
      if (o === 'states') return { ok: true, status: 200, data: { data: { workflowStates: { nodes: STATES } } } }
      const page = a.after === 'c1'
        ? { nodes: [issue(3, STATES[6])], pageInfo: { hasNextPage: false, endCursor: null } }
        : { nodes: [issue(1, STATES[1], 2), issue(2, STATES[4], 4)], pageInfo: { hasNextPage: true, endCursor: 'c1' } }
      return { ok: true, status: 200, data: { data: { issues: page } } }
    },
  }
}
const linCfg = { task_system: { kind: 'external', provider: 'linear', project_ref: 'ENG', status_map: { draft: 'Backlog', ready: 'Todo', doing: 'In Progress', blocked: 'Blocked', done: 'Done', cancelled: 'Canceled' } } }
const lf = linearFake(linCfg)
const lin = await loadProject(lf, P)
assert.deepEqual(lin.map((x) => `${x.id}:${x.status}:${x.priority}`), ['ENG-1:ready:high', 'ENG-2:blocked:low', 'ENG-3:cancelled:undefined'], 'mapped lanes, two pages')
assert.deepEqual(lf.seen.map(([o, a]) => `${o}:${a.team}:${a.after ?? ''}`), ['states:ENG:', 'issues:ENG:', 'issues:ENG:c1'])
assert.equal(lin[0].link, 'https://linear.app/x/issue/ENG-1')
assert.ok(lin[0].linear.buildable)
// without status_map, state types decide; "Blocked" (unstarted) reads as ready
const typed = await loadProject(linearFake({ task_system: { kind: 'external', provider: 'linear', project_ref: 'ENG' } }), P)
assert.deepEqual(typed.map((x) => x.status), ['ready', 'ready', 'cancelled'])
// moves: only the issue's state, via the declared setState write
const toDoing = planMove(lin[0], 'doing', 'helm')
assert.deepEqual([toDoing.kind, toDoing.connection, toDoing.operation, toDoing.args], ['doing', 'linear', 'setState', { issue: 'uuid-1', state: 's-prog' }])
assert.deepEqual(planMove(lin[0], 'blocked', 'helm').args, { issue: 'uuid-1', state: 's-blk' })
assert.equal(planMove(typed[0], 'doing', 'helm').args.state, 's-prog', 'first started state by position')
assert.equal(planMove(typed[0], 'blocked', 'helm').kind, 'refused', 'no blocked type without a status_map entry')
assert.equal(planMove(lin[0], 'done', 'helm').kind, 'close', 'Done/Cancelled hand off like internal tasks')
// an override to Linear (config not Linear): moves into Doing are plain writes, no build; team from the setting
const over = await loadProject(linearFake({ task_system: { kind: 'internal' } }), P, 'linear', { team: 'ENG' })
assert.equal(over[0].linear.buildable, false)
assert.equal(planMove(over[0], 'doing', 'helm').kind, 'write')
// errors: no profile → setup; GraphQL errors → error; a bad team key → setup
await assert.rejects(loadProject(linearFake(linCfg, { profile: false }), P), (e) => e.code === 'setup' && /service profile named “linear”/.test(e.message))
await assert.rejects(loadProject(linearFake(linCfg, { gqlError: 'Authentication required' }), P), (e) => e.code === 'error' && /Authentication required/.test(e.message))
await assert.rejects(loadProject(linearFake({ task_system: { ...linCfg.task_system, project_ref: 'a b' } }), P), (e) => e.code === 'setup')
assert.equal(errorLine([{ code: 'setup', message: 'Linear is not set up.' }]), 'Linear is not set up.')
// outcomes of the http write: GraphQL errors and success:false revert
assert.deepEqual(moveOutcome({ ok: true, status: 200, data: { data: { issueUpdate: { success: true } } } }, lin[0]).status, 'moved')
assert.match(moveOutcome({ ok: true, choice: 'write', write: { ok: true, status: 200, data: { errors: [{ message: 'Entity not found' }] } } }, lin[0]).message, /Entity not found/)
assert.equal(moveOutcome({ ok: true, status: 200, data: { data: { issueUpdate: { success: false } } } }, lin[0]).status, 'reverted')
assert.equal(moveOutcome({ ok: false, status: 401, data: null, error: { code: 'http_error', message: 'HTTP 401' } }, lin[0]).message, 'HTTP 401')
const unauth = { ...linearFake(linCfg), call: async (c, o, a) => (c === 'linear' ? { ok: false, status: 401, data: { errors: [{ message: 'Authentication required' }] }, error: { code: 'http_error', message: 'The service answered HTTP 401' } } : fake({ ...files, [`${SP}/config.json`]: JSON.stringify(linCfg) }).call(c, o, a)) }
await assert.rejects(loadProject(unauth, P), (e) => e.code === 'error' && /HTTP 401 \(Authentication required\)/.test(e.message))
console.log('linear-check ok')

// task 029: the GitHub adapter (GraphQL over the `github` http connection)
{
  const { canBuild, githubId, githubRef } = await import('../src/shared/tasks.js')
  assert.deepEqual(githubRef('me/app'), { mode: 'issues', owner: 'me', repo: 'app' })
  assert.deepEqual(githubRef('org/projects/7'), { mode: 'project', owner: 'org', number: 7 })
  for (const bad of ['me', 'me/app/x', '-me/app', 'me/..', 'org/projects/0', 'a b/c']) assert.equal(githubRef(bad), null, bad)
  assert.equal(githubId('my.lib', 12), 'my-lib-12')
  assert.match(githubId('x'.repeat(100), 1), /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)

  const OPTIONS = [{ id: 'o-todo', name: 'Todo' }, { id: 'o-prog', name: 'In progress' }, { id: 'o-blk', name: 'Blocked' }, { id: 'o-done', name: 'Done' }, { id: 'o-ice', name: 'Icebox' }]
  const item = (n, opt, type = 'ISSUE') => ({ id: `item-${n}`, type, content: type === 'ISSUE' ? { number: n, title: `Issue ${n}`, url: `https://github.com/me/app/issues/${n}`, repository: { name: n > 10 ? 'lib' : 'app' } } : { title: 'pr' }, fieldValueByName: opt ? { name: opt } : null })
  const ghFake = (config, { profile = true, gqlError, noField, missing } = {}) => {
    const seen = []
    const base = fake({ ...files, [`${SP}/config.json`]: JSON.stringify(config) })
    return {
      seen,
      call: async (c, o, a) => {
        if (c !== 'github') return base.call(c, o, a)
        seen.push([o, a])
        if (!profile) return { ok: false, status: null, data: null, error: { code: 'not_configured', message: 'No service profile "github"' } }
        if (gqlError) return { ok: true, status: 200, data: { data: null, errors: [{ type: 'NOT_FOUND', message: gqlError }] } }
        if (o === 'issues') {
          if (missing) return { ok: true, status: 200, data: { data: { repository: null } } }
          const issues = a.after === 'c1'
            ? { nodes: [{ number: 3, title: 'Three', url: 'u3', state: 'CLOSED', stateReason: 'NOT_PLANNED' }], pageInfo: { hasNextPage: false, endCursor: null } }
            : { nodes: [{ number: 1, title: 'One', url: 'u1', state: 'OPEN', stateReason: null }, { number: 2, title: 'Two', url: 'u2', state: 'CLOSED', stateReason: 'COMPLETED' }], pageInfo: { hasNextPage: true, endCursor: 'c1' } }
          return { ok: true, status: 200, data: { data: { repository: { issues } } } }
        }
        const items = a.after === 'c1'
          ? { nodes: [item(11, 'Done'), item(0, null, 'DRAFT_ISSUE')], pageInfo: { hasNextPage: false, endCursor: null } }
          : { nodes: [item(1, 'Todo'), item(2, 'Blocked'), item(3, 'Icebox'), item(4, null), item(0, null, 'PULL_REQUEST')], pageInfo: { hasNextPage: true, endCursor: 'c1' } }
        return { ok: true, status: 200, data: { data: { repositoryOwner: { projectV2: { id: 'proj-1', field: noField ? {} : { id: 'fld-1', options: OPTIONS }, items } } } } }
      },
    }
  }
  // issues mode: open → ready, closed → done / cancelled; two pages; read-only lanes
  const issCfg = { task_system: { kind: 'external', provider: 'github', project_ref: 'me/app' } }
  const gi = ghFake(issCfg)
  const iss = await loadProject(gi, P)
  assert.deepEqual(iss.map((x) => `${x.id}:${x.status}`), ['app-1:ready', 'app-2:done', 'app-3:cancelled'])
  assert.deepEqual(gi.seen.map(([o, a]) => `${o}:${a.owner}/${a.repo}:${a.after ?? ''}`), ['issues:me/app:', 'issues:me/app:c1'])
  assert.ok(canBuild(iss[0]))
  for (const to of ['draft', 'blocked', 'doing']) assert.match(planMove(iss[0], to, 'helm').reason, /Projects v2/, to)
  assert.equal(planMove(iss[0], 'done', 'helm').kind, 'close')
  assert.equal(planMove(iss[1], 'cancelled', 'helm').kind, 'close')

  // Projects v2 mode: issue items only, PRs/drafts counted; lanes from the status field through status_map
  const boardCfg = { task_system: { kind: 'external', provider: 'github', project_ref: 'me/projects/7', status_field: 'Stage', status_map: { ready: 'Todo', doing: 'In Progress', blocked: 'Blocked', done: 'Done' } } }
  const gb = ghFake(boardCfg)
  const board = await loadProject(gb, P)
  assert.deepEqual(board.map((x) => `${x.id}:${x.status}`), ['app-1:ready', 'app-2:blocked', 'app-3:draft', 'app-4:draft', 'lib-11:done'])
  assert.equal(board.skipped, 2)
  assert.deepEqual(gb.seen.map(([o, a]) => `${o}:${a.owner}:${a.number}:${a.field}:${a.after ?? ''}`), ['board:me:7:Stage:', 'board:me:7:Stage:c1'])
  const into = planMove(board[0], 'doing', 'helm')
  assert.deepEqual([into.kind, into.connection, into.operation, into.args], ['doing', 'github', 'setStatus', { project: 'proj-1', item: 'item-1', field: 'fld-1', option: 'o-prog' }], 'case-insensitive option name')
  assert.equal(planMove(board[0], 'blocked', 'helm').kind, 'write')
  assert.match(planMove(board[0], 'draft', 'helm').reason, /status_map\.draft/)
  assert.equal(planMove(board[0], 'done', 'helm').kind, 'close')
  // default map without status_map; an override (config not GitHub) moves into Doing without a build
  const over = await loadProject(ghFake({ task_system: { kind: 'internal' } }), P, 'github', { github: 'me/projects/7' })
  assert.deepEqual(over.map((x) => x.status), ['ready', 'draft', 'draft', 'draft', 'done'])
  assert.equal(canBuild(over[0]), false)
  assert.equal(planMove(over[0], 'doing', 'helm').kind, 'write')
  // errors: no profile/ref/field → setup; GraphQL errors, unknown repo and 401 → error
  await assert.rejects(loadProject(ghFake(issCfg, { profile: false }), P), (e) => e.code === 'setup' && /service profile named “github”/.test(e.message))
  await assert.rejects(loadProject(ghFake({ task_system: { kind: 'internal' } }), P, 'github'), (e) => e.code === 'setup' && /owner\/repo/.test(e.message))
  await assert.rejects(loadProject(ghFake({ task_system: { ...issCfg.task_system, project_ref: 'nope' } }), P), (e) => e.code === 'setup')
  await assert.rejects(loadProject(ghFake(boardCfg, { noField: true }), P), (e) => e.code === 'setup' && /“Stage”/.test(e.message))
  await assert.rejects(loadProject(ghFake(issCfg, { gqlError: "Could not resolve to a Repository with the name 'me/app'." }), P), (e) => e.code === 'error' && /Could not resolve/.test(e.message))
  await assert.rejects(loadProject(ghFake(issCfg, { missing: true }), P), (e) => e.code === 'error' && /no repository me\/app/.test(e.message))
  const unauth = { call: async (c, o, a) => (c === 'github' ? { ok: false, status: 401, data: { message: 'Bad credentials' }, error: { code: 'http_error', message: 'The service answered HTTP 401' } } : fake({ ...files, [`${SP}/config.json`]: JSON.stringify(issCfg) }).call(c, o, a)) }
  await assert.rejects(loadProject(unauth, P), (e) => e.code === 'error' && /HTTP 401 \(Bad credentials\)/.test(e.message))
  // outcomes: the mutation's item back → moved; GraphQL error or no item → reverted with GitHub's reason
  assert.equal(moveOutcome({ ok: true, status: 200, data: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item-1' } } } } }, board[0]).status, 'moved')
  assert.match(moveOutcome({ ok: true, choice: 'write', write: { ok: true, status: 200, data: { errors: [{ message: 'Resource not accessible by integration' }] } } }, board[0]).message, /^GitHub refused the move: Resource not accessible/)
  assert.equal(moveOutcome({ ok: true, status: 200, data: { data: { updateProjectV2ItemFieldValue: null } } }, board[0]).status, 'reverted')
}
console.log('github-check ok')
