import type { FloorState } from '../input/floor'
import { personColour, type Person } from '../input/people'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

/** Pose connections drawn in the camera picture-in-picture (MediaPipe Pose indices). */
const BONES: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
]

let toastTimer = 0

export const touchScreen = matchMedia('(pointer: coarse)').matches

export const hud = {
  status(text: string, colour = '#8a857a') {
    $('#status .txt').textContent = text
    $<HTMLElement>('#status .dot').style.background = colour
  },

  health(parts: { label: string; ok: boolean | null }[]) {
    $('#health').innerHTML = parts
      .map(p => `<span class="${p.ok === null ? 'wait' : p.ok ? 'ok' : 'bad'}">${p.label}</span>`)
      .join('')
  },

  caption(mode: 'idle' | 'listening' | 'live' | 'final' | 'question', text = '', who = '', colour = '#555') {
    const whoEl = $('#who'), textEl = $('#ctext')
    whoEl.textContent = who || 'Room'
    whoEl.style.background = who ? colour : '#45423c'
    whoEl.style.color = who ? '#1a1916' : '#d6d0c4'
    textEl.className = `ctext ${mode}`
    textEl.textContent =
      mode === 'idle' ? `Talk among yourselves. Raise a hand (or ${touchScreen ? 'hold the button' : 'hold Space'}) to talk to the board.`
      : mode === 'listening' && !text ? 'Listening…'
      : text
  },

  glow(colour: string | null) {
    $('#board').style.setProperty('--glow', colour ?? 'transparent')
    $('#board').classList.toggle('glowing', !!colour)
  },

  toast(text: string, kind: 'ok' | 'info' | 'warn' = 'ok', ms = 3800) {
    const el = $('#toast')
    el.textContent = text
    el.className = `toast show ${kind}`
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => el.classList.remove('show'), ms)
  },

  confirm(summary: string | null) {
    const el = $('#confirm')
    el.classList.toggle('show', !!summary)
    if (summary) el.innerHTML = `<b>${escapeHtml(summary)}?</b><span>Raise a hand and say “yes”, or press Enter. “No” or Esc cancels.</span>`
  },

  queue(ids: string[], name: (id: string) => string) {
    const el = $('#queue')
    el.innerHTML = ids.map(id => `<span style="--c:${personColour(id)}">${name(id)} is next</span>`).join('')
  },

  pip(people: Person[], floor: FloorState, micLevel: number) {
    const canvas = $<HTMLCanvasElement>('#pip')
    const g = canvas.getContext('2d')!
    const { width: W, height: H } = canvas
    g.clearRect(0, 0, W, H)
    g.fillStyle = 'rgba(255,255,255,0.05)'
    g.fillRect(0, H - 4, W * micLevel, 4)
    for (const p of people) {
      const colour = personColour(p.id)
      const holding = floor.holder === p.id && floor.phase !== 'idle'
      const queued = floor.queue.includes(p.id)
      const pt = (i: number) => [(1 - p.landmarks[i].x) * W, p.landmarks[i].y * H] as const
      g.strokeStyle = holding || queued || p.raised ? colour : 'rgba(210,205,195,0.55)'
      g.lineWidth = holding ? 4 : 2.5
      g.lineCap = 'round'
      for (const [a, b] of BONES) {
        if ((p.landmarks[a].visibility ?? 1) < 0.4 || (p.landmarks[b].visibility ?? 1) < 0.4) continue
        const [x1, y1] = pt(a), [x2, y2] = pt(b)
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke()
      }
      const [hx, hy] = pt(0)
      const shoulder = Math.abs(p.landmarks[11].x - p.landmarks[12].x) * W
      g.beginPath(); g.arc(hx, hy, Math.max(6, shoulder * 0.28), 0, Math.PI * 2); g.stroke()
      if (holding) {
        g.fillStyle = colour
        g.font = '600 13px system-ui'
        g.fillText(floor.phase === 'armed' ? 'hold…' : floor.phase === 'listening' ? 'listening' : '…', hx - 24, Math.max(14, hy - shoulder * 0.45))
      }
    }
    $('#piplbl').textContent = people.length ? `${people.length} ${people.length === 1 ? 'person' : 'people'}` : 'no one in view'
  },
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
