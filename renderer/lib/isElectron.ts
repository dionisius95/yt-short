/**
 * isElectron — returns true when running inside the Electron renderer process.
 */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && typeof window.electron !== 'undefined';
}

/**
 * isElectronProduction — true when running via the app:// custom protocol
 * (i.e. packaged Electron app, not dev server).
 */
export function isElectronProduction(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'app:';
}

/**
 * electronNavigate — unified navigation for Electron production + dev/browser.
 *
 * In production (app:// protocol) Next.js router.push changes the URL but
 * does NOT trigger a file load — the window stays blank. This helper:
 *   1. Stores the real project/resource ID in sessionStorage under `key`.
 *   2. Does a hard window.location.href to the static shell path.
 *
 * In dev / browser it just calls router.push(href) normally.
 *
 * Shell paths (from Next.js static export with trailingSlash):
 *   /                          → /index.html
 *   /import                    → /import/index.html
 *   /settings                  → /settings/index.html
 *   /project/[id]              → /project/_/index.html
 *   /project/[id]/clips        → /project/_/clips/index.html
 *
 * @param router   Next.js AppRouter (from useRouter())
 * @param href     The logical Next.js route, e.g. "/project/abc123"
 * @param storeId  Optional { key, value } to persist in sessionStorage
 */
export function electronNavigate(
  router: { push: (href: string) => void },
  href: string,
  storeId?: { key: string; value: string }
): void {
  if (storeId && typeof window !== 'undefined') {
    try {
      sessionStorage.setItem(storeId.key, storeId.value);
      localStorage.setItem(storeId.key, storeId.value);
    } catch {}
  }
  if (isElectronProduction()) {
    // Map logical route → static shell path
    const shellPath = toShellPath(href);
    window.location.href = shellPath;
  } else {
    router.push(href);
  }
}

/**
 * Convert a logical Next.js route to the static export shell path.
 * Dynamic segments are replaced with '_' (the placeholder used by generateStaticParams).
 */
function toShellPath(href: string): string {
  // /project/<id>/clips  →  /project/_/clips/index.html
  if (/^\/project\/[^/]+\/clips/.test(href)) {
    return '/project/_/clips/index.html';
  }
  // /project/<id>  →  /project/_/index.html
  if (/^\/project\/[^/]+/.test(href)) {
    return '/project/_/index.html';
  }
  // Static routes — just append /index.html
  const clean = href.replace(/\/$/, '');
  if (clean === '' || clean === '/') return '/index.html';
  return `${clean}/index.html`;
}

/**
 * readSessionId — read stored navigation ID from sessionStorage with localStorage fallback.
 * Preserves the stored ID so page refreshes and multi-step navigation never lose project ID.
 */
export function readSessionId(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const val = sessionStorage.getItem(key) || localStorage.getItem(key);
    return val && val !== '_' ? val : null;
  } catch {
    return null;
  }
}
