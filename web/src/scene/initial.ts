import { arrangeAll } from './layout'
import type { Colour, Scene, SceneObject } from './types'

/** A moodboard for planning a weekend away: varied colours and themes to group and argue about. */
const CARDS: [string, string, Colour][] = [
  ['Lisbon tiles', '🔷', 'blue'],
  ['Fig tree', '🌳', 'green'],
  ['Sea swim', '🌊', 'blue'],
  ['Night market', '🏮', 'red'],
  ['Olive oil tasting', '🫒', 'green'],
  ['Sunset terrace', '🌅', 'orange'],
  ['Vinyl night', '🎶', 'purple'],
  ['Long table dinner', '🍽️', 'yellow'],
  ['Bike ride', '🚲', 'grey'],
  ['Pottery class', '🏺', 'orange'],
  ['Lemon grove', '🍋', 'yellow'],
  ['Stargazing', '✨', 'purple'],
]

export function initialScene(): Scene {
  const spots = arrangeAll(CARDS.length, 'grid')
  const objects: SceneObject[] = CARDS.map(([label, emoji, colour], i) => ({
    id: `c${i + 1}`,
    number: i + 1,
    kind: 'card',
    label,
    emoji,
    colour,
    size: 'medium',
    // A little scatter so it reads as a board, not a spreadsheet.
    x: spots[i][0] + ((i * 37) % 7 - 3) * 0.004,
    y: spots[i][1] + ((i * 53) % 7 - 3) * 0.004,
    changedAt: 0,
  }))
  return { version: 0, nextNumber: CARDS.length + 1, objects, groups: [], focus: [] }
}
