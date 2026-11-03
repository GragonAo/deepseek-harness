import { describe, expect, it, vi } from 'vitest'
import { FrameQueue, MAX_BUFFERED_FRAMES } from '../src/api-proxy.ts'

describe('FrameQueue', () => {
  it('delivers pushed frames in order until the queue ends', async () => {
    const queue = new FrameQueue<number>(() => { throw new Error('overflow is not this test\'s subject') })
    queue.push(1)
    queue.push(2)
    const iterator = queue.iterate(new AbortController().signal, () => {})
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false })
    queue.end()
    await expect(iterator.next()).resolves.toEqual({ value: 2, done: false })
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })

  it('stops serving a subscriber that fell MAX_BUFFERED_FRAMES behind, dropping its backlog', async () => {
    const onOverflow = vi.fn()
    const queue = new FrameQueue<number>(onOverflow)
    for (let index = 0; index < MAX_BUFFERED_FRAMES; index += 1) queue.push(index)
    const iterator = queue.iterate(new AbortController().signal, () => {})
    queue.push(-1)
    expect(onOverflow).toHaveBeenCalledTimes(1)
    // The backlog is released as the subscription ends: the reader starts over from
    // a fresh baseline instead of receiving 20k frames it did not ask for.
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    queue.push(-2)
    expect(onOverflow).toHaveBeenCalledTimes(1)
  })
})
