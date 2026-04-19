// scripts/sync-src.js
// Copies /src/*.js into /public/src/ so Firebase Hosting (which serves from
// /public) can vend the client modules at the same /src/* paths the HTML
// already references. Runs as a hosting predeploy step and can be invoked
// manually with `npm run sync:src`.
//
// Idempotent. Safe to run repeatedly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const srcDir = path.join(repoRoot, 'src');
const destDir = path.join(repoRoot, 'public', 'src');

if (!fs.existsSync(srcDir)) {
  console.error(`[sync-src] no src/ at ${srcDir} — nothing to copy.`);
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });

// Wipe destination first so deletions in src/ propagate.
for (const entry of fs.readdirSync(destDir)) {
  fs.rmSync(path.join(destDir, entry), { recursive: true, force: true });
}

let count = 0;
function copyRecursive(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      copyRecursive(path.join(from, entry), path.join(to, entry));
    }
  } else {
    fs.copyFileSync(from, to);
    count++;
  }
}

copyRecursive(srcDir, destDir);
console.log(`[sync-src] copied ${count} file(s) from src/ -> public/src/`);
