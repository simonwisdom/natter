import { z } from 'zod'
import { anchor, arrangeAll, cluster, freeSpot, onBoard, relax } from './layout'
import { COLOURS, REGIONS, SIZES, type Scene, type SceneObject } from './types'

/**
 * The board's interaction hooks (SPEC §6). Every change, whether by voice, keyboard or
 * mouse, goes through one of these via the CommandBus.
 */
export interface ActionDef {
  name: string
  description: string
  params: z.ZodObject
  /** low: applied straight away. high: held until someone confirms. */
  risk: 'low' | 'high'
  /** false keeps an action out of the model's tool list (e.g. mouse drags). */
  exposed?: boolean
  apply(scene: Scene, input: any): Scene
  describe(input: any, scene: Scene): string
}

const ids = z.array(z.string()).min(1).describe('Object ids from the board')
const region = z.enum(REGIONS)

const byIds = (scene: Scene, list: string[]) => list.map(id => scene.objects.find(o => o.id === id)!).filter(Boolean)
const names = (scene: Scene, list: string[]) => {
  const labels = byIds(scene, list).map(o => `“${o.label}”`)
  return labels.length > 3 ? `${labels.length} cards` : labels.join(', ')
}
const update = (scene: Scene, list: string[], fn: (o: SceneObject) => Partial<SceneObject>): Scene => ({
  ...scene,
  objects: scene.objects.map(o => (list.includes(o.id) ? { ...o, ...fn(o) } : o)),
})

/** Place `list` as a cluster at `at` and push everything else out of the way. */
function placeCluster(scene: Scene, list: string[], at: [number, number]): Scene {
  const spots = cluster(list.length, at)
  const placed = update(scene, list, o => {
    const [x, y] = spots[list.indexOf(o.id)]
    return { x, y }
  })
  return { ...placed, objects: relax(placed.objects, new Set(list)) }
}

