// One task shape for every source, and the adapters that produce it.
// A task: { id, projectId, title, status, priority?, dependencies: string[], blocked?, link? }
// Internal tasks also carry { path, text, sha256 } so a move can rewrite the file (hash-checked).
// Linear tasks carry `linear`: { issue, states, statusMap, buildable } so a move can set the issue's state.
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
  label: 'Internal tasks',
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

/** GraphQL data from an http result, or a SourceError: "setup" when Helm has no `linear` profile. */
function gql(r, what) {
  if (r?.error?.code === 'not_configured')
    throw new SourceError('Linear is not set up: add a service profile named “linear” in Helm (Settings → Connections → Services, base URL https://api.linear.app, your API key).', 'setup')
  const said = r?.data?.errors?.[0]?.message // Linear's own reason, also on a 401
  if (!r?.ok) throw new SourceError(`${what}: ${r?.error?.message ?? 'no answer'}${said ? ` (${said})` : ''}`)
  if (r.data?.errors?.length) throw new SourceError(`${what}: ${r.data.errors[0].message ?? 'Linear returned an error'}`)
  return r.data?.data
}

const linear = {
  label: 'Linear',
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

/** Sources whose adapter has not landed yet. */
const later = (label, task) => ({ label, later: true, task })

export const ADAPTERS = { internal, linear, github: later('GitHub', '029') }

/** Source override setting values, in the order the setting lists them. */
export const SOURCE_OPTIONS = [
  { value: 'config', label: 'Project config (task_system)' },
  { value: 'internal', label: 'Internal tasks' },
  { value: 'linear', label: 'Linear' },
  { value: 'github', label: 'GitHub (coming in 029)' },
]

/**
 * A project's tasks from its source: the project's task_system config, unless the
 * instance overrides it (`opts.team`: the Linear team when config names none). Throws SourceError:
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
  if (!adapter || adapter.later)
    throw new SourceError(`Tasks live in ${adapter?.label ?? system.provider ?? kind}. This plugin ${adapter?.task ? `reads them once task ${adapter.task} lands` : 'has no adapter for it'}.`, 'later')
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
  if (t.linear) {
    const state = linearTarget(t.linear.states, to, t.linear.statusMap)
    if (!state) return { kind: 'refused', reason: `${t.id} can’t move to ${to}: no Linear state matches. Name one in task_system.status_map.${to}.` }
    // into Doing offers the build only when the project's task_system is Linear (the build skill reads it there)
    const kind = to === 'doing' && t.linear.buildable ? 'doing' : 'write'
    return { kind, connection: 'linear', operation: 'setState', args: { issue: t.linear.issue, state: state.id }, state }
  }
  if (!t.path || !t.sha256) return { kind: 'refused', reason: `${t.id} can’t be moved from here: this board writes internal and Linear tasks only.` }
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
  // Linear answers GraphQL errors with HTTP 200
  if (w?.ok && w.data?.errors?.length) return { status: 'reverted', message: `Linear refused the move: ${w.data.errors[0].message ?? 'error'}` }
  if (w?.ok && w.data?.data?.issueUpdate && !w.data.data.issueUpdate.success) return { status: 'reverted', message: 'Linear did not update the issue.' }
  if (w?.ok) return { status: 'moved', sha256: w.data?.sha256 }
  const code = w?.error?.code
  if (code === 'declined') return { status: 'reverted' }
  if (code === 'conflict') return { status: 'reverted', reload: true, message: `${t.id} changed since the board read it, so nothing was written. Reloaded it; try the move again.` }
  return { status: 'reverted', message: w?.error?.message ?? r?.error ?? 'The move failed.' }
}

/* ── sessions ── */
export const isLive = (x) => x.status === 'running' || x.status === 'starting' || x.status === 'waiting'
export const sessionFor = (sessions, t) => sessions.find((x) => isLive(x) && x.task?.taskId === t.id && x.task?.projectId === t.projectId)
/** Changes when a build session ends, which may have changed task statuses. */
export const endedBuilds = (sessions) => sessions.filter((x) => x.kind === 'build' && (x.status === 'exited' || x.status === 'failed')).length
