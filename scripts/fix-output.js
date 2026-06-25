/**
 * fix-output.js — post-process Next.js static export to fix Windows path issues.
 *
 * Next.js generates chunk files with paths like:
 *   _next/static/chunks/app/project/[id]/page-xxx.js
 *
 * The square brackets in [id] get URL-encoded to %5Bid%5D when requested via
 * the app:// protocol, but the actual files on disk have literal [ and ] in
 * their names. On Windows, path.join handles these fine, but net.fetch with
 * a file:// URL fails because the URL encoding doesn't match the filename.
 *
 * Fix: rename all [id] and [id]/clips directories in the _next/static/chunks
 * output to use the placeholder name '_' (matching generateStaticParams).
 * Also update all references inside JS chunk files.
 */

const fs   = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'renderer', 'out');

// ---------------------------------------------------------------------------
// Step 1: Rename [id] directories to _ in _next/static/chunks
// ---------------------------------------------------------------------------

function renameSquareBrackets(dir) {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Recurse first, then rename
      renameSquareBrackets(fullPath);

      if (entry.name.includes('[') || entry.name.includes(']')) {
        const newName = entry.name.replace(/\[([^\]]+)\]/g, '_');
        const newPath = path.join(dir, newName);
        if (!fs.existsSync(newPath)) {
          fs.renameSync(fullPath, newPath);
          console.log(`Renamed: ${entry.name} → ${newName}`);
        }
      }
    }
  }
}

renameSquareBrackets(path.join(outDir, '_next', 'static', 'chunks'));

// ---------------------------------------------------------------------------
// Step 2: Update references inside all JS chunk files
// ---------------------------------------------------------------------------

function fixRefsInDir(dir) {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      fixRefsInDir(fullPath);
    } else if (entry.name.endsWith('.js')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      // Replace URL-encoded [id] references
      const updated = content
        .replace(/%5Bid%5D/g, '_')
        .replace(/\[id\]/g, '_');
      if (updated !== content) {
        fs.writeFileSync(fullPath, updated, 'utf8');
        console.log(`Fixed refs in: ${entry.name}`);
      }
    }
  }
}

fixRefsInDir(path.join(outDir, '_next', 'static', 'chunks'));

console.log('fix-output.js complete');
