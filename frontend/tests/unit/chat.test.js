import { describe, it, expect } from 'vitest'
import { CHAT_MAX, clientIdsOf, createChatLog, recentLines } from '../../src/room/chat.js'

const message = (text, at, conn = 'a') => ({
  type: 'chat',
  conn,
  name: conn,
  colour: '#fff',
  guest: false,
  text,
  at,
})

describe('chat log', () => {
  it('keeps the last `limit` messages', () => {
    const log = createChatLog({ limit: 2 })
    log.add(message('one', 1))
    log.add(message('two', 2))
    log.add(message('three', 3))
    expect(log.messages.map((m) => m.text)).toEqual(['two', 'three'])
  })

  it("keeps the server's order, not the messages' clocks", () => {
    const log = createChatLog()
    log.add(message('first', 500))
    log.add(message('second', 100))
    expect(log.messages.map((m) => m.text)).toEqual(['first', 'second'])
  })

  it('a hundred by default', () => {
    const log = createChatLog()
    for (let i = 0; i < 150; i++) log.add(message(String(i), i))
    expect(log.messages).toHaveLength(100)
    expect(log.messages[0].text).toBe('50')
  })

  it('hands out a copy: the caller cannot rewrite it', () => {
    const log = createChatLog()
    log.add(message('kept', 1))
    log.messages.pop()
    expect(log.messages).toHaveLength(1)
  })

  it('tells listeners about each message', () => {
    const log = createChatLog()
    const seen = []
    log.onAdd((m) => seen.push(m.text))
    log.add(message('hi', 1))
    expect(seen).toEqual(['hi'])
  })
})

describe('chat helpers', () => {
  it('the cap matches the server', () => {
    expect(CHAT_MAX).toBe(500)
  })

  it("a sender's avatars are their roster entry's client ids", () => {
    const roster = [
      { conn: 'a', clientIds: [3, 4] },
      { conn: 'b', clientIds: [9] },
    ]
    expect(clientIdsOf('a', roster)).toEqual([3, 4])
    expect(clientIdsOf('gone', roster)).toEqual([])
  })

  it('the feed shows lines younger than its window, newest last, at most `max`', () => {
    const log = [message('old', 1000), message('a', 9000), message('b', 9500), message('c', 9900)]
    const arrived = new Map([
      [log[0], 1000],
      [log[1], 9000],
      [log[2], 9500],
      [log[3], 9900],
    ])
    const lines = recentLines(log, { now: 10_000, window: 8000, max: 2, arrivedAt: (m) => arrived.get(m) })
    expect(lines.map((m) => m.text)).toEqual(['b', 'c'])
  })
})
