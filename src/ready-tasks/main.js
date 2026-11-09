// Ready tasks widget: ready (or done) tasks across linked projects, filtered by priority.
import { getHelm } from '@usetdt/helm-sdk/frame'
import { errorLine, listProjects, loadAll } from '../shared/tasks.js'
import { badge, el, priorityTone, state, styles, fill } from '../shared/ui.js'

const helm = getHelm()
const app = document.getElementById('app')
styles()

let settings = {}
let data = null
let showDone = false
let seq = 0

async function load() {
  const mine = ++seq
  if (!data) state(app, 'loading', 'Loading tasks…')
  try {
    const projects = await listProjects(helm)
    const all = await loadAll(helm, projects, settings.source)
    if (mine !== seq) return
    data = { projects, ...all }
    render()
  } catch (e) {
    if (mine === seq) state(app, 'error', e.message, { label: 'Retry', run: load })
  }
}

function render() {
  if (!data) return
  const wanted = (settings.priorities ?? []).filter((p) => ['high', 'medium', 'low'].includes(p))
  const limit = Number(settings.limit) || 10
  const list = data.tasks.filter((t) => t.status === (showDone ? 'done' : 'ready') && (!wanted.length || wanted.includes(t.priority ?? 'low'))).slice(0, limit)
  const seg = (label, done) => {
    const b = el('button', { type: 'button', 'aria-pressed': String(showDone === done) }, label)
    b.addEventListener('click', () => ((showDone = done), render()))
    return b
  }
  app.className = 'sp-tasks'
  app.removeAttribute('role')
  fill(app,
    el('div', { class: 'sp-seg', role: 'group', 'aria-label': 'Show' }, seg('Ready', false), seg('Done', true)),
    list.length === 0 && el('p', { class: 'sp-muted', style: 'margin:0' }, showDone ? 'Nothing completed yet.' : 'No ready tasks. Triage moves tasks here.'),
    data.errors.length > 0 && el('p', { class: 'sp-muted', style: 'margin:0' }, errorLine(data.errors)),
    el('ul', { class: 'sp-list' }, ...list.map((t) => {
      const p = data.projects.find((x) => x.id === t.projectId)
      const link = p && el('button', { class: 'sp-link', type: 'button', title: `Open ${p.name}` }, p.code)
      link?.addEventListener('click', () => helm.openTab({ kind: 'project', id: p.id }))
      return el('li', { class: `sp-task${showDone ? ' sp-done' : ''}` },
        el('span', { class: 'sp-id' }, t.id),
        el('div', { class: 'sp-task-body' }, el('span', { class: 'sp-title' }, t.title),
          el('span', { class: 'sp-task-meta' }, t.priority && badge(priorityTone(t.priority), t.priority), link)))
    })),
  )
}

helm.on('settings', (s) => {
  const reload = !data || s.source !== settings.source
  settings = s || {}
  reload ? load() : render()
})
helm.on('refresh', load)
helm.ready()
