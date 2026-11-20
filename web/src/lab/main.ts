/**
 * Body Lab: a test bench for shaping a brainstorm with your hands, separate from the main Natter app.
 * Face the laptop as a mirror; your hands are drawn over the board. What each gesture does is in play.ts.
 *
 * Keys: O = zoom out to the overview of the whole canvas and back, H = show/hide the hints beside each hand, B = the outlines drawn from the camera: body and hands, hands only, body only, neither (also ?outlines=both|hands|body|none; remembered), A = axes, Z = zones, W = workbench, S = start/stop listening for how to organise the board, U = undo, C = clear the board, R = reset to the starting bubbles,
 *       ? = show/hide the list of these keys, N = which kind the microphones are (auto, handheld, clip-on; also ?handheld and ?clipon; remembered),
 *       D = show/hide readouts,
 *       L = show/hide the log panel (also ?log; remembered): what was heard, what was done and how long the LLM took, as it happens,
 *       P = stage mode for an audience (also ?stage): hides the test-bench text; what a hand is doing shows small beside it, and goes up in one large band once it is done,
 *       Y = tidy: lay each connected group out round its busiest bubble, without changing any words (also on the side rail, and "tidy up" said with both hands raised),
 *       M = show/hide the camera picture behind the board (also ?camera; remembered),
 *       - and = zoom your body out and in, [ and ] make the bubbles smaller and bigger (both remembered),
 *       X = mark "that didn't work", G = mark "that worked" (both go in the session log),
 *       F = delete mode on/off (also on the side rail, which a pointing finger presses by resting on a button),
 *       T = star and Backspace = bin the bubble under the mouse,
 *       V = stop/start recording. Each session's camera picture is recorded to lab-recordings/ on this computer (compressed), for replaying against tracking changes,
 *           and each microphone's sound beside it, for writing out everything that was said afterwards (uv run natter-transcript, in server/).
 * Each session is logged to lab-sessions/ by the local server (see log.ts).
 * Speech and the LLM come from the local server; without it, ideas get placeholder words.
 * The mouse does everything hands do, as a backup (see mouse.ts): drag, press and hold on empty space, right-drag, Alt-press, wheel to resize.
 * Add ?fake to the address to run without a camera and feed frames with lab.inject(frame).
 * Add ?off=steady,loose,zoom to switch tracking fixes off (see fixes.ts), and ?replay=<video address>
 * to run a recording through the tracking instead of the camera (see scripts/replay.sh).
 */
import './lab.css'
import { Microphone } from '../input/audio'
import { InputDevices } from '../input/devices'
import type { Landmark } from '../input/people'
import { Link, type ServerMessage } from '../link'
import { readFixes } from './fixes'
import { Feed } from './feed'
import { SessionLog } from './log'
import { MOUSE_HAND, MouseHand, pressGesture } from './mouse'
import { PRESS_MS, Rail, type RailButton } from './rail'
import { CameraRecorder, SCREEN_BITS_PER_SECOND, SoundRecorder } from './recorder'
import { Score } from './score'
import { DEFAULT_MARGIN, HandTracker, margin, reachInset, setMargin, toBoard, type Frame, type Gesture, type Hand } from './body'
import {
  ASK_DWELL_MS, BURN_MS, BURN_OUT_MS, DEFAULT_R, DIVE_MS, IDEA_DWELL_MS, KNOT_DRAWN, POINT_DWELL_MS, Play, R, RAISE_MS, RAISE_Y, fallbackText, setBubbleSize,
  type Bubble, type PlayRequest, type Rework, type Structure,
} from './play'
import { micHands, readBodies, whose } from './people'
import { Sense } from './sense'
import { Band, boardLine, handLine, type StageLine } from './stage'
import { NAME_DWELL_MS, spokenZoneName, type Zone } from './zones'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const bubblesEl = $('bubbles'), modesEl = $('modes'), hintEl = $('hint'), readEl = $('readout'), msgEl = $('msg')
const videoEl = $<HTMLVideoElement>('video')
const drawZonesButton = $<HTMLButtonElement>('draw-zones')
const deleteButton = $<HTMLButtonElement>('delete-mode'), railEl = $('rail')
const railEls = [...railEl.querySelectorAll('button')]
const over = $<HTMLCanvasElement>('overlay'), under = $<HTMLCanvasElement>('under')
const octx = over.getContext('2d')!, uctx = under.getContext('2d')!

// How big you and the bubbles are on the board: adjustable with keys, remembered in this browser.
const VIEW_KEY = 'bodylab.view2' // renamed when the default changed, so an old zoomed-out setting doesn't carry over
function applyView(m: number, r: number, save = true) {
  setMargin(m)
  setBubbleSize(r)
  document.documentElement.style.setProperty('--d', `${R * 200}vh`)
  if (save) try { localStorage.setItem(VIEW_KEY, JSON.stringify({ margin, r: R })) } catch { /* private window */ }
}
try {
  const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}')
  applyView(typeof v.margin === 'number' ? v.margin : DEFAULT_MARGIN, typeof v.r === 'number' ? v.r : DEFAULT_R, false)
} catch { applyView(DEFAULT_MARGIN, DEFAULT_R, false) }

const fixes = readFixes(location.search)
const handTracker = new HandTracker(fixes.steady, Number(new URLSearchParams(location.search).get('coast')) || undefined)
const play = new Play()
const sense = new Sense(fixes)
sense.near = new URLSearchParams(location.search).has('near')
const recorder = new CameraRecorder()
/** Each microphone's sound, recorded with the camera picture so the session can be written out as a transcript. */
const sounds = [new SoundRecorder(), new SoundRecorder()]
sounds.forEach((sound, n) => { sound.onEnd = () => {
  log?.event('soundStop', { file: sound.name, mic: n + 1, why: 'save or device' })
  say(`Mic ${n + 1} recording stopped: its sound is not being saved. Press V twice to retry`)
} })
const mouse = new MouseHand()
const rail = new Rail()
let frameAt = -Infinity
/** One microphone, or one each for two people: the first is the person on the left of the screen's, the second the one on the right's. */
const mics = [new Microphone(), new Microphone()]
/** Microphones held in the hand (one input of an audio interface each, or two of anything): the hand at the mouth is holding one. */
const handheld = () => micMode === 'handheld' || (micMode === 'auto' && (mics[1].started || mics.some(m => m.started && m.channel !== undefined)))
let hands: Hand[] = []
let bodies: Landmark[][] = []
/** Hand → whose it is, kept from frame to frame. */
let owners = new Map<number, number>()
/** Hands holding a microphone. */
let holding = new Set<number>()
/** The people have changed sides: the one on the left now has the second microphone. */
let swapped = false

/**
 * What the body pose says about the hands, which the hand tracker alone can't:
 * whether each one is hanging at rest (wrist below its elbow) and whether both are above the head.
 * Measured on the body, so it holds however far the view is zoomed out.
 */
function readPose(): boolean | undefined {
  const seen = (l?: Landmark) => !!l && (l.visibility ?? 1) >= 0.5
  let raised: boolean | undefined
  const wrists: { x: number; y: number; resting: boolean }[] = []
  for (const lm of bodies) {
    for (const [wrist, elbow] of [[15, 13], [16, 14]]) {
      if (!seen(lm[wrist]) || !seen(lm[elbow])) continue
      const p = toBoard(lm[wrist])
      wrists.push({ x: p.x, y: p.y, resting: lm[wrist].y > lm[elbow].y + 0.03 })
    }
    if (raised === undefined && seen(lm[15]) && seen(lm[16]) && seen(lm[11]) && seen(lm[12])) {
      const line = seen(lm[0]) ? lm[0].y : Math.min(lm[11].y, lm[12].y) - 0.12
      raised = lm[15].y < line && lm[16].y < line
    }
  }
  const people = readBodies(bodies, play.aspect)
  owners = whose(people, hands, owners, play.aspect)
  // Only with handheld microphones: otherwise a hand near the face is just a hand.
  holding = handheld() ? micHands(people, hands, holding, play.aspect) : new Set()
  for (const h of hands) {
    let best: { resting: boolean } | undefined, bestD = 0.25
    for (const w of wrists) {
      const d = Math.hypot((w.x - h.x) * play.aspect, w.y - h.y)
      if (d < bestD) { bestD = d; best = w }
    }
    // A hand holding a microphone does nothing on the board, like one at rest.
    h.resting = (best?.resting ?? false) || holding.has(h.id)
    h.person = owners.get(h.id)
  }
  return raised
}

function onFrame(frame: Frame) {
  bodies = frame.bodies
  hands = handTracker.update(frame.hands, frame.t)
  const pointer = replaying ? undefined : mouse.hand(frame.t)
  if (pointer) hands.push(pointer)
  frameAt = frame.t
  play.aspect = innerWidth / innerHeight
  const inset = reachInset()
  play.bounds = { x0: inset, y0: inset, x1: 1 - inset, y1: 1 - inset }
  // A pointing finger resting on a side button presses it, and does nothing to the board beneath.
  const free = (h: Hand) => h.id !== MOUSE_HAND && !play.ideas.has(h.id) && !play.asks.has(h.id)
  const pressed = rail.update(railButtons(), hands.filter(free), frame.t)
  if (pressed) { log?.event('railPress', { id: pressed }); pressRail(pressed) }
  play.voices = mics[1].started ? 2 : 1
  // Words count as said only if the hand's microphone picked up a voice: the speech model can make up a word from silence.
  play.heard = new Set([...captions].filter(([hand, text]) => text.trim() && (fake || (turns[turnOf(hand)]?.peaks[turnOf(hand)] ?? 0) >= SPOKEN)).map(([hand]) => hand))
  play.update({ t: frame.t, hands: hands.filter(h => !rail.holds(h.id)), raised: readPose() })
  if (play.deleteEnded) {
    say(play.deleteEnded === 'shake' ? '💨 Fire out' : 'Delete mode off')
    play.deleteEnded = undefined
  }
  log?.frame(hands, sense.fps, { light: sense.light === undefined ? undefined : +sense.light.toFixed(2), shoulders: shoulderWidth(), looking: sense.box.w < 1 || sense.box.h < 1 ? [sense.box.x, sense.box.y, sense.box.w, sense.box.h].map(v => +v.toFixed(2)) : undefined })
  checkLight(frame.t)
  render()
}

/** The nearest person's shoulder width as a share of the picture's width: how close they stand. */
function shoulderWidth(): number | undefined {
  const widths = bodies.filter(lm => lm[11] && lm[12]).map(lm => Math.abs(lm[11].x - lm[12].x))
  return widths.length ? +Math.max(...widths).toFixed(2) : undefined
}

// A dim room makes the camera hold each frame open longer, and moving hands smear. The level
// is a first guess, not yet tuned on recordings; the session log keeps the readings.
const DARK = 0.2
const DARK_MS = 5000
let darkSince: number | undefined, toldDark = false
function checkLight(t: number) {
  if (sense.light === undefined || sense.light >= DARK) { darkSince = undefined; return }
  darkSince ??= t
  if (toldDark || t - darkSince < DARK_MS) return
  toldDark = true
  log?.event('dark', { light: +sense.light.toFixed(2) })
  say('The picture is dark, so moving hands blur. More light on you will help.')
}

// ---------- words: speech and the LLM, through the local server ----------

const params = new URLSearchParams(location.search)
// Which kind the microphones are (N steps through; ?handheld or ?clipon; remembered). Auto takes two microphones, or one input of
// an audio interface, to be held in the hand, and anything else to be clipped on. Clip-on: a hand at the face is just a hand.
const MIC_MODES = ['auto', 'handheld', 'clipon'] as const
const MIC_MODE_KEY = 'bodylab.micMode'
let micMode: (typeof MIC_MODES)[number] = 'auto'
try {
  const saved = params.has('handheld') ? 'handheld' : params.has('clipon') ? 'clipon' : localStorage.getItem(MIC_MODE_KEY)
  if (MIC_MODES.includes(saved as never)) micMode = saved as typeof micMode
} catch { /* private window */ }
const micModeName = () => (micMode === 'auto' ? `auto (${handheld() ? 'handheld' : 'clip-on'} now)` : micMode === 'clipon' ? 'clip-on' : 'handheld')

