// One task shape for every source, and the adapters that produce it.
// A task: { id, projectId, title, status, priority?, dependencies: string[], blocked?, link? }
// Internal tasks also carry { path, text, sha256 } so a move can rewrite the file (hash-checked).
// Linear tasks carry `linear`: { issue, states, statusMap, buildable } so a move can set the issue's state.
// GitHub tasks carry `github`: { buildable } for Issues, plus { project, item, field, options, statusMap } on a Projects v2 board.
// Helm only hands back file text and JSON (files and http connections); this plugin owns the parsing.

export const STACK = '.tdt-project/tdt-software-production'
export const STATUSES = ['draft', 'ready', 'doing', 'blocked', 'done', 'cancelled']
const TASK_FILE = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\.md$/
const BATCH = 100

/** A tdt-software-production task file (the stack's internal Markdown authority). */
export function parseTask(id, projectId, text) {
  const field = (name) => text.match(new RegExp(`^${name}:[ \\t]*(.+)$`, 'm'))?.[1].trim()
  const heading = text.match(/^#\s+(.+)$/m)?.[1].trim() ?? id
  const title = heading.replace(new RegExp(`^${id}\\s*[—–-]\\s*`), '')
  const status = (field('Status') ?? '').toLowerCase()
  const deps = field('Dependencies')
  return {
    id,
    projectId,
    title,
    status: STATUSES.includes(status) ? status : 'draft',
    priority: field('Priority')?.toLowerCase(),
    dependencies: !deps || /^none$/i.test(deps) ? [] : deps.split(',').map((d) => d.trim()).filter(Boolean),
    blocked: field('Blocked'),
  }
}

/** The task folder from config: an ordinary relative path inside the stack folder, or null. */
export function taskDir(ref) {
  if (ref === undefined || ref === null || ref === '') return `${STACK}/tasks`
  if (typeof ref !== 'string') return null
  const rel = ref.replace(/\/+$/, '').replace(/^\.\//, '')
  if (rel.startsWith('/') || rel.split('/').some((s) => s === '..' || s === '.' || s === '')) return null
  return rel === STACK || rel.startsWith(STACK + '/') ? rel : null
}

class SourceError extends Error {
  constructor(message, code = 'error') {
    super(message)
    this.code = code
  }
}

const unwrap = (r, what) => {
  if (r?.ok) return r.data
  throw new SourceError(`${what}: ${r?.error?.message ?? 'no answer'}`, r?.error?.code === 'not_found' ? 'not_found' : 'error')
}

/* ── adapters ── */

const internal = {
  async list(helm, projectId, system) {
    const dir = taskDir(system.path)
    if (!dir) throw new SourceError('The task folder in config.json must stay inside .tdt-project/tdt-software-production/')
    const listed = unwrap(await helm.call('sp', 'list', { project: projectId }), 'Listing tasks')
    const paths = listed.files
      .map((f) => f.path)
      .filter((p) => p.startsWith(dir + '/') && TASK_FILE.test(p.slice(dir.length + 1)))
    const tasks = []
    for (let i = 0; i < paths.length; i += BATCH) {
      const read = unwrap(await helm.call('sp', 'read', { project: projectId, paths: paths.slice(i, i + BATCH) }), 'Reading tasks')
      for (const f of read.files)
        if (f.text !== undefined) tasks.push({ ...parseTask(f.path.split('/').pop().replace(/\.md$/, ''), projectId, f.text), path: f.path, text: f.text, sha256: f.sha256 })
    }
    return tasks
  },
}

/* Linear (task 026): GraphQL over the manifest's `linear` http connection (a Helm service profile). */

/** Lifecycle status for each Linear workflow state type, used when status_map does not name the state. */
const LINEAR_TYPES = { triage: 'draft', backlog: 'draft', unstarted: 'ready', started: 'doing', completed: 'done', canceled: 'cancelled' }
const LINEAR_PRIORITY = { 1: 'high', 2: 'high', 3: 'medium', 4: 'low' }
const TEAM_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/
const PAGES = 10 // ponytail: at most 1000 issues per team; filter by state server-side if a team outgrows it

/** A Linear state's lifecycle status: the status_map entry naming it (case-insensitive), else its type. */
export function linearStatus(state, statusMap = {}) {
  const name = String(state?.name ?? '').toLowerCase()
  const mapped = STATUSES.find((st) => typeof statusMap[st] === 'string' && statusMap[st].toLowerCase() === name)
  return mapped ?? LINEAR_TYPES[state?.type] ?? 'draft'
}

/** The workflow state a move to `to` sets: the one status_map names, else the first (by position) of the matching type. */
export function linearTarget(states, to, statusMap = {}) {
  const want = statusMap[to]
  if (typeof want === 'string') return states.find((x) => x.name.toLowerCase() === want.toLowerCase()) ?? null
  return states.filter((x) => LINEAR_TYPES[x.type] === to).sort((a, b) => a.position - b.position)[0] ?? null
}

const SETUP = {
  linear: 'Linear is not set up: add a service profile named “linear” in Helm (Settings → Connections → Services, base URL https://api.linear.app, your API key).',
  github: 'GitHub is not set up: add a service profile named “github” in Helm (Settings → Connections → Services, base URL https://api.github.com, a token sent as Bearer).',
}

/** GraphQL data from an http result, or a SourceError: "setup" when Helm has no profile for the service. */
function gql(r, what, service = 'linear') {
  if (r?.error?.code === 'not_configured') throw new SourceError(SETUP[service], 'setup')
  const said = r?.data?.errors?.[0]?.message ?? r?.data?.message // the service's own reason, also on a 401
  if (!r?.ok) throw new SourceError(`${what}: ${r?.error?.message ?? 'no answer'}${said ? ` (${said})` : ''}`)
  if (r.data?.errors?.length) throw new SourceError(`${what}: ${r.data.errors[0].message ?? 'the service returned an error'}`)
  return r.data?.data
}

const linear = {
  async list(helm, projectId, system, opts = {}) {
    const team = typeof system.project_ref === 'string' && system.project_ref ? system.project_ref : opts.team
    if (!team) throw new SourceError('Linear needs a team: set task_system.project_ref in config.json (the team key, such as ENG), or the Linear team setting.', 'setup')
    if (!TEAM_KEY.test(team)) throw new SourceError(`“${team}” is not a Linear team key.`, 'setup')
    const statusMap = system.status_map && typeof system.status_map === 'object' ? system.status_map : {}
    const states = gql(await helm.call('linear', 'states', { team }), 'Reading Linear states').workflowStates.nodes
    const source = { states, statusMap, buildable: String(system.provider ?? '').toLowerCase() === 'linear' }
    const tasks = []
    let after = null
    for (let page = 0; page < PAGES; page++) {
      const { nodes, pageInfo } = gql(await helm.call('linear', 'issues', { team, after }), 'Reading Linear issues').issues
      for (const i of nodes)
        tasks.push({
          id: i.identifier, projectId, title: i.title, status: linearStatus(i.state, statusMap),
          priority: LINEAR_PRIORITY[i.priority], dependencies: [], link: i.url,
          linear: { issue: i.id, ...source },
        })
      if (!pageInfo?.hasNextPage) break
      after = pageInfo.endCursor
    }
    return tasks
  },
}

/* GitHub (task 029): GraphQL over the manifest's `github` http connection. Helm's http results carry no
   headers, so REST Link paging is out; GraphQL cursors page as for Linear. */

const GH_REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/
const GH_PROJECT = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/projects\/([1-9][0-9]{0,8})$/
/** GitHub's default board options, used when task_system.status_map is absent. */
const GH_DEFAULT_MAP = { ready: 'Todo', doing: 'In Progress', done: 'Done' }

/** `owner/repo` → issues mode, `owner/projects/<n>` → Projects v2 mode, else null. */
export function githubRef(ref) {
  const p = typeof ref === 'string' ? ref.match(GH_PROJECT) : null
  if (p) return { mode: 'project', owner: p[1], number: Number(p[2]) }
  const r = typeof ref === 'string' ? ref.match(GH_REPO) : null
  return r && r[2] !== '.' && r[2] !== '..' ? { mode: 'issues', owner: r[1], repo: r[2] } : null
}

/** Task id `<repo>-<number>`: a valid build and handoff key, unique across repos on one board. */
export function githubId(repo, number) {
  const safe = String(repo).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 52)
  return `${safe || 'repo'}-${number}`
}

/** A board item's lifecycle status: the status_map entry naming its option (case-insensitive), else draft. */
export function githubStatus(optionName, statusMap) {
  const name = String(optionName ?? '').toLowerCase()
  return (name && STATUSES.find((st) => typeof statusMap[st] === 'string' && statusMap[st].toLowerCase() === name)) || 'draft'
}

const github = {
  async list(helm, projectId, system, opts = {}) {
    const raw = typeof system.project_ref === 'string' && system.project_ref ? system.project_ref : opts.github
    if (!raw) throw new SourceError('GitHub needs a repository or board: set task_system.project_ref in config.json (owner/repo, or owner/projects/<number>), or the GitHub source setting.', 'setup')
    const ref = githubRef(raw)
    if (!ref) throw new SourceError(`“${raw}” is not owner/repo or owner/projects/<number>.`, 'setup')
    const buildable = String(system.provider ?? '').toLowerCase() === 'github'
    const tasks = []
    let skipped = 0
    let after = null
    if (ref.mode === 'issues') {
      for (let page = 0; page < PAGES; page++) {
        const repo = gql(await helm.call('github', 'issues', { owner: ref.owner, repo: ref.repo, after }), 'Reading GitHub issues', 'github').repository
        if (!repo) throw new SourceError(`GitHub has no repository ${raw} (or the token cannot see it).`)
        for (const i of repo.issues.nodes)
          tasks.push({
            id: githubId(ref.repo, i.number), projectId, title: i.title, dependencies: [], link: i.url,
            status: i.state === 'OPEN' ? 'ready' : i.stateReason === 'NOT_PLANNED' ? 'cancelled' : 'done',
            github: { buildable },
          })
        if (!repo.issues.pageInfo?.hasNextPage) break
        after = repo.issues.pageInfo.endCursor
      }
      return tasks
    }
    const fieldName = typeof system.status_field === 'string' && system.status_field ? system.status_field : 'Status'
    const statusMap = system.status_map && typeof system.status_map === 'object' ? system.status_map : GH_DEFAULT_MAP
    for (let page = 0; page < PAGES; page++) {
      const board = gql(await helm.call('github', 'board', { owner: ref.owner, number: ref.number, field: fieldName, after }), 'Reading the GitHub board', 'github')
        .repositoryOwner?.projectV2
      if (!board) throw new SourceError(`GitHub has no project ${raw} (or the token cannot see it).`)
      if (!board.field?.options) throw new SourceError(`The GitHub project ${raw} has no single-select field named “${fieldName}”. Name it in task_system.status_field.`, 'setup')
      const source = { project: board.id, field: board.field.id, options: board.field.options, statusMap, buildable }
      for (const it of board.items.nodes) {
        if (it.type !== 'ISSUE' || !it.content?.number) { skipped++; continue } // ponytail: PRs and draft issues are only counted
        tasks.push({
          id: githubId(it.content.repository?.name ?? 'repo', it.content.number), projectId, title: it.content.title,
          dependencies: [], link: it.content.url, status: githubStatus(it.fieldValueByName?.name, statusMap),
          github: { ...source, item: it.id },
        })
      }
      if (!board.items.pageInfo?.hasNextPage) break
      after = board.items.pageInfo.endCursor
    }
    return Object.assign(tasks, { skipped })
  },
}

export const ADAPTERS = { internal, linear, github }

/**
 * A project's tasks from its source: the project's task_system config, unless the
 * instance overrides it (`opts.team`: the Linear team, `opts.github`: the GitHub repo or board, when config names none). Throws SourceError:
 * code "nosetup" when the project has no software-production config, "later" when its source has
 * no adapter yet, "setup" when its source needs setting up.
 */
export async function loadProject(helm, projectId, override = 'config', opts = {}) {
  const cfg = await helm.call('sp', 'read', { project: projectId, path: `${STACK}/config.json` })
  if (!cfg.ok && cfg.error?.code === 'not_found')
    throw new SourceError('This project has no software-production setup (.tdt-project/tdt-software-production/config.json).', 'nosetup')
  let config
  try {
    config = JSON.parse(unwrap(cfg, 'Reading config.json').text)
  } catch (e) {
    if (e instanceof SourceError) throw e
    throw new SourceError('The project’s software-production config.json is not valid JSON.')
  }
  const system = (config && typeof config.task_system === 'object' && config.task_system) || {}
  const configured = !system.kind || system.kind === 'internal' ? 'internal' : String(system.provider ?? 'an external task system').toLowerCase()
  const kind = override && override !== 'config' ? override : configured
  const adapter = ADAPTERS[kind]
  if (!adapter) throw new SourceError(`Tasks live in ${system.provider ?? kind}. This plugin has no adapter for it.`, 'later')
  return adapter.list(helm, projectId, kind === configured ? system : {}, opts)
}

/** Registered projects as { id, name, code, availability } (name and code as Helm shows them). */
export async function listProjects(helm) {
  const items = []
  let cursor = null
  do {
    const page = unwrap(await helm.call('tdt', 'tdt_project_list', { limit: 50, ...(cursor ? { cursor } : {}) }), 'Listing projects')
    items.push(...page.items)
    cursor = page.next_cursor
  } while (cursor)
  return items.map((p) => {
    const name = p.path.split(/[\\/]/).filter(Boolean).pop() ?? p.id
    return { id: p.id, name, code: name.replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase() || 'PRJ', availability: p.availability }
  })
}

/**
 * Tasks of every available project with a software-production setup (others are
 * skipped silently), plus per-project errors, as Helm's built-ins reported them.
 */
export async function loadAll(helm, projects, override = 'config') {
  const tasks = []
  const errors = []
  for (const p of projects.filter((x) => x.availability === 'available')) {
    try {
      tasks.push(...(await loadProject(helm, p.id, override)))
    } catch (e) {
      if (e.code !== 'nosetup') errors.push({ projectId: p.id, message: e.message, code: e.code })
    }
  }
  return { tasks, errors }
}

/** One line about per-project errors: an unsupported or unset-up source says so, anything else is counted. */
export function errorLine(errors) {
  const said = errors.filter((e) => e.code === 'later' || e.code === 'setup')
  const later = [...new Set(said.map((e) => e.message))]
  const other = errors.length - said.length
  return [...later, other ? `${other} project${other > 1 ? 's' : ''} could not be read.` : ''].filter(Boolean).join(' ')
}

/** The build skill's workspace handoff for a task, or null when none was written yet. */
export async function readHandoff(helm, projectId, taskId) {
  if (!/^[a-f0-9]{64}$/.test(projectId) || !TASK_FILE.test(`${taskId}.md`)) return null
  const r = await helm.call('handoffs', 'read', { path: `.tdt/state/software-production/${projectId}/tasks/${taskId}.md` })
  if (!r.ok && r.error?.code === 'not_found') return null
  return unwrap(r, 'Reading the handoff').text
}

/* ── moves (internal tasks) ── */

/** Task files the manifest's `tasks` connection may write. */
const WRITABLE = new RegExp(`^${STACK.replace(/[.]/g, '\\.')}/tasks/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\\.md$`)

/** The task text with only its first `Status:` line changed, or null when it has none. */
export function setStatus(text, status) {
  const line = /^Status:[ \t]*.*$/m
  return line.test(text) ? text.replace(line, `Status: ${status}`) : null
}

/**
 * What moving `t` to column `to` does:
 * none · refused { reason } · close { prompt } (Done/Cancelled: the close skill, no write) ·
 * write { connection, operation, args } (a confirmed write: the Status line, or the Linear issue's state) ·
 * doing { connection, operation, args } (Helm's build-or-move dialog; a plain write when the task can't be built).
 */
export function planMove(t, to, projectName) {
  if (!STATUSES.includes(to) || to === t.status) return { kind: 'none' }
  if (to === 'done' || to === 'cancelled')
    return { kind: 'close', prompt: `/tdt-software-production-close ${t.id} in ${projectName}${to === 'cancelled' ? ' as cancelled' : ''}` }
  if (t.github && !t.github.item)
    return { kind: 'refused', reason: `${t.id} is a plain GitHub issue: its lanes follow open/closed and this board doesn’t change them. Put it on a Projects v2 board (task_system.project_ref owner/projects/<number>) to move it.` }
  if (t.github) {
    const want = t.github.statusMap[to]
    const option = typeof want === 'string' ? t.github.options.find((o) => o.name.toLowerCase() === want.toLowerCase()) : null
    if (!option) return { kind: 'refused', reason: `${t.id} can’t move to ${to}: no board option matches. Name one in task_system.status_map.${to}.` }
    const kind = to === 'doing' && t.github.buildable ? 'doing' : 'write'
    return { kind, connection: 'github', operation: 'setStatus', args: { project: t.github.project, item: t.github.item, field: t.github.field, option: option.id }, option }
  }
  if (t.linear) {
    const state = linearTarget(t.linear.states, to, t.linear.statusMap)
    if (!state) return { kind: 'refused', reason: `${t.id} can’t move to ${to}: no Linear state matches. Name one in task_system.status_map.${to}.` }
    // into Doing offers the build only when the project's task_system is Linear (the build skill reads it there)
    const kind = to === 'doing' && t.linear.buildable ? 'doing' : 'write'
    return { kind, connection: 'linear', operation: 'setState', args: { issue: t.linear.issue, state: state.id }, state }
  }
  if (!t.path || !t.sha256) return { kind: 'refused', reason: `${t.id} can’t be moved from here: this board writes internal, Linear and GitHub board tasks only.` }
  if (!WRITABLE.test(t.path)) return { kind: 'refused', reason: `${t.id} lives outside ${STACK}/tasks/, which is the only folder this board writes.` }
  const text = setStatus(t.text, to)
  if (text === null) return { kind: 'refused', reason: `${t.id} has no “Status:” line to change.` }
  const args = { project: t.projectId, path: t.path, text, expected_sha256: t.sha256 }
  return { kind: to === 'doing' ? 'doing' : 'write', connection: 'tasks', operation: 'write', args }
}

/**
 * How a move ended, from a files write result or a build-or-move result:
 * { status: 'moved' | 'building' | 'reverted', sha256?, message?, reload? }.
 */
export function moveOutcome(r, t) {
  if (r?.choice === 'build') return r.ok ? { status: 'building' } : { status: 'reverted', message: r.error ?? 'The build did not start.' }
  if (r?.choice === 'cancel') return { status: 'reverted' }
  const w = r?.write ?? r // Helm returns the write's result in `write`, also when confirming it was refused
  // Linear and GitHub answer GraphQL errors with HTTP 200
  if (w?.ok && w.data?.errors?.length) return { status: 'reverted', message: `${t.github ? 'GitHub' : 'Linear'} refused the move: ${w.data.errors[0].message ?? 'error'}` }
  if (w?.ok && t.github && !w.data?.data?.updateProjectV2ItemFieldValue?.projectV2Item) return { status: 'reverted', message: 'GitHub did not update the item.' }
  if (w?.ok && w.data?.data?.issueUpdate && !w.data.data.issueUpdate.success) return { status: 'reverted', message: 'Linear did not update the issue.' }
  if (w?.ok) return { status: 'moved', sha256: w.data?.sha256 }
  const code = w?.error?.code
  if (code === 'declined') return { status: 'reverted' }
  if (code === 'conflict') return { status: 'reverted', reload: true, message: `${t.id} changed since the board read it, so nothing was written. Reloaded it; try the move again.` }
  return { status: 'reverted', message: w?.error?.message ?? r?.error ?? 'The move failed.' }
}

/** Start a build of `t`; the error to show, or null (also when the user declined). */
export async function startBuild(helm, t, host) {
  const r = await helm.orchestrate.build({ projectId: t.projectId, taskId: t.id, ...(host ? { host } : {}) })
  return !r.ok && r.error !== 'Declined by the user' ? r.error : null
}

/** Whether a task can be built from here: internal tasks, or a remote one whose project's task_system is that provider. */
export const canBuild = (t) => (t.linear ?? t.github)?.buildable ?? true

/* ── sessions ── */
export const isLive = (x) => x.status === 'running' || x.status === 'starting' || x.status === 'waiting'
export const sessionFor = (sessions, t) => sessions.find((x) => isLive(x) && x.task?.taskId === t.id && x.task?.projectId === t.projectId)
/** Changes when a build session ends, which may have changed task statuses. */
export const endedBuilds = (sessions) => sessions.filter((x) => x.kind === 'build' && (x.status === 'exited' || x.status === 'failed')).length
