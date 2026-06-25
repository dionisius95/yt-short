/**
 * Ollama health check & auto-start utility.
 *
 * Before making any API calls to Ollama, call `ensureOllamaRunning()`.
 * It checks if Ollama is reachable; if not, it spawns "ollama serve"
 * and waits up to 15 seconds for it to become ready.
 *
 * This eliminates the need to manually restart the laptop or start
 * Ollama before using the application.
 */

import { spawn } from 'child_process';
import http from 'http';
import { createLogger } from './logger';

const log = createLogger('OllamaHealth');

/**
 * Ping Ollama at http://127.0.0.1:11434 to see if it's responding.
 */
export async function isOllamaRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: 11434, path: '/', method: 'GET', timeout: 3000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Start the Ollama background service.
 * On Windows this spawns a detached "ollama serve" process
 * so it stays alive even if the Electron app exits.
 */
function startOllamaProcess(): void {
  log.info('Attempting to start Ollama service (ollama serve)...');
  const child = spawn('ollama', ['serve'], {
    detached: true,
    stdio: 'ignore',
    shell: true,
    windowsHide: true,
  });
  child.unref();
}

/**
 * Poll until Ollama responds or timeout is reached.
 */
async function waitForOllama(maxWaitMs = 15000, intervalMs = 1000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isOllamaRunning()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Ensure Ollama is running. If not, start it and wait for readiness.
 * Throws an AppError with code OLLAMA_UNAVAILABLE if it still can't connect.
 */
export async function ensureOllamaRunning(): Promise<void> {
  if (await isOllamaRunning()) {
    log.debug('Ollama is already running');
    return;
  }

  log.warn('Ollama is not running — starting automatically...');
  startOllamaProcess();

  const ready = await waitForOllama(15000, 1000);
  if (!ready) {
    throw {
      code: 'OLLAMA_UNAVAILABLE',
      message: 'Ollama is not running and could not be started automatically. Please start Ollama manually or check your installation.',
    };
  }

  log.info('Ollama started successfully and is responding');
}
