/**
 * The replay viewer (replay.html): a Body Lab session's log beside its camera recording and sound.
 * Playing the recording walks down the log; clicking a line or the timeline jumps the recording there.
 *
 * One clock runs everything: `now`, in milliseconds into the session, the same clock the log's `t`
 * uses. A recording starts part-way into the session (its recordStart line says when), so a place
 * in the recording is `now` less that start. Where there is no recording, `now` still moves by
 * clicking, with nothing to play.
 *
 * Keys: Space play or pause, ↑ ↓ the line before or after, ← → five seconds, F the next thing that
 * went wrong, E moments or everything, C the screen or the camera, M mirror, + − text size, , . move the log 0.1 s against the picture.
 */
import './replay.css'
import { clock, rowAt, spanAt, spans, toRows, type LogEvent, type Row, type Segment, type Span } from './rows'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const video = $<HTMLVideoElement>('video')
const list = $<HTMLOListElement>('rows')
const picker = $<HTMLSelectElement>('session')
const timeline = $('timeline')

const remembered = (key: string, fallback: string) => {
  try { return localStorage.getItem(`replay.${key}`) ?? fallback } catch { return fallback }
}
const remember = (key: string, value: string) => {
  try { localStorage.setItem(`replay.${key}`, value) } catch { /* private window */ }
}

let session = ''
let events: LogEvent[] = []
type View = 'screen' | 'camera'
let views: Record<View, Segment[]> = { screen: [], camera: [] }
let view: View = 'camera'   // which recording is shown: the page as it looked, or the camera picture
let segments: Segment[] = [] // the recordings of the view being shown
let rows: Row[] = []      // every row
let shown: Row[] = []     // the rows listed: moments, or everything
let showAll = remembered('show', 'moments') === 'all'
let end = 1               // the session's length, ms
let now = 0
let loaded = -1           // which recording the video element holds
const lengths = new Map<number, number>()
let nudge = Number(remembered('nudge', '0')) || 0   // ms the log is moved against the picture
let picked: Row | undefined
let nowIndex = -2
let scale = Number(remembered('scale', '1')) || 1
let mirror = remembered('mirror', 'yes') === 'yes'

const allSpans = (): Span[] => spans(segments, events, end, lengths, view === 'screen' ? 'screenStop' : 'recordStop')

// ---------- drawing

function drawRows() {
  shown = showAll ? rows : rows.filter(r => r.moment)
  list.textContent = ''
  if (!shown.length) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = rows.length ? 'Nothing was said or done in this session. “Everything” lists the hand readings.' : 'This session’s log is empty.'
    list.append(li)
  }
  const bits = document.createDocumentFragment()
  shown.forEach((row, i) => {
    const li = document.createElement('li')
    li.className = row.kind
    li.dataset.i = String(i)
    const at = document.createElement('span')
    at.className = 'at'
    at.textContent = clock(row.t)
    const text = document.createElement('span')
    text.textContent = row.text
    li.append(at, text)
    bits.append(li)
  })
  list.append(bits)
  nowIndex = -2
  for (const b of document.querySelectorAll<HTMLButtonElement>('#show button')) b.setAttribute('aria-pressed', String((b.dataset.show === 'all') === showAll))
  const moments = rows.filter(r => r.moment)
  const wrong = moments.filter(r => r.kind === 'fail').length
  $('counts').textContent = `${moments.length} moments · ${wrong} went wrong · ${clock(end)} long`
  drawPicked()
}

function drawTimeline() {
  const spansEl = $('spans'), marks = $('marks')
  spansEl.textContent = ''
  marks.textContent = ''
  for (const s of allSpans()) {
    const i = document.createElement('i')
    i.style.left = `${(s.from / end) * 100}%`
    i.style.width = `${((s.to - s.from) / end) * 100}%`
    i.title = 'Recorded'
    spansEl.append(i)
  }
  for (const row of rows) {
    if (!row.moment) continue
    const i = document.createElement('i')
    i.className = row.kind
    i.style.left = `${(row.t / end) * 100}%`
    i.title = `${clock(row.t)}  ${row.text}`
    marks.append(i)
  }
}

function drawPicked() {
  for (const li of list.querySelectorAll('li.picked')) li.classList.remove('picked')
  if (!picked) {
    $('detail').textContent = 'Click a line to see everything the log holds for it.'
    return
  }
  const i = shown.indexOf(picked)
  if (i >= 0) list.children[i]?.classList.add('picked')
  $('detail').textContent = `${clock(picked.t, true)}\n${JSON.stringify(picked.event, null, 2)}`
}

