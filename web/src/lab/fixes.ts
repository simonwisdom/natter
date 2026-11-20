/**
 * Tracking fixes that can each be switched off from the address, so one recorded session can
 * be replayed with and without each: lab.html?off=steady,loose,zoom
 *
 *   steady  a gesture is easier to stay in than to enter, and finger measurements are evened out
 *   loose   the hand model keeps a blurred or half-turned hand it is less sure of
 *   zoom    hands are looked for in the part of the picture the people are in, not the whole frame
 */
export const FIXES = ['steady', 'loose', 'zoom'] as const
export type Fix = typeof FIXES[number]
export type Fixes = Record<Fix, boolean>

export function readFixes(search: string): Fixes {
  const off = new Set((new URLSearchParams(search).get('off') ?? '').split(',').map(s => s.trim()))
  return Object.fromEntries(FIXES.map(f => [f, !off.has(f) && !off.has('all')])) as Fixes
}

export const ALL_FIXES: Fixes = readFixes('')
