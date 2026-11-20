import { FilesetResolver, GestureRecognizer, PoseLandmarker, type GestureRecognizerResult } from '@mediapipe/tasks-vision'
import { openCamera } from '../input/camera'
import { fingerReach, readGesture, type Frame, type Gesture, type RawHand } from './body'
import { ALL_FIXES, type Fixes } from './fixes'
import { FULL, Zoom, unseenWrist, unzoom, type Box } from './zoom'

const GESTURES: Record<string, Gesture> = {
  Closed_Fist: 'fist',
  Open_Palm: 'palm',
  Thumb_Up: 'thumbUp',
  Thumb_Down: 'thumbDown',
  Pointing_Up: 'point',
  Victory: 'victory',
}

// The hand model's defaults are 0.5 each. Lower keeps a hand it is less sure of (blurred, half
// turned away) instead of dropping it; a hand that isn't there is caught by the hand tracker,
// which wants three frames running before it counts one.
const LOOSE = { minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.3, minTrackingConfidence: 0.3 }

const LIGHT_MS = 1000

type Picture = HTMLVideoElement | HTMLCanvasElement

/** Camera → MediaPipe body pose and hand gestures, every video frame. Frames never leave the page. */
export class Sense {
  onFrame?: (frame: Frame) => void
  fps = 0
  delegate = ''
  /** How bright the camera picture is, 0 (black) to 1 (white), checked once a second. */
  light?: number
  /** The part of the frame hands are being looked for in. */
  box: Box = FULL
  private fixes: Fixes
  private running = false
  private models?: { pose: PoseLandmarker; hands: GestureRecognizer; near?: GestureRecognizer }
  private close = document.createElement('canvas')
  private turn = 0
  private lastFound?: Box
  /** Second looks taken, and how many found a hand (for replays and the readout). */
  looks = { taken: 0, found: 0 }
  private zoom = new Zoom()
  private cut = document.createElement('canvas')
  private dim = document.createElement('canvas')
  private lightAt = -Infinity
  /** A trial for dim rooms: a canvas filter (such as `brightness(1.8)`) put on each picture before the models read it. Off when empty. */
  boost = ''
  private lit = document.createElement('canvas')

  private numHands = 2
  /**
   * A trial, off unless asked for (lab.html?near): a wrist the body pose can see with no hand found on it gets a second,
   * closer look. On the first group demo's recording it found a few more hands in front of faces (kept 38% of the time, up
   * from 32%) for 13% more time a frame and slightly more flicker, so it is not on by default. Set before load().
   */
  near = false
  /** A trial: the hand model's three confidence floors, in place of the usual ones. Set before load(). */
  confidence?: { minHandDetectionConfidence: number; minHandPresenceConfidence: number; minTrackingConfidence: number }

  constructor(fixes: Fixes = ALL_FIXES) {
    this.fixes = fixes
  }

  /** How many hands to look for: two for one person, four for two. More is slower. */
  async setHands(n: number) {
    if (n === this.numHands) return
    this.numHands = n
    await this.models?.hands.setOptions({ numHands: n })
  }

