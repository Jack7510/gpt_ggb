import { describe, expect, it } from 'vitest'

import { createMemoryDatabase } from '../src/persistence/indexeddb.js'
import { createMemoryArtifactStore, assertArtifactPath, canvasArtifactPath } from '../src/persistence/opfs-artifacts.js'
import { SessionCoordinator, parseSessionChangeEvent } from '../src/sessions/session-coordinator.js'
import { SessionRepository, type LocalMessage } from '../src/sessions/session-repository.js'
import { DEFAULT_SESSION_TITLE, SessionService } from '../src/sessions/session-service.js'

const AT = '2026-09-19T00:00:00.000Z'

function repository(): SessionRepository {
  return new SessionRepository(createMemoryDatabase())
}

function message(sessionId: string, sequence: number, content: string, role: LocalMessage['role'] = 'user'): LocalMessage {
  return {
    messageId: `${sessionId}-m${sequence}`,
    sessionId,
    role,
    content,
    createdAt: AT,
    runId: null,
    deliveryState: 'complete',
    sequence,
  }
}

describe('local session isolation (§14.1)', () => {
  it('preserves final-report context markers through local storage', async () => {
    const repo = repository()
    let id = 0
    const service = new SessionService({ repository: repo, tokens: { reveal: async () => 'token' },
      runs: { stop: async () => undefined }, now: () => AT, newId: () => `id-${++id}` })
    const session = await service.createSession()
    await service.appendMessage({ sessionId: session.sessionId, role: 'final_report', content: '## Completed',
      runId: 'r1', sourceEventId: 3, contextKind: 'final_report' })
    expect((await repo.listMessages(session.sessionId))[0]).toMatchObject({ contextKind: 'final_report', sourceEventId: 3 })
  })

  it('names a default session from the first input but preserves a manual title', async () => {
    const repo = repository()
    const service = new SessionService({
      repository: repo,
      tokens: { reveal: async () => 'token' },
      runs: { stop: async () => undefined },
      now: () => AT,
      newId: () => '00000000-0000-4000-8000-0000000000fe',
    })
    const session = await service.createSession()
    expect(session.title).toBe(DEFAULT_SESSION_TITLE)
    expect(await service.applySuggestedTitle(session.sessionId, '  作一个半径为 3 的圆\n')).toBe(true)
    expect((await repo.getSession(session.sessionId))?.title).toBe('作一个半径为 3 的圆')

    await service.renameSession(session.sessionId, '我的圆')
    expect(await service.applySuggestedTitle(session.sessionId, '另一个任务')).toBe(false)
    expect((await repo.getSession(session.sessionId))?.title).toBe('我的圆')
  })

  it('keeps titles, messages, canvas and run bindings separate per session', async () => {
    const repo = repository()
    await repo.createSession({
      sessionId: 's1',
      title: 'first',
      createdAt: AT,
      updatedAt: AT,
      activeCanvasVersion: null,
      lastOpenedMessageId: null,
    })
    await repo.createSession({
      sessionId: 's2',
      title: 'second',
      createdAt: AT,
      updatedAt: AT,
      activeCanvasVersion: null,
      lastOpenedMessageId: null,
    })
    await repo.appendMessage(message('s1', 1, 'triangle'))
    await repo.appendMessage(message('s2', 1, 'circle'))
    await repo.putCanvasBinding({
      sessionId: 's1',
      canvasVersion: 'v1',
      opfsPath: canvasArtifactPath('s1', 'v1'),
      contentDigest: 'a'.repeat(64),
      updatedAt: AT,
    })
    await repo.putRunBinding({
      runId: 'run_00000000-0000-4000-8000-000000000001',
      sessionId: 's1',
      userMessageId: 's1-m1',
      assistantMessageId: null,
      runTokenCiphertext: 'v1.sealed',
      eventCursor: 0,
      status: 'accepted',
      createdAt: AT,
      expiresAt: AT,
    })

    expect((await repo.listMessages('s1')).map((entry) => entry.content)).toEqual(['triangle'])
    expect((await repo.listMessages('s2')).map((entry) => entry.content)).toEqual(['circle'])
    expect(await repo.getCanvasBinding('s2')).toBeNull()
    expect(await repo.listRunBindings('s2')).toEqual([])
  })

  it('keeps sidebar order by creation time after Session updates', async () => {
    const repo = repository()
    await repo.createSession({
      sessionId: 'first',
      title: 'first',
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: AT,
      activeCanvasVersion: null,
      lastOpenedMessageId: null,
    })
    await repo.createSession({
      sessionId: 'later',
      title: 'later',
      createdAt: '2026-09-19T00:01:00.000Z',
      updatedAt: AT,
      activeCanvasVersion: null,
      lastOpenedMessageId: null,
    })

    // Opening, sending messages, and saving a canvas all update `updatedAt`.
    await repo.updateSession('first', { updatedAt: '2026-09-20T00:00:00.000Z' })
    await repo.updateSession('later', { updatedAt: '2026-09-21T00:00:00.000Z' })

    expect((await repo.listSessions()).map(session => session.sessionId)).toEqual(['first', 'later'])
  })

  it('orders messages by sequence even when timestamps tie', async () => {
    const repo = repository()
    await repo.createSession({
      sessionId: 's1',
      title: 't',
      createdAt: AT,
      updatedAt: AT,
      activeCanvasVersion: null,
      lastOpenedMessageId: null,
    })
    await repo.appendMessage(message('s1', 2, 'second'))
    await repo.appendMessage(message('s1', 1, 'first'))
    expect((await repo.listMessages('s1')).map((entry) => entry.content)).toEqual(['first', 'second'])
    expect(await repo.nextMessageSequence('s1')).toBe(3)
  })

  it('deduplicates a Server-event projection within one run, not across a Session’s later runs', async () => {
    const repo = repository()
    await repo.createSession({ sessionId: 's1', title: 't', createdAt: AT, updatedAt: AT, activeCanvasVersion: null, lastOpenedMessageId: null })
    await repo.appendMessage({
      ...message('s1', 1, '第一次：已规划构图', 'final_report'),
      runId: 'run_00000000-0000-4000-8000-000000000001',
      sourceEventId: 1,
    })
    expect((await repo.findMessageBySourceEvent('s1', 'run_00000000-0000-4000-8000-000000000001', 1))?.content)
      .toBe('第一次：已规划构图')
    expect(await repo.findMessageBySourceEvent('s1', 'run_00000000-0000-4000-8000-000000000001', 2)).toBeNull()
    expect(await repo.findMessageBySourceEvent('s1', 'run_00000000-0000-4000-8000-000000000002', 1)).toBeNull()
  })

  it('deletes only local rows, leaving other sessions untouched', async () => {
    const repo = repository()
    for (const sessionId of ['s1', 's2']) {
      await repo.createSession({
        sessionId,
        title: sessionId,
        createdAt: AT,
        updatedAt: AT,
        activeCanvasVersion: null,
        lastOpenedMessageId: null,
      })
      await repo.appendMessage(message(sessionId, 1, sessionId))
    }
    await repo.deleteSession('s1')
    expect(await repo.getSession('s1')).toBeNull()
    expect(await repo.listMessages('s1')).toEqual([])
    expect((await repo.listMessages('s2')).length).toBe(1)
  })

  it('survives reopening the database with the same records', async () => {
    const db = createMemoryDatabase()
    const first = new SessionRepository(db)
    await first.createSession({
      sessionId: 's1',
      title: 'kept',
      createdAt: AT,
      updatedAt: AT,
      activeCanvasVersion: null,
      lastOpenedMessageId: null,
    })
    const reopened = new SessionRepository(db)
    expect((await reopened.getSession('s1'))?.title).toBe('kept')
  })
})

