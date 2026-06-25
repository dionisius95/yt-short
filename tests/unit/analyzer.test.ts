/**
 * Unit tests for the Analyzer class.
 * Validates Requirements 3.1, 3.2, 3.3
 *
 * Analyzer uses require('http').request internally (Node http, not fetch).
 * We intercept it via vi.mock('http') with a controllable spy.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { Transcript, AppError } from '../../shared/types'

// ---------------------------------------------------------------------------
// Shared spy — must be declared before vi.mock factory runs
// ---------------------------------------------------------------------------

const requestSpy = vi.fn()

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

// Import Analyzer AFTER mocks are set up
import { Analyzer, _setHttpRequest } from '../../electron/pipeline/Analyzer'

// ---------------------------------------------------------------------------
// Helper — build a fake req/res pair and queue it on requestSpy
// ---------------------------------------------------------------------------

function queueHttpResponse(responseBody: string, statusCode = 200) {
  const res = Object.assign(new EventEmitter(), { statusCode })

  const req = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
    setTimeout: vi.fn(),
    destroy: vi.fn(),
  })

  requestSpy.mockImplementationOnce((_opts: unknown, cb: unknown) => {
    setImmediate(() => {
      ;(cb as (r: typeof res) => void)(res)
      setImmediate(() => {
        res.emit('data', Buffer.from(responseBody))
        res.emit('end')
      })
    })
    return req
  })

  return { req, res }
}

function queueHttpError(message = 'ECONNREFUSED') {
  const req = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
    setTimeout: vi.fn(),
    destroy: vi.fn(),
  })

  requestSpy.mockImplementationOnce(() => {
    setImmediate(() => {
      req.emit('error', Object.assign(new Error(message), { code: message }))
    })
    return req
  })

  return req
}

function ollamaBody(text: string) {
  return JSON.stringify({ response: text, done: true })
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const VALID_HOOKS_JSON =
  '[{"startMs":1000,"endMs":30000,"viralScore":85,"summary":"Great moment"},' +
  '{"startMs":60000,"endMs":90000,"viralScore":72,"summary":"Another hook"},' +
  '{"startMs":120000,"endMs":150000,"viralScore":65,"summary":"Third hook"}]'

const sampleTranscript: Transcript = {
  projectId: 'proj-123',
  language: 'en',
  words: [
    { word: 'Hello', startMs: 0, endMs: 500, confidence: 0.95 },
    { word: 'world', startMs: 500, endMs: 1000, confidence: 0.9 },
  ],
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Analyzer.detectHooks', () => {
  let analyzer: Analyzer

  beforeEach(() => {
    analyzer = new Analyzer()
    requestSpy.mockReset()
    // Inject spy as http.request so Analyzer doesn't hit real Ollama
    _setHttpRequest(requestSpy as unknown as typeof import('http').request)
  })

  // Reset after all tests
  afterEach(() => {
    _setHttpRequest(null)
  })

  // -------------------------------------------------------------------------
  // 1. Default model name
  // -------------------------------------------------------------------------

  describe('default model name', () => {
    it('uses "llama3" as the default model when no modelName is provided', async () => {
      let capturedBody = ''
      const res = Object.assign(new EventEmitter(), { statusCode: 200 })
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn((chunk: string) => { capturedBody += chunk }),
        end: vi.fn(),
        setTimeout: vi.fn(),
        destroy: vi.fn(),
      })

      requestSpy.mockImplementationOnce((_opts: unknown, cb: unknown) => {
        setImmediate(() => {
          ;(cb as (r: typeof res) => void)(res)
          setImmediate(() => {
            res.emit('data', Buffer.from(ollamaBody(VALID_HOOKS_JSON)))
            res.emit('end')
          })
        })
        return req
      })

      await analyzer.detectHooks('proj-123', sampleTranscript)

      const body = JSON.parse(capturedBody)
      expect(body.model).toBe('llama3')
    })

    it('uses the provided modelName when explicitly specified', async () => {
      let capturedBody = ''
      const res = Object.assign(new EventEmitter(), { statusCode: 200 })
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn((chunk: string) => { capturedBody += chunk }),
        end: vi.fn(),
        setTimeout: vi.fn(),
        destroy: vi.fn(),
      })

      requestSpy.mockImplementationOnce((_opts: unknown, cb: unknown) => {
        setImmediate(() => {
          ;(cb as (r: typeof res) => void)(res)
          setImmediate(() => {
            res.emit('data', Buffer.from(ollamaBody(VALID_HOOKS_JSON)))
            res.emit('end')
          })
        })
        return req
      })

      await analyzer.detectHooks('proj-123', sampleTranscript, 'mistral')

      const body = JSON.parse(capturedBody)
      expect(body.model).toBe('mistral')
    })
  })

  // -------------------------------------------------------------------------
  // 2. Retry on JSON parse failure
  // -------------------------------------------------------------------------

  describe('retry on JSON parse failure', () => {
    it('retries up to 2 times (3 total attempts) when Ollama returns invalid JSON', async () => {
      queueHttpResponse(ollamaBody('not valid json'))
      queueHttpResponse(ollamaBody('not valid json'))
      queueHttpResponse(ollamaBody('not valid json'))

      let thrown: unknown
      try {
        await analyzer.detectHooks('proj-123', sampleTranscript)
      } catch (err) {
        thrown = err
      }

      expect((thrown as AppError).code).toBe('INSUFFICIENT_HOOKS')
      expect(requestSpy).toHaveBeenCalledTimes(3)
    })

    it('throws AppError with code INSUFFICIENT_HOOKS after all retries are exhausted', async () => {
      queueHttpResponse(ollamaBody('not json'))
      queueHttpResponse(ollamaBody('not json'))
      queueHttpResponse(ollamaBody('not json'))

      let thrown: unknown
      try {
        await analyzer.detectHooks('proj-123', sampleTranscript)
      } catch (err) {
        thrown = err
      }

      expect((thrown as AppError).code).toBe('INSUFFICIENT_HOOKS')
      expect((thrown as AppError).message).toMatch(/3 attempts/)
    })

    it('succeeds on the second attempt when the first returns invalid JSON', async () => {
      queueHttpResponse(ollamaBody('not json'))
      queueHttpResponse(ollamaBody(VALID_HOOKS_JSON))

      const hooks = await analyzer.detectHooks('proj-123', sampleTranscript)

      expect(requestSpy).toHaveBeenCalledTimes(2)
      expect(hooks).toHaveLength(3)
    })
  })

  // -------------------------------------------------------------------------
  // 3. OllamaUnavailableError
  // -------------------------------------------------------------------------

  describe('OllamaUnavailableError', () => {
    it('throws AppError with code OLLAMA_UNAVAILABLE when http request emits error', async () => {
      queueHttpError('ECONNREFUSED')

      let thrown: unknown
      try {
        await analyzer.detectHooks('proj-123', sampleTranscript)
      } catch (err) {
        thrown = err
      }

      expect((thrown as AppError).code).toBe('OLLAMA_UNAVAILABLE')
    })

    it('includes the original error message in the details field', async () => {
      queueHttpError('ECONNREFUSED')

      let thrown: unknown
      try {
        await analyzer.detectHooks('proj-123', sampleTranscript)
      } catch (err) {
        thrown = err
      }

      expect((thrown as AppError).details).toMatch(/ECONNREFUSED/)
    })

    it('throws AppError with code OLLAMA_UNAVAILABLE when Ollama returns non-200 status', async () => {
      queueHttpResponse('Service Unavailable', 503)

      let thrown: unknown
      try {
        await analyzer.detectHooks('proj-123', sampleTranscript)
      } catch (err) {
        thrown = err
      }

      expect((thrown as AppError).code).toBe('OLLAMA_UNAVAILABLE')
    })
  })

  // -------------------------------------------------------------------------
  // 4. Successful hook detection
  // -------------------------------------------------------------------------

  describe('successful hook detection', () => {
    it('returns parsed hooks when Ollama returns a valid JSON array with 3+ hooks', async () => {
      queueHttpResponse(ollamaBody(VALID_HOOKS_JSON))

      const hooks = await analyzer.detectHooks('proj-123', sampleTranscript)

      expect(hooks).toHaveLength(3)
    })

    it('assigns the correct projectId to each returned hook', async () => {
      queueHttpResponse(ollamaBody(VALID_HOOKS_JSON))

      const hooks = await analyzer.detectHooks('proj-123', sampleTranscript)

      for (const hook of hooks) {
        expect(hook.projectId).toBe('proj-123')
      }
    })

    it('returns hooks with the correct shape', async () => {
      queueHttpResponse(ollamaBody(VALID_HOOKS_JSON))

      const hooks = await analyzer.detectHooks('proj-123', sampleTranscript)

      expect(hooks[0]).toMatchObject({
        startMs: 1000,
        endMs: 30000,
        viralScore: 85,
        summary: 'Great moment',
        dismissed: false,
      })
      expect(typeof hooks[0].id).toBe('string')
      expect(hooks[0].id.length).toBeGreaterThan(0)
    })

    it('calls http.request exactly once when the first response is valid', async () => {
      queueHttpResponse(ollamaBody(VALID_HOOKS_JSON))

      await analyzer.detectHooks('proj-123', sampleTranscript)

      expect(requestSpy).toHaveBeenCalledTimes(1)
    })

    it('strips markdown code fences from the Ollama response before parsing', async () => {
      const fenced = '```json\n' + VALID_HOOKS_JSON + '\n```'
      queueHttpResponse(ollamaBody(fenced))

      const hooks = await analyzer.detectHooks('proj-123', sampleTranscript)

      expect(hooks).toHaveLength(3)
    })
  })
})