  /** Load the models. `only` forces one way of running them (replays use it to stay comparable). */
  async load(only?: 'GPU' | 'CPU') {
    if (this.models) return
    const base = import.meta.env.BASE_URL
    const vision = await FilesetResolver.forVisionTasks(`${base}wasm`)
    const create = async (delegate: 'GPU' | 'CPU') => ({
      pose: await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: `${base}models/pose_landmarker_lite.task`, delegate },
        runningMode: 'VIDEO',
        numPoses: 2,
      }),
      hands: await GestureRecognizer.createFromOptions(vision, {
        baseOptions: { modelAssetPath: `${base}models/gesture_recognizer.task`, delegate },
        runningMode: 'VIDEO',
        numHands: this.numHands,
        ...(this.confidence ?? (this.fixes.loose ? LOOSE : {})),
      }),
      // For the second look: one still picture at a time, of the patch around one wrist.
      near: this.near ? await GestureRecognizer.createFromOptions(vision, {
        baseOptions: { modelAssetPath: `${base}models/gesture_recognizer.task`, delegate },
        runningMode: 'IMAGE',
        numHands: 1,
        ...(this.confidence ?? (this.fixes.loose ? LOOSE : {})),
      }) : undefined,
    })
    if (only) {
      this.models = await create(only)
      this.delegate = only
      return
    }
    try {
      this.models = await create('GPU')
      this.delegate = 'GPU'
    } catch {
      this.models = await create('CPU')
      this.delegate = 'CPU'
    }
  }

  /** Read one picture, `width` by `height` pixels, taken at time `t` (ms, always rising). */
  read(picture: Picture, width: number, height: number, t: number): Frame {
    const models = this.models!
    const seen = picture // the light reading is of the camera's own picture
    if (this.boost) {
      if (this.lit.width !== width || this.lit.height !== height) { this.lit.width = width; this.lit.height = height }
      const c = this.lit.getContext('2d')!
      c.filter = this.boost
      c.drawImage(picture, 0, 0, width, height)
      picture = this.lit
    }
    const pose = models.pose.detectForVideo(picture, t)
    const box = this.box = this.fixes.zoom ? this.zoom.update(pose.landmarks, width / height, t) : FULL
    let from: Picture = picture
    if (box !== FULL) {
      const w = Math.max(1, Math.round(box.w * width)), h = Math.max(1, Math.round(box.h * height))
      if (this.cut.width !== w || this.cut.height !== h) { this.cut.width = w; this.cut.height = h }
      this.cut.getContext('2d')!.drawImage(picture, box.x * width, box.y * height, box.w * width, box.h * height, 0, 0, w, h)
      from = this.cut
    }
    const g = models.hands.recognizeForVideo(from, t)
    const read = (g: GestureRecognizerResult, box: Box): RawHand[] => g.landmarks.map((found, i) => {
      const landmarks = found.map(p => unzoom(p, box))
      const top = g.gestures[i]?.[0]
      const label = top?.categoryName ?? ''
      const base = GESTURES[label] ?? 'none'
      const world = g.worldLandmarks[i]
      const fingers = world ? fingerReach(world) : []
      // This frame's reading on its own; the hand tracker reads it again knowing the hand's last reading.
      const gesture = readGesture(base, fingers)
      return { landmarks, gesture, base, score: top?.score ?? 0, label, fingers }
    })
    const hands = read(g, box)
    // The hand model first looks for palms in a small copy of the picture, where a hand in front
    // of a face or a patterned shirt is a few dots that blend in. The body pose still knows where
    // that wrist is: one wrist with no hand on it gets a closer look each frame, in turn.
    if (models.near && hands.length < this.numHands) {
      const patch = unseenWrist(pose.landmarks, hands, width / height, this.turn++, this.lastFound)
      if (patch) {
        const side = NEAR_PX
        if (this.close.width !== side) { this.close.width = side; this.close.height = side }
        this.close.getContext('2d')!.drawImage(picture, patch.x * width, patch.y * height, patch.w * width, patch.h * height, 0, 0, side, side)
        const found = read(models.near.recognize(this.close), patch)
        this.looks.taken++
        if (found.length) { this.looks.found++; hands.push(found[0]) }
        this.lastFound = found.length ? patch : undefined
      } else this.lastFound = undefined
    }
    if (t - this.lightAt >= LIGHT_MS) {
      this.lightAt = t
      this.light = brightness(seen, this.dim)
    }
    return { t, bodies: pose.landmarks, hands }
  }

  async start(video: HTMLVideoElement, deviceId = '') {
    await openCamera(video, deviceId)
    if (this.running) return
    await this.load()
    let lastVideoTime = -1, lastT = 0
    const loop = () => {
      if (video.currentTime !== lastVideoTime && video.readyState >= 2 && video.videoWidth) {
        lastVideoTime = video.currentTime
        const t = performance.now()
        const frame = this.read(video, video.videoWidth, video.videoHeight, t)
        if (lastT) this.fps += (1000 / (t - lastT) - this.fps) * 0.1
        lastT = t
        this.onFrame?.(frame)
      }
      requestAnimationFrame(loop)
    }
    this.running = true
    requestAnimationFrame(loop)
  }
}

const NEAR_PX = 256 // the patch is drawn this many dots square for the second look

/** Average brightness of a picture, 0 to 1, from a thumbnail of it. */
function brightness(picture: Picture, small: HTMLCanvasElement): number | undefined {
  try {
    small.width = 32; small.height = 18
    const c = small.getContext('2d', { willReadFrequently: true })!
    c.drawImage(picture, 0, 0, 32, 18)
    const px = c.getImageData(0, 0, 32, 18).data
    let sum = 0
    for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
    return sum / (px.length / 4) / 255
  } catch {
    return undefined // a picture the page isn't allowed to read
  }
}
