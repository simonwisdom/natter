/**
 * Floor control (SPEC §4.1): who is talking to the screen, and when a command starts and ends.
 * Pure and clock-driven, so it can be tested with synthetic timelines.
 */

export const T_ARM = 300 // hand must stay up this long before listening starts
export const T_RELEASE = 250 // hand must stay down this long before the turn ends (absorbs pose flicker)
export const T_MAX = 20_000 // longest utterance
export const KEY_PERSON = 'key'

export type Phase = 'idle' | 'armed' | 'listening' | 'resolving'

export interface Turn {
  id: string
  personId: string
  source: 'gesture' | 'key'
  startedAt: number
}

export interface FloorState {
  phase: Phase
  holder?: string
  turn?: Turn
  /** People with a hand up who are waiting for the floor, in order. */
  queue: string[]
  armedAt?: number
}

export interface FloorEvents {
  turnStart(turn: Turn): void
  turnEnd(turn: Turn, cancelled: boolean): void
  change(state: FloorState): void
}

export class FloorController {
  state: FloorState = { phase: 'idle', queue: [] }
  private raised = new Map<string, number>() // person -> time hand went up
  private loweredAt = new Map<string, number>() // person -> time hand went down (pending release)
  /** People whose turn was cut short (cancel or T_MAX); they must lower their hand before they can arm again. */
  private blocked = new Set<string>()
  private blockedDownAt = new Map<string, number>()
  private turnCount = 0
  private events: FloorEvents

  constructor(events: FloorEvents) {
    this.events = events
  }

  /** Feed the set of people whose hand is up in this frame. */
  update(raisedNow: Set<string>, t: number) {
    for (const id of this.blocked) {
      if (id === KEY_PERSON) continue
      if (raisedNow.has(id)) { this.blockedDownAt.delete(id); continue }
      const down = this.blockedDownAt.get(id)
      if (down === undefined) this.blockedDownAt.set(id, t)
      else if (t - down >= T_RELEASE) { this.blocked.delete(id); this.blockedDownAt.delete(id) }
    }
    for (const id of raisedNow) {
      if (this.blocked.has(id)) continue
      this.loweredAt.delete(id)
      if (!this.raised.has(id)) this.raised.set(id, t)
    }
    for (const id of [...this.raised.keys()]) {
      if (id === KEY_PERSON || raisedNow.has(id)) continue
      const down = this.loweredAt.get(id)
      if (down === undefined) this.loweredAt.set(id, t)
      else if (t - down >= T_RELEASE) { this.raised.delete(id); this.loweredAt.delete(id) }
    }
    this.step(t)
  }

  keyDown(t: number) {
    if (this.blocked.has(KEY_PERSON)) return
    if (!this.raised.has(KEY_PERSON)) this.raised.set(KEY_PERSON, t - T_ARM)
    this.step(t)
  }

  keyUp(t: number) {
    this.blocked.delete(KEY_PERSON)
    this.raised.delete(KEY_PERSON)
    this.step(t)
  }

  /** Abandon the current turn (Esc or "cancel"). */
  cancel(t: number) {
    const turn = this.state.turn
    if (this.state.phase === 'listening' && turn) {
      this.raised.delete(turn.personId)
      this.blocked.add(turn.personId)
      this.set({ phase: 'idle', queue: this.state.queue })
      this.events.turnEnd(turn, true)
    } else if (this.state.phase === 'armed') {
      this.set({ phase: 'idle', queue: this.state.queue })
    }
    this.step(t)
  }

  /** The resolver answered (or failed); the floor is free again. */
  resolved(t: number) {
    if (this.state.phase !== 'resolving') return
    this.set({ phase: 'idle', queue: this.state.queue })
    this.step(t)
  }

  private step(t: number): void {
    const s = this.state
    // Only ending a turn is debounced: a hand that is on its way down can't arm or queue.
    const up = (id: string) => this.raised.has(id)
    const upNow = (id: string) => this.raised.has(id) && !this.loweredAt.has(id)
    const heldFor = (id: string) => t - (this.raised.get(id) ?? t)
    const byRaiseTime = (a: string, b: string) => this.raised.get(a)! - this.raised.get(b)!
    const queue = [...this.raised.keys()]
      .filter(id => upNow(id) && heldFor(id) >= T_ARM)
      .filter(id => id !== s.holder || s.phase === 'resolving')
      .sort(byRaiseTime)

    switch (s.phase) {
      case 'idle': {
        const next = [...this.raised.keys()].filter(upNow).sort(byRaiseTime)[0]
        if (!next) return this.setIfChanged({ phase: 'idle', queue: [] })
        if (heldFor(next) >= T_ARM) return this.startTurn(next, t)
        return this.set({ phase: 'armed', holder: next, armedAt: this.raised.get(next), queue: [] })
      }
      case 'armed': {
        if (!upNow(s.holder!)) {
          this.set({ phase: 'idle', queue: [] })
          return this.step(t)
        }
        if (heldFor(s.holder!) >= T_ARM) return this.startTurn(s.holder!, t)
        return
      }
      case 'listening': {
        const turn = s.turn!
        if (!up(turn.personId) || t - turn.startedAt >= T_MAX) {
          if (up(turn.personId)) this.blocked.add(turn.personId)
          this.raised.delete(turn.personId)
          this.set({ phase: 'resolving', holder: turn.personId, turn, queue: queue.filter(id => id !== turn.personId) })
          this.events.turnEnd(turn, false)
          return
        }
        return this.setIfChanged({ ...s, queue })
      }
      case 'resolving':
        return this.setIfChanged({ ...s, queue: queue.filter(id => id !== s.holder) })
    }
  }

  private startTurn(personId: string, t: number) {
    const turn: Turn = {
      id: `t${++this.turnCount}-${Math.round(t)}`,
      personId,
      source: personId === KEY_PERSON ? 'key' : 'gesture',
      startedAt: t,
    }
    this.set({ phase: 'listening', holder: personId, turn, queue: [] })
    this.events.turnStart(turn)
  }

  private set(state: FloorState) {
    this.state = state
    this.events.change(state)
  }

  private setIfChanged(state: FloorState) {
    if (JSON.stringify(state) !== JSON.stringify(this.state)) this.set(state)
  }
}
