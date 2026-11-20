import './style.css'
import { Microphone } from './input/audio'
import { InputDevices } from './input/devices'
import { FloorController, type FloorState } from './input/floor'
import { personColour, personName } from './input/people'
import { PoseTracker } from './input/pose'
import { Link, type ResolverResult, type ServerMessage } from './link'
import { actionSchemas } from './scene/actions'
import { CommandBus } from './scene/bus'
import { initialScene } from './scene/initial'
import type { ActionCall, Scene } from './scene/types'
import { Board } from './ui/board'
import { hud, touchScreen } from './ui/hud'

const RESULT_TIMEOUT_MS = 20_000
const PREVIEW_MS = 350

const bus = new CommandBus(initialScene())
const board = new Board(document.querySelector('#board')!, bus)
const link = new Link(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
const mic = new Microphone()
const pose = new PoseTracker()

/** Turns waiting for a server result, by id: who spoke, and when we gave up waiting. */
const waiting = new Map<string, { personId: string; timer: number }>()
const health = { server: false, stt: 'loading', llm: 'unknown', camera: 'off', mic: 'off' }
let raisedNow = new Set<string>()
let textCount = 0

const floor = new FloorController({
  turnStart(turn) {
    const colour = personColour(turn.personId)
    hud.glow(colour)
    hud.caption('listening', '', personName(turn.personId), colour)
    board.showNumbers(true)
    // The board goes with turn_start so the server can resolve partial words while the hand is still up.
    const start = { type: 'turn_start', turnId: turn.id, personId: turn.personId, source: turn.source, scene: sceneForModel(bus.scene), actions: actionSchemas() }
    if (!link.send(start)) {
      hud.toast('The local server is offline, so I can’t hear you. Start it with ./run.sh', 'warn')
    }
    for (const chunk of mic.beginTurn()) link.sendAudio(chunk)
    mic.onChunk = chunk => link.sendAudio(chunk)
  },
  turnEnd(turn, cancelled) {
    mic.endTurn()
    hud.glow(null)
    const sent = link.send({
      type: 'turn_end', turnId: turn.id, cancelled,
      scene: sceneForModel(bus.scene), actions: actionSchemas(),
    })
    if (cancelled || !sent) {
      board.showNumbers(false)
      hud.caption('idle')
      if (cancelled) hud.toast('Cancelled', 'info')
      floor.resolved(performance.now())
      return
    }
    expectResult(turn.id, turn.personId)
  },
  change: renderFloor,
})

function expectResult(turnId: string, personId: string) {
  const timer = window.setTimeout(() => {
    waiting.delete(turnId)
    hud.toast('No answer from the server in time. Try again?', 'warn')
    endOfTurn(turnId)
  }, RESULT_TIMEOUT_MS)
  waiting.set(turnId, { personId, timer })
}

/** Free the floor, but only for the voice turn that holds it; typed commands never touch the floor. */
function endOfTurn(turnId: string) {
  if (floor.state.phase !== 'resolving' || floor.state.turn?.id !== turnId) return
  board.showNumbers(false)
  floor.resolved(performance.now())
}

/** What the resolver sees: compact, rounded, no internal bookkeeping. */
function sceneForModel(scene: Scene) {
  const r = (v: number) => Math.round(v * 100) / 100
  return {
    version: scene.version,
    objects: scene.objects.map(o => ({
      id: o.id, number: o.number, kind: o.kind, label: o.label, colour: o.colour, size: o.size,
      x: r(o.x), y: r(o.y), ...(o.group && { group: o.group }), ...(o.starred && { starred: true }),
    })),
    groups: scene.groups,
    selection: scene.focus,
  }
}

function renderFloor(s: FloorState) {
  const who = s.holder ? personName(s.holder) : ''
  const colour = s.holder ? personColour(s.holder) : undefined
  switch (s.phase) {
    case 'idle': hud.status(bus.pending ? 'Waiting for a yes or no' : 'Raise a hand to talk to the board'); break
    case 'armed': hud.status(`${who}: keep it up…`, colour); break
    case 'listening': hud.status(`Listening to ${who}`, colour); break
    case 'resolving': hud.status('Working it out…', colour); break
  }
  hud.queue(s.queue, personName)
}

link.onConnection = connected => {
  health.server = connected
  if (!connected) { health.stt = 'loading'; health.llm = 'unknown' }
  renderHealth()
}

link.onMessage = (msg: ServerMessage) => {
  if (msg.type === 'status') {
    health.stt = msg.stt
    health.llm = msg.llm
    renderHealth()
    return
  }
  if (msg.type === 'idea' || msg.type === 'ideas' || msg.type === 'structure') return // Body Lab only
  const turn = waiting.get(msg.turnId) ?? (floor.state.turn?.id === msg.turnId ? { personId: floor.state.turn.personId } : undefined)
  if (!turn) return
  const colour = personColour(turn.personId), who = personName(turn.personId)
  if (msg.type === 'partial') hud.caption('live', msg.text, who, colour)
  else if (msg.type === 'final') hud.caption('final', msg.text || '(didn’t catch that)', who, colour)
  else if (msg.type === 'result') {
    const entry = waiting.get(msg.turnId)
    if (entry) clearTimeout(entry.timer)
    waiting.delete(msg.turnId)
    console.info('[natter] result', msg.tier, msg.timings, msg.result)
    try {
      handleResult(msg.result, turn.personId, msg.text, msg.turnId)
    } catch (e) {
      console.error(e)
      hud.toast(`Something went wrong applying that: ${(e as Error).message}`, 'warn')
      endOfTurn(msg.turnId)
    }
  }
}

function handleResult(result: ResolverResult, personId: string, text: string, turnId: string) {
  const colour = personColour(personId)
  switch (result.kind) {
    case 'actions': {
      const calls: ActionCall[] = result.calls.map(c => ({ ...c, sceneVersion: result.sceneVersion }))
      board.highlight(targetsOf(calls), colour)
      setTimeout(() => {
        try {
          board.highlight([], colour)
          const outcome = bus.apply(calls, personId)
          if (outcome.pending) hud.toast('Needs a yes first', 'info')
          else if (outcome.applied.length) hud.toast(outcome.applied.map(a => a.summary).join(' · ') + '  ·  say “undo” to reverse', 'ok', 5000)
          if (outcome.errors.length) hud.toast(outcome.errors.join(' · '), 'warn', 5000)
          hud.confirm(bus.pending?.summary ?? null)
          if (floor.state.phase !== 'listening') hud.caption('idle')
        } finally {
          endOfTurn(turnId)
        }
      }, PREVIEW_MS)
      return
    }
    case 'clarify':
      hud.caption('question', result.question, 'Board', '#e9e3d6')
      board.highlight(result.candidates ?? [], colour)
      setTimeout(() => board.highlight([], colour), 6000)
      endOfTurn(turnId)
      return
    case 'none':
      if (result.reason === 'cancelled') hud.toast('Cancelled', 'info')
      else if (result.reason === 'not_a_command') hud.toast(text ? `That didn’t sound like a command: “${text}”` : 'I didn’t catch anything', 'info')
      else hud.toast(result.explanation || 'There’s no way to do that on this board yet', 'info', 5000)
      if (floor.state.phase !== 'listening') hud.caption('idle')
      endOfTurn(turnId)
      return
    case 'error': {
      const messages: Record<string, string> = {
        no_api_key: 'No Anthropic API key. Add ANTHROPIC_API_KEY to .env and restart. Simple commands like “undo” still work.',
        stt_not_ready: 'The speech model is still loading. Try again in a moment.',
        timeout: 'The LLM took too long to answer. Try again?',
        model_failed: 'The LLM couldn’t turn that into an action. Try rephrasing?',
        invalid_calls: 'I couldn’t work out a valid change for that. Try rephrasing?',
      }
      hud.toast(messages[result.reason] ?? `Something went wrong: ${result.reason}`, 'warn', 6000)
      if (floor.state.phase !== 'listening') hud.caption('idle')
      endOfTurn(turnId)
    }
  }
}

function targetsOf(calls: ActionCall[]): string[] {
  return calls.flatMap(c => {
    const v = c.input.ids ?? c.input.id
    return Array.isArray(v) ? (v as string[]) : typeof v === 'string' ? [v] : []
  })
}

function renderHealth() {
  hud.health([
    { label: health.server ? 'server' : 'server offline', ok: health.server },
    { label: health.stt === 'ready' ? 'speech' : health.stt === 'failed' ? 'speech failed' : 'speech loading…', ok: !health.server ? false : health.stt === 'ready' ? true : health.stt === 'failed' ? false : null },
    { label: health.llm === 'ollama' ? 'Local model (Ollama)' : health.llm === 'ollama_loading' ? 'Starting local model' : health.llm === 'ollama_failed' ? 'Local model unavailable' : health.llm === 'no_api_key' ? 'Hosted LLM: no API key' : health.llm === 'claude_code' ? 'Hosted LLM (Claude Code login)' : 'Hosted LLM', ok: health.llm === 'ready' || health.llm === 'claude_code' || health.llm === 'ollama' },
    { label: `camera ${health.camera}`, ok: health.camera === 'on' ? true : health.camera === 'off' ? null : false },
    { label: `mic ${health.mic}`, ok: health.mic === 'on' ? true : health.mic === 'off' ? null : false },
  ])
}

// ---- Camera, microphone and the clock that drives floor timing ----

pose.onPeople = (people, t) => {
  raisedNow = new Set(people.filter(p => p.raised).map(p => p.id))
  floor.update(raisedNow, t)
  hud.pip(people, floor.state, mic.level)
}
setInterval(() => floor.update(raisedNow, performance.now()), 100)

async function startDevices() {
  document.querySelector('#start')!.classList.add('hidden')
  try {
    await inputs.start('microphone', true)
    health.mic = 'on'
  } catch (e) {
    health.mic = 'blocked'
    hud.toast(`Microphone unavailable: ${(e as Error).message}`, 'warn', 6000)
  }
  renderHealth()
  try {
    health.camera = 'starting'
    renderHealth()
    await inputs.start('camera', true)
    health.camera = 'on'
  } catch (e) {
    health.camera = 'blocked'
    hud.toast(`Camera unavailable: ${(e as Error).message}. ${touchScreen ? 'Use the Hold to talk button' : 'Hold Space to talk'} instead.`, 'warn', 6000)
  }
  renderHealth()
}

const inputs = new InputDevices({
  camera: async id => { await pose.start(document.querySelector('#video')!, id); health.camera = 'on'; renderHealth() },
  microphone: async id => { await mic.start(id); health.mic = 'on'; renderHealth() },
}, () => floor.state.phase === 'listening' || floor.state.phase === 'armed')
document.querySelector('#startbtn')!.addEventListener('click', startDevices)

// ---- Keyboard: hold Space to talk, Esc cancels, Enter confirms, / types ----

const typing = () => document.activeElement instanceof Element && !!document.activeElement.closest('input, select, button, summary, textarea')
window.addEventListener('keydown', e => {
  if (typing()) {
    if (e.key === 'Escape') (document.activeElement as HTMLInputElement).blur()
    return
  }
  if (e.code === 'Space') {
    e.preventDefault()
    if (!e.repeat) floor.keyDown(performance.now())
  } else if (e.key === 'Escape') {
    if (floor.state.phase === 'listening' || floor.state.phase === 'armed') floor.cancel(performance.now())
    else if (bus.pending) applyLocal([{ name: 'reject', input: {} }])
  } else if (e.key === 'Enter' && bus.pending) {
    applyLocal([{ name: 'confirm', input: {} }])
  } else if (e.key === '/') {
    e.preventDefault()
    document.querySelector<HTMLInputElement>('#text')!.focus()
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    applyLocal([{ name: e.shiftKey ? 'redo' : 'undo', input: {} }])
  }
})
// Releasing Space in another window never sends keyup here; treat losing focus as letting go.
window.addEventListener('blur', () => floor.keyUp(performance.now()))
window.addEventListener('keyup', e => {
  if (e.code === 'Space' && !typing()) floor.keyUp(performance.now())
})

// ---- Touch: the hold-to-talk button does what Space does ----

const talk = document.querySelector<HTMLButtonElement>('#talk')!
talk.addEventListener('pointerdown', e => {
  talk.setPointerCapture(e.pointerId)
  talk.classList.add('held')
  floor.keyDown(performance.now())
})
for (const type of ['pointerup', 'pointercancel'] as const) {
  talk.addEventListener(type, () => {
    talk.classList.remove('held')
    floor.keyUp(performance.now())
  })
}
talk.addEventListener('contextmenu', e => e.preventDefault())

function applyLocal(calls: ActionCall[]) {
  const outcome = bus.apply(calls, 'keyboard')
  if (outcome.applied.length) hud.toast(outcome.applied.map(a => a.summary).join(' · '), 'ok')
  if (outcome.errors.length) hud.toast(outcome.errors.join(' · '), 'warn')
  hud.confirm(bus.pending?.summary ?? null)
}

document.querySelector('#textform')!.addEventListener('submit', e => {
  e.preventDefault()
  const input = document.querySelector<HTMLInputElement>('#text')!
  const text = input.value.trim()
  if (!text) return
  const turnId = `x${++textCount}`
  const sent = link.send({ type: 'text_command', turnId, text, scene: sceneForModel(bus.scene), actions: actionSchemas() })
  if (!sent) return hud.toast('The local server is offline. Start it with ./run.sh', 'warn')
  input.value = ''
  hud.caption('final', text, 'Keyboard', personColour('key'))
  expectResult(turnId, 'key')
})

// Floor events reach the HUD through `change`; render the starting state once.
renderFloor(floor.state)
renderHealth()
hud.caption('idle')

declare global {
  interface Window { natter: unknown }
}
/** Handy in the console, and used to export the eval fixture: natter.bus.scene, natter.floor.state. */
window.natter = { bus, floor, actions: actionSchemas, sceneForModel: () => sceneForModel(bus.scene) }
