import { afterEach, describe, expect, it, vi } from 'vitest'
import { SoundRecorder, soundName } from './recorder'

afterEach(() => vi.unstubAllGlobals())

function recording() {
  const instances: FakeRecorder[] = []
  class FakeRecorder {
    static isTypeSupported() { return true }
    state = 'recording'
    ondataavailable?: (event: { data: { size: number } }) => void
    onstop?: () => void
    onerror?: () => void
    constructor() { instances.push(this) }
    start() {}
    stop() { this.state = 'inactive'; this.onstop?.() }
    chunk() { this.ondataavailable?.({ data: { size: 1 } }) }
  }
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('MediaStream', class { constructor(_tracks: unknown) {} })
  const stream = { getAudioTracks: () => [{}] } as MediaStream
  const sound = new SoundRecorder()
  const ended = vi.fn()
  sound.onEnd = ended
  sound.start(stream, 'session', 0)
  return { sound, ended, instances, stream }
}

describe('recorded sound', () => {
  it('is named for its session, its microphone and the input of the device it listens to', () => {
    expect(soundName('2026-11-19T19-02-11', 0, 0, 1)).toBe('2026-11-19T19-02-11-mic1c0-1')
    expect(soundName('2026-11-19T19-02-11', 1, 1, 2)).toBe('2026-11-19T19-02-11-mic2c1-2')
    expect(soundName('2026-11-19T19-02-11', 0, undefined, 1)).toBe('2026-11-19T19-02-11-mic1-1')
  })

  it.each(['network', 'server'])('reports a %s save failure and stops recording', async failure => {
    vi.stubGlobal('fetch', failure === 'network' ? vi.fn().mockRejectedValue(new Error('offline')) : vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    const { sound, ended, instances } = recording()
    instances[0].chunk()
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1))
    expect(sound.on).toBe(false)
    expect(instances[0].state).toBe('inactive')
  })

  it('reports a device failure, but an intentional stop is quiet', () => {
    const { sound, ended, instances, stream } = recording()
    sound.stop()
    expect(ended).not.toHaveBeenCalled()
    sound.start(stream, 'session', 0)
    instances[1].onerror?.()
    expect(ended).toHaveBeenCalledTimes(1)
    expect(sound.on).toBe(false)
  })

  it('does not stop a replacement recording when an old upload fails', async () => {
    let reject!: (reason: Error) => void
    const fetch = vi.fn().mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    vi.stubGlobal('fetch', fetch)
    const { sound, ended, instances, stream } = recording()
    instances[0].chunk()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    sound.start(stream, 'session', 0)
    reject(new Error('old request failed'))
    // Drain the upload's promise chain before checking the replacement.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sound.on).toBe(true)
    expect(ended).not.toHaveBeenCalled()
    sound.stop()
  })
})
