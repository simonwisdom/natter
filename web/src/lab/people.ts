/**
 * Body Lab with two people: whose hand is whose, so each person's words come from their own
 * microphone and two-handed moves stay with one person. Person 0 stands on the left of the
 * screen, person 1 on the right.
 */
import type { Landmark } from '../input/people'
import { toBoard, type Hand, type Pt } from './body'

/** One person in shot, in board coordinates. */
export interface Body {
  /** The middle of the shoulders, across the board. */
  x: number
  /** Shoulder width, in board heights. */
  width: number
  wrists: Pt[]
  mouth?: Pt
}

const WRIST_REACH = 0.25 // a hand further than this from every wrist isn't matched to one
const REACH = 2.5 // shoulder widths from the middle of a body: a hand further off than this is not theirs
const SAME_BODY = 0.6 // shoulder widths: two bodies whose middles are closer than this are one person seen twice
const AT_MOUTH = 0.6 // shoulder widths from the mouth: a hand this close is holding a microphone up

const seen = (l?: Landmark) => !!l && (l.visibility ?? 1) >= 0.5

/** The people the pose model found whose shoulders can be seen. */
export function readBodies(bodies: Landmark[][], aspect: number): Body[] {
  const out: Body[] = []
  for (const lm of bodies) {
    if (!seen(lm[11]) || !seen(lm[12])) continue
    const a = toBoard(lm[11]), b = toBoard(lm[12])
    const x = (a.x + b.x) / 2, width = Math.hypot((a.x - b.x) * aspect, a.y - b.y)
    // The pose model sometimes finds one person twice: two bodies standing in the same place are one.
    if (out.some(o => Math.abs(o.x - x) * aspect < SAME_BODY * Math.max(o.width, width))) continue
    const lips = [lm[9], lm[10]].filter(seen).map(toBoard)
    const mouth = lips.length ? { x: lips.reduce((s, p) => s + p.x, 0) / lips.length, y: lips.reduce((s, p) => s + p.y, 0) / lips.length } : seen(lm[0]) ? toBoard(lm[0]) : undefined
    out.push({
      x,
      width,
      wrists: [lm[15], lm[16]].filter(seen).map(toBoard),
      mouth,
    })
  }
  return out
}

/**
 * Which person each hand belongs to. Two people in shot and a hand on one's wrist is the only
 * reading taken as sure; with less to go on a hand keeps the person it had (`known`, by hand
 * id), and a hand never placed before goes to the nearest body, or by the half of the screen
 * a lone body stands in. Returns the hands it could place.
 */
export function whose(bodies: Body[], hands: Hand[], known: Map<number, number>, aspect: number): Map<number, number> {
  const order = [...bodies].sort((a, b) => a.x - b.x)
  const side = (body: Body) => (order.length >= 2 ? Math.min(1, order.indexOf(body)) : body.x < 0.5 ? 0 : 1)
  const out = new Map<number, number>()
  const onWrist = (h: Hand) => {
    let owner: Body | undefined, best = WRIST_REACH
    for (const body of order) {
      for (const w of body.wrists) {
        const d = Math.hypot((w.x - h.x) * aspect, w.y - h.y)
        if (d < best) { best = d; owner = body }
      }
    }
    return owner
  }
  if (order.length >= 2) {
    for (const h of hands) {
      const owner = onWrist(h), was = known.get(h.id)
      if (owner) out.set(h.id, side(owner))
      else if (was !== undefined) out.set(h.id, was)
      else out.set(h.id, side(order.reduce((n, body) => (Math.abs(body.x - h.x) < Math.abs(n.x - h.x) ? body : n))))
    }
    return out
  }
  const lone = order[0]
  if (!lone) {
    for (const h of hands) { const was = known.get(h.id); if (was !== undefined) out.set(h.id, was) }
    return out
  }
  // One body in shot. The hands on its wrists are all one person's, whatever they were taken
  // for before (a body seen double can have split them): the person most of them had, or by
  // the half of the screen the body stands in. That keeps someone alone able to use both hands together.
  const theirs = hands.filter(h => onWrist(h))
  const had = theirs.map(h => known.get(h.id)).filter(p => p !== undefined)
  const ones = had.filter(p => p === 1).length
  const person = ones * 2 > had.length ? 1 : ones * 2 < had.length ? 0 : side(lone)
  for (const h of hands) {
    const was = known.get(h.id)
    if (theirs.includes(h)) out.set(h.id, person)
    else if (was !== undefined) out.set(h.id, was)
    // A new hand out of this body's reach is the other person's, whose body isn't being found just now.
    else out.set(h.id, Math.abs(lone.x - h.x) * aspect < REACH * lone.width ? person : 1 - person)
  }
  return out
}

/** A hand held up at someone's mouth: it is holding a microphone, not working on the board. */
export function atMouth(bodies: Body[], h: Pt, aspect: number): boolean {
  return bodies.some(body => !!body.mouth && Math.hypot((body.mouth.x - h.x) * aspect, body.mouth.y - h.y) < AT_MOUTH * body.width)
}

/**
 * The hands holding a microphone. One that has been up at a mouth stays one wherever it is
 * held after that (people lower a microphone to their chest between sentences), until it
 * opens flat, which a hand round a microphone can't, or is lost.
 */
export function micHands(bodies: Body[], hands: Hand[], was: Set<number>, aspect: number): Set<number> {
  const out = new Set<number>()
  for (const h of hands) if (h.gesture !== 'palm' && (was.has(h.id) || atMouth(bodies, h, aspect))) out.add(h.id)
  return out
}