// The keyboard shortcuts, in small (? shows and hides the list; a small "? keys" in the corner is the reminder).
const KEYS: [string, [string, string][]][] = [
  ['Show and hide', [['P', 'stage mode, for an audience'], ['L', 'log panel'], ['D', 'readouts and gesture guide'], ['H', 'hints beside each hand'], ['B', 'outlines: body and hands, hands, body, none'], ['M', 'camera picture behind the board']]],
  ['Board', [['U', 'undo'], ['Y', 'tidy'], ['F', 'delete mode'], ['S', 'say how to organise'], ['A  Z  W', 'axes, zones, workbench'], ['O', 'overview of the whole canvas'], ['C', 'clear the board'], ['R', 'example ideas'], ['T  ⌫', 'star or bin the bubble under the mouse']]],
  ['View', [['−  =', 'zoom your body out and in'], ['[  ]', 'smaller and bigger bubbles']]],
  ['Microphones and recording', [['N', 'microphones: auto, handheld, clip-on'], ['K', 'swap the two microphones'], ['V', 'stop or start recording'], ['⇧V', 'stop or start recording the screen'],['X  G', 'mark “didn’t work” or “worked” in the log']]],
]
const keysEl = $('keys')
keysEl.replaceChildren(...KEYS.map(([title, rows]) => {
  const group = document.createElement('section'), h = document.createElement('h3'), list = document.createElement('dl')
  h.textContent = title
  for (const [key, what] of rows) {
    const dt = document.createElement('dt'), dd = document.createElement('dd')
    dt.textContent = key
    dd.textContent = what
    list.append(dt, dd)
  }
  group.append(h, list)
  return group
}))
const replaying = params.get('replay')
// A trial for dim rooms: ?boost=1.8 brightens each picture before the models read it; ?boost=1.6,1.3 adds contrast.
{
  const [gain, contrast] = (params.get('boost') ?? '').split(',').map(Number)
  if (gain > 0) sense.boost = `brightness(${gain})${contrast > 0 ? ` contrast(${contrast})` : ''}`
}
const fake = params.has('fake') || !!replaying
// How many hands to look for: two, or four once a second microphone is in use. ?hands=4 sets it, for measuring what it costs.
const handCount = Number(params.get('hands')) || undefined
if (handCount) void sense.setHands(handCount)
const link = fake ? undefined : new Link(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
const log = link ? new SessionLog(msg => link.send(msg)) : undefined
/**
 * Each microphone's sound goes to the server on its own connection: the server hears one
 * turn at a time on a connection, so two let both people speak at once. Everything else goes on the first.
 */
const voiceLinks = [link, fake ? undefined : new Link(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)]
let stt = 'off', llm = 'off'
/** `peaks` is the loudest each microphone got while the turn was open; `shared` whether the other microphone had a turn of its own in that time. */
type Turn = { id: string; hand: number; voice: number; peaks: number[]; shared: boolean }
/** Turns by id, kept after they close so a turn that comes back with no words can say which microphone heard what. */
const turnsById = new Map<string, Turn>()
/** The open turn on each microphone: a hand holding an idea, or (hand -1) the board being organised. */
const turns: (Turn | undefined)[] = [undefined, undefined]
const BOARD = -1
const anyTurn = () => turns.find(Boolean)
/** Which microphone's turn this hand has open, or -1. */
const turnOf = (hand: number) => turns.findIndex(t => t?.hand === hand)
/** Which microphone a hand speaks into: with two, its person's (the first when it can't be told whose hand it is). */
const voiceOf = (hand: number) => {
  if (!mics[1].started) return 0
  const person = hands.find(h => h.id === hand)?.person ?? 0
  return swapped ? 1 - person : person
}

/** Start a turn on a microphone, with a little pre-roll: people start speaking as the hand closes. */
function openTurn(voice: number, id: string, hand: number, mode: string): boolean {
  if (!voiceLinks[voice]?.send({ type: 'turn_start', turnId: id, mode, personId: voice ? 'lab2' : 'lab', source: 'gesture' })) return false
  const turn = turns[voice] = { id, hand, voice, peaks: [0, 0], shared: false }
  turnsById.set(id, turn)
  if (turnsById.size > 40) turnsById.delete(turnsById.keys().next().value!)
  for (const chunk of mics[voice].beginTurn().slice(-5)) voiceLinks[voice]!.sendAudio(chunk)
  return true
}

/** Stop a microphone's turn; with `end`, tell the server so. Returns whether the server was told. */
function closeTurn(voice: number, end?: object): boolean {
  const t = turns[voice]
  if (!t) return false
  mics[voice].endTurn()
  turns[voice] = undefined
  log?.event('turnMics', { turnId: t.id, mic: voice + 1, peaks: t.peaks.map(p => +p.toFixed(2)), shared: t.shared, midTurn: (t.hand === BOARD ? organising?.heard : captions.get(t.hand)) ?? '' })
  return !!end && !!voiceLinks[voice]?.send({ type: 'turn_end', turnId: t.id, ...end })
}
/** What is showing in the banner while the board is organised by voice. */
let organising: { heard: string; thinking: boolean } | undefined
let organiseTimer = 0
let turnCount = 0
/** Spoken turn → the bubble waiting for its words. */
const turnBubble = new Map<string, string>()
/** Bubble → what to do if its words never arrive. */
const waiting = new Map<string, { timer: number; giveUp: () => void }>()
/** Hand → what has been heard so far while it holds an idea. */
const captions = new Map<number, string>()
/** Spoken angle turn → send the ask it belongs to, once the words (or none) are back. */
const angleAsks = new Map<string, (angle: string) => void>()
let namingZone: { turnId: string; zone: Zone; oldName: string; text: string; timer?: number } | undefined
const WAIT_MS = 12_000

const canListen = (voice = 0) => !!voiceLinks[voice]?.connected && mics[voice].started && stt === 'ready'

function wait(bubbleId: string, giveUp: () => void) {
  const timer = window.setTimeout(() => { waiting.delete(bubbleId); log?.event('gaveUp', { bubble: bubbleId }); giveUp() }, WAIT_MS)
  waiting.set(bubbleId, { timer, giveUp })
}
function settle(bubbleId: string, failed = false) {
  const w = waiting.get(bubbleId)
  if (!w) return
  clearTimeout(w.timer)
  waiting.delete(bubbleId)
  if (failed) w.giveUp()
}

function onRequest(req: PlayRequest) {
  const speaks = req.kind === 'listenStart' || req.kind === 'askStart' ? voiceOf(req.hand) : undefined
  log?.event('request', { ...req, ...(speaks !== undefined ? { listening: canListen(speaks) && !turns[speaks], ...(mics[1].started ? { mic: speaks + 1 } : {}) } : {}) })
  if (req.kind === 'zoneName') {
    if (req.start) {
      const voice = voiceOf(req.hand)
      if (!canListen(voice) || anyTurn() || namingZone) { say('Speech isn’t available right now'); return }
      const id = `zone-${++turnCount}-${Date.now()}`
      if (!openTurn(voice, id, req.hand, 'zone_name')) return
      namingZone = { turnId: id, zone: req.zone, oldName: req.zone.name, text: '' }
    } else if (namingZone) {
      const voice = turns.findIndex(t => t?.id === namingZone!.turnId)
      if (voice < 0) return
      closeTurn(voice, { mode: 'zone_name', cancelled: req.cancelled })
      if (req.cancelled) clearZoneName()
      else namingZone.timer = window.setTimeout(() => { clearZoneName(); say('Didn’t catch the zone name') }, WAIT_MS)
    }
  } else if (req.kind === 'listenStart') {
    const voice = voiceOf(req.hand)
    if (!canListen(voice) || turns[voice]) return
    openTurn(voice, `idea-${++turnCount}-${Date.now()}`, req.hand, 'idea')
  } else if (req.kind === 'listenEnd') {
    const voice = turnOf(req.hand)
    const mine = turns[voice]
    if (mine) {
      closeTurn(voice, { mode: 'idea', cancelled: !req.bubbleId })
      captions.delete(req.hand)
    }
    const id = req.bubbleId
    if (!id) return
    if (!mine) return play.setText(id, ...play.spare()) // nothing could hear it
    turnBubble.set(mine.id, id)
    wait(id, () => play.remove(id))
  } else if (req.kind === 'rework') {
    const id = req.bubbleId
    const plain = fallbackText(req.how, req.idea, req.other)
    if (!link?.send({ type: 'rework', id, how: req.how, idea: req.idea, other: req.other, zone: req.zone, board: req.board })) return play.setText(id, plain)
    wait(id, () => play.setText(id, plain))
  } else if (req.kind === 'area') {
    // A name for an area of the canvas, for the overview. Until it comes (or if it never does) the area keeps its stand-in name.
    link?.send({ type: 'rework', id: `area:${req.key}`, how: 'area', board: req.labels })
  } else if (req.kind === 'askStart') {
    // A victory sign has asked and is still up: anything said until it comes down is the angle.
    const voice = voiceOf(req.hand)
    if (!canListen(voice) || turns[voice]) return
    openTurn(voice, `angle-${++turnCount}-${Date.now()}`, req.hand, 'angle')
  } else if (req.kind === 'suggest') {
    const ids = req.bubbleIds
    const giveUp = () => { for (const id of ids) if (play.find(id)?.pending) play.remove(id) } // wherever they are now: their area may have been left
    const send = (angle: string) => {
      settle(ids[0])
      if (!ids.some(id => play.find(id)?.pending)) return // given up on, or undone, while the words were on their way
      // The LLM gets the whole wait from here; hearing the angle has its own.
      if (link?.send({ type: 'suggest', id: ids.join(','), idea: req.idea, other: req.other, linked: req.linked, angle: angle || undefined, branches: req.branches, board: req.board, zone: req.zone })) return wait(ids[0], unanswered)
      giveUp()
      say('The LLM isn’t connected')
    }
    const unanswered = () => { giveUp(); say('The LLM didn’t answer') }
    const voice = req.hand !== undefined ? turnOf(req.hand) : -1
    const mine = turns[voice]?.id.startsWith('angle-') ? turns[voice] : undefined
    if (!mine) return send('') // nothing was listening: ask without an angle
    captions.delete(mine.hand)
    if (!closeTurn(voice, { mode: 'angle', cancelled: false })) return send('')
    angleAsks.set(mine.id, send)
    // If the words never come back, ask without an angle rather than not at all.
    wait(ids[0], () => { if (angleAsks.delete(mine.id)) send('') })
  } else if (req.kind === 'structureStart') {
    // The board has no hand to say whose words these are: with two microphones it listens on the first.
    if (!canListen() || anyTurn() || !openTurn(0, `board-${++turnCount}-${Date.now()}`, BOARD, 'structure')) { play.setStructuring(false); return say(anyTurn() ? 'Finish the idea in your hand first' : 'Speech isn’t available') }
    organising = { heard: '', thinking: false }
  } else {
    const voice = turnOf(BOARD)
    if (voice < 0) return
    const root = (b: Bubble): Bubble => { let r = b; for (let p = play.byId(r.parent); p; p = play.byId(r.parent)) r = p; return r }
    const board = play.bubbles.filter(b => !b.leaving && !b.pending).map(b => ({ id: b.id, text: b.text, family: root(b).text, colour: b.colour, starred: b.starred }))
    closeTurn(voice, { mode: 'structure', cancelled: false, board })
    if (organising) organising.thinking = true
    clearTimeout(organiseTimer)
    organiseTimer = window.setTimeout(() => { if (organising) { organising = undefined; say('The LLM didn’t answer') } }, WAIT_MS)
  }
}

const SILENT_DBFS = -50 // quieter than this over a whole turn: the microphone wasn't spoken into
const SPOKEN = 0.15 // a turn's own microphone this high: a voice, not the room (spoken ideas peak near 0.4 to 0.6, silence under 0.02)
const HEARD = 0.35 // a microphone's level bar this high during a turn: someone was speaking into it

/** What to tell someone whose idea came back with no words: where the sound went, if it can be told. */
function unheard(turnId: string, dbfs?: number): string {
  const turn = turnsById.get(turnId)
  const two = mics[1].started
  if (!turn || dbfs === undefined || dbfs >= SILENT_DBFS) return 'Didn’t catch any words: close your fist, then say the idea'
  // Their own microphone was silent while the other one, with no turn of its own, heard speech.
  if (two && !turn.shared && turn.peaks[1 - turn.voice] >= HEARD) return `Mic ${2 - turn.voice} heard that, not mic ${turn.voice + 1}: press K if you two have swapped sides`
  return `${two ? `Mic ${turn.voice + 1}` : 'The microphone'} heard nothing: speak into it while your fist is closed`
}

function onServer(msg: ServerMessage) {
  if (msg.type !== 'partial') log?.event('server', { ...msg })
  const naming = namingZone
  if ('turnId' in msg && naming && naming.turnId === msg.turnId) {
    if (msg.type === 'partial') naming.text = msg.text
    if (msg.type === 'final') {
      const name = spokenZoneName(msg.text)
      if (play.zoneEditor.editing && naming.zone.name === naming.oldName && name) play.zoneEditor.rename(naming.zone, name)
      if (!msg.text.trim()) say('Didn’t catch the zone name')
      else if (!name) {
        log?.event('zoneNameTooLong', { id: naming.zone.id, heard: msg.text })
        say(`That sounded like talk, so “${naming.zone.name}” keeps its name: point at the title and say just the name, or click it to type`)
      }
      clearZoneName()
    } else if (msg.type === 'result') { clearZoneName(); say('Didn’t catch the zone name') }
    return
  }
  if (msg.type === 'status') { stt = msg.stt; llm = msg.llm; return }
  if ((msg.type === 'final' || msg.type === 'result') && angleAsks.has(msg.turnId)) {
    // The angle for an ask: send the ask with it. If the speech failed, ask without one.
    const send = angleAsks.get(msg.turnId)!
    angleAsks.delete(msg.turnId)
    const angle = msg.type === 'final' ? msg.text.trim() : ''
    if (angle) say(`✌️ “${angle.length > 40 ? `${angle.slice(0, 38)}…` : angle}”`)
    return send(angle)
  }
  if (msg.type === 'partial') {
    const t = turns.find(t => t?.id === msg.turnId)
    if (t) { if (t.hand === BOARD) organising!.heard = msg.text; else captions.set(t.hand, msg.text) }
  } else if (msg.type === 'final') {
    if (msg.turnId.startsWith('board-')) {
      if (!organising) return
      organising.heard = msg.text
      // "Tidy up" needs no thought: lay the board out now, and let the LLM's answer for this turn pass.
      if (TIDY_WORDS.test(msg.text)) { tidied.add(msg.turnId); organising = undefined; clearTimeout(organiseTimer); return tidy() }
      if (!msg.text.trim()) { organising = undefined; clearTimeout(organiseTimer); say(msg.skipped ? `Skipped “${msg.skipped}”` : 'Didn’t catch that') }
      return
    }
    const id = turnBubble.get(msg.turnId)
    const b = play.find(id)
    if (!id || !b) return
    if (!msg.text.trim()) {
      // Nothing said, or only a filler word: take the bubble back.
      turnBubble.delete(msg.turnId); settle(id); play.remove(id)
      say(msg.skipped ? `Skipped “${msg.skipped}”` : unheard(msg.turnId, msg.audio_dbfs))
    }
    else {
      b.full = msg.text // kept behind the label: stretch the bubble to read it
      b.text = msg.text.length > 44 ? `${msg.text.slice(0, 42)}…` : msg.text // shown until the LLM names it
    }
  } else if (msg.type === 'idea' && msg.id.startsWith('area:')) {
    if (msg.text) play.setAreaName(msg.id.slice(5), msg.text, msg.emoji)
  } else if (msg.type === 'idea') {
    const id = turnBubble.get(msg.id) ?? msg.id
    const spoken = turnBubble.delete(msg.id)
    if (msg.text) { settle(id); play.setText(id, msg.text, msg.emoji) }
    else if (spoken) { settle(id); const b = play.find(id); if (b) play.setText(id, b.text) } // keep the words as heard
    else settle(id, true)
  } else if (msg.type === 'ideas') {
    const ids = msg.id.split(',')
    settle(ids[0])
    ids.forEach((id, i) => {
      const idea = msg.ideas?.[i]
      if (idea) play.setText(id, idea.text, idea.emoji)
      else play.remove(id)
    })
    if (msg.angle) play.setAngle(ids, msg.angle)
    if (!msg.ideas?.length) say('The LLM didn’t answer')
  } else if (msg.type === 'structure') {
    if (tidied.delete(msg.id)) return
    clearTimeout(organiseTimer)
    organising = undefined
    if (msg.error || !msg.kind) return say('The LLM couldn’t organise that')
    if (msg.kind === 'none') return say('That didn’t sound like a way to organise the board')
    play.applyStructure(msg as unknown as Structure)
  } else if (msg.type === 'result') {
    // A spoken idea whose transcription failed or wasn't ready.
    const id = turnBubble.get(msg.turnId)
    if (id && msg.result.kind === 'error') { turnBubble.delete(msg.turnId); settle(id); play.setText(id, ...play.spare()) }
  }
}

// ---------- drawing ----------

const els = new Map<string, HTMLElement>()

function clearZoneName() {
  clearTimeout(namingZone?.timer)
  namingZone = undefined
}

// ---------- typing a zone's name ----------

let titleClick: { zone: Zone; t: number; x: number; y: number } | undefined
/** The zone whose name is being typed. */
let typingZone: Zone | undefined
const zoneInput = document.createElement('input')
zoneInput.id = 'zone-name'
zoneInput.maxLength = 40
zoneInput.hidden = true
zoneInput.setAttribute('aria-label', 'Zone name')
document.body.append(zoneInput)

function typeZoneName(zone: Zone) {
  if (!play.zoneEditor.editing || anyTurn() || namingZone) return
  typingZone = zone
  zoneInput.value = zone.name === 'New zone' ? '' : zone.name
  zoneInput.placeholder = 'Zone name'
  zoneInput.style.left = `${zone.x0 * 100}vw`
  zoneInput.style.top = `${zone.y0 * 100}vh`
  zoneInput.style.width = `${(zone.x1 - zone.x0) * 100}vw`
  zoneInput.hidden = false
  zoneInput.focus()
  zoneInput.select()
  render()
}
function endZoneTyping(keep: boolean) {
  const zone = typingZone
  if (!zone) return
  typingZone = undefined
  zoneInput.hidden = true
  if (keep && play.zoneEditor.rename(zone, zoneInput.value)) log?.event('zoneTyped', { id: zone.id, name: zone.name })
  render()
}
zoneInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') endZoneTyping(true)
  else if (e.key === 'Escape') endZoneTyping(false)
})
zoneInput.addEventListener('blur', () => endZoneTyping(true))

