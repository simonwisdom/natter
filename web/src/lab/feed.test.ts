import { describe, expect, it } from 'vitest'
import { Feed, feedLine } from './feed'

describe('the log panel', () => {
  it('says what was heard, what the LLM wrote and how long it took', () => {
    expect(feedLine('final', { text: 'Camera' })).toBe('🎙️ Heard “Camera”')
    expect(feedLine('final', { text: '', skipped: 'Yeah.' })).toBe('🎙️ Skipped “Yeah.”')
    expect(feedLine('final', { text: '' })).toBe('🎙️ Heard nothing')
    expect(feedLine('idea', { text: 'Camera', emoji: '📷', backend: 'claude_code', ms: 974 })).toBe('✨ LLM → 📷 Camera · 1.0 s')
    expect(feedLine('idea', { text: 'Camera', emoji: '', backend: 'ollama', ms: 2230 })).toBe('✨ Local model → Camera · 2.2 s')
    expect(feedLine('ideas', { ideas: [{ text: 'Morning stretches' }, { text: 'Walk to somewhere' }], ms: 1439 })).toBe('✨ LLM → Morning stretches / Walk to somewhere · 1.4 s')
    expect(feedLine('structure', { kind: 'zones', zones: ['Browser', 'This Mac', 'Cloud'] })).toBe('✨ LLM → zones: Browser, This Mac, Cloud')
  })

  it('says what the hands did', () => {
    expect(feedLine('merge', { text: 'Hello', into: 'Dogs and cats' })).toBe('✊ Merged “Hello” into “Dogs and cats”')
    expect(feedLine('connect', { a: 'Reward timing', b: 'System One models' })).toBe('☝️ Connected “Reward timing” and “System One models”')
    expect(feedLine('bin', { text: 'Camera', mode: 'delete' })).toBe('🔥 Burned “Camera”')
    expect(feedLine('ask', { text: 'Hand tracking' })).toBe('✌️ Asked about “Hand tracking”')
  })

  it('leaves out hand readings, moves and a branch that became a connection', () => {
    for (const type of ['raw', 'gesture', 'grab', 'drop', 'stats', 'handLost', 'turnMics', 'branchEnd']) expect(feedLine(type, {})).toBeUndefined()
    expect(feedLine('ideaAbandoned', { why: 'connected instead' })).toBeUndefined()
  })

  it('keeps the last few lines with the time each happened', () => {
    const feed = new Feed(2)
    feed.add('final', { text: 'One' }, 5_000)
    feed.add('gesture', {}, 6_000)
    feed.add('final', { text: 'Two' }, 61_000)
    feed.add('final', { text: 'Three' }, 125_400)
    expect(feed.rows).toEqual([{ at: '1:01', text: '🎙️ Heard “Two”' }, { at: '2:05', text: '🎙️ Heard “Three”' }])
    expect(feed.version).toBe(3)
  })
})
