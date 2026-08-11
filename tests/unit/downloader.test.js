/**
 * Unit tests for the Downloader class.
 * Validates Requirements 2.1, 2.2, 2.3
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------
vi.mock('electron', () => ({
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('child_process');
// ---------------------------------------------------------------------------
// Helpers — fake child process factory
// ---------------------------------------------------------------------------
import { spawn } from 'child_process';
const mockSpawn = vi.mocked(spawn);
/**
 * Creates a fake ChildProcess-like EventEmitter with stdout/stderr streams.
 */
function makeFakeProc() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    proc.stdin = null;
    proc.stdio = [];
    return proc;
}
/**
 * Creates a fake process that emits a filepath line then closes successfully.
 */
function makeSuccessProc(filePath = '/tmp/abc123.mp4') {
    const proc = makeFakeProc();
    // Emit stdout data and close asynchronously so the caller can set up listeners
    setImmediate(() => {
        proc.stdout.emit('data', Buffer.from(`${filePath}\n`));
        proc.stdout.emit('data', Buffer.from('{"title":"Test Video","duration":120}\n'));
        proc.emit('close', 0, null);
    });
    return proc;
}
/**
 * Creates a fake process that exits with a non-zero code (failure).
 * Emits synchronously so it works with fake timers.
 */
function makeFailProc(code = 1) {
    const proc = makeFakeProc();
    // Use Promise.resolve() (microtask) instead of setImmediate so that
    // fake timers don't block the close event from firing.
    Promise.resolve().then(() => {
        proc.stderr.emit('data', Buffer.from('yt-dlp error\n'));
        proc.emit('close', code, null);
    });
    return proc;
}
/**
 * Creates a fake process that never closes (for cancel testing).
 */
function makeHangingProc() {
    return makeFakeProc();
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
import { Downloader } from '../../electron/pipeline/Downloader';
const BASE_REQ = {
    projectId: 'proj-test',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    outputDir: '/tmp/downloads',
};
describe('Downloader — quality tier mapping', () => {
    let downloader;
    beforeEach(() => {
        downloader = new Downloader();
        mockSpawn.mockReset();
    });
    const cases = [
        { quality: '1080p', heightToken: 'height<=1080' },
        { quality: '720p', heightToken: 'height<=720' },
        { quality: '480p', heightToken: 'height<=480' },
        { quality: '360p', heightToken: 'height<=360' },
    ];
    for (const { quality, heightToken } of cases) {
        it(`maps '${quality}' to a format string containing '${heightToken}'`, async () => {
            mockSpawn.mockReturnValue(makeSuccessProc());
            await downloader.download({
                ...BASE_REQ,
                quality: quality,
            });
            expect(mockSpawn).toHaveBeenCalledOnce();
            const [cmd, args] = mockSpawn.mock.calls[0];
            expect(cmd).toBe('yt-dlp');
            // The --format flag is followed by the format string
            const formatIdx = args.indexOf('--format');
            expect(formatIdx).toBeGreaterThanOrEqual(0);
            const formatArg = args[formatIdx + 1];
            expect(formatArg).toContain(heightToken);
        });
    }
});
// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------
describe('Downloader — retry logic', () => {
    let downloader;
    beforeEach(() => {
        vi.useFakeTimers();
        downloader = new Downloader();
        mockSpawn.mockReset();
    });
    afterEach(() => {
        vi.useRealTimers();
    });
    it('retries up to 3 times total when yt-dlp always fails', async () => {
        // Always return a failing process
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockSpawn.mockImplementation(() => makeFailProc());
        // Start the download — it will retry with 5s delays between attempts
        // Attach a no-op catch immediately to prevent unhandled rejection warnings
        // from late-firing process close events after the test assertion.
        const downloadPromise = downloader.download({
            ...BASE_REQ,
            quality: '720p',
        });
        downloadPromise.catch(() => { });
        // Attempt 1: let the microtask (process close) run
        await Promise.resolve();
        await Promise.resolve();
        // Advance past the first retry delay (5s) → triggers attempt 2
        await vi.advanceTimersByTimeAsync(6_000);
        await Promise.resolve();
        await Promise.resolve();
        // Advance past the second retry delay (5s) → triggers attempt 3
        await vi.advanceTimersByTimeAsync(6_000);
        await Promise.resolve();
        await Promise.resolve();
        // All retries exhausted — the promise should now reject
        await expect(downloadPromise).rejects.toThrow();
        // spawn should have been called exactly 3 times (RETRY_LIMIT)
        expect(mockSpawn).toHaveBeenCalledTimes(3);
    });
});
// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------
describe('Downloader — cancel', () => {
    let downloader;
    beforeEach(() => {
        downloader = new Downloader();
        mockSpawn.mockReset();
    });
    it('calls kill(SIGTERM) on the child process when cancel() is invoked', async () => {
        const hangingProc = makeHangingProc();
        mockSpawn.mockReturnValue(hangingProc);
        // Start the download but don't await — it will hang
        const downloadPromise = downloader.download({
            ...BASE_REQ,
            quality: '1080p',
        });
        // Give the spawn call a chance to register
        await Promise.resolve();
        // Cancel the download
        downloader.cancel(BASE_REQ.projectId);
        // Verify kill was called with SIGTERM
        expect(hangingProc.kill).toHaveBeenCalledWith('SIGTERM');
        // Emit the SIGTERM close so the promise settles (avoids unhandled rejection)
        hangingProc.emit('close', null, 'SIGTERM');
        await expect(downloadPromise).rejects.toThrow(/cancelled/);
    });
    it('does nothing when cancel() is called for an unknown projectId', () => {
        // Should not throw
        expect(() => downloader.cancel('non-existent-project')).not.toThrow();
    });
});