/** Tidy the board (the side button, Y, or saying "tidy up" with both hands raised). */
function tidy() {
  if (play.overview) return say('Go into an area first')
  say(play.tidy() ? '✨ Tidied (Undo brings it back)' : play.bubbles.length ? 'Finish drawing zones first, or clear them: tidy works without zones' : 'Nothing to tidy')
}
/** Words that mean "just tidy", not a way of organising for the LLM to work out. */
const TIDY_WORDS = /^\W*(please\s+)?(tidy|tidy (it|this|that|things|everything) up|tidy up|tidy up (the board|everything|this|it)|tidy the board|clean (it |this |that )?up|neaten( it| this)?( up)?|space (them|it|things) out|spread (them|it|things) out)\W*$/i
const tidied = new Set<string>()

const RAIL_REACH = 0.04 // board widths short of a side button that still press it
function railButtons(): RailButton[] {
  return railEls.map(el => {
    const r = el.getBoundingClientRect()
    // A finger counts from a little way short of the button and all the way to the edge beyond it:
    // the buttons sit where the camera follows a hand worst, and an arm at full stretch wavers.
    return { id: el.id, x0: r.left / innerWidth - RAIL_REACH, x1: 1.1, y0: r.top / innerHeight, y1: r.bottom / innerHeight }
  })
}
/** A side button was pressed, by a finger or the mouse. */
function pressRail(id: string) {
  if (play.overview) say('Go into an area first')
  else if (id === 'undo') say(play.undo() ? 'Undone' : 'Nothing to undo')
  else if (id === 'tidy') tidy()
  // A victory sign still listening for an angle doesn't hold the buttons: switching mode takes that ask back.
  else if (turns.some(t => t && !t.id.startsWith('angle-')) && !(id === 'delete-mode' ? play.deleting : play.zoneEditor.editing)) say('Finish speaking first')
  else if (id === 'delete-mode') {
    play.setDeleting(!play.deleting)
    clearZoneName()
    say(play.deleting ? 'Delete mode: point at a bubble to delete it' : 'Delete mode off')
  } else if (id === 'draw-zones') {
    play.setDrawingZones(!play.zoneEditor.editing)
    if (!play.zoneEditor.editing) clearZoneName()
  }
  render()
}
for (const el of railEls) el.addEventListener('click', () => pressRail(el.id))
const HINT: Record<Rework, string> = { further: 'take it further', smaller: 'simplest version', opposite: 'the opposite', combine: '' }

/** The hubs a victory sign is settling on or asking from now, and the bubbles connected to them. */
let feeding = { hubs: new Set<string>(), into: new Set<string>() }
function hubsAsked() {
  const hubs = new Set<string>(), into = new Set<string>()
  for (const aim of play.aims.values()) {
    if (aim.kind !== 'ask' || aim.other) continue
    const linked = play.hub(play.byId(aim.bubble))
    if (linked.length) { hubs.add(aim.bubble); for (const k of linked) into.add(k.id) }
  }
  for (const ask of play.asks.values()) {
    if (!ask.linkedIds.length) continue
    hubs.add(ask.bubble)
    for (const id of ask.linkedIds) into.add(id)
  }
  return { hubs, into }
}

function bubbleEl(b: Bubble): HTMLElement {
  let el = els.get(b.id)
  if (!el) {
    el = document.createElement('div')
    el.className = 'bubble born'
    el.innerHTML = `<span class="star">★</span><span class="hub"></span><span class="how"></span><span class="spark">✨</span><span class="emoji"></span><span class="label"></span><span class="full"></span>`
    bubblesEl.append(el)
    els.set(b.id, el)
  }
  return el
}

function render() {
  const W = innerWidth, H = innerHeight
  const targets = new Set([...play.bubbles.map(b => b.mergeInto), ...[...play.ideas.values()].map(i => i.over)].filter(Boolean))
  const sources = new Set([...play.ideas.values()].map(i => i.parent).filter(Boolean))
  const live = new Set<string>()
  feeding = hubsAsked()
  play.bubbles.forEach((b, i) => {
    live.add(b.id)
    const el = bubbleEl(b)
    const emoji = el.querySelector('.emoji')!, label = el.querySelector('.label')!, how = el.querySelector('.how')!
    if (emoji.textContent !== b.emoji) emoji.textContent = b.emoji
    if (label.textContent !== b.text) label.textContent = b.text
    const more = b.full && b.full !== b.text ? b.full : ''
    const full = el.querySelector('.full')!
    if (full.textContent !== more) full.textContent = more
    el.classList.toggle('more', !!more)
    el.classList.toggle('open', !!more && !!b.opened)
    el.classList.toggle('claude', !!b.byClaude)
    const hint = b.hint ? HINT[b.hint] : ''
    if (hint && how.textContent !== hint) how.textContent = hint
    const tilt = b.leaving === 'bin' ? (b.y - 0.5) * 40 : 0
    // A burning bubble shrinks away where it stands; the flames are drawn over it.
    const burnt = b.leaving === 'burn' ? Math.min(1, (performance.now() - (b.leftAt ?? 0)) / BURN_OUT_MS) : 0
    el.classList.toggle('burning', b.leaving === 'burn')
    el.style.transform = `translate(${b.x * W}px, ${b.y * H}px) translate(-50%, -50%) scale(${b.scale * (1 - 0.65 * burnt * burnt)}) rotate(${tilt}deg)`
    el.style.zIndex = String(i + 1)
    el.dataset.colour = b.colour
    el.classList.toggle('held', b.holders.length > 0)
    el.classList.toggle('starred', b.starred)
    el.classList.toggle('leaving', !!b.leaving)
    el.classList.toggle('pending', b.pending)
    el.classList.toggle('target', targets.has(b.id))
    el.classList.toggle('hinting', !!hint)
    el.classList.toggle('source', sources.has(b.id))
    // A hub wears a small badge saying a victory sign there asks about all of them; while one is asking, the bubbles feeding it glow.
    const hub = b.pending || b.leaving ? 0 : play.hub(b).length
    const badge = el.querySelector('.hub')!
    const mark = hub ? `✌️ all ${hub + 1}` : ''
    if (badge.textContent !== mark) badge.textContent = mark
    el.classList.toggle('is-hub', hub > 0)
    el.classList.toggle('feeding', feeding.into.has(b.id) || feeding.hubs.has(b.id))
  })
  for (const [id, el] of els) if (!live.has(id)) { el.remove(); els.delete(id) }

  const m = play.modes
  const editingZones = play.zoneEditor.editing
  // Zooming out and in is eased; the bubbles themselves fade while the small tiles are on screen.
  const now = performance.now()
  zoom += ((play.overview ? 1 : 0) - zoom) * Math.min(1, (now - zoomAt) / 110)
  if (Math.abs((play.overview ? 1 : 0) - zoom) < 0.004) zoom = play.overview ? 1 : 0
  zoomAt = now
  document.body.classList.toggle('overview', zoom > 0.02)
  document.body.classList.toggle('drawing-zones', editingZones)
  document.body.classList.toggle('deleting', play.deleting)
  deleteButton.setAttribute('aria-pressed', String(play.deleting))
  railEl.style.right = `${reachInset() * 100 + 2}vw` // inside what the hands can reach
  for (const el of railEls) el.style.setProperty('--press', String(rail.aim?.id === el.id ? Math.min(1, (performance.now() - rail.aim.since) / PRESS_MS) : 0))
  drawZonesButton.setAttribute('aria-pressed', String(editingZones))
  drawZonesButton.textContent = editingZones ? 'Done drawing' : 'Draw zones'
  document.body.classList.toggle('workbench', m.workbench)
  document.body.classList.toggle('camera', showCamera)
  // Mirrored and zoomed exactly as toBoard places the hands, so the picture sits under the outline drawn from it.
  videoEl.style.transform = showCamera ? `scaleX(-1) scale(${1 / (1 - 2 * margin)})` : ''
  const chips = ([['A', 'Axes', m.axes], ['Z', 'Zones', m.zones], ['W', 'Workbench', m.workbench], ['O', 'Overview', play.overview]] as const)
    .map(([key, name, on]) => `<span class="${on ? 'on' : ''}"><kbd>${key}</kbd>${name}</span>`).join('')
    + (organising ? `<span class="on listening">${organising.thinking ? 'Organising…' : '🎙️ How should the board be organised?'}${organising.heard ? ` “${organising.heard}”` : ''}</span>` : '')
  if (modesEl.innerHTML !== chips) modesEl.innerHTML = chips
  hintEl.textContent = play.overview
    ? '☝️ rest a pointing finger on an area to go there   ✊✊ or close both fists and pull them apart over it   an empty area is fresh space   O or a click also works'
    : editingZones
    ? namingZone ? `🎙️ Say the zone name${namingZone.text ? `: ${namingZone.text}` : ''} · open your hand to finish`
      : play.zoneEditor.notice || '✊ close your fist and drag to draw a zone · drag a corner to resize or a border to move · ☝️ point at a title and say its name, or click it and type · 👎 inside a zone deletes it · U undo'
    : play.deleting ? '🔥 Delete mode: rest a pointing finger on a bubble to burn it · shake your finger to put the fire out · U undo'
    : m.workbench
    ? 'Workbench: hold a bubble, then with your other fist   pull apart = take it further   push together = simplest version   cross over = the opposite'
    // The short version: the words beside each hand say what it can do where it is, and the README has the rest.
    : '✊ on a bubble: move it, drop on another to merge   ✊ on empty space: say a new idea   ☝️ on a bubble: pull out a branch, or connect to another   ✌️ ask for more, and say an angle   ✊✊ resize, or zoom out on empty space   🙌 say how to organise   👍 star   👎 bin'

  drawUnder(W, H)
  drawOver(W, H)
  readout()
}

