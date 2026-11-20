export const COLOURS = ['blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'grey'] as const
export type Colour = (typeof COLOURS)[number]

export const SIZES = ['small', 'medium', 'large'] as const
export type Size = (typeof SIZES)[number]

export const REGIONS = [
  'left', 'right', 'top', 'bottom', 'center',
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
] as const
export type Region = (typeof REGIONS)[number]

export interface SceneObject {
  id: string
  /** Stable on-screen number, so people can say "number four". */
  number: number
  kind: 'card' | 'note'
  label: string
  emoji?: string
  colour: Colour
  size: Size
  /** Centre position, 0..1 across and down the board. */
  x: number
  y: number
  group?: string
  starred?: boolean
  /** Scene version that last changed this object; used to reject stale calls. */
  changedAt: number
}

export interface Group {
  id: string
  label: string
}

export interface Scene {
  version: number
  nextNumber: number
  objects: SceneObject[]
  groups: Group[]
  /** Ids in focus; others are dimmed. Empty means no focus. */
  focus: string[]
}

export interface ActionCall {
  name: string
  input: Record<string, unknown>
  sceneVersion?: number
}
