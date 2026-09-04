#!/usr/bin/env node
/**
 * Neutrality guard.
 *
 * Scans tracked text files for accusatory vocabulary. Findings produced by this system are
 * discrepancies to verify; the code base, prompts, docs and commit messages must not carry
 * allegations. Run: `pnpm neutrality` (also runs in CI).
 *
 * Usage:
 *   node scripts/neutrality-check.mjs            # scan the repository
 *   node scripts/neutrality-check.mjs --commit-msg <file>   # scan a commit message file
 */
import { readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const BLOCKLIST = [
  // es / ca
  /\bfraud/, /\bestafa/, /sobrepre(cio|u)/, /\bsospech/, /\bsospit/, /desfalc/, /malversa/, /\bmordida/,
  /\bsoborn/, /\bsuborn/, /\bculpable/, /\brobo\b/, /\brobar\b/, /\brobad/, /\bladr(on|ones|e)\b/,
  // en
  /kickback/, /\bskim/, /\bshaving\b/, /embezzl/, /corrupt/, /\bsteal/, /\bstole/, /\bthie(f|ves)\b/, /\bguilty\b/, /\bcrook/,
];

const ALLOWED_DIRS_SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'coverage', 'data']);
const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.sql',
  '.yml',
  '.yaml',
  '.txt',
  '.csv',
  '.html',
  '.css',
]);

function normalise(s) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function scanText(text, label, problems) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const n = normalise(line);
    for (const re of BLOCKLIST) {
      const m = re.exec(n);
      if (m) {
        // allow explicit references to the blocklist itself
        if (n.includes('blocklist') || n.includes('neutrality')) continue;
        problems.push(`${label}:${i + 1}: contains "${m[0]}"`);
      }
    }
  });
}

function listTrackedFiles() {
  try {
    const out = execSync('git ls-files -z --cached --others --exclude-standard', {
      encoding: 'utf8',
    });
    return out.split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

const args = process.argv.slice(2);
const problems = [];

if (args[0] === '--commit-msg' && args[1]) {
  scanText(readFileSync(args[1], 'utf8'), 'commit message', problems);
} else {
  for (const rel of listTrackedFiles()) {
    const parts = rel.split('/');
    if (parts.some((p) => ALLOWED_DIRS_SKIP.has(p))) continue;
    if (!TEXT_EXT.has(path.extname(rel))) continue;
    if (rel === 'scripts/neutrality-check.mjs') continue;
    try {
      if (statSync(rel).size > 2_000_000) continue;
      scanText(readFileSync(rel, 'utf8'), rel, problems);
    } catch {
      /* unreadable file: skip */
    }
  }
}

if (problems.length) {
  console.error('Neutrality check failed. Rephrase as a discrepancy to verify:');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
} else {
  console.log('Neutrality check passed.');
}
