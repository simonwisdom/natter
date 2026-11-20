// MediaPipe loads its wasm and models at runtime; serve them from public/ so the app works offline.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'

cpSync('node_modules/@mediapipe/tasks-vision/wasm', 'public/wasm', { recursive: true })

const BASE = 'https://storage.googleapis.com/mediapipe-models'
const MODELS = {
  'pose_landmarker_lite.task': `${BASE}/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task`,
  // Hand landmarks plus fist / open palm / thumbs up / thumbs down, for the Body Lab.
  'gesture_recognizer.task': `${BASE}/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task`,
}
mkdirSync('public/models', { recursive: true })
for (const [name, url] of Object.entries(MODELS)) {
  const path = `public/models/${name}`
  if (existsSync(path)) continue
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Couldn't download ${name} (${res.status}) from ${url}`)
  writeFileSync(path, Buffer.from(await res.arrayBuffer()))
  console.log(`Downloaded ${name} (MediaPipe, Apache-2.0)`)
}