describe('session service (§14.1)', () => {
  it('stops every run of a deleted session best-effort and still clears local data', async () => {
    const repo = repository()
    const stopped: string[] = []
    const service = new SessionService({
      repository: repo,
      tokens: { reveal: async () => 'token' },
      runs: {
        stop: async (runId) => {
          stopped.push(runId)
          if (runId.endsWith('2')) throw new Error('server_unreachable')
        },
      },
      now: () => AT,
      newId: () => '00000000-0000-4000-8000-0000000000ff',
    })
    const session = await service.createSession()
    for (const suffix of ['1', '2']) {
      await repo.putRunBinding({
        runId: `run_00000000-0000-4000-8000-00000000000${suffix}`,
        sessionId: session.sessionId,
        userMessageId: 'm1',
        assistantMessageId: null,
        runTokenCiphertext: 'v1.sealed',
        eventCursor: 0,
        status: 'accepted',
        createdAt: AT,
        expiresAt: AT,
      })
    }

    await service.deleteSession(session.sessionId)

    expect(stopped).toHaveLength(2)
    expect(await repo.getSession(session.sessionId)).toBeNull()
    expect(await repo.listRunBindings(session.sessionId)).toEqual([])
  })

  it('never forwards a sessionId to the remote stop port', async () => {
    const repo = repository()
    const seen: unknown[] = []
    const service = new SessionService({
      repository: repo,
      tokens: { reveal: async () => 'token' },
      runs: {
        stop: async (...args: unknown[]) => {
          seen.push(args)
        },
      },
      now: () => AT,
      newId: () => '00000000-0000-4000-8000-0000000000fe',
    })
    const session = await service.createSession()
    await repo.putRunBinding({
      runId: 'run_00000000-0000-4000-8000-000000000003',
      sessionId: session.sessionId,
      userMessageId: 'm1',
      assistantMessageId: null,
      runTokenCiphertext: 'v1.sealed',
      eventCursor: 0,
      status: 'accepted',
      createdAt: AT,
      expiresAt: AT,
    })
    await service.deleteSession(session.sessionId)
    expect(seen).toEqual([['run_00000000-0000-4000-8000-000000000003', 'token']])
  })
})