function centroid(objs: SceneObject[]): [number, number] {
  return [objs.reduce((s, o) => s + o.x, 0) / objs.length, objs.reduce((s, o) => s + o.y, 0) / objs.length]
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group'

export const ACTIONS: ActionDef[] = [
  {
    name: 'moveItems',
    description: 'Move objects together to a region of the board.',
    params: z.object({ ids, to: region }),
    risk: 'low',
    apply: (s, p) => placeCluster(s, p.ids, anchor(p.to)),
    describe: (p, s) => `Moved ${names(s, p.ids)} to the ${p.to}`,
  },
  {
    name: 'groupItems',
    description: 'Put objects next to each other as a labelled group. Replaces any group they were in.',
    params: z.object({
      ids,
      label: z.string().min(1).max(40).describe('Short group name, e.g. "Food"'),
      at: region.optional().describe('Where to put the group; defaults to where the items already are'),
    }),
    risk: 'low',
    apply: (s, p) => {
      const existing = s.groups.find(g => g.label.toLowerCase() === p.label.toLowerCase())
      let id = existing?.id ?? slug(p.label)
      while (!existing && s.groups.some(g => g.id === id)) id += '-2'
      const groups = existing ? s.groups : [...s.groups, { id, label: p.label }]
      const at = p.at ? anchor(p.at) : centroid(byIds(s, p.ids))
      const grouped = update({ ...s, groups }, p.ids, () => ({ group: id }))
      return pruneGroups(placeCluster(grouped, p.ids, at))
    },
    describe: (p, s) => `Grouped ${names(s, p.ids)} as “${p.label}”`,
  },
  {
    name: 'ungroup',
    description: 'Dissolve a group; its objects stay where they are.',
    params: z.object({ group: z.string().describe('Group id') }),
    risk: 'low',
    apply: (s, p) => pruneGroups({ ...s, objects: s.objects.map(o => (o.group === p.group ? { ...o, group: undefined } : o)) }),
    describe: (p, s) => `Ungrouped “${s.groups.find(g => g.id === p.group)?.label ?? p.group}”`,
  },
  {
    name: 'removeFromGroup',
    description: 'Take objects out of their group and move them back out beside it.',
    params: z.object({ ids }),
    risk: 'low',
    apply: (s, p) => {
      const taken = update(s, p.ids, o => ({ group: undefined, x: o.x, y: o.y + 0.001 }))
      const [x, y] = freeSpot(taken.objects.filter(o => !p.ids.includes(o.id)))
      return pruneGroups(placeCluster(taken, p.ids, [x, y]))
    },
    describe: (p, s) => `Took ${names(s, p.ids)} out of the group`,
  },
  {
    name: 'setColour',
    description: 'Change the colour of objects.',
    params: z.object({ ids, colour: z.enum(COLOURS) }),
    risk: 'low',
    apply: (s, p) => update(s, p.ids, () => ({ colour: p.colour })),
    describe: (p, s) => `Made ${names(s, p.ids)} ${p.colour}`,
  },
  {
    name: 'resize',
    description: 'Make objects small, medium or large.',
    params: z.object({ ids, size: z.enum(SIZES) }),
    risk: 'low',
    apply: (s, p) => {
      const resized = update(s, p.ids, () => ({ size: p.size }))
      return { ...resized, objects: relax(resized.objects, new Set(p.ids)) }
    },
    describe: (p, s) => `Made ${names(s, p.ids)} ${p.size}`,
  },
  {
    name: 'star',
    description: 'Mark objects as favourites with a star, or remove the star.',
    params: z.object({ ids, starred: z.boolean().describe('true to add the star, false to remove it') }),
    risk: 'low',
    apply: (s, p) => update(s, p.ids, () => ({ starred: p.starred })),
    describe: (p, s) => `${p.starred ? 'Starred' : 'Unstarred'} ${names(s, p.ids)}`,
  },
  {
    name: 'addNote',
    description: 'Add a sticky note with text.',
    params: z.object({
      text: z.string().min(1).max(80),
      colour: z.enum(COLOURS).optional(),
      near: z.string().optional().describe('Object id to put the note next to'),
      at: region.optional(),
    }),
    risk: 'low',
    apply: (s, p) => {
      const target = p.near && s.objects.find(o => o.id === p.near)
      const [x, y] = target ? onBoard(target.x + 0.06, target.y + 0.06) : p.at ? anchor(p.at) : freeSpot(s.objects)
      const id = `n${s.nextNumber}`
      const note: SceneObject = {
        id, number: s.nextNumber, kind: 'note', label: p.text, colour: p.colour ?? 'yellow',
        size: 'small', x, y, group: target ? target.group : undefined, changedAt: s.version,
      }
      const added = { ...s, nextNumber: s.nextNumber + 1, objects: [...s.objects, note] }
      return { ...added, objects: relax(added.objects, new Set([id])) }
    },
    describe: p => `Added a note: “${p.text}”`,
  },
  {
    name: 'editLabel',
    description: 'Change the text on an object.',
    params: z.object({ id: z.string(), label: z.string().min(1).max(80) }),
    risk: 'low',
    apply: (s, p) => update(s, [p.id], () => ({ label: p.label })),
    describe: p => `Renamed to “${p.label}”`,
  },
  {
    name: 'arrange',
    description: 'Lay out every object on the board in a grid, a row or a circle, optionally sorted.',
    params: z.object({
      layout: z.enum(['grid', 'row', 'circle']),
      sortBy: z.enum(['colour', 'label', 'group', 'size', 'starred']).optional(),
    }),
    risk: 'low',
    apply: (s, p) => {
      const key = (o: SceneObject): string => {
        switch (p.sortBy) {
          case 'colour': return String(COLOURS.indexOf(o.colour))
          case 'label': return o.label.toLowerCase()
          case 'group': return o.group ?? '~'
          case 'size': return String(SIZES.indexOf(o.size))
          case 'starred': return o.starred ? '0' : '1'
          default: return String(o.number).padStart(4, '0')
        }
      }
      const order = [...s.objects].sort((a, b) => key(a).localeCompare(key(b)) || a.number - b.number)
      const spots = arrangeAll(order.length, p.layout)
      const pos = new Map(order.map((o, i) => [o.id, spots[i]]))
      return { ...s, objects: s.objects.map(o => ({ ...o, x: pos.get(o.id)![0], y: pos.get(o.id)![1] })) }
    },
    describe: p => `Arranged everything in a ${p.layout}${p.sortBy ? ` by ${p.sortBy}` : ''}`,
  },
  {
    name: 'focus',
    description: 'Spotlight some objects and dim the rest. Pass an empty list to clear the spotlight.',
    params: z.object({ ids: z.array(z.string()) }),
    risk: 'low',
    apply: (s, p) => ({ ...s, focus: p.ids }),
    describe: (p, s) => (p.ids.length ? `Spotlighting ${names(s, p.ids)}` : 'Cleared the spotlight'),
  },
  {
    name: 'deleteItems',
    description: 'Remove objects from the board.',
    params: z.object({ ids }),
    risk: 'high',
    apply: (s, p) => pruneGroups({ ...s, objects: s.objects.filter(o => !p.ids.includes(o.id)), focus: s.focus.filter(id => !p.ids.includes(id)) }),
    describe: (p, s) => `Deleted ${names(s, p.ids)}`,
  },
  {
    name: 'place',
    description: 'Put one object at an exact position (mouse drag).',
    params: z.object({ id: z.string(), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
    risk: 'low',
    exposed: false,
    apply: (s, p) => update(s, [p.id], () => ({ x: p.x, y: p.y })),
    describe: (p, s) => `Moved ${names(s, [p.id])}`,
  },
]

function pruneGroups(scene: Scene): Scene {
  const used = new Set(scene.objects.map(o => o.group).filter(Boolean))
  return { ...scene, groups: scene.groups.filter(g => used.has(g.id)) }
}

/** Built-ins the CommandBus handles itself; listed so the model can say "undo". */
export const BUILTINS = [
  { name: 'undo', description: 'Undo the last change.' },
  { name: 'redo', description: 'Redo the last undone change.' },
] as const

export function actionByName(name: string): ActionDef | undefined {
  return ACTIONS.find(a => a.name === name)
}

/** The tool list sent to the resolver with each turn. */
export function actionSchemas() {
  const empty = { type: 'object', properties: {}, additionalProperties: false }
  return [
    ...ACTIONS.filter(a => a.exposed !== false).map(a => {
      const { $schema: _, ...schema } = z.toJSONSchema(a.params) as Record<string, unknown>
      return { name: a.name, description: a.description, input_schema: schema, risk: a.risk }
    }),
    ...BUILTINS.map(b => ({ name: b.name, description: b.description, input_schema: empty, risk: 'low' })),
  ]
}