/** Moves the highlight, the playhead and the caption to `now`. */
function drawNow() {
  $('head').style.left = `${Math.min(1, now / end) * 100}%`
  $('time').textContent = `${clock(now, true)} / ${clock(end)}`
  const i = rowAt(shown, now)
  if (i !== nowIndex) {
    list.querySelector('li.now')?.classList.remove('now')
    const li = list.children[i] as HTMLElement | undefined
    if (i >= 0 && li && !li.classList.contains('empty')) {
      li.classList.add('now')
      // Keep the playing line in view, without pulling the list away from someone reading it.
      if (!list.matches(':hover')) li.scrollIntoView({ block: 'nearest' })
    }
    nowIndex = i
  }
  // The caption holds the last thing said or written for a few seconds, like a subtitle.
  const moments = rows.filter(r => r.moment)
  const last = moments[rowAt(moments, now)]
  $('caption').textContent = last && now - last.t < 6000 ? last.text : ''
}

function drawControls() {
  $('play').textContent = video.paused ? '▶' : '⏸'
  $('play').setAttribute('aria-label', video.paused ? 'Play' : 'Pause')
  $('speed').textContent = `${video.playbackRate}×`
  // The screen was recorded as it looked, already a mirror; only the camera picture needs turning.
  video.classList.toggle('mirror', mirror && view === 'camera')
  $('mirror').setAttribute('aria-pressed', String(mirror))
  $('mirror').hidden = view !== 'camera'
  $('view').hidden = !views.screen.length || !views.camera.length
  $('view').textContent = view === 'screen' ? 'Showing the screen' : 'Showing the camera'
  $('sync').textContent = nudge ? `log moved ${nudge > 0 ? '+' : ''}${(nudge / 1000).toFixed(1)} s` : ''
  document.documentElement.style.fontSize = `${16 * scale}px`
}

function sayNoVideo(text: string) {
  $('novideo').hidden = !text
  $('novideo').textContent = text
}

// ---------- the clock and the recording

/** Puts the right recording in the video element, at the right place for `now`. */
function seek(t: number, play = !video.paused) {
  now = Math.max(0, Math.min(end, t))
  const span = spanAt(allSpans(), now)
  if (!span) {
    video.pause()
    sayNoVideo(!segments.length ? 'This session was not recorded. The log is on the right.'
      : view === 'screen' && spanAt(spans(views.camera, events, end), now) ? 'The screen was not being recorded at this point. C shows the camera.'
      : 'No recording at this point in the session.')
    drawNow()
    drawControls()
    return
  }
  sayNoVideo('')
  const at = Math.max(0, (now - nudge - span.from) / 1000)
  if (loaded !== span.index) {
    loaded = span.index
    const rate = video.playbackRate
    video.src = `/lab-replay/media/${encodeURIComponent(session)}/${span.index}?view=${view}`
    video.playbackRate = rate
    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration)) {
        lengths.set(span.index, video.duration * 1000)
        end = Math.max(end, span.from + video.duration * 1000)
        drawTimeline()
      }
      video.currentTime = at
      if (play) void video.play().catch(() => drawControls())
    }, { once: true })
  } else {
    video.currentTime = at
    if (play && video.paused) void video.play().catch(() => drawControls())
  }
  drawNow()
}

function tick() {
  if (loaded >= 0 && !video.paused && !video.seeking) {
    now = segments[loaded].t + video.currentTime * 1000 + nudge
    drawNow()
  }
  requestAnimationFrame(tick)
}

video.addEventListener('ended', () => {
  // On to the next recording, if the session has one.
  const next = segments[loaded + 1]
  if (next) seek(next.t + nudge, true)
  else drawControls()
})
video.addEventListener('play', drawControls)
video.addEventListener('pause', drawControls)
video.addEventListener('error', () => {
  if (loaded >= 0) sayNoVideo('This recording could not be opened. The log is on the right.')
})

function toggle() {
  if (!video.paused) return video.pause()
  const span = spanAt(allSpans(), now)
  if (span && loaded === span.index) return void video.play().catch(() => drawControls())
  // Nothing recorded here: start from the next recording.
  const next = span ?? allSpans().find(s => s.from > now) ?? allSpans()[0]
  if (next) seek(span ? now : next.from, true)
}

function pick(row: Row | undefined, jump = true) {
  if (!row) return
  picked = row
  drawPicked()
  // Start a moment before the line, so what led to it is seen.
  if (jump) seek(row.t - 300)
  const li = list.children[shown.indexOf(row)]
  li?.scrollIntoView({ block: 'nearest' })
}

function step(by: number) {
  if (!shown.length) return
  const from = picked && shown.includes(picked) ? shown.indexOf(picked) : rowAt(shown, now)
  pick(shown[Math.max(0, Math.min(shown.length - 1, from + by))])
}

function nextFailure() {
  const fails = rows.filter(r => r.kind === 'fail')
  if (!fails.length) return
  const after = picked ? picked.t : now
  const next = fails.find(r => r.t > after) ?? fails[0]
  if (!shown.includes(next)) { showAll = true; remember('show', 'all'); drawRows() }
  pick(next)
}

// ---------- loading

