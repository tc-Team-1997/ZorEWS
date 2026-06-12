#!/usr/bin/env node
/**
 * Converts Postman Collection v2.1 JSON files → Postman local workspace v3 YAML.
 * Also writes the environment YAML.
 */
const fs   = require('fs');
const path = require('path');

// ─────────────────────────── YAML helpers ────────────────────────────────────

function sanitize(name) {
  return name
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function needsQuote(str) {
  if (typeof str !== 'string') return false;
  return /[{}:,#&*!\[\]>|'"@`%~^]/.test(str) ||
    /^(true|false|yes|no|null|on|off|\d.*)$/i.test(str) ||
    str.startsWith('-') || str.startsWith('?') || str === '';
}

/** Return YAML-safe inline scalar (single-quoted if needed). */
function q(str) {
  if (str === null || str === undefined) return "''";
  str = String(str);
  if (!needsQuote(str)) return str;
  return "'" + str.replace(/'/g, "''") + "'";
}

/** Write a string value as YAML (block scalar when multi-line). */
function writeVal(str, baseIndent) {
  str = str == null ? '' : String(str);
  if (!str.includes('\n')) return q(str);
  const pad = ' '.repeat(baseIndent + 2);
  return '|-\n' + str.split('\n').map(l => pad + l).join('\n');
}

// ─────────────────────────── Postman → v3 ────────────────────────────────────

function urlStr(url) {
  if (!url) return '';
  if (typeof url === 'string') return url;
  return url.raw || '';
}

function queryParams(url) {
  if (!url || typeof url !== 'object') return [];
  return (url.query || []).filter(p => !p.disabled);
}

function pathVars(url) {
  if (!url || typeof url !== 'object') return [];
  return url.variable || [];
}

function convertBody(body) {
  if (!body || !body.mode) return null;
  switch (body.mode) {
    case 'raw': {
      const lang = (body.options && body.options.raw && body.options.raw.language) || 'text';
      const typeMap = { json: 'json', xml: 'xml', html: 'html', javascript: 'javascript' };
      return { type: typeMap[lang] || 'text', content: body.raw || '' };
    }
    case 'formdata':
      return { type: 'formdata', content: (body.formdata || []).map(f => ({ key: f.key, type: f.type || 'text', value: f.value || '' })) };
    case 'urlencoded':
      return { type: 'urlencoded', content: (body.urlencoded || []).map(f => ({ key: f.key, value: f.value || '' })) };
    default:
      return null;
  }
}

function convertAuth(auth) {
  if (!auth || auth.type === 'noauth') return null;
  const t = auth.type;
  const creds = (auth[t] || []).map(c => ({ key: c.key, value: c.value || '' }));
  return { type: t, credentials: creds };
}

function renderAuth(auth, indent) {
  if (!auth) return '';
  const p = ' '.repeat(indent);
  const lines = [`${p}auth:`, `${p}  type: ${auth.type}`];
  if (auth.credentials && auth.credentials.length) {
    lines.push(`${p}  credentials:`);
    auth.credentials.forEach(c => {
      lines.push(`${p}    - key: ${q(c.key)}`);
      lines.push(`${p}      value: ${q(String(c.value || ''))}`);
    });
  }
  return lines.join('\n');
}

function renderScripts(events, indent) {
  if (!events || !events.length) return '';
  const p = ' '.repeat(indent);
  const scripts = [];
  events.forEach(e => {
    if (!e.script) return;
    const execArr = e.script.exec || [];
    const code = Array.isArray(execArr) ? execArr.join('\n') : String(execArr || '');
    if (!code.trim()) return;
    scripts.push({ type: e.listen === 'prerequest' ? 'beforeRequest' : 'afterResponse', code });
  });
  if (!scripts.length) return '';
  const lines = [`${p}scripts:`];
  scripts.forEach(s => {
    lines.push(`${p}  - type: ${s.type}`);
    lines.push(`${p}    language: text/javascript`);
    if (s.code.includes('\n')) {
      lines.push(`${p}    code: |-`);
      s.code.split('\n').forEach(l => lines.push(`${p}      ${l}`));
    } else {
      lines.push(`${p}    code: ${q(s.code)}`);
    }
  });
  return lines.join('\n');
}

function buildRequestYaml(item, order) {
  const req  = item.request;
  const rawUrl  = urlStr(req.url);
  const method  = req.method || 'GET';
  const fname   = sanitize(item.name);

  const lines = ['$kind: http-request'];
  if (item.name !== fname) lines.push(`name: ${q(item.name)}`);
  lines.push(`order: ${order}`);
  lines.push(`method: ${method}`);
  lines.push(`url: ${writeVal(rawUrl, 0)}`);

  // Headers
  const headers = (req.header || []).filter(h => !h.disabled);
  if (headers.length) {
    lines.push('headers:');
    headers.forEach(h => {
      lines.push(`  - key: ${q(h.key)}`);
      lines.push(`    value: ${q(String(h.value || ''))}`);
    });
  }

  // Query params
  const qps = queryParams(req.url);
  if (qps.length) {
    lines.push('queryParams:');
    qps.forEach(p => {
      lines.push(`  - key: ${q(p.key)}`);
      lines.push(`    value: ${q(String(p.value || ''))}`);
      if (p.disabled) lines.push('    disabled: true');
    });
  }

  // Path variables
  const pvs = pathVars(req.url);
  if (pvs.length) {
    lines.push('pathVariables:');
    pvs.forEach(p => {
      lines.push(`  - key: ${q(p.key)}`);
      lines.push(`    value: ${q(String(p.value || ''))}`);
    });
  }

  // Body
  const body = convertBody(req.body);
  if (body) {
    lines.push('body:');
    lines.push(`  type: ${body.type}`);
    if (['json','text','xml','html','javascript'].includes(body.type)) {
      const c = body.content;
      if (!c) {
        lines.push("  content: ''");
      } else if (c.includes('\n')) {
        lines.push('  content: |-');
        c.split('\n').forEach(l => lines.push(`    ${l}`));
      } else {
        lines.push(`  content: ${q(c)}`);
      }
    } else if (['formdata','urlencoded'].includes(body.type)) {
      lines.push('  content:');
      body.content.forEach(f => {
        lines.push(`    - key: ${q(f.key)}`);
        lines.push(`      value: ${q(f.value)}`);
        if (f.type && f.type !== 'text') lines.push(`      type: ${f.type}`);
      });
    }
  }

  // Request-level auth
  const auth = convertAuth(req.auth);
  if (auth) {
    const al = renderAuth(auth, 0);
    if (al) lines.push(al);
  }

  // Scripts
  const sc = renderScripts(item.event, 0);
  if (sc) lines.push(sc);

  return lines.join('\n') + '\n';
}

function buildDefinitionYaml(name, description, auth, events) {
  const lines = ['$kind: collection'];
  if (name) lines.push(`name: ${q(name)}`);
  if (description) {
    lines.push(`description: ${writeVal(description, 0)}`);
  }
  const authStr = renderAuth(convertAuth(auth), 0);
  if (authStr) lines.push(authStr);
  const sc = renderScripts(events, 0);
  if (sc) lines.push(sc);
  return lines.join('\n') + '\n';
}

// ─────────────────────────── Directory traversal ─────────────────────────────

const _usedNames = new Map();

function uniqueName(dir, base) {
  if (!_usedNames.has(dir)) _usedNames.set(dir, new Set());
  const used  = _usedNames.get(dir);
  const lower = base.toLowerCase();
  if (!used.has(lower)) { used.add(lower); return base; }
  let i = 2;
  while (used.has(`${lower}-${i}`)) i++;
  const u = `${base}-${i}`;
  used.add(u.toLowerCase());
  return u;
}

function processItems(items, dir, startOrder = 1000) {
  let order = startOrder;
  (items || []).forEach(item => {
    if (item.item) {
      // ── Folder ──
      const folderName = uniqueName(dir, sanitize(item.name));
      const folderDir  = path.join(dir, folderName);
      fs.mkdirSync(folderDir, { recursive: true });

      // Folder definition
      const resDir = path.join(folderDir, '.resources');
      fs.mkdirSync(resDir, { recursive: true });
      const defLines = ['$kind: collection'];
      if (item.name !== folderName) defLines.push(`name: ${q(item.name)}`);
      if (item.description) defLines.push(`description: ${writeVal(item.description, 0)}`);
      fs.writeFileSync(path.join(resDir, 'definition.yaml'), defLines.join('\n') + '\n');

      processItems(item.item, folderDir, 1000);
    } else if (item.request) {
      // ── Request ──
      const reqName  = sanitize(item.name);
      const uniqName = uniqueName(dir, reqName);
      const yaml     = buildRequestYaml(item, order);
      fs.writeFileSync(path.join(dir, `${uniqName}.request.yaml`), yaml);
      order += 1000;
    }
  });
}

function convertCollection(jsonPath, outputDir) {
  console.log(`\nConverting: ${path.basename(jsonPath)}`);
  const json  = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const cname = json.info.name;
  const cdir  = path.join(outputDir, sanitize(cname));
  fs.mkdirSync(cdir, { recursive: true });

  // Collection definition
  const resDir = path.join(cdir, '.resources');
  fs.mkdirSync(resDir, { recursive: true });
  const defYaml = buildDefinitionYaml(cname, json.info.description, json.auth, json.event);
  fs.writeFileSync(path.join(resDir, 'definition.yaml'), defYaml);

  _usedNames.clear();
  processItems(json.item, cdir, 1000);

  // Count
  const count = countFiles(cdir);
  console.log(`  ✓ ${count.requests} requests, ${count.folders} folders → ${cdir}`);
}

function countFiles(dir) {
  let requests = 0, folders = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach(e => {
    if (e.isDirectory() && e.name !== '.resources') {
      folders++;
      const sub = countFiles(path.join(dir, e.name));
      requests += sub.requests;
      folders  += sub.folders;
    } else if (e.isFile() && e.name.endsWith('.request.yaml')) {
      requests++;
    }
  });
  return { requests, folders };
}

// ─────────────────────────── Main ────────────────────────────────────────────

const BASE    = '/Users/chuadhary_taniya/ZorEWS';
const OUTPUT  = path.join(BASE, 'postman/collections');

const postmanCollections = [
  'ZorEWS-AI.postman_collection.json',
  'ZorEWS-Alerts.postman_collection.json',
  'ZorEWS-Auth.postman_collection.json',
  'ZorEWS-Borrower.postman_collection.json',
  'ZorEWS-Config.postman_collection.json',
  'ZorEWS-Dashboard.postman_collection.json',
  'ZorEWS-EWS.postman_collection.json',
  'ZorEWS-Reports.postman_collection.json',
  'ZorEWS-Users.postman_collection.json',
  'ZorEWS-Workflow.postman_collection.json',
].map(f => path.join(BASE, 'docs/postman', f));

const extraCollections = [
  'ews-cms-postman.json',
  'ews-rules-postman.json',
  'ews-rules-plus-postman.json',
  'ews-reports-builder-postman.json',
  'ews-copilot-postman.json',
].map(f => path.join(BASE, 'docs', f));

console.log('=== Converting collections ===');
[...postmanCollections, ...extraCollections].forEach(f => convertCollection(f, OUTPUT));

// ─────────────────────────── Environment ─────────────────────────────────────

console.log('\n=== Writing environment ===');
const envJson = JSON.parse(fs.readFileSync(path.join(BASE, 'docs/postman/local.postman_environment.json'), 'utf8'));
const envLines = [`name: ${q(envJson.name)}`, 'values:'];
envJson.values.forEach(v => {
  const val = String(v.value || '');
  envLines.push(`  - key: ${v.key}`);
  envLines.push(`    value: ${q(val)}`);
  envLines.push(`    type: ${v.type}`);
  envLines.push(`    enabled: ${v.enabled}`);
});
const envPath = path.join(BASE, 'postman/environments/ZorEWS Local.environment.yaml');
fs.writeFileSync(envPath, envLines.join('\n') + '\n');
console.log(`  ✓ Environment → ${envPath}`);

console.log('\n✅  All done!');