function fit(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, W: number, H: number) {
  const dpr = devicePixelRatio || 1
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
}

const INK = '#fff4dc', DIM = 'rgba(255, 244, 220, 0.45)'
const TINT: Record<string, string> = { blue: '#8ec5ff', orange: '#ffb870', purple: '#cfa8ff', green: '#a6e58a', pink: '#ff9ec4', teal: '#7fe0d0' }

/** Zones and axes, drawn in a W by H box (the reachable part of the board). */
function overlays(c: CanvasRenderingContext2D, W: number, H: number, u: number) {
  if (play.modes.zones) {
    const editor = play.zoneEditor
    const zones = play.zoneRects.filter(z => z.id !== editor.draft?.id)
    if (editor.draft) zones.push(editor.draft)
    zones.forEach(z => {
      const x = z.x0 * W, y = z.y0 * H, w = (z.x1 - z.x0) * W, h = (z.y1 - z.y0) * H
      c.strokeStyle = DIM
      c.lineWidth = editor.editing ? 0.35 * u : 0.5 * u
      c.setLineDash([0.2 * u, 2 * u])
      c.beginPath()
      c.roundRect(x, y, w, h, Math.min(3 * u, w / 2, h / 2))
      c.stroke()
      c.setLineDash([])
      // The title strip says where naming stands: filling as a finger rests on it, bright yellow
      // and pulsing while it listens (with the words as they are heard), then waiting for the name.
      const listening = editor.naming?.zone.id === z.id
      const heard = namingZone?.zone.id === z.id ? namingZone.text : ''
      const settling = !listening && namingZone?.zone.id === z.id
      const resting = editor.aim?.zone.id === z.id ? Math.min(1, (performance.now() - editor.aim.since) / NAME_DWELL_MS) : 0
      const strip = Math.min(0.07 * H, h)
      if (listening || settling || resting) {
        c.save()
        c.beginPath()
        c.roundRect(x, y, w, strip, Math.min(3 * u, w / 2, strip / 2))
        c.clip()
        c.fillStyle = listening ? `rgba(255, 210, 63, ${0.8 + 0.2 * Math.sin(performance.now() / 160)})` : settling ? 'rgba(255, 210, 63, 0.45)' : 'rgba(255, 244, 220, 0.3)'
        c.fillRect(x, y, listening || settling ? w : w * resting, strip)
        c.restore()
        if (listening) {
          c.strokeStyle = '#ffd23f'
          c.lineWidth = 0.8 * u
          c.beginPath()
          c.roundRect(x, y, w, h, Math.min(3 * u, w / 2, h / 2))
          c.stroke()
        }
      }
      c.fillStyle = listening || settling ? '#1c1626' : INK
      c.font = `600 ${Math.min(4 * u, h * 0.18)}px Fraunces, Georgia, serif`
      const title = typingZone?.id === z.id ? '' : listening ? (heard ? `🎙️ “${heard}”` : '🎙️ Listening: say the name') : settling ? (heard ? `“${heard}”…` : '…') : z.name
      c.fillText(title, x + w / 2, y + Math.min(0.035 * H, h / 2), Math.max(1, w - 2 * u))
      if (editor.editing) for (const [cx, cy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
        c.beginPath(); c.arc(cx, cy, 0.7 * u, 0, Math.PI * 2); c.fill()
      }
    })
  }

  if (play.modes.axes) {
    const x0 = 0.06 * W, x1 = 0.96 * W, y0 = 0.86 * H, y1 = 0.12 * H
    const [xa, xb] = play.labels.x, [ya, yb] = play.labels.y
    const usual = xa === 'easy' && yb === 'big win' // the starting axes have an obvious best corner
    if (usual) {
      c.fillStyle = 'rgba(166, 229, 138, 0.13)'
      c.beginPath()
      c.roundRect(x0, y1, (x1 - x0) / 2, (y0 - y1) / 2, 2 * u)
      c.fill()
    }
    c.strokeStyle = DIM
    c.lineWidth = 0.6 * u
    c.beginPath()
    c.moveTo(x0, y1); c.lineTo(x0, y0); c.lineTo(x1, y0)
    c.moveTo((x0 + x1) / 2, y1); c.lineTo((x0 + x1) / 2, y0)
    c.moveTo(x0, (y0 + y1) / 2); c.lineTo(x1, (y0 + y1) / 2)
    c.stroke()
    c.fillStyle = INK
    c.font = `600 ${3.6 * u}px Fraunces, Georgia, serif`
    c.textAlign = 'left'
    c.fillText(xa, x0 + u, y0 + 3.5 * u)
    if (usual) c.fillText('do these first', x0 + 2 * u, y1 + 3.5 * u)
    c.textAlign = 'right'
    c.fillText(xb, x1, y0 + 3.5 * u)
    c.textAlign = 'center'
    c.save()
    c.translate(x0 - 3 * u, 0)
    c.rotate(-Math.PI / 2)
    c.fillText(yb, -(y1 + 12 * u), 0)
    c.fillText(ya, -(y0 - 12 * u), 0)
    c.restore()
  }
}

/** How far zoomed out the picture is: 0 in the work view, 1 in the overview, easing between. */
let zoom = 0, zoomAt = 0

/**
 * The overview: every area of the canvas as a small tile. While zooming, each tile slides between
 * where it sits on the canvas around the one on screen (that one fills the screen) and its place in the grid.
 */
function drawAreas(c: CanvasRenderingContext2D, W: number, H: number, u: number) {
  const cells = play.cells(), focus = cells.find(k => k.current)!
  const e = zoom * zoom * (3 - 2 * zoom)
  const mix = (a: number, b: number) => a + (b - a) * e
  const mid = play.canvasHold && play.overview ? (() => { const [a, b] = play.canvasHold!.hands.map(id => hands.find(h => h.id === id)); return a && b ? play.cellAt((a.x + b.x) / 2, (a.y + b.y) / 2)?.key : undefined })() : undefined
  for (const k of cells) {
    const x = mix(k.col - focus.col, k.x0) * W, y = mix(k.row - focus.row, k.y0) * H
    const w = mix(1, k.x1 - k.x0) * W, h = mix(1, k.y1 - k.y0) * H
    if (x > W || y > H || x + w < 0 || y + h < 0) continue
    const pad = Math.min(w, h) * 0.035 * e
    const aimed = play.overviewAim?.key === k.key ? Math.min(1, (performance.now() - play.overviewAim.since) / DIVE_MS) : 0
    // The tile a finger or the mouse is over lights up, so it is clear which one a rest or a click will choose.
    const over = play.overview && !play.canvasHold && hands.some(h => !h.resting && (h.gesture === 'point' || h.id === MOUSE_HAND) && play.cellAt(h.gesture === 'point' ? h.tipX : h.x, h.gesture === 'point' ? h.tipY : h.y)?.key === k.key)
    const hot = aimed > 0 || mid === k.key || over
    c.globalAlpha = e
    c.fillStyle = hot ? 'rgba(255, 210, 63, 0.14)' : k.bubbles.length ? 'rgba(255, 244, 220, 0.06)' : 'rgba(255, 244, 220, 0.02)'
    c.strokeStyle = hot ? '#ffd23f' : k.current ? INK : DIM
    c.lineWidth = (k.current || hot ? 0.5 : 0.25) * u
    c.setLineDash(k.bubbles.length || k.current ? [] : [u, u])
    c.beginPath()
    c.roundRect(x + pad, y + pad, w - 2 * pad, h - 2 * pad, 2 * u)
    c.fill()
    c.stroke()
    c.setLineDash([])
    if (aimed) {
      // Counting down to going there: the tile fills from the left.
      c.save()
      c.clip()
      c.fillStyle = 'rgba(255, 210, 63, 0.22)'
      c.fillRect(x + pad, y + pad, (w - 2 * pad) * aimed, h - 2 * pad)
      c.restore()
    }
    c.globalAlpha = 1
    const at = (b: Bubble) => [x + b.x * w, y + b.y * h] as const
    c.strokeStyle = 'rgba(255, 244, 220, 0.5)'
    c.lineWidth = Math.max(1, 0.7 * u * h / H)
    c.beginPath()
    for (const b of k.bubbles) {
      const p = k.bubbles.find(o => o.id === b.parent)
      if (p) { c.moveTo(...at(p)); c.lineTo(...at(b)) }
    }
    for (const [a, b] of k.links) {
      const p = k.bubbles.find(o => o.id === a), q = k.bubbles.find(o => o.id === b)
      if (p && q) { c.moveTo(...at(p)); c.lineTo(...at(q)) }
    }
    c.stroke()
    for (const b of k.bubbles) {
      const [bx, by] = at(b), r = R * b.scale * h
      c.fillStyle = TINT[b.colour] ?? TINT.green
      c.beginPath()
      c.arc(bx, by, r, 0, Math.PI * 2)
      c.fill()
      if (r >= 7) { c.font = `${r * 0.95}px system-ui`; c.fillText(b.pending ? '…' : b.emoji, bx, by) }
    }
    c.globalAlpha = e
    if (k.name) {
      c.font = `600 ${Math.min(4.2 * u, h * 0.11)}px Fraunces, Georgia, serif`
      c.fillStyle = INK
      c.fillText(`${k.emoji ? `${k.emoji} ` : ''}${k.name}`, x + w / 2, y + pad + h * 0.1, w - 4 * pad - 2 * u)
    } else if (!k.bubbles.length) {
      c.font = `${Math.min(7 * u, h * 0.2)}px system-ui`
      c.fillStyle = hot ? '#ffd23f' : DIM
      c.fillText(k.current ? '•' : '＋', x + w / 2, y + h / 2)
    }
    c.globalAlpha = 1
  }
}

/** Behind the bubbles: zones, axes, and the links between an idea and what it grew from. */
function drawUnder(W: number, H: number) {
  const c = uctx
  fit(under, c, W, H)
  const u = H / 100
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  if (zoom > 0.02) return drawAreas(c, W, H, u)

  // The overlays fill the part of the board the hands can reach, so their edges are usable.
  const bd = play.bounds
  if (bd.x0 > 0) {
    c.strokeStyle = 'rgba(255, 244, 220, 0.18)'
    c.lineWidth = 0.3 * u
    c.setLineDash([u, u])
    c.strokeRect(bd.x0 * W, bd.y0 * H, (bd.x1 - bd.x0) * W, (bd.y1 - bd.y0) * H)
    c.setLineDash([])
  }
  c.save()
  c.translate(bd.x0 * W, bd.y0 * H)
  overlays(c, (bd.x1 - bd.x0) * W, (bd.y1 - bd.y0) * H, u)
  c.restore()

  c.strokeStyle = 'rgba(255, 244, 220, 0.6)'
  c.lineWidth = 0.7 * u
  for (const b of play.bubbles) {
    const p = play.byId(b.parent)
    if (!p || b.leaving) continue
    c.beginPath()
    c.moveTo(p.x * W, p.y * H)
    c.lineTo(b.x * W, b.y * H)
    c.stroke()
  }
  // Connections between ideas that didn't grow from one another: dashed.
  // While a victory sign is on a hub, the lines into it light up: all of them feed the ask.
  const plain = c.strokeStyle, wide = c.lineWidth
  c.setLineDash([1.6 * u, 1.6 * u])
  for (const [a, b] of play.links) {
    const p = play.byId(a), q = play.byId(b)
    if (!p || !q) continue
    const lit = feeding.hubs.has(a) && feeding.into.has(b) || feeding.hubs.has(b) && feeding.into.has(a)
    c.strokeStyle = lit ? '#ffd23f' : plain
    c.lineWidth = lit ? wide * 1.8 : wide
    c.beginPath()
    c.moveTo(p.x * W, p.y * H)
    c.lineTo(q.x * W, q.y * H)
    c.stroke()
  }
  c.setLineDash([])
  c.strokeStyle = plain
  c.lineWidth = wide
  // What grew from a connection hangs off its knot.
  for (const b of play.bubbles) {
    const p = play.byId(b.knot?.[0]), q = play.byId(b.knot?.[1])
    if (!p || !q || b.leaving) continue
    const k = play.knot(p, q)
    c.beginPath()
    c.moveTo(k.x * W, k.y * H)
    c.lineTo(b.x * W, b.y * H)
    c.stroke()
  }
  // Each connection has a knot at its middle to ask the LLM about the pair, and the angle last asked sits under it.
  for (const [a, b] of play.links) {
    const p = play.byId(a), q = play.byId(b)
    if (!p || !q || p.leaving || q.leaving) continue
    const k = play.knot(p, q), kx = k.x * W, ky = k.y * H, kr = R * KNOT_DRAWN * H
    c.fillStyle = '#1c1626'
    c.beginPath()
    c.arc(kx, ky, kr, 0, Math.PI * 2)
    c.fill()
    c.stroke()
    c.fillStyle = INK
    c.font = `${kr * 1.1}px system-ui`
    c.fillText('✌️', kx, ky)
    const word = play.linkWord(a, b)
    if (!word) continue
    c.font = `italic 600 ${2.6 * u}px Fraunces, Georgia, serif`
    const w = c.measureText(word).width + 2.4 * u, wy = ky + kr + 2.6 * u
    c.fillStyle = 'rgba(0, 0, 0, 0.55)'
    c.beginPath()
    c.roundRect(kx - w / 2, wy - 1.9 * u, w, 3.8 * u, 1.9 * u)
    c.fill()
    c.fillStyle = INK
    c.fillText(word, kx, wy)
  }

  // Both hands going up: a line to reach above, filling as the board gets ready to listen.
  if (play.raisedAt !== undefined || play.structuring) {
    const done = play.structuring ? 1 : Math.min(1, (performance.now() - play.raisedAt!) / RAISE_MS)
    c.strokeStyle = play.structuring ? '#ffd23f' : DIM
    c.lineWidth = 0.8 * u
    c.beginPath()
    c.moveTo(W / 2 - done * W / 2, RAISE_Y * H)
    c.lineTo(W / 2 + done * W / 2, RAISE_Y * H)
    c.stroke()
  }
}

const BODY_LINES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24]]
const HAND_LINES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]]
const GLYPH: Record<Gesture, string> = { fist: '✊', palm: '✋', thumbUp: '👍', thumbDown: '👎', point: '☝️', victory: '✌️', none: '' }

