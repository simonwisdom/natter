import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import { openCamera } from './camera'
import { PeopleTracker, type Person } from './people'

/** Camera → MediaPipe pose landmarks → tracked people. Frames never leave the page. */
export class PoseTracker {
  private tracker = new PeopleTracker()
  private landmarker?: PoseLandmarker
  private lastVideoTime = -1
  people: Person[] = []
  onPeople?: (people: Person[], t: number) => void

  async start(video: HTMLVideoElement, deviceId = '') {
    await openCamera(video, deviceId, 960, 540)
    if (this.landmarker) return
    const vision = await FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}wasm`)
    const options = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: `${import.meta.env.BASE_URL}models/pose_landmarker_lite.task`, delegate },
      runningMode: 'VIDEO' as const,
      numPoses: 4,
      minPoseDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })
    try {
      this.landmarker = await PoseLandmarker.createFromOptions(vision, options('GPU'))
    } catch {
      this.landmarker = await PoseLandmarker.createFromOptions(vision, options('CPU'))
    }
    const loop = () => {
      if (video.currentTime !== this.lastVideoTime && video.readyState >= 2) {
        this.lastVideoTime = video.currentTime
        const t = performance.now()
        const result = this.landmarker!.detectForVideo(video, t)
        this.people = this.tracker.update(result.landmarks, t)
        this.onPeople?.(this.people, t)
      }
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }
}
