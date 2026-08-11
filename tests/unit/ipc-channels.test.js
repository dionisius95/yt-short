/**
 * Unit tests for IPC channel constants and handler registration.
 * Validates Requirements 10.2 — the IPC bridge and typed API layer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CHANNELS, PUSH_CHANNELS } from '../../electron/ipc/channels';
// ---------------------------------------------------------------------------
// Mock Electron modules — they are not available in the Node test environment
// ---------------------------------------------------------------------------
vi.mock('electron', () => {
    const handlers = new Map();
    return {
        ipcMain: {
            handle: vi.fn((channel, handler) => {
                handlers.set(channel, handler);
            }),
            removeHandler: vi.fn((channel) => {
                handlers.delete(channel);
            }),
            _handlers: handlers,
        },
        shell: {
            openPath: vi.fn(),
            showItemInFolder: vi.fn(),
        },
        dialog: {
            showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
        },
        BrowserWindow: {
            fromWebContents: vi.fn().mockReturnValue(null),
        },
    };
});
// ---------------------------------------------------------------------------
// Channel constants tests
// ---------------------------------------------------------------------------
describe('CHANNELS constants', () => {
    it('exports a non-empty object of channel name constants', () => {
        expect(CHANNELS).toBeDefined();
        expect(typeof CHANNELS).toBe('object');
        expect(Object.keys(CHANNELS).length).toBeGreaterThan(0);
    });
    it('all channel values are non-empty strings', () => {
        for (const [key, value] of Object.entries(CHANNELS)) {
            expect(typeof value, `CHANNELS.${key} should be a string`).toBe('string');
            expect(value.length, `CHANNELS.${key} should not be empty`).toBeGreaterThan(0);
        }
    });
    it('all channel values are unique (no duplicates)', () => {
        const values = Object.values(CHANNELS);
        const unique = new Set(values);
        expect(unique.size).toBe(values.length);
    });
    it('channel names follow the namespace:action pattern', () => {
        // Allow lowercase letters, digits, hyphens, and colons (e.g. "shell:open-path")
        const colonPattern = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/;
        for (const [key, value] of Object.entries(CHANNELS)) {
            expect(colonPattern.test(value), `CHANNELS.${key} = "${value}" should match namespace:action pattern`).toBe(true);
        }
    });
    it('contains all required pipeline channels', () => {
        // Download
        expect(CHANNELS.DOWNLOAD_START).toBe('download:start');
        expect(CHANNELS.DOWNLOAD_CANCEL).toBe('download:cancel');
        expect(CHANNELS.DOWNLOAD_PROGRESS).toBe('download:progress');
        // Transcription
        expect(CHANNELS.TRANSCRIBE_START).toBe('transcribe:start');
        expect(CHANNELS.TRANSCRIBE_CANCEL).toBe('transcribe:cancel');
        expect(CHANNELS.TRANSCRIBE_PROGRESS).toBe('transcribe:progress');
        // Analysis
        expect(CHANNELS.ANALYZE_START).toBe('analyze:start');
        expect(CHANNELS.ANALYZE_CANCEL).toBe('analyze:cancel');
        // Hooks
        expect(CHANNELS.HOOKS_LIST).toBe('hooks:list');
        expect(CHANNELS.HOOK_UPDATE).toBe('hook:update');
        expect(CHANNELS.HOOK_DISMISS).toBe('hook:dismiss');
        // Clips
        expect(CHANNELS.CLIP_GENERATE).toBe('clip:generate');
        expect(CHANNELS.CLIP_CANCEL).toBe('clip:cancel');
        expect(CHANNELS.CLIP_LIST).toBe('clip:list');
        expect(CHANNELS.CLIP_GET).toBe('clip:get');
        expect(CHANNELS.CLIP_DELETE).toBe('clip:delete');
        expect(CHANNELS.CLIP_PROGRESS).toBe('clip:progress');
        // Export
        expect(CHANNELS.EXPORT_START).toBe('export:start');
        expect(CHANNELS.EXPORT_CANCEL).toBe('export:cancel');
        expect(CHANNELS.EXPORT_PROGRESS).toBe('export:progress');
        // Upload
        expect(CHANNELS.UPLOAD_AUTH_START).toBe('upload:auth:start');
        expect(CHANNELS.UPLOAD_AUTH_STATUS).toBe('upload:auth:status');
        expect(CHANNELS.UPLOAD_START).toBe('upload:start');
        expect(CHANNELS.UPLOAD_CANCEL).toBe('upload:cancel');
        expect(CHANNELS.UPLOAD_PROGRESS).toBe('upload:progress');
        // Projects
        expect(CHANNELS.PROJECT_LIST).toBe('project:list');
        expect(CHANNELS.PROJECT_GET).toBe('project:get');
        expect(CHANNELS.PROJECT_DELETE).toBe('project:delete');
        // Settings
        expect(CHANNELS.SETTINGS_GET).toBe('settings:get');
        expect(CHANNELS.SETTINGS_SET).toBe('settings:set');
        // Deps
        expect(CHANNELS.DEPS_CHECK).toBe('deps:check');
        // Shell / dialog
        expect(CHANNELS.SHELL_OPEN_PATH).toBe('shell:open-path');
        expect(CHANNELS.SHELL_SHOW_ITEM).toBe('shell:show-item');
        expect(CHANNELS.DIALOG_OPEN_DIRECTORY).toBe('dialog:open-directory');
    });
});
// ---------------------------------------------------------------------------
// PUSH_CHANNELS tests
// ---------------------------------------------------------------------------
describe('PUSH_CHANNELS', () => {
    it('is a non-empty readonly array', () => {
        expect(Array.isArray(PUSH_CHANNELS)).toBe(true);
        expect(PUSH_CHANNELS.length).toBeGreaterThan(0);
    });
    it('contains only progress/event channels (not request channels)', () => {
        for (const ch of PUSH_CHANNELS) {
            expect(ch, `Push channel "${ch}" should contain "progress"`).toContain('progress');
        }
    });
    it('contains all five progress channels', () => {
        const pushSet = new Set(PUSH_CHANNELS);
        expect(pushSet.has('download:progress')).toBe(true);
        expect(pushSet.has('transcribe:progress')).toBe(true);
        expect(pushSet.has('clip:progress')).toBe(true);
        expect(pushSet.has('export:progress')).toBe(true);
        expect(pushSet.has('upload:progress')).toBe(true);
    });
    it('push channels are a subset of all CHANNELS values', () => {
        const allValues = new Set(Object.values(CHANNELS));
        for (const ch of PUSH_CHANNELS) {
            expect(allValues.has(ch), `Push channel "${ch}" must exist in CHANNELS`).toBe(true);
        }
    });
});
// ---------------------------------------------------------------------------
// Handler registration tests
// ---------------------------------------------------------------------------
describe('registerIpcHandlers', () => {
    let ipcMain;
    beforeEach(async () => {
        // Reset mock call counts before each test
        const electron = await import('electron');
        ipcMain = electron.ipcMain;
        vi.clearAllMocks();
    });
    afterEach(() => {
        vi.clearAllMocks();
    });
    it('registers a handler for every non-push channel', async () => {
        const { registerIpcHandlers } = await import('../../electron/ipc/handlers');
        // Build minimal stub services
        const stubServices = buildStubServices();
        registerIpcHandlers(stubServices);
        // Channels that are neither push events nor ipcMain.handle channels
        // (e.g. UPLOAD_AUTH_CALLBACK is an internal OAuth callback channel)
        const internalOnlyChannels = new Set([
            CHANNELS.UPLOAD_AUTH_CALLBACK,
        ]);
        // Every channel that is NOT a push channel and NOT internal-only should have a handler
        const pushSet = new Set(PUSH_CHANNELS);
        const invokeChannels = Object.values(CHANNELS).filter((ch) => !pushSet.has(ch) && !internalOnlyChannels.has(ch));
        expect(ipcMain.handle).toHaveBeenCalledTimes(invokeChannels.length);
        for (const channel of invokeChannels) {
            expect(ipcMain.handle, `ipcMain.handle should have been called with channel "${channel}"`).toHaveBeenCalledWith(channel, expect.any(Function));
        }
    });
    it('does NOT register handlers for push (event) channels', async () => {
        const { registerIpcHandlers } = await import('../../electron/ipc/handlers');
        registerIpcHandlers(buildStubServices());
        const registeredChannels = ipcMain.handle.mock.calls.map((call) => call[0]);
        for (const pushCh of PUSH_CHANNELS) {
            expect(registeredChannels, `Push channel "${pushCh}" should NOT have a handler registered`).not.toContain(pushCh);
        }
    });
    it('unregisterIpcHandlers removes all channel handlers', async () => {
        const { registerIpcHandlers, unregisterIpcHandlers } = await import('../../electron/ipc/handlers');
        registerIpcHandlers(buildStubServices());
        vi.clearAllMocks();
        unregisterIpcHandlers();
        // removeHandler should be called once per channel (all channels including push)
        expect(ipcMain.removeHandler).toHaveBeenCalledTimes(Object.values(CHANNELS).length);
    });
    it('project:list handler delegates to listProjects service', async () => {
        const { registerIpcHandlers } = await import('../../electron/ipc/handlers');
        const mockProjects = [{ id: '1', title: 'Test' }];
        const services = buildStubServices({
            listProjects: vi.fn().mockResolvedValue(mockProjects),
        });
        registerIpcHandlers(services);
        // Find the registered handler for project:list
        const call = ipcMain.handle.mock.calls.find((c) => c[0] === CHANNELS.PROJECT_LIST);
        expect(call).toBeDefined();
        const handler = call[1];
        const result = await handler({});
        expect(result).toEqual(mockProjects);
        expect(services.listProjects).toHaveBeenCalledOnce();
    });
    it('settings:get handler delegates to getSettings service', async () => {
        const { registerIpcHandlers } = await import('../../electron/ipc/handlers');
        const mockSettings = { downloadDir: '/tmp', exportDir: '/tmp' };
        const services = buildStubServices({
            getSettings: vi.fn().mockResolvedValue(mockSettings),
        });
        registerIpcHandlers(services);
        const call = ipcMain.handle.mock.calls.find((c) => c[0] === CHANNELS.SETTINGS_GET);
        expect(call).toBeDefined();
        const handler = call[1];
        const result = await handler({});
        expect(result).toEqual(mockSettings);
    });
    it('download:start handler passes request to startDownload service', async () => {
        const { registerIpcHandlers } = await import('../../electron/ipc/handlers');
        const mockResult = { projectId: 'proj-123' };
        const services = buildStubServices({
            startDownload: vi.fn().mockResolvedValue(mockResult),
        });
        registerIpcHandlers(services);
        const call = ipcMain.handle.mock.calls.find((c) => c[0] === CHANNELS.DOWNLOAD_START);
        expect(call).toBeDefined();
        const handler = call[1];
        const req = { url: 'https://youtube.com/watch?v=abc', quality: '1080p', outputDir: '/tmp' };
        const result = await handler({}, req);
        expect(result).toEqual(mockResult);
        expect(services.startDownload).toHaveBeenCalledWith(req);
    });
});
function buildStubServices(overrides = {}) {
    return {
        listProjects: vi.fn().mockResolvedValue([]),
        getProject: vi.fn().mockResolvedValue(null),
        deleteProject: vi.fn().mockResolvedValue(undefined),
        startDownload: vi.fn().mockResolvedValue({ projectId: '' }),
        cancelDownload: vi.fn().mockResolvedValue(undefined),
        startTranscribe: vi.fn().mockResolvedValue(undefined),
        cancelTranscribe: vi.fn().mockResolvedValue(undefined),
        startAnalyze: vi.fn().mockResolvedValue([]),
        cancelAnalyze: vi.fn().mockResolvedValue(undefined),
        listHooks: vi.fn().mockResolvedValue([]),
        updateHook: vi.fn().mockResolvedValue(undefined),
        dismissHook: vi.fn().mockResolvedValue(undefined),
        generateClip: vi.fn().mockResolvedValue({ clipId: '' }),
        cancelClip: vi.fn().mockResolvedValue(undefined),
        listClips: vi.fn().mockResolvedValue([]),
        getClip: vi.fn().mockResolvedValue(null),
        deleteClip: vi.fn().mockResolvedValue(undefined),
        startExport: vi.fn().mockResolvedValue(undefined),
        cancelExport: vi.fn().mockResolvedValue(undefined),
        startAuthFlow: vi.fn().mockResolvedValue(undefined),
        getAuthStatus: vi.fn().mockResolvedValue({ authenticated: false }),
        startUpload: vi.fn().mockResolvedValue(undefined),
        cancelUpload: vi.fn().mockResolvedValue(undefined),
        getSettings: vi.fn().mockResolvedValue({}),
        setSettings: vi.fn().mockResolvedValue(undefined),
        checkDeps: vi.fn().mockResolvedValue({}),
        runPipeline: vi.fn().mockResolvedValue(undefined),
        cancelPipeline: vi.fn().mockResolvedValue(undefined),
        getPipelineStatus: vi.fn().mockResolvedValue({ running: false }),
        generateThumbnail: vi.fn().mockResolvedValue(null),
        importLocalFile: vi.fn().mockResolvedValue({ projectId: '' }),
        openFilePicker: vi.fn().mockResolvedValue(null),
        detectScenes: vi.fn().mockResolvedValue({ cuts: [], framesAnalyzed: 0 }),
        detectSpeakers: vi.fn().mockResolvedValue({ segments: [], speakerCount: 0, method: 'none' }),
        getTranscript: vi.fn().mockResolvedValue(null),
        generateMetadata: vi.fn().mockResolvedValue(null),
        saveCustomThumbnail: vi.fn().mockResolvedValue(''),
        searchYouTube: vi.fn().mockResolvedValue([]),
        searchClipCafe: vi.fn().mockResolvedValue([]),
        ...overrides,
    };
}
