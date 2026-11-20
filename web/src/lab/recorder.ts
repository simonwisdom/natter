/**
 * Records the camera picture (no sound) of a Body Lab session, so the session
 * can be replayed against a change to the tracking. Pieces go to the local server, which
 * writes lab-recordings/<name>.webm on this computer; nothing is sent anywhere else.
 */
export const BITS_PER_SECOND = 1_000_000

/** The screen has more detail than the camera picture (small words), so it gets more. About 19 MB a minute. */
export const SCREEN_BITS_PER_SECOND = 2_500_000

export class CameraRecorder {
  private rec?: MediaRecorder
  private count = 0
  private tag: string
  private bits: number
  /** `tag` goes in the file's name ("screen" for the recording of the page itself), so one session can hold both. */
  constructor(tag = '', bits = BITS_PER_SECOND) {
    this.tag = tag
    this.bits = bits
  }
  /** The file being written, without its ending. */
  name = ''
  /** Called when recording ends for any reason other than stop(): the camera changed, or a piece wasn't saved. */
  onEnd?: (why: 'camera' | 'save') => void

  get on() {
    return !!this.rec
  }

  start(stream: MediaStream, session: string) {
    this.stop()
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t))
    // About 8 MB a minute at the camera's full size: enough for the tracking to read a replay much as it read the camera.
    const rec = new MediaRecorder(new MediaStream(stream.getVideoTracks()), { mimeType: type, videoBitsPerSecond: this.bits })
    const name = this.name = `${session}-${this.tag ? `${this.tag}-` : ''}${++this.count}`
    // One piece at a time, in order: the file is the pieces end to end.
    let sending: Promise<unknown> = Promise.resolve()
    const end = (why: 'camera' | 'save') => {
      if (this.rec !== rec) return
      this.rec = undefined
      if (rec.state !== 'inactive') rec.stop()
      this.onEnd?.(why)
    }
    rec.ondataavailable = e => {
      if (!e.data.size) return
      sending = sending
        .then(() => fetch(`/lab-recording/${name}`, { method: 'POST', body: e.data }))
        .then(r => { if (!r.ok) throw new Error(String(r.status)) })
        .catch(() => end('save'))
    }
    rec.onstop = () => end('camera')
    rec.onerror = () => end('camera')
    this.rec = rec
    rec.start(3000)
  }

  stop() {
    const rec = this.rec
    this.rec = undefined
    if (rec && rec.state !== 'inactive') rec.stop() // hands over the last piece first
  }
}

export const SOUND_BITS_PER_SECOND = 48_000

/** The part of a sound file's name that says which microphone it is, and which input of its device: "mic2c1" is the second microphone, on input 2. */
export function soundName(session: string, mic: number, channel: number | undefined, part: number): string {
  return `${session}-mic${mic + 1}${channel === undefined ? '' : `c${channel}`}-${part}`
}

/**
 * Records one microphone's sound for the whole session, beside the camera picture, so a
 * transcript of everything said can be written afterwards (uv run natter-transcript).
 * It goes to the same local server and stays on this computer.
 */
export class SoundRecorder {
  private rec?: MediaRecorder
  private count = 0
  name = ''
  /** An unexpected stop must be visible: the camera can still be recording without sound. */
  onEnd?: () => void

  get on() {
    return !!this.rec
  }

  /** Returns whether recording started: a browser that can't record sound this way leaves it off. */
  start(stream: MediaStream, session: string, mic: number, channel?: number): boolean {
    this.stop()
    const type = ['audio/webm;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t))
    if (!type || !stream.getAudioTracks().length) return false
    const rec = new MediaRecorder(new MediaStream(stream.getAudioTracks()), { mimeType: type, audioBitsPerSecond: SOUND_BITS_PER_SECOND })
    const name = this.name = soundName(session, mic, channel, ++this.count)
    let sending: Promise<unknown> = Promise.resolve()
    const end = () => {
      if (this.rec !== rec) return
      this.rec = undefined
      if (rec.state !== 'inactive') rec.stop()
      this.onEnd?.()
    }
    rec.ondataavailable = e => {
      if (!e.data.size) return
      sending = sending
        .then(() => fetch(`/lab-recording/${name}`, { method: 'POST', body: e.data }))
        .then(r => { if (!r.ok) throw new Error(String(r.status)) })
        .catch(end)
    }
    rec.onstop = end
    rec.onerror = end
    this.rec = rec
    rec.start(3000)
    return true
  }

  stop() {
    const rec = this.rec
    this.rec = undefined
    if (rec && rec.state !== 'inactive') rec.stop()
  }
}
