import { contextBridge, ipcRenderer } from 'electron';

/**
 * The shape of the electron bridge exposed to the renderer via contextBridge.
 * Accessible as `window.electron` in the renderer process.
 */
export interface ElectronBridge {
  /**
   * Invoke a main-process handler and await the result.
   * Corresponds to ipcMain.handle() on the main side.
   */
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;

  /**
   * Subscribe to a push event from the main process.
   * Returns an unsubscribe function — call it to clean up the listener.
   */
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void;

  /**
   * Subscribe to a push event for a single emission only.
   */
  once: (channel: string, listener: (...args: unknown[]) => void) => void;

  /**
   * Remove a specific listener from a channel.
   */
  off: (channel: string, listener: (...args: unknown[]) => void) => void;
}

/**
 * Allowlist of channels the renderer is permitted to invoke.
 * Any channel not in this list will be rejected.
 */
const INVOKE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'download:start',
  'download:cancel',
  'transcribe:start',
  'transcribe:cancel',
  'transcript:get',
  'analyze:start',
  'analyze:cancel',
  'analyze:generate-metadata',
  'hooks:list',
  'hook:update',
  'hook:dismiss',
  'clip:generate',
  'clip:cancel',
  'clip:list',
  'clip:get',
  'clip:delete',
  'clip:update-script',
  'clip:update-caption-visibility',
  'clip:save-metadata',
  'export:start',
  'export:cancel',
  'upload:auth:start',
  'upload:auth:disconnect',
  'upload:auth:status',
  'upload:start',
  'upload:cancel',
  'telegram:send-code',
  'telegram:sign-in',
  'project:list',
  'project:get',
  'project:delete',
  'settings:get',
  'settings:set',
  'accounts:get',
  'accounts:save',
  'presets:get',
  'presets:save',
  'avatar-presets:get',
  'avatar-presets:save',
  'avatar-presets:delete',
  'deps:check',
  'youtube:search',
  'youtube:trending',
  'youtube:analyze-trend',
  'youtube:optimize-gist',
  'clipcafe:search',
  'clipcafe:genre-movies',
  'clipcafe:movie-clips',
  'commentator:generate',
  'commentator:get-voices',
  'shell:open-path',
  'shell:show-item',
  'dialog:open-directory',
  'pipeline:run',
  'pipeline:cancel',
  'pipeline:status',
  'thumbnail:generate',
  'thumbnail:save-custom',
  'thumbnail:generate-ai',
  'dialog:open-file',
  'local:import',
  'local:file-picker',
  'scene:detect',
  'speaker:detect',
  'frame:extract',
  'tracking:detect',
  'translate:start',
  'translate:reset',
  'dub:start',
  'preview:render',
]);

/**
 * Allowlist of channels the renderer is permitted to subscribe to.
 * These are push events sent from main → renderer.
 */
const SUBSCRIBE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'download:progress',
  'transcribe:progress',
  'clip:progress',
  'export:progress',
  'upload:progress',
  'pipeline:progress',
]);

const bridge: ElectronBridge = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!INVOKE_ALLOWLIST.has(channel)) {
      return Promise.reject(
        new Error(`[preload] Blocked invoke on disallowed channel: ${channel}`)
      );
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  on(channel: string, listener: (...args: unknown[]) => void): () => void {
    if (!SUBSCRIBE_ALLOWLIST.has(channel)) {
      console.warn(`[preload] Blocked subscription on disallowed channel: ${channel}`);
      return () => { /* no-op */ };
    }
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  once(channel: string, listener: (...args: unknown[]) => void): void {
    if (!SUBSCRIBE_ALLOWLIST.has(channel)) {
      console.warn(`[preload] Blocked once-subscription on disallowed channel: ${channel}`);
      return;
    }
    ipcRenderer.once(channel, (_event, ...args) => listener(...args));
  },

  off(channel: string, listener: (...args: unknown[]) => void): void {
    ipcRenderer.removeListener(
      channel,
      listener as Parameters<typeof ipcRenderer.removeListener>[1]
    );
  },
};

contextBridge.exposeInMainWorld('electron', bridge);
