import './devices.css'

type Input = 'camera' | 'microphone' | 'microphone2'
const KEY = 'natter.inputs'

const NAMES: Record<Input, string> = { camera: 'Camera', microphone: 'Microphone', microphone2: 'Second microphone' }
const USE: Record<Input, string> = { camera: 'Use camera', microphone: 'Use microphone', microphone2: 'Use second microphone' }

/**
 * The same input choices on both boards. Save a choice only after it opens successfully.
 * A board that gives a way to open a second microphone gets a third list for it: with two,
 * the first belongs to the person on the left of the screen and the second to the one on the right.
 */
export class InputDevices {
  private saved: Partial<Record<Input, string>> = {}
  private kinds: Input[]
  private selects = {} as Record<Input, HTMLSelectElement>
  private buttons: HTMLButtonElement[] = []
  private status: HTMLElement
  private panel!: HTMLElement
  private busy = false
  private listFailed = false
  private open: Partial<Record<Input, (id: string) => Promise<void>>>
  private inTurn: () => boolean

  constructor(open: Partial<Record<Input, (id: string) => Promise<void>>>, inTurn: () => boolean) {
    this.open = open
    this.inTurn = inTurn
    this.kinds = (['camera', 'microphone', 'microphone2'] as const).filter(kind => open[kind])
    try { this.saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {} } catch { /* private window */ }
    const panel = document.createElement('details')
    panel.className = 'input-devices'
    panel.innerHTML = '<summary>Inputs</summary><div class="input-options"><strong>Camera &amp; microphone</strong><p class="input-status" role="status">Allow access to see device names.</p></div>'
    const content = panel.querySelector('.input-options')!
    this.status = panel.querySelector('.input-status')!
    const two = this.kinds.includes('microphone2')
    for (const kind of this.kinds) {
      const label = document.createElement('label')
      label.textContent = two && kind !== 'camera' ? `${NAMES[kind]} (person on the ${kind === 'microphone' ? 'left' : 'right'})` : NAMES[kind]
      const select = document.createElement('select')
      select.setAttribute('aria-label', NAMES[kind])
      this.selects[kind] = select
      label.append(select)
      const button = document.createElement('button')
      button.textContent = USE[kind]
      button.type = 'button'
      button.onclick = () => { void this.start(kind).catch(() => {}) }
      content.append(label, button)
      this.buttons.push(button)
    }
    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.textContent = 'Refresh devices'
    refresh.onclick = () => { void this.refresh() }
    content.append(refresh)
    this.buttons.push(refresh)
    // Selecting a device must not also clear a board, undo it or start a voice turn.
    panel.addEventListener('keydown', event => event.stopPropagation())
    panel.addEventListener('keyup', event => event.stopPropagation())
    panel.addEventListener('toggle', () => { if (panel.open) void this.refresh(); else this.letGo() })
    // A click on the board gives the keys back to the board: it doesn't move the focus by itself.
    document.addEventListener('pointerdown', event => { if (!(event.target instanceof Node && panel.contains(event.target))) this.letGo() }, true)
    this.panel = panel
    document.body.append(panel)
    navigator.mediaDevices?.addEventListener('devicechange', () => {
      void this.refresh()
      this.status.textContent = 'Devices changed. Choose an available input and press Use.'
    })
    void this.refresh()
  }

  /** Take the focus off the panel, so the board's keys work again after an input is chosen. */
  private letGo() {
    const active = document.activeElement
    if (active instanceof HTMLElement && this.panel.contains(active)) active.blur()
  }

  /** The saved choice for an input, if there is one. */
  choice(kind: Input): string {
    return this.saved[kind] ?? ''
  }

  async refresh() {
    if (this.busy) return
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      for (const kind of this.kinds) {
        const select = this.selects[kind]
        const value = select.options.length ? select.value : this.saved[kind] ?? ''
        const options = [new Option(kind === 'microphone2' ? 'None' : 'System default', '')]
        devices.filter(device => device.kind === (kind === 'camera' ? 'videoinput' : 'audioinput') && device.deviceId)
          .forEach((device, i) => {
            const name = device.label || `${kind === 'camera' ? 'Camera' : 'Microphone'} ${i + 1}`
            options.push(new Option(name, device.deviceId))
            // An audio interface is one device with several inputs: offer its first two on their own.
            if (kind !== 'camera' && inputsOf(device) >= 2) for (const n of [0, 1]) options.push(new Option(`${name}: input ${n + 1} only`, `${device.deviceId}|${n}`))
          })
        if (value && !options.some(option => option.value === value)) options.push(new Option('Unavailable device — choose another', value))
        select.replaceChildren(...options)
        select.value = value
      }
      if (this.listFailed) this.status.textContent = 'Devices refreshed. Choose an input and press Use.'
      this.listFailed = false
    } catch {
      this.listFailed = true
      this.status.textContent = 'Cannot list inputs. Allow camera and microphone access in your browser, then refresh.'
    }
  }

  async start(kind: Input, startup = false) {
    if (this.busy || this.inTurn()) {
      this.status.textContent = 'Finish your voice turn, then try again.'
      throw new Error('Input change is busy')
    }
    this.busy = true
    this.buttons.forEach(button => { button.disabled = true })
    Object.values(this.selects).forEach(select => { select.disabled = true })
    let id = startup ? this.saved[kind] ?? '' : this.selects[kind].value
    this.status.textContent = `Starting ${NAMES[kind].toLowerCase()}…`
    try {
      try {
        await this.open[kind]!(id)
      } catch (error) {
        // A disconnected remembered device must not prevent the next visit from starting.
        // A second microphone has nothing to fall back to: it stays chosen, and the board says it didn't start.
        if (!startup || !id || kind === 'microphone2' || !(error instanceof DOMException) || !['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw error
        id = ''
        await this.open[kind]!(id)
      }
      this.saved[kind] = id
      this.selects[kind].value = id
      try { localStorage.setItem(KEY, JSON.stringify(this.saved)) } catch { /* private window */ }
      this.status.textContent = kind === 'microphone2' && !id ? 'Second microphone off.' : `${NAMES[kind]} ready.`
    } catch (error) {
      this.selects[kind].value = this.saved[kind] ?? ''
      this.status.textContent = `Could not use ${NAMES[kind].toLowerCase()}. Check browser permission or choose another device, then try again.`
      throw error
    } finally {
      this.busy = false
      this.buttons.forEach(button => { button.disabled = false })
      Object.values(this.selects).forEach(select => { select.disabled = false })
      this.letGo()
      await this.refresh()
    }
  }
}

// ?inputs in the address lists every microphone's first two inputs, for an interface the browser reports as having one.
const SPLIT_ALL = typeof location !== 'undefined' && new URLSearchParams(location.search).has('inputs')

/** How many inputs a microphone device has. Where the browser doesn't say, two are offered: choosing one that isn't there is refused or reported, not silent. */
function inputsOf(device: MediaDeviceInfo): number {
  if (SPLIT_ALL) return 2
  const caps = (device as Partial<InputDeviceInfo>).getCapabilities?.()
  return caps?.channelCount?.max ?? 2
}
