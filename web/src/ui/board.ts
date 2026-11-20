import type { CommandBus } from '../scene/bus'
import { SIZE_W, sizeH } from '../scene/layout'
import type { Colour, Scene, SceneObject } from '../scene/types'

export const CARD_COLOURS: Record<Colour, { bg: string; band: string; ink: string }> = {
  blue: { bg: '#e3eefb', band: '#4d86d9', ink: '#1f3352' },
  green: { bg: '#e6f2df', band: '#5a9e47', ink: '#24391c' },
  yellow: { bg: '#fbf3cf', band: '#e2b52c', ink: '#463812' },
  orange: { bg: '#fde6d2', band: '#e5823a', ink: '#4a2a12' },
  red: { bg: '#fadcdc', band: '#d4494b', ink: '#4a1717' },
  pink: { bg: '#fbe1ee', band: '#df6fa5', ink: '#4c1d33' },
  purple: { bg: '#ebe2f8', band: '#8a63cf', ink: '#2e1f48' },
  grey: { bg: '#ecebe8', band: '#8a8780', ink: '#2f2e2b' },
}

/** Renders the scene and turns mouse drags into `place` calls through the bus. */
export class Board {
  private cards = new Map<string, HTMLElement>()
  private groupEls = new Map<string, HTMLElement>()
  private root: HTMLElement
  private cardLayer: HTMLElement
  private groupLayer: HTMLElement
  private bus: CommandBus

  constructor(root: HTMLElement, bus: CommandBus) {
    this.root = root
    this.bus = bus
    this.cardLayer = root.querySelector('#cards')!
    this.groupLayer = root.querySelector('#groups')!
    bus.onChange(({ scene }) => this.render(scene))
    this.render(bus.scene)
  }

  showNumbers(on: boolean) {
    this.root.classList.toggle('numbers', on)
  }

  /** Outline objects in a person's colour: the preview before a change, or clarify candidates. */
  highlight(ids: string[], colour: string) {
    for (const [id, el] of this.cards) {
      const on = ids.includes(id)
      el.classList.toggle('targeted', on)
      el.style.setProperty('--target', on ? colour : 'transparent')
    }
  }

  render(scene: Scene) {
    const live = new Set(scene.objects.map(o => o.id))
    for (const [id, el] of this.cards) {
      if (!live.has(id)) {
        el.classList.add('leaving')
        setTimeout(() => el.remove(), 300)
        this.cards.delete(id)
      }
    }
    for (const o of scene.objects) {
      let el = this.cards.get(o.id)
      if (!el) {
        el = this.create(o)
        this.cards.set(o.id, el)
        this.cardLayer.append(el)
        requestAnimationFrame(() => el!.classList.remove('entering'))
      }
      this.update(el, o, scene)
    }
    this.renderGroups(scene)
  }

  private create(o: SceneObject): HTMLElement {
    const el = document.createElement('div')
    el.className = `card entering ${o.kind}`
    el.dataset.id = o.id
    el.innerHTML = `<span class="num"></span><span class="star">★</span><span class="emoji"></span><span class="label"></span>`
    this.enableDrag(el)
    return el
  }

  private update(el: HTMLElement, o: SceneObject, scene: Scene) {
    const w = SIZE_W[o.size], h = sizeH(o.size)
    const c = CARD_COLOURS[o.colour]
    el.style.left = `${(o.x - w / 2) * 100}%`
    el.style.top = `${(o.y - h / 2) * 100}%`
    el.style.width = `${w * 100}%`
    el.style.height = `${h * 100}%`
    el.style.setProperty('--bg', c.bg)
    el.style.setProperty('--band', c.band)
    el.style.setProperty('--ink', c.ink)
    el.style.setProperty('--tilt', `${((o.number * 47) % 7) - 3}deg`)
    el.classList.toggle('starred', !!o.starred)
    el.classList.toggle('dimmed', scene.focus.length > 0 && !scene.focus.includes(o.id))
    el.classList.toggle('size-large', o.size === 'large')
    el.classList.toggle('size-small', o.size === 'small')
    el.querySelector('.num')!.textContent = String(o.number)
    el.querySelector('.emoji')!.textContent = o.emoji ?? ''
    el.querySelector('.label')!.textContent = o.label
  }

  private renderGroups(scene: Scene) {
    const seen = new Set<string>()
    for (const g of scene.groups) {
      const members = scene.objects.filter(o => o.group === g.id)
      if (!members.length) continue
      seen.add(g.id)
      let el = this.groupEls.get(g.id)
      if (!el) {
        el = document.createElement('div')
        el.className = 'group'
        el.innerHTML = '<span class="glabel"></span>'
        this.groupLayer.append(el)
        this.groupEls.set(g.id, el)
      }
      const pad = 0.018
      const x0 = Math.min(...members.map(o => o.x - SIZE_W[o.size] / 2)) - pad
      const x1 = Math.max(...members.map(o => o.x + SIZE_W[o.size] / 2)) + pad
      const y0 = Math.min(...members.map(o => o.y - sizeH(o.size) / 2)) - pad * 2.2
      const y1 = Math.max(...members.map(o => o.y + sizeH(o.size) / 2)) + pad * 1.6
      Object.assign(el.style, { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` })
      el.querySelector('.glabel')!.textContent = `${g.label} · ${members.length}`
    }
    for (const [id, el] of this.groupEls) {
      if (!seen.has(id)) { el.remove(); this.groupEls.delete(id) }
    }
  }

  private enableDrag(el: HTMLElement) {
    el.addEventListener('pointerdown', down => {
      down.preventDefault()
      const rect = this.root.getBoundingClientRect()
      const start = { x: down.clientX, y: down.clientY, left: el.offsetLeft, top: el.offsetTop }
      el.setPointerCapture(down.pointerId)
      el.classList.add('dragging')
      const move = (e: PointerEvent) => {
        el.style.left = `${start.left + e.clientX - start.x}px`
        el.style.top = `${start.top + e.clientY - start.y}px`
      }
      const up = (e: PointerEvent) => {
        el.removeEventListener('pointermove', move)
        el.classList.remove('dragging')
        const id = el.dataset.id!
        const o = this.bus.scene.objects.find(obj => obj.id === id)
        if (!o) return
        const x = Math.min(1, Math.max(0, o.x + (e.clientX - start.x) / rect.width))
        const y = Math.min(1, Math.max(0, o.y + (e.clientY - start.y) / rect.height))
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 3) return this.render(this.bus.scene)
        this.bus.apply([{ name: 'place', input: { id, x, y } }], 'mouse')
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up, { once: true })
    })
  }
}