async function open(id: string, at = 0) {
  session = id
  video.pause()
  video.removeAttribute('src')
  video.load()
  loaded = -1
  lengths.clear()
  picked = undefined
  const res = await fetch(`/lab-replay/sessions/${encodeURIComponent(id)}`)
  if (!res.ok) {
    rows = []; events = []; segments = []; views = { screen: [], camera: [] }
    drawRows(); drawTimeline()
    sayNoVideo('That session could not be found.')
    return
  }
  const data = await res.json() as { events: LogEvent[]; segments: Segment[]; screens?: Segment[] }
  events = data.events
  views = { screen: data.screens ?? [], camera: data.segments }
  // The screen, where it was recorded: it shows the bubbles and the hands, which the camera picture doesn't.
  view = views.screen.length && (remembered('view', 'screen') === 'screen' || !views.camera.length) ? 'screen' : 'camera'
  segments = views[view]
  rows = toRows(events)
  end = Math.max(1, ...events.map(e => e.t))
  history.replaceState(null, '', `?session=${encodeURIComponent(id)}`)
  document.title = `Replay ${id}`
  drawRows()
  drawTimeline()
  seek(at || segments[0]?.t || 0, false)
  drawControls()
}

async function start() {
  drawControls()
  let sessions: { id: string; kb: number; recorded: boolean }[] = []
  try {
    sessions = await (await fetch('/lab-replay/sessions')).json()
  } catch {
    sayNoVideo('The Natter server is not answering. Start it with ./run.sh and reload.')
    return
  }
  if (!sessions.length) {
    sayNoVideo('No sessions yet. Use the Body Lab, then come back.')
    return
  }
  for (const s of sessions) {
    const option = document.createElement('option')
    option.value = s.id
    const [day, time] = s.id.split('T')
    option.textContent = `${day}  ${(time ?? '').replace(/-/g, ':')}${s.recorded ? '' : '  (log only)'}`
    picker.append(option)
  }
  const params = new URLSearchParams(location.search)
  const asked = params.get('session')
  if (asked && !sessions.some(s => s.id === asked)) {
    // A session too short to be listed can still be opened by its address.
    const option = document.createElement('option')
    option.value = option.textContent = asked
    picker.prepend(option)
    sessions.unshift({ id: asked, kb: 0, recorded: true })
  }
  const first = sessions.find(s => s.id === asked) ?? sessions.find(s => s.recorded) ?? sessions[0]
  picker.value = first.id
  await open(first.id, (Number(params.get('t')) || 0) * 1000)
  requestAnimationFrame(tick)
}

// ---------- hands on

picker.addEventListener('change', () => { void open(picker.value); picker.blur() })
list.addEventListener('click', e => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-i]')
  if (li) pick(shown[Number(li.dataset.i)])
})
timeline.addEventListener('click', e => {
  const box = timeline.getBoundingClientRect()
  picked = undefined
  drawPicked()
  seek(((e.clientX - box.left) / box.width) * end)
})
$('play').addEventListener('click', toggle)
$('speed').addEventListener('click', () => {
  video.playbackRate = video.playbackRate === 1 ? 2 : video.playbackRate === 2 ? 0.5 : 1
  drawControls()
})
$('view').addEventListener('click', () => {
  const playing = !video.paused
  view = view === 'screen' ? 'camera' : 'screen'
  remember('view', view)
  segments = views[view]
  loaded = -1
  lengths.clear()
  video.pause()
  drawTimeline()
  seek(now, playing)
  drawControls()
})
$('mirror').addEventListener('click', () => { mirror = !mirror; remember('mirror', mirror ? 'yes' : 'no'); drawControls() })
for (const b of document.querySelectorAll<HTMLButtonElement>('#show button')) {
  b.addEventListener('click', () => { showAll = b.dataset.show === 'all'; remember('show', showAll ? 'all' : 'moments'); drawRows(); drawNow() })
}

addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target === picker) return
  const k = e.key
  if (k === ' ') toggle()
  else if (k === 'ArrowDown') step(1)
  else if (k === 'ArrowUp') step(-1)
  else if (k === 'ArrowRight') seek(now + 5000)
  else if (k === 'ArrowLeft') seek(now - 5000)
  else if (k === 'f' || k === 'F') nextFailure()
  else if (k === 'e' || k === 'E') { showAll = !showAll; remember('show', showAll ? 'all' : 'moments'); drawRows(); drawNow() }
  else if (k === 'm' || k === 'M') $('mirror').click()
  else if ((k === 'c' || k === 'C') && !$('view').hidden) $('view').click()
  else if (k === '+' || k === '=') { scale = Math.min(2.5, +(scale + 0.1).toFixed(1)); remember('scale', String(scale)); drawControls() }
  else if (k === '-' || k === '_') { scale = Math.max(0.7, +(scale - 0.1).toFixed(1)); remember('scale', String(scale)); drawControls() }
  else if (k === ',' || k === '.') { nudge += k === '.' ? 100 : -100; remember('nudge', String(nudge)); drawControls(); seek(now) }
  else return
  e.preventDefault()
})

void start()
