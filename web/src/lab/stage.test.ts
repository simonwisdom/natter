import { describe, expect, it } from 'vitest'
import { Play } from './play'
import { BAND_MS, Band, boardLine, handLine, type StageLine } from './stage'

const up = (id: number) => ({ id, resting: false })
const none = () => ({ captions: new Map<number, string>() })

describe('what a hand is doing', () => {
  it('is nothing while the hand is idle or hanging at rest', () => {
    const play = new Play()
    expect(handLine(play, up(1), none())).toBeUndefined()
    play.ideas.set(1, { x: 0.5, y: 0.5 })
    expect(handLine(play, { id: 1, resting: true }, none())).toBeUndefined()
  })
  it('names a new idea and shows the words as they are heard', () => {
    const play = new Play()
    play.ideas.set(1, { x: 0.5, y: 0.5 })
    expect(handLine(play, up(1), { captions: new Map(), listening: 1 })).toEqual({ kind: 'idea', what: '💡 New idea', heard: 'listening…' })
    expect(handLine(play, up(1), { captions: new Map([[1, 'a picnic']]), listening: 1 })).toEqual({ kind: 'idea', what: '💡 New idea', heard: '“a picnic”' })
  })
  it('names the bubble a branch grows from, and the one it would connect to', () => {
    const play = new Play()
    const [a, b] = play.bubbles
    play.ideas.set(1, { parent: a.id, x: 0.5, y: 0.5 })
    expect(handLine(play, up(1), none())).toMatchObject({ kind: 'branch', what: `🌱 Branch from “${a.text}”` })
    play.ideas.set(1, { parent: a.id, x: b.x, y: b.y, over: b.id })
    expect(handLine(play, up(1), none())).toMatchObject({ kind: 'connect', what: `🔗 Connect to “${b.text}”` })
  })
  it('tells a move from a merge and a two-handed resize', () => {
    const play = new Play()
    const [a, b] = play.bubbles
    a.holders = [1]
    expect(handLine(play, up(1), none())).toEqual({ kind: 'move', what: '✊ Move' })
    a.mergeInto = b.id
    expect(handLine(play, up(1), none())).toEqual({ kind: 'merge', what: `✊ Merge into “${b.text}”` })
    a.holders = [1, 2]
    expect(handLine(play, up(2), none())).toEqual({ kind: 'resize', what: '✊✊ Resize' })
  })
  it('calls a victory sign asking for ideas, with the angle as it is heard', () => {
    const play = new Play()
    play.asks.set(1, { bubble: play.bubbles[0].id } as never)
    expect(handLine(play, up(1), { captions: new Map([[1, 'risks']]), listening: 1 })).toEqual({ kind: 'ask', what: '✌️ Ask for ideas', heard: '“risks”' })
  })
})

describe('what the board is doing', () => {
  it('says Thinking while a bubble waits for its words, without naming Claude', () => {
    const play = new Play()
    expect(boardLine(play, none())).toBeUndefined()
    play.bubbles[0].pending = true
    expect(boardLine(play, none())).toEqual({ kind: 'thinking', what: '✨ Thinking', thinking: true })
  })
  it('puts organising the board first, with what was heard', () => {
    const play = new Play()
    play.bubbles[0].pending = true
    expect(boardLine(play, { captions: new Map(), organising: { heard: '', thinking: false } })).toEqual({ kind: 'organise', what: '🙌 Organise the board', heard: 'listening…' })
    expect(boardLine(play, { captions: new Map(), organising: { heard: 'by effort', thinking: true } })).toEqual({ kind: 'organise', what: '✨ Organising the board', heard: '“by effort”', thinking: true })
  })
})

describe('the band at the top', () => {
  const idea: StageLine = { kind: 'idea', what: '💡 New idea', heard: '“a picnic”' }
  const thinking: StageLine = { kind: 'thinking', what: '✨ Thinking', thinking: true }
  const busy = (line: StageLine) => new Map([[1, line]])

  it('stays empty while the hand is still at it, and takes the words once the idea is placed', () => {
    const band = new Band()
    expect(band.update(busy(idea), undefined, 0, 8)).toBeUndefined()
    expect(band.update(new Map(), thinking, 100, 9)).toEqual({ ...idea, thinking: true })
    expect(band.update(new Map(), undefined, 200, 9)).toEqual({ ...idea, thinking: false })
  })
  it('lets the finished action go after a moment, and says Thinking if the wait goes on', () => {
    const band = new Band()
    band.update(busy(idea), undefined, 0, 8)
    band.update(new Map(), thinking, 100, 9)
    expect(band.update(new Map(), thinking, 100 + BAND_MS, 9)).toEqual(thinking)
    expect(band.update(new Map(), undefined, 200 + BAND_MS, 9)).toBeUndefined()
  })
  it('does not announce an idea that was cancelled, a move or a resize', () => {
    const band = new Band()
    band.update(busy(idea), undefined, 0, 8)
    expect(band.update(new Map(), undefined, 100, 8)).toBeUndefined()
    band.update(busy({ kind: 'move', what: '✊ Move' }), undefined, 200, 8)
    expect(band.update(new Map(), undefined, 300, 8)).toBeUndefined()
    band.update(busy({ kind: 'resize', what: '✊✊ Resize' }), undefined, 400, 8)
    expect(band.update(new Map(), undefined, 500, 8)).toBeUndefined()
  })
  it('announces a merge, a connection and an ask without a new bubble', () => {
    for (const line of [{ kind: 'merge', what: '✊ Merge into “Long walk”' }, { kind: 'connect', what: '🔗 Connect to “Long walk”' }, { kind: 'ask', what: '✌️ Ask for ideas', heard: 'listening…' }] as StageLine[]) {
      const band = new Band()
      band.update(busy(line), undefined, 0, 8)
      expect(band.update(new Map(), undefined, 100, 7)).toMatchObject({ what: line.what.replace('Merge into', 'Merged into').replace('Connect to', 'Connected to'), heard: line.kind === 'ask' ? '' : undefined })
      expect(band.update(new Map(), undefined, 100, 7)?.what).not.toMatch(/Merge into|Connect to/)
    }
  })
  it('announces one hand finishing while the other is still busy', () => {
    const band = new Band()
    band.update(new Map([[1, idea], [2, { kind: 'move', what: '✊ Move' } as StageLine]]), undefined, 0, 8)
    expect(band.update(new Map([[2, { kind: 'move', what: '✊ Move' } as StageLine]]), undefined, 100, 9)).toMatchObject({ what: '💡 New idea' })
  })
  it('does not say Thinking while a victory sign is still held, only once it is lowered', () => {
    const band = new Band()
    const ask: StageLine = { kind: 'ask', what: '✌️ Ask for ideas from all 4', heard: '“risks”' }
    expect(band.update(busy(ask), thinking, 0, 10)).toBeUndefined()
    expect(band.update(new Map(), thinking, 100, 10)).toEqual({ ...ask, thinking: true })
  })
  it('shows organising the board at once, over anything else', () => {
    const band = new Band()
    const organise: StageLine = { kind: 'organise', what: '🙌 Organise the board', heard: 'listening…' }
    band.update(busy(idea), undefined, 0, 8)
    band.update(new Map(), undefined, 100, 9)
    expect(band.update(new Map(), organise, 200, 9)).toEqual(organise)
  })
})