let showHints = true
// The outlines drawn from the camera: the body's and the hands' (B steps through both, hands only, body only, neither; ?outlines=…; remembered).
// With the hands' outline off, the ring at each palm and its gesture sign stay, so a hand can still be found.
const OUTLINES = ['both', 'hands', 'body', 'none'] as const
const OUTLINES_KEY = 'bodylab.outlines'
let outlines: (typeof OUTLINES)[number] = 'both'
try {
  const saved = params.get('outlines') ?? localStorage.getItem(OUTLINES_KEY)
  if (OUTLINES.includes(saved as never)) outlines = saved as typeof outlines
} catch { /* private window */ }
const showBody = () => outlines === 'both' || outlines === 'body'
const showHandLines = () => outlines === 'both' || outlines === 'hands'

/** What this hand can do right now, shown beside it: the object it is on, then the actions open to it. */
function handHint(h: Hand): string[] {
  if (play.canvasHold?.hands.includes(h.id)) return [] // the hold draws its own label
  if (h.id === MOUSE_HAND) return mouseHint(h)
  if (rail.holds(h.id)) return []
  if (play.overview) return ['☝️ rest on an area: go there', '✊✊ pull apart: go there']
  if (play.deleting) return ['☝️ rest on a bubble: delete']
  if (play.zoneEditor.editing) return play.zoneEditor.naming?.hand === h.id
    ? ['🎙️ say the name', '✋ finish'] : ['✊ draw / adjust zone', '☝️ title: say its name']
  if (play.structuring) return []
  const held = play.bubbles.find(b => b.holders.includes(h.id))
  if (held) {
    const into = play.byId(held.mergeInto)
    if (held.holders.length > 1) {
      return play.modes.workbench ? ['apart: further', 'together: simpler', 'cross: opposite'] : ['apart: bigger', 'together: smaller']
    }
    return into ? [`✋ merge into “${into.text}”`] : ['✋ drop', 'other hand: resize', 'throw: fling']
  }
  if (play.ideas.has(h.id) || play.asks.has(h.id)) return [] // the idea, or the ask, draws its own label
  const aim = play.aims.get(h.id)
  if (aim?.kind === 'idea') return ['keep closed: new idea']
  const tip = h.gesture === 'point' || h.gesture === 'victory'
  const over = play.bubbleAt(tip ? h.tipX : h.x, tip ? h.tipY : h.y)
  if (over) return over.pending ? [] : ['✊ move', '☝️ branch', play.hub(over).length ? `✌️ ask about all ${play.hub(over).length + 1} together` : '✌️ ask for more', '👍 👎']
  if (play.knotAt(tip ? h.tipX : h.x, tip ? h.tipY : h.y)) return ['✌️ ask about this pair']
  return ['✊ new idea']
}

/** The same, for the mouse standing in for a hand. */
function mouseHint(h: Hand): string[] {
  if (play.overview) return ['click an area: go there']
  if (play.deleting) return ['press and hold a bubble: delete']
  if (play.zoneEditor.editing) return play.zoneEditor.naming?.hand === h.id
    ? ['🎙️ say the name', 'let go: finish'] : ['drag: draw / adjust zone', 'hold a title: say its name', 'Backspace: delete zone']
  if (play.structuring) return []
  const held = play.bubbles.find(b => b.holders.includes(h.id))
  if (held) {
    const into = play.byId(held.mergeInto)
    return into ? [`let go: merge into “${into.text}”`] : ['let go: drop', 'flick: fling']
  }
  if (play.ideas.has(h.id) || play.asks.has(h.id)) return []
  if (play.aims.get(h.id)?.kind === 'idea') return ['keep holding: new idea']
  const over = play.bubbleAt(h.x, h.y)
  if (over) return over.pending ? [] : ['drag: move', 'right-drag: branch', 'Alt-press: ask for more', 'wheel: resize', 'T star · ⌫ bin']
  if (play.knotAt(h.x, h.y)) return ['Alt-press: ask about this pair']
  return ['press and hold: new idea']
}

/** Where an ask is aimed: the bubble, or the knot between it and `other`. Board fractions; `r` in board heights. */
function askSpot(b: Bubble, other?: Bubble) {
  return other ? { ...play.knot(b, other), r: R * 0.6 } : { x: b.x, y: b.y, r: R * b.scale }
}

/** A line of words on a dark pill, kept on screen. */
function pill(c: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, W: number, right = W) {
  c.font = `600 ${size}px Fraunces, Georgia, serif`
  const w = Math.min(W * 0.7, c.measureText(text).width) + size * 1.2
  const px = Math.min(right - w / 2 - size / 3, Math.max(w / 2 + size / 3, x))
  c.fillStyle = 'rgba(0, 0, 0, 0.7)'
  c.beginPath()
  c.roundRect(px - w / 2, y - size * 0.85, w, size * 1.7, size * 0.85)
  c.fill()
  c.fillStyle = INK
  c.fillText(text, px, y, W * 0.7)
}

