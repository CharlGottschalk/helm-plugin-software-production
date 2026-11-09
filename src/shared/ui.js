// UI shared by the Kanban tool and both widgets: one stylesheet on theme tokens
// (docs/theme.md) plus small DOM helpers. Connection data only ever becomes text.
import { el } from '@usetdt/helm-sdk/frame'

export { el }

const CSS = `
.sp-meta{display:flex;align-items:center;gap:var(--sp-3);min-width:0}
.sp-icon-btn{display:grid;place-items:center;width:22px;height:22px;margin-left:auto;padding:0;font:inherit;color:var(--c-text-2);background:none;border:1px solid var(--c-line);border-radius:var(--radius-sm);cursor:pointer}
.sp-icon-btn:hover{color:var(--c-cyan);border-color:var(--c-cyan)}
.sp-notice{display:flex;align-items:center;gap:var(--sp-2);padding:var(--sp-2) var(--sp-3);font-size:var(--fs-sm);color:var(--c-text-1);background:var(--c-amber-ghost);border:1px solid var(--c-amber);border-radius:var(--radius-sm)}
.sp-notice button{margin-left:auto;padding:0 var(--sp-1);font:inherit;color:var(--c-text-2);background:none;border:0;cursor:pointer}
.sp-dot{display:inline-block;width:7px;height:7px;flex-shrink:0;transform:rotate(45deg);background:currentColor}
.sp-tone-cyan{color:var(--c-cyan)}.sp-tone-amber{color:var(--c-amber)}.sp-tone-red{color:var(--c-red)}.sp-tone-green{color:var(--c-green)}.sp-tone-neutral{color:var(--c-text-3)}
.sp-id{flex-shrink:0;min-width:26px;padding-top:2px;font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.08em;color:var(--c-cyan)}
.sp-title{font-size:var(--fs-md);color:var(--c-text-0)}
.sp-small{font-family:var(--font-mono);font-size:var(--fs-2xs);color:var(--c-text-2)}
.sp-reason{font-size:var(--fs-xs);color:var(--c-text-2)}
.sp-muted{font-size:var(--fs-sm);color:var(--c-text-2)}
.sp-tasks{display:flex;flex-direction:column;gap:var(--sp-3)}
.sp-list{display:flex;flex-direction:column;list-style:none;margin:0;padding:0}
.sp-task{display:flex;align-items:flex-start;gap:var(--sp-3);padding:var(--sp-2) 0;border-bottom:1px solid var(--c-line)}
.sp-task:last-child{border-bottom:0}
.sp-task-body{display:flex;flex-direction:column;gap:4px;min-width:0}
.sp-task-meta{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-2);font-size:var(--fs-2xs);color:var(--c-text-2)}
.sp-done .sp-title{color:var(--c-text-2);text-decoration:line-through}
.sp-link{padding:0;font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.08em;color:var(--c-text-2);background:none;border:0;cursor:pointer}
.sp-link:hover{color:var(--c-cyan);text-decoration:underline}
.sp-seg{display:flex;align-self:flex-start;border:1px solid var(--c-line);border-radius:var(--radius-sm);overflow:hidden}
.sp-seg button{height:24px;padding:0 var(--sp-3);font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--c-text-2);background:none;border:0;cursor:pointer}
.sp-seg button[aria-pressed=true]{color:var(--c-on-accent);background:var(--c-cyan)}
.sp-metrics{display:flex;flex-direction:column;gap:var(--sp-3);list-style:none;margin:0;padding:0}
.sp-metric-row{display:flex;justify-content:space-between;margin-bottom:4px;font-size:var(--fs-sm);color:var(--c-text-1)}
.sp-metric-row>span:first-child{display:inline-flex;align-items:center;gap:var(--sp-2)}
.sp-meter{display:flex;gap:2px;height:8px;width:100%}
.sp-meter>span{flex:1;background:rgb(var(--rgb-accent) / .08);transform:skewX(var(--skew))}
.sp-meter>span.on{background:currentColor}
.sp-handoff{width:100%;max-height:280px;overflow:auto;margin:0;padding:var(--sp-2);font-family:var(--font-mono);font-size:var(--fs-xs);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--c-text-1);background:var(--c-well);border:1px solid var(--c-line);border-radius:var(--radius-sm)}
.h-btn--sm{font-size:var(--fs-xs);padding:2px var(--sp-2)}
`

/** Add the shared stylesheet once (the frame CSP allows inline styles). */
export function styles() {
  if (document.getElementById('sp-css')) return
  const style = document.createElement('style')
  style.id = 'sp-css'
  style.textContent = CSS
  document.head.append(style)
}

export const STATUS_TONES = { draft: 'neutral', ready: 'cyan', doing: 'amber', blocked: 'red', done: 'green', cancelled: 'neutral' }
export const STATUS_LABELS = { draft: 'Draft', ready: 'Ready', doing: 'Doing', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled' }
export const priorityTone = (p) => (p === 'high' ? 'red' : p === 'medium' ? 'amber' : 'cyan')

export const dot = (tone) => el('span', { class: `sp-dot sp-tone-${tone}`, 'aria-hidden': 'true' })
export const badge = (tone, text) => el('span', { class: `h-badge${tone === 'neutral' ? '' : ` h-badge--${tone}`}` }, text)

export function button(label, onClick, { ghost = true, small = true, title } = {}) {
  const b = el('button', { class: `h-btn${ghost ? ' h-btn--ghost' : ''}${small ? ' h-btn--sm' : ''}`, type: 'button', ...(title ? { title } : {}) }, label)
  b.addEventListener('click', onClick)
  return b
}

export function iconButton(text, label, onClick) {
  const b = el('button', { class: 'sp-icon-btn', type: 'button', 'aria-label': label, title: label }, text)
  b.addEventListener('click', onClick)
  return b
}

/** A segmented meter like Helm's, `value` 0–100. */
export function meter(value, tone) {
  const on = Math.round((value / 100) * 20)
  return el('div', { class: `sp-meter sp-tone-${tone}`, role: 'meter', 'aria-valuenow': String(Math.round(value)), 'aria-valuemin': '0', 'aria-valuemax': '100' },
    ...Array.from({ length: 20 }, (_, i) => el('span', i < on ? { class: 'on' } : {})))
}

/** Replace the app's content with a state (docs/widget.md#anatomy-and-states). */
export function state(app, kind, text, action) {
  app.className = `h-state${kind === 'loading' ? ' h-state--loading' : kind === 'error' ? ' h-state--error' : ''}`
  app.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  app.replaceChildren(el('span', {}, text), ...(action ? [button(action.label, action.run, { ghost: kind === 'error', small: false })] : []))
}

/** A dismissable notice above the content; returns the element (empty when there is no message). */
export function notice(message, onDismiss) {
  if (!message) return el('div', { hidden: '' })
  const close = el('button', { type: 'button', 'aria-label': 'Dismiss' }, '✕')
  close.addEventListener('click', onDismiss)
  return el('div', { class: 'sp-notice', role: 'status' }, el('span', {}, message), close)
}

/** replaceChildren that skips false/null/undefined, like `el` does. */
export const fill = (node, ...children) => node.replaceChildren(...children.filter((c) => c !== null && c !== undefined && c !== false))
