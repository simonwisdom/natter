import { describe, expect, it } from 'vitest'
import { actionSchemas } from './actions'
import { CommandBus } from './bus'
import { initialScene } from './initial'

const bus = () => new CommandBus(initialScene())
const obj = (b: CommandBus, id: string) => b.scene.objects.find(o => o.id === id)!

describe('CommandBus', () => {
  it('applies a valid call, bumps the version and stamps changed objects', () => {
    const b = bus()
    const out = b.apply([{ name: 'setColour', input: { ids: ['c1'], colour: 'red' } }], 'p1')
    expect(out.errors).toEqual([])
    expect(obj(b, 'c1').colour).toBe('red')
    expect(obj(b, 'c1').changedAt).toBe(1)
    expect(obj(b, 'c2').changedAt).toBe(0)
  })

  it('rejects unknown actions, bad params and unknown ids without changing the board', () => {
    const b = bus()
    const before = b.scene
    const out = b.apply([
      { name: 'explode', input: {} },
      { name: 'setColour', input: { ids: ['c1'], colour: 'mauve' } },
      { name: 'setColour', input: { ids: ['zz'], colour: 'red' } },
    ], 'p1')
    expect(out.errors).toHaveLength(3)
    expect(b.scene).toBe(before)
  })

  it('rejects calls resolved against a version older than a change to their targets', () => {
    const b = bus()
    b.apply([{ name: 'setColour', input: { ids: ['c1'], colour: 'red' } }], 'p1')
    const out = b.apply([{ name: 'resize', input: { ids: ['c1'], size: 'large' }, sceneVersion: 0 }], 'p2')
    expect(out.errors[0]).toMatch(/changed/)
    const ok = b.apply([{ name: 'resize', input: { ids: ['c2'], size: 'large' }, sceneVersion: 0 }], 'p2')
    expect(ok.errors).toEqual([])
  })

  it('lets later calls in one batch act on objects changed earlier in the same batch', () => {
    const b = bus()
    const out = b.apply([
      { name: 'groupItems', input: { ids: ['c1', 'c2'], label: 'Food' }, sceneVersion: 0 },
      { name: 'setColour', input: { ids: ['c1', 'c2'], colour: 'red' }, sceneVersion: 0 },
    ], 'p1')
    expect(out.errors).toEqual([])
    expect(obj(b, 'c2').colour).toBe('red')
  })

  it('keeps clusters and notes on the board when there are many objects', () => {
    const b = bus()
    b.apply([{ name: 'addNote', input: { text: 'x', near: 'c5' } }], 'p1')
    const all = b.scene.objects.map(o => o.id)
    b.apply([{ name: 'moveItems', input: { ids: all, to: 'left' } }], 'p1')
    for (const o of b.scene.objects) {
      expect(o.y).toBeGreaterThanOrEqual(0.25)
      expect(o.y).toBeLessThanOrEqual(0.68)
      expect(o.x).toBeLessThanOrEqual(0.94)
    }
  })

  it('undoes and redoes a whole batch as one step', () => {
    const b = bus()
    b.apply([
      { name: 'setColour', input: { ids: ['c1'], colour: 'red' } },
      { name: 'star', input: { ids: ['c1'], starred: true } },
    ], 'p1')
    b.apply([{ name: 'undo', input: {} }], 'p1')
    expect(obj(b, 'c1').colour).toBe('blue')
    expect(obj(b, 'c1').starred).toBeUndefined()
    b.apply([{ name: 'redo', input: {} }], 'p1')
    expect(obj(b, 'c1').starred).toBe(true)
    expect(b.apply([{ name: 'redo', input: {} }], 'p1').errors[0]).toMatch(/Nothing to redo/)
  })

  it('catches a stale call after an undo reverts its target', () => {
    const b = bus()
    b.apply([{ name: 'setColour', input: { ids: ['c1'], colour: 'red' } }], 'p1')
    const v = b.scene.version
    b.apply([{ name: 'undo', input: {} }], 'p1')
    expect(b.apply([{ name: 'resize', input: { ids: ['c1'], size: 'small' }, sceneVersion: v }], 'p1').errors[0]).toMatch(/changed/)
  })

  it('holds high-risk calls until confirmed, and drops them on reject', () => {
    const b = bus()
    const out = b.apply([{ name: 'deleteItems', input: { ids: ['c1'] } }], 'p1')
    expect(out.pending?.summary).toMatch(/Deleted/)
    expect(b.scene.objects).toHaveLength(12)
    b.apply([{ name: 'reject', input: {} }], 'p1')
    expect(b.pending).toBeUndefined()
    b.apply([{ name: 'deleteItems', input: { ids: ['c1'] } }], 'p1')
    b.apply([{ name: 'confirm', input: {} }], 'p2')
    expect(b.scene.objects).toHaveLength(11)
  })

  it('groups items, keeps them on the board and removes empty groups', () => {
    const b = bus()
    b.apply([{ name: 'groupItems', input: { ids: ['c1', 'c3'], label: 'Water', at: 'right' } }], 'p1')
    expect(b.scene.groups).toEqual([{ id: 'water', label: 'Water' }])
    for (const o of b.scene.objects) {
      expect(o.x).toBeGreaterThanOrEqual(0)
      expect(o.x).toBeLessThanOrEqual(1)
    }
    expect(obj(b, 'c1').x).toBeGreaterThan(0.6)
    b.apply([{ name: 'ungroup', input: { group: 'water' } }], 'p1')
    expect(b.scene.groups).toEqual([])
  })

  it('adds notes with the next number', () => {
    const b = bus()
    b.apply([{ name: 'addNote', input: { text: 'Book train' } }], 'p1')
    const note = b.scene.objects.at(-1)!
    expect(note).toMatchObject({ id: 'n13', number: 13, kind: 'note', label: 'Book train' })
  })
})

describe('actionSchemas', () => {
  it('exposes JSON schemas for model-facing actions only', () => {
    const schemas = actionSchemas()
    const names = schemas.map(s => s.name)
    expect(names).toContain('groupItems')
    expect(names).toContain('undo')
    expect(names).not.toContain('place')
    const group = schemas.find(s => s.name === 'groupItems')!.input_schema as any
    expect(group.required).toEqual(['ids', 'label'])
    expect(group).not.toHaveProperty('$schema')
  })
})
