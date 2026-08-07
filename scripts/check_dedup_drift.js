#!/usr/bin/env node
// BUG-5 (docs/REVIEW_2026-08-03.md): frontend/ and monitor_dashboard/ are two fully separate
// Vite apps with no shared workspace, so a handful of files are maintained as byte-identical
// copies in both places by hand. That drifted silently for months before the last full audit
// caught it (a plain-text header where the logo should be, a CSS variable referenced in one
// app's copy that isn't defined in its stylesheet). Rather than restructure the build pipeline
// (higher risk, and blocked on aligning the two apps' React versions - see the BUG-5 entry),
// this catches drift the moment it happens: run on every PR, fails loudly with a diff-style
// message instead of waiting for the next manual audit.
//
// When a genuine change is made to one of these files, make the same edit in its pair before
// this passes - that's still a manual step, just one CI won't let slip through unnoticed anymore.
//
// Line endings are normalized before comparing (CRLF vs LF alone isn't real drift - see BUG-5).

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

// Add a pair here whenever a new file is deliberately duplicated between the two apps, expected
// to stay byte-identical. Not every file that started as a duplicate belongs here forever -
// three were deliberately dropped from this list:
//   - LMStudioLogsView.jsx / RpiTerminalModal.jsx: SEC-5 scoped the httpOnly-cookie auth
//     migration to frontend/ only, since monitor_dashboard's cross-origin remote-dashboard mode
//     can't rely on a same-origin cookie - monitor_dashboard's copies intentionally stayed on
//     ?token= query strings. These two are now permanently, deliberately different.
//   - TokenCountView.jsx: frontend's copy is dead code (confirmed under ENH-5, never actually
//     rendered), so FEAT-4's CSV/JSON export buttons were only added to monitor_dashboard's
//     copy, the one that's actually live. Also now permanently different.
const PAIRS = [
  ['frontend/src/components/CustomAlertModal.jsx', 'monitor_dashboard/src/CustomAlertModal.jsx'],
  ['frontend/src/components/TokenChart.jsx', 'monitor_dashboard/src/TokenChart.jsx'],
  ['frontend/src/hooks/useApi.js', 'monitor_dashboard/src/useApi.js']
];

function normalize(content) {
  return content.replace(/\r\n/g, '\n');
}

function main() {
  const problems = [];

  for (const [a, b] of PAIRS) {
    const aPath = path.join(repoRoot, a);
    const bPath = path.join(repoRoot, b);
    const aExists = fs.existsSync(aPath);
    const bExists = fs.existsSync(bPath);

    if (!aExists || !bExists) {
      problems.push(`${a} <-> ${b}: ${!aExists ? a : b} is missing entirely.`);
      continue;
    }

    const aContent = normalize(fs.readFileSync(aPath, 'utf8'));
    const bContent = normalize(fs.readFileSync(bPath, 'utf8'));
    if (aContent !== bContent) {
      problems.push(`${a} <-> ${b}: contents differ.`);
    }
  }

  if (problems.length > 0) {
    console.error('BUG-5 dedup check failed: these file pairs must stay byte-identical between frontend/ and monitor_dashboard/ (mod line endings), but have drifted:\n');
    problems.forEach((p) => console.error(`  - ${p}`));
    console.error('\nApply the same edit to both copies, then re-run this check.');
    process.exit(1);
  }

  console.log(`BUG-5 dedup check passed: all ${PAIRS.length} shared file pair(s) match.`);
}

main();
