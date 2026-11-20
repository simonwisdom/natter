/**
 * Microphone capture at 16 kHz mono in 100 ms chunks, with a rolling pre-roll buffer:
 * people start talking as they raise a hand, so a turn begins with the last 2 s of audio.
 */

export const SAMPLE_RATE = 16000
const CHUNK = 1600 // 100 ms
const PREROLL_CHUNKS = 20 // 2 s

// Averages each run of input samples into one 16 kHz sample (input runs at the device rate,
// usually 48 kHz). `sampleRate` is the worklet's global for the context rate.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor(options) { super(); this.channel = options.processorOptions.channel; this.buf = new Float32Array(${CHUNK}); this.n = 0; this.step = sampleRate / ${SAMPLE_RATE}; this.pos = 0; this.sum = 0; this.count = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][this.channel]
    // Sound is arriving, but not on the input asked for: say so once, rather than hear nothing.
    if (!ch && inputs[0] && inputs[0].length && !this.told) { this.told = true; this.port.postMessage('missing') }
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i]; this.count++
      if (++this.pos < this.step) continue
      this.pos -= this.step
      this.buf[this.n++] = this.sum / this.count
      this.sum = 0; this.count = 0
      if (this.n === ${CHUNK}) { this.port.postMessage(this.buf.slice(0)); this.n = 0 }
    }
    return true
  }
}
registerProcessor('tap', Tap)
`

/**
 * A microphone choice as the Inputs list stores it: a device, or one input of a device with
 * several ("<device id>|1" is its second input). An audio interface with two microphones
 * plugged in is one device with two inputs.
 */
export function parseSource(source: string): { deviceId: string; channel?: number } {
  const at = source.lastIndexOf('|')
  if (at < 0) return { deviceId: source }
  return { deviceId: source.slice(0, at), channel: Number(source.slice(at + 1)) || 0 }
}

export class Microphone {
  private ring: Float32Array<ArrayBuffer>[] = []
  private live = false
  private ctx?: AudioContext
  private stream?: MediaStream
  private node?: AudioWorkletNode
  /** Recent loudness 0..1, for the level meter. */
  level = 0
  onChunk?: (pcm: Float32Array<ArrayBuffer>) => void
  /** The chosen input turned out not to be there, after the microphone had started. */
  onProblem?: (what: string) => void

  /** The one input of the device being read (0 is the first), when a single input was chosen. */
  channel?: number
  /** What is being listened to, for showing which microphone is which: the device's name, and the input when one was chosen. */
  name = ''

  get started() {
    return !!this.ctx
  }

  /** The sound as it comes from the device, for recording: every input of it, not only the one being listened to. */
  get sound(): MediaStream | undefined {
    return this.stream
  }

  stop() {
    if (this.node) this.node.port.onmessage = null
    this.stream?.getTracks().forEach(track => track.stop())
    void this.ctx?.close()
    this.ctx = undefined
    this.stream = undefined
    this.node = undefined
    this.channel = undefined
    this.name = ''
    this.ring = []
    this.level = 0
    this.live = false
  }

  /** `source` is a device id, or a device id and one of its inputs (see parseSource). */
  async start(source = '') {
    const { deviceId, channel } = parseSource(source)
    // Created before any await: iOS only lets an AudioContext run if it starts inside the tap.
    // It runs at the device rate; asking for 16 kHz gives silent or garbled input on iPhone.
    const ctx = new AudioContext()
    void ctx.resume()
    const stream = await navigator.mediaDevices.getUserMedia({
      // One input of several: the browser's echo and noise clean-up would fold the inputs into one, so it is off.
      audio: { ...(channel === undefined
        ? { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        : { channelCount: { ideal: 2 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }),
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
    }).catch(e => {
      void ctx.close()
      throw e
    })
    // Reading an input the device didn't give would hear nothing and say nothing about it.
    const got = stream.getAudioTracks?.()[0]?.getSettings?.().channelCount
    if (channel !== undefined && got !== undefined && got <= channel) {
      stream.getTracks().forEach(track => track.stop())
      void ctx.close()
      throw new Error(`The device gave ${got} input${got === 1 ? '' : 's'}, not input ${channel + 1}`)
    }
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
      const node = new AudioWorkletNode(ctx, 'tap', { processorOptions: { channel: channel ?? 0 } })
      const mute = ctx.createGain()
      mute.gain.value = 0
      ctx.createMediaStreamSource(stream).connect(node)
      node.connect(mute).connect(ctx.destination) // keeps the worklet pulled without playing anything
      await ctx.resume()
      if (this.node) this.node.port.onmessage = null
      this.stream?.getTracks().forEach(track => track.stop())
      void this.ctx?.close()
      this.ring = []
      this.level = 0
      this.channel = channel
      this.name = `${channel === undefined ? '' : `input ${channel + 1} of `}${stream.getAudioTracks?.()[0]?.label || 'microphone'}`
      this.ctx = ctx
      this.stream = stream
      this.node = node
      node.port.onmessage = (e: MessageEvent<Float32Array<ArrayBuffer> | 'missing'>) => {
        if (e.data === 'missing') this.onProblem?.(`This microphone has no input ${(channel ?? 0) + 1}: it is hearing nothing`)
        else this.push(e.data)
      }
    } catch (error) {
      stream.getTracks().forEach(track => track.stop())
      void ctx.close()
      throw error
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  private push(chunk: Float32Array<ArrayBuffer>) {
    let sum = 0
    for (const v of chunk) sum += v * v
    this.level = this.level * 0.6 + Math.min(1, Math.sqrt(sum / chunk.length) * 8) * 0.4
    this.ring.push(chunk)
    if (this.ring.length > PREROLL_CHUNKS) this.ring.shift()
    if (this.live) this.onChunk?.(chunk)
  }

  /** Start streaming; returns the pre-roll to send first. */
  beginTurn(): Float32Array<ArrayBuffer>[] {
    this.live = true
    return [...this.ring]
  }

  endTurn() {
    this.live = false
    // The next turn's pre-roll shouldn't replay the end of this one.
    this.ring = []
  }
}
