import { actionByName } from './actions'
import type { ActionCall, Scene } from './types'

const ID_FIELDS = ['id', 'ids', 'near'] as const

export interface Applied {
  name: string
  summary: string
  ids: string[]
}

export interface Outcome {
  applied: Applied[]
  errors: string[]
  /** A high-risk call waiting for confirm/reject. */
  pending?: { call: ActionCall; summary: string }
}

export interface Change {
  scene: Scene
  outcome: Outcome
  by: string
}

/**
 * The only writer of scene state (SPEC §5–7). Validates each call against its schema,
 * the objects that exist and the scene version it was resolved against; keeps undo/redo;
 * holds high-risk calls until confirmed.
 */
export class CommandBus {
  private undoStack: Scene[] = []
  private redoStack: Scene[] = []
  private pendingCall?: { call: ActionCall; summary: string; by: string }
  private listeners: ((change: Change) => void)[] = []
  scene: Scene

  constructor(initial: Scene) {
    this.scene = initial
  }

  onChange(fn: (change: Change) => void) {
    this.listeners.push(fn)
  }

  get pending() {
    return this.pendingCall
  }

  apply(calls: ActionCall[], by: string): Outcome {
    const outcome: Outcome = { applied: [], errors: [] }
    let before = this.scene
    const baseVersion = this.scene.version
    let scene = this.scene

    for (const call of calls) {
      if (call.name === 'undo' || call.name === 'redo') {
        const from = call.name === 'undo' ? this.undoStack : this.redoStack
        const to = call.name === 'undo' ? this.redoStack : this.undoStack
        // Commit anything applied earlier in this batch before moving through history.
        // Undo/redo ends the batch; later calls in it are reported, not silently dropped.
        if (scene !== before) { this.undoStack.push(before); this.redoStack = []; this.scene = scene; before = scene }
        const later = calls.slice(calls.indexOf(call) + 1)
        if (later.length) outcome.errors.push(`Skipped ${later.map(c => c.name).join(', ')} after ${call.name}`)
        const target = from.pop()
        if (!target) { outcome.errors.push(`Nothing to ${call.name}`); break }
        to.push(scene)
        scene = restamp(scene, target)
        this.scene = scene
        outcome.applied.push({ name: call.name, summary: call.name === 'undo' ? 'Undone' : 'Redone', ids: [] })
        this.emit(outcome, by)
        return outcome
      }
      if (call.name === 'confirm' || call.name === 'reject') {
        const held = this.pendingCall
        if (!held) { outcome.errors.push('Nothing is waiting for confirmation'); continue }
        this.pendingCall = undefined
        if (call.name === 'reject') {
          outcome.applied.push({ name: 'reject', summary: `Cancelled: ${held.summary}`, ids: [] })
          continue
        }
        const result = this.run(scene, held.call, true, baseVersion)
        if (typeof result === 'string') outcome.errors.push(result)
        else if ('scene' in result) { scene = result.scene; outcome.applied.push(result.applied) }
        continue
      }

      const result = this.run(scene, call, false, baseVersion)
      if (typeof result === 'string') { outcome.errors.push(result); continue }
      if ('pending' in result) {
        this.pendingCall = { call, summary: result.pending, by }
        outcome.pending = { call, summary: result.pending }
        continue
      }
      scene = result.scene
      outcome.applied.push(result.applied)
    }

    if (scene !== before) {
      this.undoStack.push(before)
      this.redoStack = []
      this.scene = scene
    }
    this.emit(outcome, by)
    return outcome
  }

  /** `baseVersion` is the scene version before this batch: changes made earlier in the same batch aren't "stale". */
  private run(scene: Scene, call: ActionCall, confirmed: boolean, baseVersion: number):
    string | { scene: Scene; applied: Applied } | { pending: string } {
    const def = actionByName(call.name)
    if (!def) return `Unknown action: ${call.name}`
    const parsed = def.params.safeParse(call.input)
    if (!parsed.success) return `${call.name}: ${parsed.error.issues.map(i => i.message).join('; ')}`
    const input = parsed.data as Record<string, unknown>

    const refs = ID_FIELDS.flatMap(k => {
      const v = input[k]
      return Array.isArray(v) ? (v as string[]) : typeof v === 'string' ? [v] : []
    })
    const missing = refs.filter(id => !scene.objects.some(o => o.id === id))
    if (missing.length) return `${call.name}: no object ${missing.join(', ')}`
    if (call.sceneVersion !== undefined) {
      const stale = refs.filter(id => {
        const changedAt = scene.objects.find(o => o.id === id)!.changedAt
        return changedAt > call.sceneVersion! && changedAt <= baseVersion
      })
      if (stale.length) return `${call.name}: the board changed while you were speaking`
    }

    const summary = def.describe(input, scene)
    if (def.risk === 'high' && !confirmed) return { pending: summary }

    const version = scene.version + 1
    const next = def.apply(scene, input)
    const old = new Map(scene.objects.map(o => [o.id, o]))
    const objects = next.objects.map(o => {
      const prev = old.get(o.id)
      return prev && sameObject(prev, o) ? o : { ...o, changedAt: version }
    })
    return { scene: { ...next, version, objects }, applied: { name: call.name, summary, ids: refs } }
  }

  private emit(outcome: Outcome, by: string) {
    for (const fn of this.listeners) fn({ scene: this.scene, outcome, by })
  }
}

/** Move to `target` as a new version, stamping objects that differ so stale calls are caught. */
function restamp(current: Scene, target: Scene): Scene {
  const version = current.version + 1
  const old = new Map(current.objects.map(o => [o.id, o]))
  const objects = target.objects.map(o => {
    const prev = old.get(o.id)
    return prev && sameObject(prev, o) ? o : { ...o, changedAt: version }
  })
  return { ...target, version, objects }
}

function sameObject(a: object, b: object) {
  const strip = ({ changedAt: _, ...rest }: any) => rest
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b))
}
