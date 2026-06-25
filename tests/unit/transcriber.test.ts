/**
 * Unit tests for the Transcriber class.
 * Validates Requirements 2.1, 2.2
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

vi.mock('child_process')
vi.mock('fs')

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { spawn } from 'child_process'
import fs from 'fs'
import { Transcriber } from '../../electron/pipeline/Transcriber'
import { CHANNELS } from '../../electron/ipc/channels'
import { BrowserWindow } from 'electron'

const mockSpawn = vi.mocked(spawn)
const mockFs = vi.mocked(fs)
const mockGetAllWindows = vi.mocked(BrowserWindow.getAllWindows)

// ---------------------------------------------------------------------------
// Helper: create a fake child process
// ---------------------------------------------------------------------------

interface MockProcessOptions {
  stdout?: string
  stderr?: string
  exitCode?: number
}

function createMockProcess(options: MockProcessOptions = {}) {
  const { stdout = '', stderr = '', exitCode = 0 } = options

  const stdoutEmitter = new EventEmitter()
  const stderrEmitter = new EventEmitter()
  const procEmitter = new EventEmitter()

  const proc = Object.assign(procEmitter, {
    stdout: stdoutEmitter,
    stderr: stderrEmitter,
  })

  // Schedule emissions asynchronously so listeners can be attached first
  setImmediate(() => {
    if (stdout) {
      stdoutEmitter.emit('data', Buffer.from(stdout))
    }
    if (stderr) {
      stderrEmitter.emit('data', Buffer.from(stderr))
    }
    procEmitter.emit('close', exitCode)
  })

  return proc
}

// ---------------------------------------------------------------------------
// Valid Whisper JSON fixture
// ---------------------------------------------------------------------------

const VALID_WHISPER_JSON = JSON.stringify({
  segments: [
    {
      words: [
        { word: ' Hello', start: 0.0, end: 0.5, probability: 0.95 },
        { word: ' world', start: 0.5, end: 1.0, probability: 0.88 },
      ],
    },
  ],
})

const EMPTY_WHISPER_JSON = JSON.stringify({ segments: [] })

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()

  // Default: fs.existsSync returns true, readFileSync returns valid JSON
  mockFs.existsSync = vi.fn().mockReturnValue(true)
  mockFs.readFileSync = vi.fn().mockReturnValue(VALID_WHISPER_JSON)
  mockFs.unlinkSync = vi.fn()

  // Default: spawn returns a successful process
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(mockSpawn as any).mockImplementation(() => createMockProcess())

  // Default: no open windows
  mockGetAllWindows.mockReturnValue([])
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Transcriber', () => {
  let transcriber: Transcriber

  beforeEach(() => {
    transcriber = new Transcriber()
  })

  // -------------------------------------------------------------------------
  // 1. Model size path mapping
  // -------------------------------------------------------------------------

  describe('model size path mapping', () => {
    const modelSizes = ['tiny', 'base', 'small', 'medium', 'large'] as const

    for (const size of modelSizes) {
      it(`maps model size "${size}" to models/ggml-${size}.bin in whisper-cli args`, async () => {
        await transcriber.transcribe('proj-1', 'audio.wav', 'en', size)

        // Find the whisper-cli spawn call (not ffmpeg)
        const whisperCall = mockSpawn.mock.calls.find(
          ([cmd]) => cmd === 'whisper-cli',
        )
        expect(whisperCall).toBeDefined()

        const args = whisperCall![1] as string[]
        const modelIndex = args.indexOf('--model')
        expect(modelIndex).toBeGreaterThanOrEqual(0)
        // Path ends with ggml-{size}.bin — actual dir depends on os.homedir()
        expect(args[modelIndex + 1]).toContain(`ggml-${size}.bin`)
      })
    }
  })

  // -------------------------------------------------------------------------
  // 2. Empty audio detection
  // -------------------------------------------------------------------------

  describe('empty audio detection', () => {
    it('returns a Transcript with an empty words array when parseWhisperOutput returns no words', async () => {
      mockFs.readFileSync = vi.fn().mockReturnValue(EMPTY_WHISPER_JSON)

      const transcript = await transcriber.transcribe('proj-2', 'audio.wav', 'en', 'base')

      expect(transcript.words).toEqual([])
    })

    it('returns a Transcript with words when Whisper JSON contains word entries', async () => {
      const transcript = await transcriber.transcribe('proj-3', 'audio.wav', 'en', 'base')

      expect(transcript.words.length).toBeGreaterThan(0)
    })

    it('sets projectId and language on the returned Transcript', async () => {
      const transcript = await transcriber.transcribe('proj-4', 'audio.wav', 'fr', 'small')

      expect(transcript.projectId).toBe('proj-4')
      expect(transcript.language).toBe('fr')
    })
  })

  // -------------------------------------------------------------------------
  // 3. Progress events
  // -------------------------------------------------------------------------

  describe('progress events', () => {
    it('calls webContents.send with TRANSCRIBE_PROGRESS channel when stderr contains "progress = 50"', async () => {
      const mockSend = vi.fn()
      const mockWindow = {
        isDestroyed: vi.fn().mockReturnValue(false),
        webContents: { send: mockSend },
      }
      mockGetAllWindows.mockReturnValue([mockWindow as unknown as Electron.BrowserWindow])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(mockSpawn as any).mockImplementation(() =>
        createMockProcess({
          stderr: 'whisper_print_progress_callback: progress = 50 %',
        }),
      )

      await transcriber.transcribe('proj-5', 'audio.wav', 'en', 'base')

      const progressCalls = mockSend.mock.calls.filter(
        ([channel]) => channel === CHANNELS.TRANSCRIBE_PROGRESS,
      )
      expect(progressCalls.length).toBeGreaterThan(0)
    })

    it('does not send progress to destroyed windows', async () => {
      const mockSend = vi.fn()
      const mockWindow = {
        isDestroyed: vi.fn().mockReturnValue(true),
        webContents: { send: mockSend },
      }
      mockGetAllWindows.mockReturnValue([mockWindow as unknown as Electron.BrowserWindow])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(mockSpawn as any).mockImplementation(() =>
        createMockProcess({
          stderr: 'progress = 75 %',
        }),
      )

      await transcriber.transcribe('proj-6', 'audio.wav', 'en', 'base')

      expect(mockSend).not.toHaveBeenCalled()
    })

    it('emits progress events at start (0%) and end (100%) of transcription', async () => {
      const mockSend = vi.fn()
      const mockWindow = {
        isDestroyed: vi.fn().mockReturnValue(false),
        webContents: { send: mockSend },
      }
      mockGetAllWindows.mockReturnValue([mockWindow as unknown as Electron.BrowserWindow])

      await transcriber.transcribe('proj-7', 'audio.wav', 'en', 'base')

      const progressPayloads = mockSend.mock.calls
        .filter(([channel]) => channel === CHANNELS.TRANSCRIBE_PROGRESS)
        .map(([, payload]) => (payload as { percent: number }).percent)

      expect(progressPayloads).toContain(0)
      expect(progressPayloads).toContain(100)
    })

    it('maps whisper stderr progress = 50 to a value in the 20–95 range', async () => {
      const mockSend = vi.fn()
      const mockWindow = {
        isDestroyed: vi.fn().mockReturnValue(false),
        webContents: { send: mockSend },
      }
      mockGetAllWindows.mockReturnValue([mockWindow as unknown as Electron.BrowserWindow])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(mockSpawn as any).mockImplementation(() =>
        createMockProcess({
          stderr: 'progress = 50 %',
        }),
      )

      await transcriber.transcribe('proj-8', 'audio.wav', 'en', 'base')

      const progressPayloads = mockSend.mock.calls
        .filter(([channel]) => channel === CHANNELS.TRANSCRIBE_PROGRESS)
        .map(([, payload]) => (payload as { percent: number }).percent)

      // progress=50 maps to 20 + round(50/100 * 75) = 57 or 58
      const mappedValue = progressPayloads.find((p) => p >= 20 && p <= 95 && p !== 20 && p !== 95)
      expect(mappedValue).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // 4. JSON sidecar file handling
  // -------------------------------------------------------------------------

  describe('JSON sidecar file handling', () => {
    it('reads a json output file when it exists', async () => {
      await transcriber.transcribe('proj-9', 'audio.wav', 'en', 'base')

      // Transcriber writes to a tmpdir JSON path, then reads it back
      expect(mockFs.existsSync).toHaveBeenCalled()
      expect(mockFs.readFileSync).toHaveBeenCalled()
    })

    it('cleans up the json output file after reading', async () => {
      await transcriber.transcribe('proj-10', 'audio.wav', 'en', 'base')

      // unlinkSync called at least once (cleanup of tmpdir JSON)
      expect(mockFs.unlinkSync).toHaveBeenCalled()
    })

    it('returns empty words when sidecar file does not exist and stdout is not valid JSON', async () => {
      mockFs.existsSync = vi.fn().mockReturnValue(false)

      const transcript = await transcriber.transcribe('proj-11', 'audio.wav', 'en', 'base')

      expect(transcript.words).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // 5. MP4 audio extraction
  // -------------------------------------------------------------------------

  describe('MP4 audio extraction', () => {
    it('spawns ffmpeg to extract audio when the input file is an MP4', async () => {
      await transcriber.transcribe('proj-12', 'video.mp4', 'en', 'base')

      const ffmpegCall = mockSpawn.mock.calls.find(([cmd]) => cmd === 'ffmpeg')
      expect(ffmpegCall).toBeDefined()
    })

    it('does not spawn ffmpeg for non-MP4 audio files', async () => {
      await transcriber.transcribe('proj-13', 'audio.wav', 'en', 'base')

      const ffmpegCall = mockSpawn.mock.calls.find(([cmd]) => cmd === 'ffmpeg')
      expect(ffmpegCall).toBeUndefined()
    })
  })
})
