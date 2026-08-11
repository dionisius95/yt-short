import { BrowserWindow, session } from 'electron';
import { CHANNELS } from '../ipc/channels';
import { createLogger } from '../utils/logger';

const log = createLogger('TikTokUploader');

function emitProgress(clipId: string, percent: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(CHANNELS.UPLOAD_PROGRESS, { clipId, percent });
    }
  }
}

export class TikTokUploader {
  async upload(
    clipId: string,
    filePath: string,
    sessionId: string,
    title: string,
    description: string,
    tags: string[],
    configManager: any
  ): Promise<string> {
    log.info({ clipId, filePath }, 'Starting TikTok Studio upload via BrowserWindow');
    emitProgress(clipId, 0);

    // 1. Inject Cookies
    const sessionInstance = session.defaultSession;
    if (sessionId) {
      if (sessionId.includes(';')) {
        const cookies = sessionId.split(';').map(c => c.trim()).filter(Boolean);
        for (const cookie of cookies) {
          const parts = cookie.split('=');
          const name = parts[0].trim();
          const value = parts.slice(1).join('=').trim();
          try {
            await sessionInstance.cookies.set({
              url: 'https://www.tiktok.com',
              name,
              value,
              domain: '.tiktok.com',
              path: '/'
            });
          } catch (cookieErr) {
            log.warn({ name, cookieErr }, 'Failed to set individual cookie');
          }
        }
      } else {
        await sessionInstance.cookies.set({
          url: 'https://www.tiktok.com',
          name: 'sessionid',
          value: sessionId,
          domain: '.tiktok.com',
          path: '/'
        });
      }
    }

    emitProgress(clipId, 10);

    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      show: true, // Show the window so the user can see automation or login if needed
      title: 'TikTok Studio Auto-Uploader (Antigravity)',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    // Set a standard desktop User-Agent to bypass TikTok's bot detection on Electron
    const desktopUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    win.webContents.setUserAgent(desktopUserAgent);

    win.setMenuBarVisibility(false);

    try {
      // 3. Load TikTok Studio upload page
      log.info('Loading TikTok Studio upload page...');
      await win.loadURL('https://www.tiktok.com/tiktokstudio/upload');
      emitProgress(clipId, 20);

      // 4. Check if we are redirected to login page
      let currentUrl = win.webContents.getURL();
      if (currentUrl.includes('/login')) {
        log.warn('TikTok session cookie invalid or expired. Prompting user for login...');
        win.focus();

        // Wait for the user to login and be redirected back to the upload page
        await new Promise<void>((resolve, reject) => {
          const checkInterval = setInterval(async () => {
            if (win.isDestroyed()) {
              clearInterval(checkInterval);
              reject(new Error('Upload window was closed by user.'));
              return;
            }

            const url = win.webContents.getURL();
            if (url.includes('/tiktokstudio/upload') || url.includes('/creator-center/upload')) {
              clearInterval(checkInterval);
              log.info('User successfully logged in. Saving new cookie...');

              // Save the new cookie to config
              const cookies = await sessionInstance.cookies.get({ url: 'https://www.tiktok.com' });
              const sessionCookie = cookies.find(c => c.name === 'sessionid');
              if (sessionCookie) {
                configManager.set('tiktokSessionId', sessionCookie.value);
                log.info('New TikTok sessionid cookie saved to configuration.');
              }
              resolve();
            }
          }, 1000);
        });
      }

      emitProgress(clipId, 30);

      // Inject automation banner
      try {
        await win.webContents.executeJavaScript(`
          (() => {
            const banner = document.createElement('div');
            banner.id = 'antigravity-automation-banner';
            banner.style.cssText = "position:fixed;top:0;left:0;right:0;background:#fe2c55;color:white;text-align:center;padding:12px;z-index:999999;font-weight:bold;font-size:14px;box-shadow:0 2px 10px rgba(0,0,0,0.3);font-family:sans-serif;";
            banner.innerText = "🤖 ANTIGRAVITY AUTOMATION: Silakan SERET (drag & drop) file video Anda ke area unggah di bawah ini untuk memulai.";
            document.body.appendChild(banner);
          })()
        `);
      } catch {}

      // 5. Wait for the file input to be available in the DOM (page loaded)
      log.info('Waiting for TikTok Studio upload DOM to load...');
      await new Promise<void>((resolve, reject) => {
        let attempts = 0;
        const findInput = setInterval(async () => {
          if (win.isDestroyed()) {
            clearInterval(findInput);
            reject(new Error('Window destroyed during DOM load.'));
            return;
          }

          const hasInput = await win.webContents.executeJavaScript(`
            !!document.querySelector('input[type="file"]')
          `);

          if (hasInput) {
            clearInterval(findInput);
            resolve();
          } else {
            attempts++;
            if (attempts > 30) {
              clearInterval(findInput);
              reject(new Error('Timeout waiting for file input element in TikTok Studio.'));
            }
          }
        }, 1000);
      });

      emitProgress(clipId, 40);

      // 6. Inject the video file path using Chrome DevTools Protocol (CDP)
      log.info({ filePath }, 'Selecting file in TikTok Studio upload page via CDP...');
      try {
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('DOM.enable');

        let nodeId = 0;
        let retryAttempts = 0;
        while (retryAttempts < 5) {
          try {
            const doc = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1 });
            const node = await win.webContents.debugger.sendCommand('DOM.querySelector', {
              nodeId: doc.root.nodeId,
              selector: 'input[type="file"]'
            });
            if (node && node.nodeId) {
              nodeId = node.nodeId;
              break;
            }
          } catch (err) {
            log.warn({ retryAttempts, err }, 'CDP DOM query retry due to error');
          }
          retryAttempts++;
          await new Promise(r => setTimeout(r, 1000));
        }

        if (!nodeId) {
          throw new Error('Could not find input element node ID after retries.');
        }

        await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
          nodeId: nodeId,
          files: [filePath]
        });
        log.info('File successfully selected via CDP.');
      } catch (cdpErr) {
        log.error({ cdpErr }, 'CDP File selection failed');
        throw cdpErr;
      } finally {
        if (win.webContents.debugger.isAttached()) {
          win.webContents.debugger.detach();
        }
      }

      emitProgress(clipId, 60);

      // Wait a safe 5 seconds for the video to register and start uploading
      await new Promise(r => setTimeout(r, 5000));
      emitProgress(clipId, 70);

      // 7. Type title, description, and hashtags into the description editor
      const fullCaption = `${title || 'AI Short'}\n\n${description || ''}\n${tags.map(t => `#${t}`).join(' ')}`.trim();

      // Wait a bit for editor container to mount
      await new Promise(r => setTimeout(r, 3000));

      await win.webContents.executeJavaScript(`
        (() => {
          const editor = document.querySelector('div[contenteditable="true"]') || document.querySelector('.public-DraftEditor-content');
          if (editor) {
            editor.focus();
            // Clear existing text first
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            // Insert custom caption
            document.execCommand('insertText', false, ${JSON.stringify(fullCaption)});
            return true;
          }
          return false;
        })()
      `);

      emitProgress(clipId, 75);

      // 8. Wait for upload progress to finish and click Post button
      log.info('Waiting for TikTok to process and enable Post button...');
      await new Promise<void>((resolve, reject) => {
        let attempts = 0;
        const findPostButton = setInterval(async () => {
          if (win.isDestroyed()) {
            clearInterval(findPostButton);
            reject(new Error('Window destroyed during posting.'));
            return;
          }

          // Check if post button exists and is clickable (not disabled)
          const result = await win.webContents.executeJavaScript(`
            (() => {
              const buttons = Array.from(document.querySelectorAll('button'));
              const postBtn = buttons.find(b => {
                const text = b.textContent || '';
                return text.includes('Post') || text.includes('Publish') || text.includes('Bagikan');
              });

              if (postBtn) {
                const isDisabled = postBtn.disabled || postBtn.getAttribute('disabled') === 'true' || postBtn.classList.contains('disabled');
                if (!isDisabled) {
                  postBtn.click();
                  return 'clicked';
                }
                return 'disabled';
              }
              return 'not_found';
            })()
          `);

          if (result === 'clicked') {
            clearInterval(findPostButton);
            resolve();
          } else {
            attempts++;
            if (attempts > 60) { // 60 seconds timeout
              clearInterval(findPostButton);
              reject(new Error('Timeout waiting for Post button to become enabled.'));
            }
          }
        }, 1000);
      });

      emitProgress(clipId, 90);
      // Wait 20 seconds for TikTok to finalize posting
      log.info('Waiting 20 seconds for upload submission to finish...');
      await new Promise(r => setTimeout(r, 20000));
      emitProgress(clipId, 100);

      if (!win.isDestroyed()) {
        win.close();
      }
      return 'https://www.tiktok.com/tiktokstudio/content';
    } catch (err) {
      log.error({ err }, 'TikTok upload failed');
      try {
        if (!win.isDestroyed()) {
          await win.webContents.executeJavaScript(`
            (() => {
              const banner = document.getElementById('antigravity-automation-banner');
              if (banner) {
                banner.style.background = '#ff4d4f';
                banner.innerText = "❌ Gagal mengunggah otomatis. Silakan selesaikan unggahan secara manual di halaman ini.";
              }
            })()
          `);
        }
      } catch {}
      try {
        if (!win.isDestroyed() && win.webContents.debugger.isAttached()) {
          win.webContents.debugger.detach();
        }
      } catch {}
      if (!win.isDestroyed()) {
        await new Promise(r => setTimeout(r, 30000));
        if (!win.isDestroyed()) {
          win.close();
        }
      }
      throw err;
    }
  }
}
