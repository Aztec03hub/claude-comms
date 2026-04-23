#!/usr/bin/env node
// CI bundle-size check (Batch 4M, plan §"Version pinning & CI size check").
//
// Measures gzipped byte size of named output chunks against documented
// ceilings. Fails (exit 1) if any chunk exceeds its ceiling.
//
// Ceilings come from plan §"Version pinning & CI size check (R1-9 fix)":
//   index           <= 180 KB gzipped
//   vendor-markdown <= 130 KB gzipped
//   vendor-diff     <=  25 KB gzipped
//
// If a check fails, see CONTRIBUTING.md "Bundle size" section for the
// fallback ladder. Raising a ceiling requires explicit review.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ lives inside web/, so dist is at ../dist relative to this file.
const DIST = path.resolve(__dirname, '..', 'dist', 'assets');

const CEILINGS = {
  // chunk-name-prefix -> max gzipped bytes
  'index':            180 * 1024,
  'vendor-markdown':  130 * 1024,
  'vendor-diff':       25 * 1024,
};

if (!existsSync(DIST)) {
  console.error(`check-bundle-size: dist directory not found at ${DIST}`);
  console.error('Run `npm run build` first.');
  process.exit(2);
}

const files = readdirSync(DIST).filter((f) => f.endsWith('.js'));

let failed = false;
const seen = new Set();

for (const [prefix, ceiling] of Object.entries(CEILINGS)) {
  // Vite emits hashed filenames like `vendor-markdown-AbC123.js`. Match by
  // prefix + dash. Also accept exact `prefix.js` for completeness.
  const matches = files.filter(
    (f) => f.startsWith(`${prefix}-`) || f === `${prefix}.js`,
  );

  if (matches.length === 0) {
    console.warn(
      `WARN: no chunk found for prefix "${prefix}" — skipping (ceiling ${(ceiling / 1024).toFixed(1)} KB).`,
    );
    continue;
  }

  for (const name of matches) {
    seen.add(name);
    const full = path.join(DIST, name);
    const raw = readFileSync(full);
    const gz = gzipSync(raw).length;
    const gzKB = (gz / 1024).toFixed(1);
    const ceilKB = (ceiling / 1024).toFixed(1);
    const over = gz > ceiling;
    const status = over ? 'OVER' : 'OK  ';
    console.log(
      `[${status}] ${name.padEnd(38)} ${gzKB.padStart(7)} KB  (ceiling ${ceilKB} KB)`,
    );
    if (over) failed = true;
  }
}

// Informational: list the other JS chunks so reviewers see the full picture.
const unmeasured = files.filter((f) => !seen.has(f) && !f.endsWith('.map'));
if (unmeasured.length > 0) {
  console.log('\nOther chunks (not gated):');
  for (const name of unmeasured) {
    if (name.endsWith('.map')) continue;
    const raw = readFileSync(path.join(DIST, name));
    const gz = gzipSync(raw).length;
    const gzKB = (gz / 1024).toFixed(1);
    console.log(`         ${name.padEnd(38)} ${gzKB.padStart(7)} KB`);
  }
}

if (failed) {
  console.error(
    '\nBundle size check FAILED. See CONTRIBUTING.md "Bundle size" for the fallback ladder.',
  );
  process.exit(1);
}

console.log('\nBundle size check passed.');
