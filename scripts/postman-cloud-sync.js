#!/usr/bin/env node
/**
 * Pushes any locally-tracked Postman collection that is NOT yet in the cloud
 * workspace up to Postman, then writes the returned UID back into
 * `.postman/resources.yaml` so the local↔cloud map stays in sync.
 *
 * Why this exists: collections are linked into the workspace via
 * `.postman/resources.yaml`. `localResources.collections` lists everything
 * tracked locally; `cloudResources.collections` maps each to its cloud UID.
 * A collection present in the former but absent from the latter has never
 * been pushed (e.g. ZorEWS-AI). This script closes that gap.
 *
 * Usage:
 *   POSTMAN_API_KEY=PMAK-… node scripts/postman-cloud-sync.js
 *   POSTMAN_API_KEY=PMAK-… node scripts/postman-cloud-sync.js --dry-run
 *
 * The API key is YOUR secret — get it from
 * https://go.postman.co/settings/me/api-keys and never commit it.
 */
const fs   = require('fs');
const path = require('path');

const REPO   = path.resolve(__dirname, '..');
const RESYAML = path.join(REPO, '.postman', 'resources.yaml');
const DRY     = process.argv.includes('--dry-run');
const API_KEY = process.env.POSTMAN_API_KEY || '';

// ── Minimal targeted parse of resources.yaml (no YAML dep needed) ────────────
function parseResources(txt) {
  const workspace = (txt.match(/workspace:\s*\n\s*id:\s*([0-9a-f-]+)/) || [])[1] || null;
  const section = (name) => {
    // grab the block between `<name>:` (under cloud/localResources) — we only
    // need the collections lists, parsed line-by-line below.
    return txt;
  };
  const localBlock = txt.slice(txt.indexOf('localResources:'),
                              txt.indexOf('cloudResources:'));
  const cloudBlock = txt.slice(txt.indexOf('cloudResources:'));
  const localCols  = [...localBlock.matchAll(/^\s*-\s*(\.\.\/[^\n]+\.json)\s*$/gm)].map(m => m[1].trim());
  const cloudCols  = new Set(
    [...cloudBlock.matchAll(/^\s*(\.\.\/[^\n:]+\.json)\s*:/gm)].map(m => m[1].trim())
  );
  return { workspace, localCols, cloudCols };
}

function main() {
  if (!fs.existsSync(RESYAML)) {
    console.error(`✕ ${RESYAML} not found — run from a repo with .postman/ set up.`);
    process.exit(1);
  }
  const txt = fs.readFileSync(RESYAML, 'utf8');
  const { workspace, localCols, cloudCols } = parseResources(txt);

  if (!workspace) { console.error('✕ could not read workspace id from resources.yaml'); process.exit(1); }

  const missing = localCols.filter(c => !cloudCols.has(c));
  console.log(`Workspace:        ${workspace}`);
  console.log(`Local collections: ${localCols.length}`);
  console.log(`Cloud-synced:      ${cloudCols.size}`);
  console.log(`Not yet in cloud:  ${missing.length}`);
  missing.forEach(m => console.log(`   • ${m}`));

  if (missing.length === 0) { console.log('\n✅ Nothing to push — every local collection is already in the cloud.'); return; }

  if (DRY) { console.log('\n(dry-run) — would push the above. Re-run without --dry-run + a POSTMAN_API_KEY to sync.'); return; }

  if (!API_KEY) {
    console.error('\n✕ POSTMAN_API_KEY not set. Get one at https://go.postman.co/settings/me/api-keys then:');
    console.error('    POSTMAN_API_KEY=PMAK-… node scripts/postman-cloud-sync.js');
    process.exit(2);
  }

  (async () => {
    let updated = txt;
    for (const rel of missing) {
      const abs = path.resolve(path.dirname(RESYAML), rel);
      if (!fs.existsSync(abs)) { console.error(`   ✕ ${rel} — file missing on disk, skipped`); continue; }
      const collection = JSON.parse(fs.readFileSync(abs, 'utf8'));
      process.stdout.write(`   → pushing ${path.basename(rel)} … `);
      const res = await fetch(`https://api.getpostman.com/collections?workspace=${workspace}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
        body: JSON.stringify({ collection }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { console.log(`HTTP ${res.status}`); console.error(`     ${JSON.stringify(body).slice(0,200)}`); continue; }
      const uid = body.collection && body.collection.uid;
      console.log(`✓ ${uid}`);
      // Append the new mapping under cloudResources.collections.
      const anchor = updated.match(/(cloudResources:\s*\n\s*collections:\s*\n)/);
      if (anchor && uid) {
        updated = updated.replace(anchor[1], `${anchor[1]}    ${rel}: ${uid}\n`);
      }
    }
    if (updated !== txt) {
      fs.writeFileSync(RESYAML, updated);
      console.log(`\n✓ Updated ${path.relative(REPO, RESYAML)} with new cloud UIDs.`);
    }
    console.log('\n✅ Cloud sync complete.');
  })();
}

main();
