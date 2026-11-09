// One task shape for every source, and the adapters that produce it.
// A task: { id, projectId, title, status, priority?, dependencies: string[], blocked?, link? }
// Helm only hands back file text (files connections); this plugin owns the parsing.

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
      for (const f of read.files) if (f.text !== undefined) tasks.push(parseTask(f.path.split('/').pop().replace(/\.md$/, ''), projectId, f.text))
    }
    return tasks
  },
}

/** Sources whose adapter ships with task 023. */
const later = (label) => ({ label, later: true })

export const ADAPTERS = { internal, jira: later('Jira'), linear: later('Linear'), github: later('GitHub') }

/** Source override setting values, in the order the setting lists them. */
export const SOURCE_OPTIONS = [
  { value: 'config', label: 'Project config (task_system)' },
  { value: 'internal', label: 'Internal tasks' },
  { value: 'jira', label: 'Jira (needs 023)' },
  { value: 'linear', label: 'Linear (needs 023)' },
  { value: 'github', label: 'GitHub (needs 023)' },
]

/**
 * A project's tasks from its source: the project's task_system config, unless the
 * instance overrides it. Throws SourceError: code "nosetup" when the project has no
 * software-production config, "later" when its source has no adapter yet.
 */
export async function loadProject(helm, projectId, override = 'config') {
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
    throw new SourceError(`Tasks live in ${adapter?.label ?? system.provider ?? kind}. This plugin reads them once task 023 adds that adapter.`, 'later')
  return adapter.list(helm, projectId, kind === configured ? system : {})
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

/** One line about per-project errors: a source that needs 023 says so, anything else is counted. */
export function errorLine(errors) {
  const later = [...new Set(errors.filter((e) => e.code === 'later').map((e) => e.message))]
  const other = errors.length - errors.filter((e) => e.code === 'later').length
  return [...later, other ? `${other} project${other > 1 ? 's' : ''} could not be read.` : ''].filter(Boolean).join(' ')
}

/** The build skill's workspace handoff for a task, or null when none was written yet. */
export async function readHandoff(helm, projectId, taskId) {
  if (!/^[a-f0-9]{64}$/.test(projectId) || !TASK_FILE.test(`${taskId}.md`)) return null
  const r = await helm.call('handoffs', 'read', { path: `.tdt/state/software-production/${projectId}/tasks/${taskId}.md` })
  if (!r.ok && r.error?.code === 'not_found') return null
  return unwrap(r, 'Reading the handoff').text
}

/* ── sessions ── */
export const isLive = (x) => x.status === 'running' || x.status === 'starting' || x.status === 'waiting'
export const sessionFor = (sessions, t) => sessions.find((x) => isLive(x) && x.task?.taskId === t.id && x.task?.projectId === t.projectId)
/** Changes when a build session ends, which may have changed task statuses. */
export const endedBuilds = (sessions) => sessions.filter((x) => x.kind === 'build' && (x.status === 'exited' || x.status === 'failed')).length