describe('artifact paths (§3.2)', () => {
  it('rejects traversal and separator abuse', () => {
    expect(() => assertArtifactPath('../secrets')).toThrow('artifact_path_invalid')
    expect(() => assertArtifactPath('a/../../b')).toThrow('artifact_path_invalid')
    expect(() => assertArtifactPath('')).toThrow('artifact_path_invalid')
  })

  it('stores and reads one canvas copy per version', async () => {
    const store = createMemoryArtifactStore()
    const path = canvasArtifactPath('s1', 'v1')
    await store.put(path, new Uint8Array([1, 2, 3]))
    expect(Array.from((await store.get(path)) ?? [])).toEqual([1, 2, 3])
    await store.clear()
    expect(await store.get(path)).toBeNull()
  })
})

describe('multi-tab coordination (§14.1)', () => {
  function lockManager(held: Set<string>): {
    request<T>(name: string, options: unknown, callback: (lock: unknown) => Promise<T>): Promise<T>
  } {
    return {
      request: async <T>(name: string, _options: unknown, callback: (lock: unknown) => Promise<T>): Promise<T> => {
        // A real Web Lock hands `null` to `ifAvailable` requests when the lock
        // is already held by another tab.
        if (held.has(name)) return callback(null) as Promise<T>
        held.add(name)
        try {
          return await callback({ name })
        } finally {
          held.delete(name)
        }
      },
    }
  }

  function coordinator(held: Set<string>): SessionCoordinator {
    return new SessionCoordinator({
      locks: lockManager(held),
      createChannel: () => ({
        postMessage: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        close: () => undefined,
      }),
      now: () => AT,
    })
  }

  it('refuses a second tab writing the same session', async () => {
    const held = new Set<string>()
    const first = coordinator(held)
    const second = coordinator(held)
    const a = await first.withWriterLock('s1', async () => {
      // While the first tab works, the second must be denied.
      const denied = await second.withWriterLock('s1', async () => 'b')
      expect(denied).toBeNull()
      return 'a'
    })
    expect(a).toBe('a')
    // Released after the first tab finishes.
    expect(await second.withWriterLock('s1', async () => 'b')).toBe('b')
  })

  it('ignores malformed change events', () => {
    expect(parseSessionChangeEvent({ kind: 'nope', sessionId: 's1' })).toBeNull()
    expect(parseSessionChangeEvent(null)).toBeNull()
    expect(parseSessionChangeEvent({ kind: 'messages_changed', sessionId: 's1', at: AT })).toEqual({
      kind: 'messages_changed',
      sessionId: 's1',
      at: AT,
    })
  })
})