/** In front of the bubbles: the mirror image of whoever is in shot, and their hands. */
function drawOver(W: number, H: number) {
  const c = octx
  fit(over, c, W, H)
  const u = H / 100

  c.strokeStyle = 'rgba(255, 244, 220, 0.16)'
  c.lineWidth = 1.2 * u
  for (const lm of showBody() ? bodies : []) {
    const pt = (i: number) => { const p = toBoard(lm[i]); return [p.x * W, p.y * H] as const }
    const ok = (i: number) => lm[i] && (lm[i].visibility ?? 1) >= 0.5
    c.beginPath()
    for (const [a, b] of BODY_LINES) {
      if (!ok(a) || !ok(b)) continue
      c.moveTo(...pt(a)); c.lineTo(...pt(b))
    }
    c.stroke()
  }

  c.textAlign = 'center'
  c.textBaseline = 'middle'
  // Flames over each burning bubble: they rise and thin out as it shrinks to nothing.
  for (const b of play.bubbles) {
    if (b.leaving !== 'burn') continue
    const p = Math.min(1, (performance.now() - (b.leftAt ?? 0)) / BURN_OUT_MS)
    const rad = R * b.scale * H * (1 - 0.65 * p * p)
    const cx = b.x * W, cy = b.y * H
    const glow = c.createRadialGradient(cx, cy, rad * 0.2, cx, cy, rad * 1.5)
    glow.addColorStop(0, `rgba(255, 170, 60, ${0.75 * (1 - p)})`)
    glow.addColorStop(1, 'rgba(255, 90, 30, 0)')
    c.fillStyle = glow
    c.beginPath()
    c.arc(cx, cy, rad * 1.5, 0, Math.PI * 2)
    c.fill()
    c.globalAlpha = Math.min(1, 2.2 * (1 - p))
    for (let i = 0; i < 7; i++) {
      // Each flame has its own place round the bubble and its own flicker, fixed by its number.
      const a = -Math.PI / 2 + (i - 3) * 0.5, flick = Math.sin(performance.now() / 70 + i * 2.1)
      c.font = `${(5 + 2.5 * (1 - p) + flick) * u}px system-ui`
      c.fillText('🔥', cx + Math.cos(a) * rad * 0.85, cy + Math.sin(a) * rad * 0.6 - p * rad * 0.9 + flick * 0.4 * u)
    }
    c.globalAlpha = 1
  }
  const hold = play.canvasHold
  const [ha, hb] = hold ? hold.hands.map(id => hands.find(h => h.id === id)) : []
  if (hold && ha && hb) {
    // Two fists have hold of the canvas: a line between them, and what moving them will do.
    c.strokeStyle = '#ffd23f'
    c.lineWidth = 0.6 * u
    c.setLineDash([u, u])
    c.beginPath()
    c.moveTo(ha.x * W, ha.y * H)
    c.lineTo(hb.x * W, hb.y * H)
    c.stroke()
    c.setLineDash([])
    pill(c, play.overview ? '⟵ pull apart to go in here ⟶' : '⟶ push together to zoom out ⟵', (ha.x + hb.x) / 2 * W, Math.max(4 * u, (ha.y + hb.y) / 2 * H - 7 * u), 2.8 * u, W)
  }
  for (const h of hands) {
    const colour = h.id === 1 ? '#ffb347' : '#5fd6c4'
    c.strokeStyle = colour
    if (h.resting && !play.ideas.has(h.id)) {
      // At rest: shown faintly, and it does nothing.
      c.globalAlpha = 0.25
      c.lineWidth = 0.6 * u
      c.beginPath()
      c.arc(h.x * W, h.y * H, 3 * u, 0, Math.PI * 2)
      c.stroke()
      c.globalAlpha = 1
      continue
    }
    c.globalAlpha = 0.55
    c.lineWidth = 0.6 * u
    c.beginPath()
    for (const [a, b] of showHandLines() ? HAND_LINES : []) {
      const p = h.landmarks[a], q = h.landmarks[b]
      if (!p || !q) continue
      c.moveTo(p.x * W, p.y * H); c.lineTo(q.x * W, q.y * H)
    }
    c.stroke()
    c.globalAlpha = 1

    const x = h.x * W, y = h.y * H
    const r = (h.gesture === 'fist' ? 2.8 : 4.2) * u
    c.lineWidth = 0.8 * u
    c.beginPath()
    c.arc(x, y, r, 0, Math.PI * 2)
    c.stroke()

    if (showHints && !stage) {
      // A short list under the hand; it changes as the hand moves on and off bubbles.
      const lines = handHint(h)
      c.font = `600 ${2.5 * u}px Fraunces, Georgia, serif`
      lines.forEach((line, i) => {
        const w = c.measureText(line).width + 2.4 * u
        const lx = Math.min(W - w / 2 - u, Math.max(w / 2 + u, x)), ly = Math.min(H - 3 * u, y + r + (3.6 + i * 4) * u)
        c.fillStyle = 'rgba(0, 0, 0, 0.6)'
        c.beginPath()
        c.roundRect(lx - w / 2, ly - 1.8 * u, w, 3.6 * u, 1.8 * u)
        c.fill()
        c.fillStyle = INK
        c.fillText(line, lx, ly)
      })
    }

    // Stage mode: what this hand is doing, small and beside it. (An idea and an ask draw their own labels below.)
    const doing = stage ? stageHands.get(h.id) : undefined
    if (doing && (doing.kind === 'move' || doing.kind === 'merge' || doing.kind === 'resize')) pill(c, doing.what, x, Math.min(H - 3 * u, y + r + 4.2 * u), 2.8 * u, W)

    const aim = play.aims.get(h.id), aimed = play.byId(aim?.bubble)
    if (h.gesture === 'point' || h.gesture === 'victory') {
      // The fingertip is what the hand aims with.
      c.fillStyle = colour
      c.beginPath()
      c.arc(h.tipX * W, h.tipY * H, 1.1 * u, 0, Math.PI * 2)
      c.fill()
    }
    if (aim?.kind === 'idea') {
      // A fist held on empty space, counting down to a new idea.
      const done = Math.min(1, (performance.now() - aim.since) / IDEA_DWELL_MS)
      c.strokeStyle = '#fff096'
      c.lineWidth = 1.2 * u
      c.beginPath()
      c.arc(x, y, 5.5 * u, -Math.PI / 2, -Math.PI / 2 + done * Math.PI * 2)
      c.stroke()
    }
    if (aim && aimed) {
      // Counting down to a branch: a ring closing round the bubble (or, for an ask about a pair, round their knot).
      const done = Math.min(1, (performance.now() - aim.since) / (aim.kind === 'ask' ? ASK_DWELL_MS : aim.kind === 'burn' ? BURN_MS : POINT_DWELL_MS))
      const at = askSpot(aimed, play.byId(aim.other))
      c.strokeStyle = aim.kind === 'ask' ? '#ffd23f' : aim.kind === 'burn' ? '#ff6a3d' : INK
      c.lineWidth = 1.2 * u
      c.beginPath()
      c.arc(at.x * W, at.y * H, at.r * H + 1.5 * u, -Math.PI / 2, -Math.PI / 2 + done * Math.PI * 2)
      c.stroke()
    }

    const ask = play.asks.get(h.id), asked = play.byId(ask?.bubble)
    if (ask && asked) {
      // The sign has asked and is still up: the ring pulses while it listens for an angle.
      const at = askSpot(asked, play.byId(ask.other))
      const listening = turnOf(h.id) >= 0
      const ax = at.x * W, ay = at.y * H
      c.strokeStyle = '#ffd23f'
      c.lineWidth = (1.2 + (listening ? 0.5 * Math.sin(performance.now() / 160) : 0)) * u
      c.beginPath()
      c.arc(ax, ay, at.r * H + 1.5 * u, 0, Math.PI * 2)
      c.stroke()
      const top = ay - at.r * H - 5 * u
      const all = ask.linkedIds.length ? `all ${ask.linkedIds.length + 1} together · ` : ''
      pill(c, listening ? `🎙️ ${all}say an angle (“risks”, “similarities”) · lower your hand to send` : `${all}lower your hand to send`, ax, Math.max(4 * u, top), 2.8 * u, W)
      const heard = captions.get(h.id)
      if (heard) pill(c, heard, ax, Math.min(H - 6 * u, ay + at.r * H + 6 * u), 3.4 * u, W)
    }

    const idea = play.ideas.get(h.id)
    if (idea) {
      const listening = turnOf(h.id) >= 0
      const parent = play.byId(idea.parent)
      const ix = idea.x * W, iy = idea.y * H
      let title: string
      if (parent) {
        // A branch: a shoot in the parent's colour, growing from it to the fingertip.
        const tint = TINT[parent.colour] ?? TINT.green
        const inside = Math.hypot((idea.x - parent.x) * W, (idea.y - parent.y) * H) <= R * parent.scale * H
        c.strokeStyle = tint
        c.lineWidth = 1.6 * u
        if (!inside) {
          // From the parent's rim, so the shoot doesn't cross its label.
          const dx = ix - parent.x * W, dy = iy - parent.y * H, d = Math.hypot(dx, dy), rim = R * parent.scale * H
          c.beginPath()
          c.moveTo(parent.x * W + dx / d * rim, parent.y * H + dy / d * rim)
          c.lineTo(ix, iy)
          c.stroke()
        }
        c.fillStyle = tint
        c.strokeStyle = INK
        c.lineWidth = 0.7 * u
        c.beginPath()
        c.arc(ix, iy, 6 * u, 0, Math.PI * 2)
        c.fill()
        c.stroke()
        c.font = `${5.5 * u}px system-ui`
        c.fillText(listening ? '🎙️' : '🌱', ix, iy)
        const onto = play.byId(idea.over)
        title = inside ? 'pull out to branch · open hand here to cancel'
          : onto ? `open hand to ${play.links.some(l => l.includes(parent.id) && l.includes(onto.id)) ? 'disconnect from' : 'connect to'} “${onto.text}”`
          : `branch of “${parent.text}” · open hand to plant`
      } else {
        // A new idea: a glow in the fist.
        const glow = (9 + 1.4 * Math.sin(performance.now() / 120)) * u
        const g = c.createRadialGradient(ix, iy, 0, ix, iy, glow)
        g.addColorStop(0, 'rgba(255, 240, 150, 0.95)')
        g.addColorStop(1, 'rgba(255, 240, 150, 0)')
        c.fillStyle = g
        c.beginPath()
        c.arc(ix, iy, glow, 0, Math.PI * 2)
        c.fill()
        // The fist stays in view while it holds the idea, with what it is doing as a small badge on it.
        c.font = `${6.5 * u}px system-ui`
        c.fillText('✊', ix, iy)
        c.font = `${3.6 * u}px system-ui`
        c.fillText(listening ? '🎙️' : '💡', ix + 4.6 * u, iy - 4.2 * u)
        title = 'new idea · open hand to place'
      }
      c.font = `600 ${2.8 * u}px Fraunces, Georgia, serif`
      const tw = c.measureText(title).width + 3 * u
      const tx = Math.min(W - tw / 2 - u, Math.max(tw / 2 + u, ix)), ty = Math.max(4 * u, iy - 10 * u)
      c.fillStyle = 'rgba(0, 0, 0, 0.7)'
      c.beginPath()
      c.roundRect(tx - tw / 2, ty - 2.4 * u, tw, 4.8 * u, 2.4 * u)
      c.fill()
      c.fillStyle = INK
      c.fillText(title, tx, ty)
      const x = ix, y = iy
      const heard = captions.get(h.id)
      if (heard) {
        c.font = `600 ${3.4 * u}px Fraunces, Georgia, serif`
        const w = Math.min(W * 0.6, c.measureText(heard).width) + 4 * u
        const cx = Math.min(W - w / 2 - u, Math.max(w / 2 + u, x)), cy = Math.min(H - 6 * u, y + 13 * u)
        c.fillStyle = 'rgba(0, 0, 0, 0.7)'
        c.beginPath()
        c.roundRect(cx - w / 2, cy - 3 * u, w, 6 * u, 3 * u)
        c.fill()
        c.fillStyle = INK
        c.fillText(heard, cx, cy, W * 0.6)
      }
    } else if (play.deleting) {
      // The hand is on fire: whatever it points at burns.
      const at = h.gesture === 'point' ? [h.tipX * W, h.tipY * H] : [x, y - r - 3.4 * u]
      c.font = `${(6.5 + 0.8 * Math.sin(performance.now() / 90)) * u}px system-ui`
      c.fillText('🔥', at[0], at[1])
    } else if (GLYPH[h.gesture]) {
      c.font = `${4.6 * u}px system-ui`
      c.fillText(GLYPH[h.gesture], x, y - r - 3.4 * u)
    }
  }
}

// ---------- stage mode: what an audience needs to follow along ----------

let stage = params.has('stage')
const stageEl = $('stage'), healthEl = $('health')
const band = new Band()
/** What each hand is in the middle of, for the small words beside it. */
let stageHands = new Map<number, StageLine>()

// The camera picture behind the board, lined up with the hands drawn over it: for seeing what the camera sees (M, or ?camera).
const CAMERA_KEY = 'bodylab.camera'
let showCamera = params.has('camera')
try { showCamera ||= localStorage.getItem(CAMERA_KEY) === '1' } catch { /* private window */ }

// The log panel (L, or ?log; remembered): the session's events in plain words, in the corner, in stage mode too.
const FEED_KEY = 'bodylab.feed'
const feed = new Feed()
const feedEl = $('feed')
let showFeed = params.has('log')
try { showFeed ||= localStorage.getItem(FEED_KEY) === '1' } catch { /* private window */ }
if (log) log.onEvent = (type, data, ms) => feed.add(type, data, ms)
let feedDrawn = -1

function renderFeed() {
  feedEl.hidden = !showFeed
  if (!showFeed || feedDrawn === feed.version) return
  feedDrawn = feed.version
  feedEl.replaceChildren(...(feed.rows.length ? feed.rows : [{ at: '', text: 'Log: what is heard and done shows here (L hides it)' }]).map(row => {
    const line = document.createElement('div'), at = document.createElement('time')
    at.textContent = row.at
    line.append(at, row.text)
    return line
  }))
}

function renderStage() {
  renderFeed()
  document.body.classList.toggle('stage', stage)
  if (!stage) return
  const words = { organising, captions, listening: anyTurn()?.hand }
  stageHands = new Map()
  for (const h of hands) { const line = handLine(play, h, { ...words, listening: turnOf(h.id) >= 0 ? h.id : undefined }); if (line) stageHands.set(h.id, line) }
  // While a hand is busy its words sit beside it (drawOver); the band takes over once it has finished.
  const s = band.update(stageHands, boardLine(play, words), performance.now(), play.bubbles.length)
  stageEl.classList.toggle('show', !!s)
  if (s) {
    const what = stageEl.querySelector('.what')!, heardEl = stageEl.querySelector('.heard')!
    if (what.textContent !== s.what) what.textContent = s.what
    if (heardEl.textContent !== (s.heard ?? '')) heardEl.textContent = s.heard ?? ''
    stageEl.classList.toggle('thinking', !!s.thinking)
    const n = s.heard?.length ?? 0
    stageEl.classList.toggle('long', n > 60 && n <= 160)
    stageEl.classList.toggle('longer', n > 160)
  }
  const problem = fake ? 'Practice: no camera, speech or LLM' : !link?.connected ? 'Server off' : stt !== 'ready' ? `Speech ${stt}` : llm === 'off' || llm.endsWith('failed') ? 'LLM off' : !mics[0].started ? 'No microphone' : sense.fps < 5 ? 'No camera picture' : ''
  healthEl.classList.toggle('bad', !!problem)
  const text = problem || 'Ready'
  if (healthEl.lastElementChild!.textContent !== text) healthEl.lastElementChild!.textContent = text
}

