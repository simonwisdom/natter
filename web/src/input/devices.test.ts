import { afterEach, describe, expect, it, vi } from 'vitest'
import { openCamera } from './camera'
import { Microphone, parseSource } from './audio'

afterEach(() => vi.unstubAllGlobals())

function stream() {
  const stop = vi.fn()
  return { getTracks: () => [{ stop }], stop }
}

describe('camera selection', () => {
  it('requests the chosen device and releases the old camera after playback', async () => {
    const old = stream(), next = stream()
    const getUserMedia = vi.fn().mockResolvedValue(next)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const video = { srcObject: old, play: vi.fn(async () => { expect(old.stop).not.toHaveBeenCalled() }) }
    await openCamera(video as unknown as HTMLVideoElement, 'usb-camera')
    expect(getUserMedia).toHaveBeenCalledWith({ video: { deviceId: { exact: 'usb-camera' }, width: { ideal: 1280 }, height: { ideal: 720 } } })
    expect(video.srcObject).toBe(next)
    expect(old.stop).toHaveBeenCalledOnce()
  })

  it('keeps the old camera when permission is denied', async () => {
    const old = stream()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new Error('denied')) } })
    const video = { srcObject: old }
    await expect(openCamera(video as unknown as HTMLVideoElement, 'missing')).rejects.toThrow('denied')
    expect(video.srcObject).toBe(old)
    expect(old.stop).not.toHaveBeenCalled()
  })

  it('restores the old camera and stops the failed new stream if playback fails', async () => {
    const old = stream(), next = stream()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(next) } })
    const video = { srcObject: old, play: vi.fn().mockRejectedValue(new Error('play failed')) }
    await expect(openCamera(video as unknown as HTMLVideoElement, 'usb')).rejects.toThrow('play failed')
    expect(video.srcObject).toBe(old)
    expect(old.stop).not.toHaveBeenCalled()
    expect(next.stop).toHaveBeenCalledOnce()
  })
})

function audioSetup() {
  const contexts: { close: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; audioWorklet: { addModule: ReturnType<typeof vi.fn> } }[] = []
  const nodes: { port: { onmessage: null | ((event: { data: Float32Array }) => void) } }[] = []
  const connection = () => ({ connect: vi.fn().mockReturnThis() })
  vi.stubGlobal('AudioContext', class {
    close = vi.fn().mockResolvedValue(undefined)
    resume = vi.fn().mockResolvedValue(undefined)
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }
    destination = {}
    createGain = () => ({ ...connection(), gain: { value: 1 } })
    createMediaStreamSource = connection
    constructor() { contexts.push(this) }
  })
  vi.stubGlobal('AudioWorkletNode', class {
    port = { onmessage: null }
    connect = vi.fn().mockReturnValue(connection())
    constructor() { nodes.push(this) }
  })
  const getUserMedia = vi.fn()
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  return { contexts, nodes, getUserMedia }
}

describe('microphone selection', () => {
  it('uses the selected microphone, clears old pre-roll and releases old resources', async () => {
    const { contexts, nodes, getUserMedia } = audioSetup()
    const old = stream(), next = stream()
    getUserMedia.mockResolvedValueOnce(old).mockResolvedValueOnce(next)
    const mic = new Microphone()
    await mic.start()
    nodes[0].port.onmessage!({ data: new Float32Array([0.5]) })
    await mic.start('usb-mic')
    expect(getUserMedia.mock.calls[1][0].audio.deviceId).toEqual({ exact: 'usb-mic' })
    expect(old.stop).toHaveBeenCalledOnce()
    expect(contexts[0].close).toHaveBeenCalledOnce()
    expect(nodes[0].port.onmessage).toBeNull()
    expect(mic.beginTurn()).toEqual([])
    expect(mic.started).toBe(true)
  })

  it('keeps the working microphone after capture or worklet failure', async () => {
    const { contexts, getUserMedia } = audioSetup()
    const old = stream(), failed = stream()
    getUserMedia.mockResolvedValueOnce(old).mockRejectedValueOnce(new Error('denied'))
    const mic = new Microphone()
    await mic.start()
    await expect(mic.start('denied')).rejects.toThrow('denied')
    expect(contexts[1].close).toHaveBeenCalledOnce()
    // Make only the next newly created context's worklet fail.
    getUserMedia.mockReset().mockImplementationOnce(async () => {
      contexts[2].audioWorklet.addModule.mockRejectedValue(new Error('worklet failed'))
      return failed
    })
    await expect(mic.start('broken')).rejects.toThrow('worklet failed')
    expect(old.stop).not.toHaveBeenCalled()
    expect(contexts[0].close).not.toHaveBeenCalled()
    expect(failed.stop).toHaveBeenCalledOnce()
    expect(contexts[2].close).toHaveBeenCalledOnce()
    expect(mic.started).toBe(true)
  })

  it('reads one input of an audio interface, with the browser’s clean-up off so the inputs stay apart', async () => {
    const { getUserMedia } = audioSetup()
    getUserMedia.mockResolvedValue(stream())
    const mic = new Microphone()
    await mic.start('interface|1')
    expect(getUserMedia.mock.calls[0][0].audio).toEqual({ channelCount: { ideal: 2 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId: { exact: 'interface' } })
    expect(mic.channel).toBe(1)
    await mic.start('interface')
    expect(getUserMedia.mock.calls[1][0].audio).toMatchObject({ channelCount: 1, echoCancellation: true })
    expect(mic.channel).toBeUndefined()
    expect(parseSource('')).toEqual({ deviceId: '' })
  })

  it('refuses an input the device did not give, and keeps the microphone that was working', async () => {
    const { contexts, getUserMedia } = audioSetup()
    const old = stream(), mono = { ...stream(), getAudioTracks: () => [{ getSettings: () => ({ channelCount: 1 }) }] }
    getUserMedia.mockResolvedValueOnce(old).mockResolvedValueOnce(mono)
    const mic = new Microphone()
    await mic.start()
    await expect(mic.start('interface|1')).rejects.toThrow('not input 2')
    expect(mono.stop).toHaveBeenCalledOnce()
    expect(contexts[1].close).toHaveBeenCalledOnce()
    expect(old.stop).not.toHaveBeenCalled()
    expect(mic.started).toBe(true)
  })

  it('says so when sound arrives but not on the input that was chosen', async () => {
    const { nodes, getUserMedia } = audioSetup()
    getUserMedia.mockResolvedValue(stream())
    const mic = new Microphone()
    const problems: string[] = []
    mic.onProblem = what => problems.push(what)
    await mic.start('interface|1')
    ;(nodes[0].port.onmessage as unknown as (e: { data: string }) => void)({ data: 'missing' })
    expect(problems).toEqual(['This microphone has no input 2: it is hearing nothing'])
  })

  it('stops, for a second microphone that is switched off', async () => {
    const { contexts, getUserMedia } = audioSetup()
    const s = stream()
    getUserMedia.mockResolvedValue(s)
    const mic = new Microphone()
    await mic.start('interface|0')
    mic.stop()
    expect(s.stop).toHaveBeenCalledOnce()
    expect(contexts[0].close).toHaveBeenCalledOnce()
    expect(mic.started).toBe(false)
    expect(mic.channel).toBeUndefined()
  })
})
