import { describe, expect, it } from 'vitest'
import { FloorController, T_ARM, T_MAX, T_RELEASE, type Turn } from './floor'
import { isHandRaised, PeopleTracker } from './people'

function setup() {
  const log: string[] = []
  const floor = new FloorController({
    turnStart: (t: Turn) => log.push(`start ${t.personId}`),
    turnEnd: (t: Turn, cancelled) => log.push(`${cancelled ? 'cancel' : 'end'} ${t.personId}`),
    change: () => {},
  })
  /** Feed the same raised set every 33 ms from `from` to `to`. */
  const hold = (ids: string[], from: number, to: number) => {
    for (let t = from; t <= to; t += 33) floor.update(new Set(ids), t)
  }
  return { floor, log, hold }
}

describe('FloorController', () => {
  it('ignores a hand raised for less than T_ARM', () => {
    const { floor, log, hold } = setup()
    hold(['p1'], 0, T_ARM - 100)
    hold([], T_ARM - 67, T_ARM + 600)
    expect(log).toEqual([])
    expect(floor.state.phase).toBe('idle')
  })

  it('starts after T_ARM and ends once the hand has been down for T_RELEASE', () => {
    const { floor, log, hold } = setup()
    hold(['p1'], 0, 2000)
    expect(log).toEqual(['start p1'])
    hold([], 2033, 2033 + T_RELEASE - 50)
    expect(floor.state.phase).toBe('listening')
    hold([], 2033 + T_RELEASE - 17, 2033 + T_RELEASE + 100)
    expect(log).toEqual(['start p1', 'end p1'])
    expect(floor.state.phase).toBe('resolving')
  })

  it('survives a one-frame dropout without ending the turn', () => {
    const { log, hold } = setup()
    hold(['p1'], 0, 1000)
    hold([], 1033, 1066)
    hold(['p1'], 1099, 2000)
    expect(log).toEqual(['start p1'])
  })

  it('queues a second hand and hands over the floor after resolving', () => {
    const { floor, log, hold } = setup()
    hold(['p1'], 0, 600)
    hold(['p1', 'p2'], 633, 1500)
    expect(floor.state.queue).toEqual(['p2'])
    hold(['p2'], 1533, 1533 + T_RELEASE + 100)
    expect(log).toEqual(['start p1', 'end p1'])
    floor.resolved(2000)
    expect(log).toEqual(['start p1', 'end p1', 'start p2'])
  })

  it('caps a turn at T_MAX, and the same raised hand does not start another', () => {
    const { floor, log, hold } = setup()
    hold(['p1'], 0, T_ARM + T_MAX + 100)
    expect(log).toEqual(['start p1', 'end p1'])
    floor.resolved(T_ARM + T_MAX + 200)
    hold(['p1'], T_ARM + T_MAX + 233, T_ARM + T_MAX + 2000)
    expect(log).toEqual(['start p1', 'end p1'])
    hold([], T_ARM + T_MAX + 2033, T_ARM + T_MAX + 2500)
    hold(['p1'], T_ARM + T_MAX + 2533, T_ARM + T_MAX + 3000)
    expect(log.at(-1)).toBe('start p1')
  })

  it('does not restart a cancelled gesture turn while the hand stays up', () => {
    const { floor, log, hold } = setup()
    hold(['p1'], 0, 1000)
    floor.cancel(1000)
    hold(['p1'], 1033, 2500)
    expect(log).toEqual(['start p1', 'cancel p1'])
  })

  it('treats the key as an instant raise and cancel as an abandoned turn', () => {
    const { floor, log } = setup()
    floor.keyDown(0)
    expect(log).toEqual(['start key'])
    floor.cancel(500)
    expect(log).toEqual(['start key', 'cancel key'])
    floor.keyUp(600)
    expect(floor.state.phase).toBe('idle')
    floor.keyDown(1000)
    floor.keyUp(2000)
    expect(log.at(-1)).toBe('end key')
  })
})

const pose = (wristY: number, x = 0.5) => {
  const lm = Array.from({ length: 33 }, () => ({ x, y: 0.6, visibility: 0.9 }))
  lm[0] = { x, y: 0.3, visibility: 0.9 } // nose
  lm[11] = { x: x - 0.05, y: 0.45, visibility: 0.9 }
  lm[12] = { x: x + 0.05, y: 0.45, visibility: 0.9 }
  lm[15] = { x: x - 0.08, y: wristY, visibility: 0.9 }
  return lm
}

describe('people', () => {
  it('detects a wrist above the nose as raised, and below as not', () => {
    expect(isHandRaised(pose(0.2))).toBe(true)
    expect(isHandRaised(pose(0.4))).toBe(false)
    expect(isHandRaised(pose(0.7))).toBe(false)
  })

  it('keeps ids stable as people move a little, and gives newcomers new ids', () => {
    const tracker = new PeopleTracker()
    const a = tracker.update([pose(0.7, 0.3), pose(0.7, 0.7)], 0)
    const b = tracker.update([pose(0.7, 0.33), pose(0.7, 0.68)], 33)
    expect(b.map(p => p.id)).toEqual(a.map(p => p.id))
    const c = tracker.update([pose(0.7, 0.33), pose(0.7, 0.68), pose(0.2, 0.05)], 66)
    expect(c).toHaveLength(3)
    expect(c.find(p => p.raised)!.id).toBe('p3')
  })
})
