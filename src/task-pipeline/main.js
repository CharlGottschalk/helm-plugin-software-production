// Task pipeline widget: counts per lifecycle status, with Build on the first ready tasks.
import { getHelm } from '@usetdt/helm-sdk/frame'
import { STATUSES, canBuild, endedBuilds, errorLine, listProjects, loadAll, loadProject, sessionFor, startBuild } from '../shared/tasks.js'
import { STATUS_LABELS, STATUS_TONES, badge, button, dot, el, meter, state, styles, fill } from '../shared/ui.js'

const helm = getHelm()
const app = document.getElementById('app')
styles()

let settings = {}
let sessions = []
let ended = 0
let data = null
let message = null
let seq = 0

async function load() {
  const mine = ++seq
  if (!data) state(app, 'loading', 'Loading tasks…')
  try {
    const projects = await listProjects(helm)
    let all
    if (settings.projectId) {
      // one project: its own errors (no setup, unsupported or unset-up source) are worth showing
      try {
        all = { tasks: await loadProject(helm, settings.projectId, settings.source), errors: [] }
      } catch (e) {
        if (e.code !== 'nosetup' && e.code !== 'later' && e.code !== 'setup') throw e
        all = { tasks: [], errors: [], note: e.message }
      }
    } else all = await loadAll(helm, projects, settings.source)
    if (mine !== seq) return
    data = { projects, ...all }
    render()
  } catch (e) {
    if (mine === seq) state(app, 'error', e.message, { label: 'Retry', run: load })
  }
}

async function build(t) {
  message = await startBuild(helm, t)
  render()
}

function render() {
  if (!data) return
  const project = settings.projectId ? data.projects.find((p) => p.id === settings.projectId) : undefined
  const mine = data.tasks
  const limit = Number.isFinite(Number(settings.limit)) ? Number(settings.limit) : 5
  const ready = mine.filter((t) => t.status === 'ready').slice(0, limit)
  app.className = 'sp-tasks'
  app.removeAttribute('role')
  fill(app,
    el('span', { class: 'hud-label' }, `${project ? project.name : 'All linked projects'} · ${mine.length} tasks`),
    el('ul', { class: 'sp-metrics' }, ...STATUSES.map((st) => {
      const n = mine.filter((t) => t.status === st).length
      return el('li', {},
        el('div', { class: 'sp-metric-row' }, el('span', {}, dot(STATUS_TONES[st]), STATUS_LABELS[st]), el('span', { class: 'mono' }, String(n))),
        meter(mine.length ? (n / mine.length) * 100 : 0, STATUS_TONES[st]))
    })),
    data.errors.length > 0 && el('p', { class: 'sp-muted', style: 'margin:0' }, errorLine(data.errors)),
    message && el('div', { class: 'h-state h-state--error', role: 'alert' }, message),
    data.note && el('p', { class: 'sp-muted', style: 'margin:0' }, data.note),
    !data.note && !mine.length && el('p', { class: 'sp-muted', style: 'margin:0' }, `No software-production tasks${project ? ' in this project' : ''}.`),
    el('ul', { class: 'sp-list' }, ...ready.map((t) => {
      const p = data.projects.find((x) => x.id === t.projectId)
      return el('li', { class: 'sp-task' },
        el('span', { class: 'sp-id' }, t.id),
        el('div', { class: 'sp-task-body' }, el('span', { class: 'sp-title' }, t.title),
          el('span', { class: 'sp-task-meta' }, p && !project && el('span', { class: 'sp-small' }, p.code),
            sessionFor(sessions, t) ? badge('amber', 'building') : canBuild(t) && button('⚡ Build', () => build(t)))))
    })),
  )
}

helm.on('settings', (s) => {
  const reload = !data || s.projectId !== settings.projectId || s.source !== settings.source
  settings = s || {}
  reload ? ((data = null), load()) : render()
})
helm.sessions.on('change', (list) => {
  sessions = Array.isArray(list) ? list : []
  const n = endedBuilds(sessions)
  if (n !== ended) {
    ended = n
    if (data) load()
  }
  render()
})
helm.on('refresh', load)
helm.ready()
