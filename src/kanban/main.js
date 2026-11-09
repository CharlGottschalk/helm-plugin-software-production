// Kanban tool: one project's tasks by status, Build on ready cards, the build skill's
// handoff on cards in progress (docs/tool.md). Cards move by drag or the Move menu (task 028):
// Draft/Ready/Blocked/Doing rewrite the task's Status line through a confirmed files write, or set a
// Linear issue's state through a confirmed http write (task 026); into Doing, Helm offers to start the
// build instead when the project's task source can be built. Done/Cancelled hand off to the close skill.
import { getHelm } from '@usetdt/helm-sdk/frame'
import { STATUSES, endedBuilds, listProjects, loadProject, moveOutcome, planMove, readHandoff, sessionFor } from '../shared/tasks.js'
import { STATUS_LABELS, STATUS_TONES, badge, button, dot, el, iconButton, notice, state, styles, fill } from '../shared/ui.js'

const helm = getHelm()
const app = document.getElementById('app')
styles()

let settings = {}
let sessions = []
let ended = 0
let project = null
let tasks = null
let message = null
let loadSeq = 0
const handoffs = new Map() // taskId → { text } | { error } | 'loading'
const open = new Set()
const moving = new Map() // taskId → the column it shows in while its move is pending

async function load() {
  const seq = ++loadSeq
  if (!settings.project) return state(app, 'empty', 'Choose a project in settings.', { label: 'Settings', run: () => helm.openSettings() })
  if (!tasks) state(app, 'loading', 'Loading tasks…')
  try {
    const projects = await listProjects(helm)
    const p = projects.find((x) => x.id === settings.project)
    if (!p) throw Object.assign(new Error('This project is no longer registered in the workspace.'), { code: 'gone' })
    if (p.availability !== 'available') throw Object.assign(new Error(`The project is ${p.availability}.`), { code: 'gone' })
    const list = await loadProject(helm, p.id, settings.source, { team: settings.linearTeam })
    if (seq !== loadSeq) return
    project = p
    tasks = list
    render()
  } catch (e) {
    if (seq !== loadSeq) return
    tasks = null
    const quiet = e.code === 'later' || e.code === 'nosetup'
    state(app, quiet || e.code === 'setup' ? 'empty' : 'error', e.message, quiet ? undefined : { label: 'Retry', run: load })
  }
}

async function build(t) {
  message = null
  const r = await helm.orchestrate.build({ projectId: t.projectId, taskId: t.id, host: settings.host === 'codex' ? 'codex' : 'claude' })
  if (!r.ok && r.error !== 'Declined by the user') message = r.error
  render()
}

const hostOf = () => (settings.host === 'codex' ? 'codex' : 'claude')

async function move(t, to) {
  if (moving.has(t.id)) return
  const plan = planMove(t, to, project.name)
  if (plan.kind === 'none') return
  message = null
  if (plan.kind === 'refused') return (message = plan.reason), render()
  if (plan.kind === 'close') {
    // no write: the close skill records done/cancelled with its history; Helm confirms the hand-off
    helm.startChat(plan.prompt)
    message = `Closing ${t.id} is handed to an agent session (${plan.prompt}). The card moves once the task file changes; reload then.`
    return render()
  }
  moving.set(t.id, to) // optimistic; reverted below unless the write lands
  render()
  let r
  try {
    r = plan.kind === 'doing'
      ? await helm.orchestrate.build({ projectId: t.projectId, taskId: t.id, host: hostOf() }, { orWrite: { connection: plan.connection, operation: plan.operation, args: plan.args } })
      : await helm.call(plan.connection, plan.operation, plan.args)
  } catch (e) {
    r = { ok: false, error: { message: e.message } }
  }
  const out = moveOutcome(r, t)
  moving.delete(t.id)
  if (out.status === 'moved') Object.assign(t, { status: to }, t.linear ? {} : { text: plan.args.text, sha256: out.sha256 })
  if (out.message) message = out.message
  if (out.reload) return load()
  render()
}

async function toggleHandoff(t, reload = false) {
  if (open.has(t.id) && !reload) open.delete(t.id)
  else {
    open.add(t.id)
    handoffs.set(t.id, 'loading')
    render()
    try {
      handoffs.set(t.id, { text: await readHandoff(helm, t.projectId, t.id) })
    } catch (e) {
      handoffs.set(t.id, { error: e.message })
    }
  }
  render()
}