/** A microphone's loudness as a short bar, for telling two apart: speak into one and see which moves. */
const meter = (m: Microphone) => (m.started ? '▮'.repeat(Math.round(m.level * 8)).padEnd(8, '·') : 'off')

const micRows = mics.map(() => {
  const row = document.createElement('div')
  row.innerHTML = '<b></b><span class="bar"><i></i></span><span class="name"></span>'
  $('mics').append(row)
  return row
})

/** Each microphone on its own line, always in view: whose it is, how loud it is hearing, and what it is listening to. */
function renderMics() {
  const two = mics[1].started
  for (const turn of turns) {
    if (!turn) continue
    mics.forEach((m, n) => { turn.peaks[n] = Math.max(turn.peaks[n], m.level) })
    if (turns[1 - turn.voice]) turn.shared = true
  }
  mics.forEach((m, n) => {
    const row = micRows[n]
    const label = `Mic ${n + 1}${two ? ((swapped ? 1 - n : n) === 0 ? ' · left' : ' · right') : ''}`
    const same = n === 1 && two && m.name === mics[0].name
    const name = !m.started ? (n ? 'off (choose it under Inputs)' : 'off') : same ? 'same input as mic 1: both hear everyone' : m.name
    const [labelEl, barEl, nameEl] = [row.children[0], row.children[1].firstElementChild as HTMLElement, row.children[2]]
    if (labelEl.textContent !== label) labelEl.textContent = label
    if (nameEl.textContent !== name) nameEl.textContent = name
    row.classList.toggle('off', !m.started)
    row.classList.toggle('bad', same)
    row.classList.toggle('live', !!turns[n])
    barEl.style.width = `${Math.round(m.level * 100)}%`
  })
}

/** Which microphones are on and what each listens to, in the session log: a session can then be read back knowing how it was set up. */
function logMics() {
  log?.event('mics', { mics: mics.map(m => (m.started ? m.name : 'off')) })
}

function readout() {
  renderStage()
  renderMics()
  if (readEl.hidden) return
  const lines = [
    `${sense.fps.toFixed(0)} fps  ${sense.delegate}   light ${sense.light === undefined ? '-' : `${Math.round(sense.light * 100)}%`}   looking at ${Math.round(sense.box.w * sense.box.h * 100)}% of the picture${recorder.on ? '   RECORDING' : ''}${Object.values(fixes).every(Boolean) ? '' : `   off: ${Object.entries(fixes).filter(([, on]) => !on).map(([f]) => f).join(', ')}`}`,
    `server ${link?.connected ? 'connected' : 'off'}   speech ${stt}   ${mics[1].started ? `mic 1 ${meter(mics[0])}  mic 2 ${meter(mics[1])}` : `mic ${mics[0].started ? 'on' : 'off'}`}   model ${llm}   mics ${micModeName()}`,
    `bubbles ${play.bubbles.length}   hands ${hands.length} (${hands.filter(h => h.resting).length} resting)   waiting for words ${waiting.size}   log ${log?.session ?? 'off'}`,
    ...hands.map(h => `hand ${h.id}  ${h.gesture.padEnd(9)} ${(h.label || '-').padEnd(11)} ${(h.score * 100).toFixed(0)}%  fingers ${h.fingers.map(f => f.toFixed(1)).join(' ')}  at ${h.x.toFixed(2)}, ${h.y.toFixed(2)}  speed ${Math.hypot(h.vx, h.vy).toFixed(1)}${mics[1].started ? `  mic ${voiceOf(h.id) + 1}` : ''}`),
  ]
  readEl.textContent = lines.join('\n')
}

// ---------- keys ----------

let msgTimer = 0
function say(text: string) {
  // On stage the band at the top carries it; otherwise a small card near the top. Never over the middle, where the presenter's face is.
  if (stage) return band.notice(text, performance.now())
  msgEl.textContent = text
  msgEl.classList.add('show')
  clearTimeout(msgTimer)
  msgTimer = window.setTimeout(() => msgEl.classList.remove('show'), 2500)
}

addEventListener('keydown', e => {
  // Only somewhere letters are typed keeps them: a pressed button still has the focus, and must not take the board's keys.
  if (e.target instanceof Element && e.target.closest('input, select, textarea')) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const k = e.key.toLowerCase()
  if ('rdazwxgucshbo'.includes(k)) log?.event('key', { key: k, modes: { ...play.modes } })
  if (k === 'x') say('Marked: that didn’t work')
  if (k === 'g') say('Marked: that worked')
  const view: Record<string, [number, number]> = { '-': [-0.02, 0], '=': [0.02, 0], '+': [0.02, 0], '[': [0, -0.005], ']': [0, 0.005] }
  if (view[k]) {
    applyView(margin + view[k][0], R + view[k][1])
    log?.event('view', { margin, r: R })
    if (margin <= -0.5 || margin >= 0.2) say('That is as far as the zoom goes')
    else say(view[k][0] ? (reachInset() > 0 ? `Zoomed out: you reach the middle ${Math.round((1 - 2 * reachInset()) * 100)}% of the screen` : 'You reach the whole screen') : `Bubble size: ${Math.round(R * 200)}% of screen height`)
  }
  if (k === 's') play.setStructuring(!play.structuring)
  if (k === 'o') { play.setOverview(!play.overview); if (!play.overview && (play.deleting || play.zoneEditor.editing)) say('Leave this mode first') }
  if (k === 'escape' && play.zoneEditor.editing) { play.setDrawingZones(false); clearZoneName() }
  if (k === 'f' || (k === 'escape' && play.deleting)) pressRail('delete-mode')
  if (k === 'u') say(play.undo() ? 'Undone' : 'Nothing to undo')
  if (k === 'y') tidy()
  if (k === 'k' && mics[1].started) { swapped = !swapped; say(swapped ? 'Microphones swapped: the person on the left has the second one' : 'Microphones back: the person on the left has the first one') }
  if (k === 'c') { play.clear(); say('Cleared (U brings it back)') }
  if (k === 'r') { play.reset(); say('Example ideas') }
  if (k === 'b') {
    outlines = OUTLINES[(OUTLINES.indexOf(outlines) + 1) % OUTLINES.length]
    try { localStorage.setItem(OUTLINES_KEY, outlines) } catch { /* private window */ }
    say({ both: 'Outlines: body and hands', hands: 'Outlines: hands only', body: 'Outlines: body only', none: 'Outlines off (B brings them back)' }[outlines])
  }
  if (k === '?' || k === '/') keysEl.hidden = !keysEl.hidden
  if (k === 'escape') keysEl.hidden = true
  if (k === 'n') {
    micMode = MIC_MODES[(MIC_MODES.indexOf(micMode) + 1) % MIC_MODES.length]
    try { localStorage.setItem(MIC_MODE_KEY, micMode) } catch { /* private window */ }
    log?.event('micMode', { mode: micMode, handheld: handheld() })
    say({
      auto: 'Microphones: auto. Two microphones are taken to be held in the hand, one to be clipped on',
      handheld: 'Microphones: handheld. A hand at the mouth is holding a microphone',
      clipon: 'Microphones: clip-on. A hand at the face is just a hand',
    }[micMode])
  }
  if (k === 'v') {
    if (e.shiftKey) toggleScreen()
    else toggleRecording()
  }
  if (k === 't' || k === 'backspace' || k === 'delete') mouse.thumb(k === 't', performance.now())
  if (k === 'h') showHints = !showHints
  if (k === 'p') stage = !stage
  if (k === 'm') {
    showCamera = !showCamera
    try { localStorage.setItem(CAMERA_KEY, showCamera ? '1' : '0') } catch { /* private window */ }
    say(showCamera ? 'Camera picture on (M hides it)' : 'Camera picture off')
  }
  if (k === 'd') { readEl.hidden = !readEl.hidden; hintEl.hidden = readEl.hidden }
  if (k === 'l') {
    showFeed = !showFeed
    try { localStorage.setItem(FEED_KEY, showFeed ? '1' : '0') } catch { /* private window */ }
    say(showFeed ? 'Log panel on (L hides it)' : 'Log panel off')
  }
  if (k === 'a' && !play.zoneEditor.editing) play.modes.axes = !play.modes.axes
  if (k === 'z' && !play.zoneEditor.editing) play.modes.zones = !play.modes.zones
  if (k === 'w') { play.modes.workbench = !play.modes.workbench; say(play.modes.workbench ? 'Workbench on: two hands rework an idea' : 'Workbench off: two hands resize') }
  if (fake) render()
})

// ---------- mouse: a stand-in hand, for when the camera isn't there or isn't behaving ----------