function card(t, col) {
  const live = sessionFor(sessions, t)
  const actions = el('div', { class: 'actions' })
  if (col === 'ready' && !live && !moving.has(t.id) && (!t.linear || t.linear.buildable)) actions.append(button('⚡ Build', () => build(t)))
  if (live) actions.append(button('Open session', () => helm.openTab({ kind: 'session', id: live.id }), { ghost: false }))
  if (live || t.status === 'doing') actions.append(button(open.has(t.id) ? 'Hide handoff' : 'Handoff', () => toggleHandoff(t), { title: 'The build skill’s workspace handoff' }))
  const h = open.has(t.id) ? handoffs.get(t.id) : undefined
  const busy = moving.has(t.id)
  const menu = el('select', { class: 'h-input move', 'aria-label': `Move ${t.id} to`, ...(busy ? { disabled: '' } : {}) },
    el('option', { value: '' }, busy ? 'Moving…' : 'Move to…'),
    ...STATUSES.filter((st) => st !== col).map((st) => el('option', { value: st }, STATUS_LABELS[st])))
  menu.addEventListener('change', () => menu.value && move(t, menu.value))
  actions.append(menu)
  const li = el('li', { class: `card${busy ? ' busy' : ''}`, draggable: busy ? 'false' : 'true', 'data-id': t.id },
    el('div', { class: 'card-top' }, el('span', { class: 'sp-id' }, t.id), live && badge('amber', 'Building')),
    el('p', { class: 'sp-title', style: 'margin:0' }, t.title),
    t.status === 'blocked' && t.blocked && el('span', { class: 'sp-reason' }, t.blocked),
    t.dependencies.length > 0 && el('span', { class: 'sp-small' }, `↳ after ${t.dependencies.join(', ')}`),
    actions.childElementCount > 0 && actions,
    h === 'loading' && el('span', { class: 'sp-muted' }, 'Loading handoff…'),
    h && h !== 'loading' && (h.error
      ? el('span', { class: 'sp-reason', role: 'alert' }, h.error)
      : h.text === null
        ? el('span', { class: 'sp-muted' }, 'No handoff yet. The build skill writes one when it pauses or finishes.')
        : el('pre', { class: 'sp-handoff', 'aria-label': `Handoff for ${t.id}` }, h.text)),
    h && h !== 'loading' && button('Reload handoff', () => toggleHandoff(t, true)),
  )
  li.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', t.id)
    e.dataTransfer.effectAllowed = 'move'
  })
  return li
}

/** Where a card shows: its pending move, else Doing while a ready task builds, else its status. */
const columnOf = (t) => moving.get(t.id) ?? (t.status === 'ready' && sessionFor(sessions, t) ? 'doing' : t.status)

function dropTarget(section, st) {
  section.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    section.classList.add('drop')
  })
  section.addEventListener('dragleave', (e) => !section.contains(e.relatedTarget) && section.classList.remove('drop'))
  section.addEventListener('drop', (e) => {
    e.preventDefault()
    section.classList.remove('drop')
    const t = tasks?.find((x) => x.id === e.dataTransfer.getData('text/plain'))
    if (t && columnOf(t) !== st) move(t, st)
  })
  return section
}

function render() {
  if (!tasks || !project) return
  const wip = Number(settings.wipLimit) || 3
  const host = settings.host === 'codex' ? 'Codex' : 'Claude Code'
  const cols = Object.keys(STATUS_LABELS).filter((st) => (st !== 'cancelled' || settings.showCancelled) && (st !== 'draft' || tasks.some((t) => t.status === 'draft')))
  const columns = el('div', { class: 'columns', style: `grid-template-columns:repeat(${cols.length},minmax(220px,1fr))` },
    ...cols.map((st) => {
      const cards = tasks.filter((t) => columnOf(t) === st)
      const over = st === 'doing' && cards.length > wip
      return dropTarget(el('section', { class: `column${over ? ' over' : ''}`, 'aria-label': `${STATUS_LABELS[st]} column` },
        el('header', { class: 'col-head' }, dot(over ? 'amber' : STATUS_TONES[st]), el('span', {}, STATUS_LABELS[st]),
          el('span', { class: 'count' }, st === 'doing' ? `${cards.length} / ${wip}` : String(cards.length))),
        cards.length ? el('ul', { class: 'cards' }, ...cards.map((t) => card(t, st))) : el('p', { class: 'empty' }, 'Nothing here.')), st)
    }))
  app.className = 'board'
  app.removeAttribute('role')
  fill(app,
    el('div', { class: 'sp-meta' }, el('span', { class: 'hud-label' }, `${project.name} · ${tasks.length} work items · builds with ${host}`), iconButton('↻', 'Reload tasks', load)),
    notice(message, () => ((message = null), render())),
    columns,
  )
}

helm.on('settings', (s) => {
  const changed = s.project !== settings.project || s.source !== settings.source || s.linearTeam !== settings.linearTeam
  settings = s || {}
  if (changed) {
    tasks = null
    handoffs.clear()
    open.clear()
    load()
  } else render()
})
helm.sessions.on('change', (list) => {
  sessions = Array.isArray(list) ? list : []
  const n = endedBuilds(sessions)
  // a finished build may have changed statuses and its handoff
  if (n !== ended) {
    ended = n
    for (const id of open) toggleHandoff({ id, projectId: settings.project }, true)
    if (tasks) load()
  }
  render()
})
helm.ready()