if (!replaying) {
  const onBoard = (e: Event) => !(e.target instanceof Element && e.target.closest('button, select, input, label, summary, a, .input-devices'))
  const at = (e: MouseEvent) => ({ x: e.clientX / innerWidth, y: e.clientY / innerHeight })
  addEventListener('pointermove', e => { const p = at(e); mouse.move(p.x, p.y, performance.now()) })
  addEventListener('pointerdown', e => {
    if (!onBoard(e)) return
    e.preventDefault()
    const p = at(e)
    if (play.overview) {
      // A click on an area goes there.
      const cell = play.cellAt(p.x, p.y)
      if (cell) { play.dive(cell.col, cell.row); log?.event('mouse', { gesture: 'dive', x: +p.x.toFixed(2), y: +p.y.toFixed(2) }) }
      return
    }
    const { x0, x1, y0, y1 } = play.bounds
    const onTitle = play.zoneEditor.editing && !!play.zoneEditor.title({ x: (p.x - x0) / (x1 - x0), y: (p.y - y0) / (y1 - y0) })
    const gesture = pressGesture(e, play.deleting || onTitle)
    mouse.press(gesture, p.x, p.y, performance.now())
    titleClick = onTitle && e.button === 0 ? { zone: play.zoneEditor.title({ x: (p.x - x0) / (x1 - x0), y: (p.y - y0) / (y1 - y0) })!, t: performance.now(), x: e.clientX, y: e.clientY } : undefined
    log?.event('mouse', { gesture, x: +p.x.toFixed(2), y: +p.y.toFixed(2) })
  })
  addEventListener('pointerup', e => {
    mouse.release(performance.now())
    // A quick click on a zone's title (not a hold, which listens for a spoken name) opens it for typing.
    const c = titleClick
    titleClick = undefined
    if (c && performance.now() - c.t < 350 && Math.hypot(e.clientX - c.x, e.clientY - c.y) < 8) typeZoneName(c.zone)
  })
  addEventListener('pointercancel', () => mouse.release(performance.now()))
  addEventListener('contextmenu', e => { if (onBoard(e)) e.preventDefault() })
  addEventListener('blur', () => mouse.leave())
  document.documentElement.addEventListener('pointerleave', () => { if (!mouse.holding) mouse.leave() })
  let wheelAt = -Infinity, wheelDid: 'resize' | 'view' | undefined
  addEventListener('wheel', e => {
    if (!onBoard(e)) return
    const p = at(e)
    // One turn of the wheel does one thing: the tail of a scroll that resized a bubble doesn't zoom out, and the tail of one that went into an area resizes nothing there.
    const now = performance.now(), tail = now - wheelAt < 500
    if (play.overview) {
      // Scrolling in over an area goes there.
      const cell = e.deltaY < 0 && !tail ? play.cellAt(p.x, p.y) : undefined
      if (cell) { play.dive(cell.col, cell.row); wheelDid = 'view' }
      wheelAt = now
      return e.preventDefault()
    }
    const b = tail && wheelDid === 'view' ? undefined : play.resizeAt(p.x, p.y, Math.exp(-e.deltaY * 0.002), now)
    if (b) { e.preventDefault(); wheelDid = 'resize'; if (fake) render() }
    // Scrolling out on empty space zooms out to the overview.
    else if (e.deltaY > 0 && !tail && !play.bubbleAt(p.x, p.y)) { play.setOverview(true); wheelDid = 'view'; e.preventDefault() }
    wheelAt = now
  }, { passive: false })
  // With no camera frames arriving, the mouse hand moves the board along by itself.
  const tick = () => {
    const now = performance.now()
    if (now - frameAt > 60 && (mouse.live(now) || hands.length || (zoom > 0 && zoom < 1))) onFrame({ t: now, bodies: [], hands: [] })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// Every session with a camera and the server is recorded, unless V switched it off.
let recording = true
function startRecording() {
  const stream = $<HTMLVideoElement>('video').srcObject as MediaStream | null
  if (!recording || recorder.on || !log || !stream) return false
  recorder.start(stream, log.session)
  log.event('recordStart', { file: recorder.name })
  recordSound()
  return true
}
/** Record each running microphone that isn't being recorded yet, while the session is being recorded. Called again whenever a microphone starts. */
function recordSound() {
  mics.forEach((m, n) => {
    if (!m.started || !m.sound) return stopSound(n)
    if (!recording || !recorder.on || !log) return
    // A microphone opened again has a new stream: the old recording ends and a new part begins.
    if (sounds[n].on && soundOf[n] === m.sound) return
    stopSound(n)
    if (!sounds[n].start(m.sound, log.session, n, m.channel)) return
    soundOf[n] = m.sound
    log.event('soundStart', { file: sounds[n].name, mic: n + 1 })
  })
}
const soundOf: (MediaStream | undefined)[] = []
function stopSound(n: number) {
  if (sounds[n].on) log?.event('soundStop', { file: sounds[n].name, mic: n + 1 })
  sounds[n].stop()
  soundOf[n] = undefined
}
function toggleRecording() {
  recording = !recording
  if (!recording) {
    const was = recorder.on
    recorder.stop()
    sounds.forEach((_, n) => stopSound(n))
    if (was) log?.event('recordStop', { file: recorder.name })
    say('Recording off for this session (V turns it back on)')
  } else say(startRecording() ? 'Recording the camera picture and the microphones on this computer (V stops)' : 'Nothing to record: no camera or no server')
}
recorder.onEnd = why => {
  log?.event('recordStop', { file: recorder.name, why })
  sounds.forEach((_, n) => stopSound(n))
  // A changed camera starts a new recording by itself, once it is running.
  if (why === 'save') { recording = false; say('Recording stopped: the server could not save it') }
}
addEventListener('pagehide', () => { recorder.stop(); screenRecorder.stop(); sounds.forEach(s => s.stop()) })

// The page itself can be recorded too (Shift+V), so a session can be watched back with its bubbles and
// hands (replay.html). Chrome asks to share the tab every time, and only after a key or a click, so it is
// asked for on Shift+V, or on the first key or click of a session when it was on the last time.
const SCREEN_KEY = 'bodylab.screen'
const screenRecorder = new CameraRecorder('screen', SCREEN_BITS_PER_SECOND)
let screenStream: MediaStream | undefined
let askingScreen = false
// On unless it was turned off here with Shift+V: a session is hard to follow afterwards without the board.
let wantScreen = true
try { wantScreen = localStorage.getItem(SCREEN_KEY) !== '0' } catch { /* private window */ }
async function startScreen() {
  if (screenStream || askingScreen) return
  if (!log) return say('Nothing to record: no server')
  askingScreen = true
  let stream: MediaStream
  try {
    // A smaller, slower picture than the screen's own keeps the load off the hand tracking.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 20, max: 24 }, width: { max: 1920 }, height: { max: 1200 } },
      audio: false, preferCurrentTab: true, selfBrowserSurface: 'include',
    } as DisplayMediaStreamOptions)
  } catch {
    askingScreen = false
    return say('Screen not recorded: sharing this tab was not allowed (Shift+V asks again)')
  }
  askingScreen = false
  screenStream = stream
  screenRecorder.start(stream, log.session)
  log.event('screenStart', { file: screenRecorder.name })
  stream.getVideoTracks()[0]?.addEventListener('ended', () => stopScreen('sharing stopped'))
  say('Recording the screen too, on this computer (Shift+V stops)')
}
function stopScreen(why?: string) {
  if (!screenStream) return
  const stream = screenStream
  screenStream = undefined
  screenRecorder.stop()
  stream.getTracks().forEach(t => t.stop())
  log?.event('screenStop', { file: screenRecorder.name, ...(why ? { why } : {}) })
}
screenRecorder.onEnd = why => {
  if (!screenStream) return
  stopScreen(why === 'save' ? 'save' : 'sharing stopped')
  if (why === 'save') say('Screen recording stopped: the server could not save it')
}
function toggleScreen() {
  if (askingScreen) return
  wantScreen = !screenStream
  try { localStorage.setItem(SCREEN_KEY, wantScreen ? '1' : '0') } catch { /* private window */ }
  if (wantScreen) void startScreen()
  else { stopScreen(); say('Screen recording off (Shift+V turns it back on)') }
}
/** The first key or click of a session, unless screen recording was turned off: Chrome only lets a page ask after one. */
let askedScreen = false
function resumeScreen() {
  if (askedScreen || !wantScreen || !log) return
  askedScreen = true
  void startScreen()
}
addEventListener('pointerdown', resumeScreen)
addEventListener('keydown', e => { if (!(e.shiftKey && e.key.toLowerCase() === 'v') && e.key !== 'Escape' && e.key !== 'Shift') resumeScreen() })

/**
 * Run a recorded session through the tracking, one frame at a time at a fixed rate, so the
 * result doesn't depend on how fast this computer is. The score ends up in #replay-done.
 */
async function replay(url: string) {
  const video = $<HTMLVideoElement>('video')
  const rate = Number(params.get('rate')) || 30
  video.muted = true
  video.src = url
  await new Promise((ok, fail) => { video.onloadeddata = ok; video.onerror = () => fail(new Error('the recording did not load')) })
  if (!Number.isFinite(video.duration)) throw new Error('the recording has no length; run it through scripts/replay.sh, which repairs that')
  const conf = (params.get('conf') ?? '').split(',').map(Number)
  if (conf.length === 3 && conf.every(Number.isFinite)) sense.confidence = { minHandDetectionConfidence: conf[0], minHandPresenceConfidence: conf[1], minTrackingConfidence: conf[2] }
  await sense.load(params.get('delegate') === 'cpu' ? 'CPU' : params.get('delegate') === 'gpu' ? 'GPU' : undefined)
  const score = new Score()
  // Hands summed over frames: found by the camera code, then tracked ones by what the board makes of them.
  const tally = { raw: 0, active: 0, atRest: 0, mic: 0, zoomed: 0, ideas: 0 }
  let ideaHands = new Set<number>()
  let readMs = 0
  const ideaAt: [number, number][] = []
  // ?trace keeps every frame's hands and bodies, for working out afterwards why a hand was missed.
  const trace: object[] | undefined = params.has('trace') ? [] : undefined
  const seconds = Math.min(video.duration, Number(params.get('seconds')) || Infinity)
  for (let n = 0; n / rate < seconds; n++) {
    const seeked = new Promise(ok => video.addEventListener('seeked', ok, { once: true }))
    video.currentTime = n / rate
    await seeked
    const began = performance.now()
    const frame = sense.read(video, video.videoWidth, video.videoHeight, 1 + n * 1000 / rate)
    readMs += performance.now() - began
    onFrame(frame)
    score.frame(frame.t, frame.hands.length, hands)
    tally.raw += frame.hands.length
    for (const h of hands) tally[holding.has(h.id) ? 'mic' : h.resting ? 'atRest' : 'active']++
    tally.zoomed += sense.box.w * sense.box.h
    for (const id of play.ideas.keys()) if (!ideaHands.has(id)) { tally.ideas++; if (trace) ideaAt.push([+(n / rate).toFixed(1), id]) }
    ideaHands = new Set(play.ideas.keys())
    if (trace) trace.push({
      raw: frame.hands.map(h => [+(1 - h.landmarks[9].x).toFixed(3), +h.landmarks[9].y.toFixed(3), h.gesture, +h.score.toFixed(2)]),
      hands: hands.map(h => [h.id, +h.x.toFixed(3), +h.y.toFixed(3), h.gesture, holding.has(h.id) ? 'mic' : h.resting ? 'rest' : 'on', h.person ?? -1]),
      bodies: readBodies(frame.bodies, play.aspect).map(b => ({ x: +b.x.toFixed(3), w: +b.width.toFixed(3), mouth: b.mouth, wrists: b.wrists })),
      rawAt: frame.hands.map(h => toBoard(h.landmarks[0])),
      box: [sense.box.x, sense.box.y, sense.box.w, sense.box.h].map(v => +v.toFixed(2)),
    })
    if (n % rate === 0) say(`Replaying ${Math.round(n / rate)} of ${Math.round(seconds)} s`)
  }
  if (trace) Object.assign(window, { replayTrace: trace, replayIdeas: ideaAt })
  return { ...score.result(), ...tally, looks: sense.looks, readMs: Math.round(readMs / Math.max(1, score.frames)), seconds: +seconds.toFixed(1), rate, delegate: sense.delegate, fixes, size: [video.videoWidth, video.videoHeight] }
}

// ---------- start ----------

const inputs = new InputDevices({
  camera: async id => {
    await sense.start($<HTMLVideoElement>('video'), id)
    startRecording()
  },
  microphone: async id => { await mics[0].start(id); logMics(); recordSound() },
  // Two people have four hands in shot; looking for four costs speed, so it is only done with two microphones.
  microphone2: async id => {
    if (id) await mics[1].start(id)
    else mics[1].stop()
    logMics()
    recordSound()
    // If that fails the microphone still works; only the other person's hands may go unseen.
    await sense.setHands(handCount ?? (mics[1].started ? 4 : 2)).catch(() => say('Couldn’t switch how many hands to look for: reload the page'))
  },
}, () => !!anyTurn())

Object.assign(window, { lab: { play, sense, feed, inject: onFrame, state: () => ({ hands, waiting: waiting.size }), hear: (hand: number, text: string) => { if (fake) captions.set(hand, text) },
  // Practice only: a spoken organising request as if heard, and a short message, to see how they show.
  organise: (heard: string) => { if (fake) organising = { heard, thinking: false } }, say } })

if (replaying) {
  const done = (result: object) => {
    const el = document.createElement('pre')
    el.id = 'replay-done'
    el.style.cssText = 'position:fixed;left:0;bottom:0;opacity:0;pointer-events:none' // out of sight, but there for a script waiting on it
    el.textContent = JSON.stringify(result)
    document.body.append(el)
    Object.assign(window, { replayResult: result })
    say('Replay finished')
  }
  replay(replaying).then(done, err => done({ error: err instanceof Error ? err.message : String(err) }))
} else if (fake) {
  // No server either: Play fills in placeholder words itself.
  onFrame({ t: performance.now(), bodies: [], hands: [] })
} else {
  play.empty()
  play.onRequest = onRequest
  play.onEvent = (type, data) => {
    log!.event(type, data)
    if (type === 'ideaAbandoned' && data.why === 'too long') say('That was a long one: say one idea in a few words')
  }
  log!.event('start', { agent: navigator.userAgent, width: innerWidth, height: innerHeight, margin, r: R, fixes })
  say('Starting camera…')
  /** A connection dropped: the server has forgotten what it was hearing on it. */
  const dropped = (voice: number) => {
    // A zone's name is lost with the first connection (as before), or with the one it was being said on.
    // If that one is still up, the server is told to drop the turn.
    const naming = namingZone ? turns.findIndex(t => t?.id === namingZone!.turnId) : -1
    if (namingZone && (voice === 0 || naming === voice)) { closeTurn(naming, { mode: 'zone_name', cancelled: true }); clearZoneName() }
    // Stop sending an angle's sound; an ask already lowered goes without one (below, or when its wait runs out).
    const t = turns[voice]
    if (t?.id.startsWith('angle-')) { captions.delete(t.hand); closeTurn(voice) }
  }
  link!.onMessage = onServer
  link!.onConnection = up => {
    if (up) link!.send({ type: 'lab_hello' })
    else {
      stt = 'off'; llm = 'off'
      dropped(0)
      const lowered = [...angleAsks.values()]
      angleAsks.clear()
      for (const send of lowered) send('')
    }
  }
  voiceLinks[1]!.onMessage = onServer
  voiceLinks[1]!.onConnection = up => { if (!up) dropped(1) }
  mics.forEach((m, voice) => {
    m.onChunk = chunk => voiceLinks[voice]!.sendAudio(chunk)
    m.onProblem = what => say(`${voice ? 'Second microphone' : 'Microphone'}: ${what}. Choose it again in Inputs`)
  })
  sense.onFrame = onFrame
  inputs.start('camera', true).then(
    () => {
      const { width, height, frameRate } = ($<HTMLVideoElement>('video').srcObject as MediaStream).getVideoTracks()[0]?.getSettings() ?? {}
      log!.event('camera', { delegate: sense.delegate, width, height, frameRate })
      say('Hold your hands up to the camera')
    },
    err => {
      msgEl.textContent = `Camera didn't start: ${err instanceof Error ? err.message : err}`
      msgEl.classList.add('show')
    },
  ).finally(() => {
    // Attempt the microphone even if the camera failed. Keep permission prompts sequential.
    void inputs.start('microphone', true).catch(() => say('No microphone: choose one in Inputs'))
      .then(() => { if (inputs.choice('microphone2')) return inputs.start('microphone2', true) })
      .catch(() => say('The second microphone didn’t start: choose it again in Inputs'))
  })
  render()
}
