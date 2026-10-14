#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const STREAM_DATA = join(DATA, 'streams');
const PLAYLISTS = join(ROOT, 'streams');
const PREVIOUS = process.env.PREVIOUS_STREAM_DIR || '';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERIFIED_ID_RE = /^[A-Z]{2}:/;
const pretty = (value) => JSON.stringify(value, null, 2) + '\n';

function hashId(value) {
  return `aws_${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}

function endpointKey(row) {
  return `${row.stationId}\n${row.url}`;
}

function provenanceKeys(row) {
  const sources = Array.isArray(row.sources) ? row.sources : [];
  const ids = Array.isArray(row.sourceIds) ? row.sourceIds : [];
  const keys = new Set();

  for (const source of sources) {
    if (source === 'radio-browser') {
      for (const id of ids) {
        if (UUID_RE.test(id)) keys.add(`${source}:${id.toLowerCase()}`);
      }
      continue;
    }

    if (source === 'verified-radio-streams') {
      for (const id of ids) {
        if (VERIFIED_ID_RE.test(id)) keys.add(`${source}:${id}`);
      }
      continue;
    }

    if (sources.length === 1) {
      for (const id of ids) keys.add(`${source}:${id}`);
    }
  }

  return [...keys].sort();
}

function putUnique(map, ambiguous, key, value) {
  if (!key || ambiguous.has(key)) return;
  const old = map.get(key);
  if (old && old !== value) {
    map.delete(key);
    ambiguous.add(key);
    return;
  }
  map.set(key, value);
}

async function loadPrevious() {
  const bySource = new Map();
  const byEndpoint = new Map();
  const ambiguousSources = new Set();
  const ambiguousEndpoints = new Set();
  const ids = new Set();

  if (!PREVIOUS) return { bySource, byEndpoint, ids };

  let files;
  try {
    files = (await readdir(PREVIOUS)).filter((name) => /^[A-Z]{2}\.json$/.test(name)).sort();
  } catch {
    return { bySource, byEndpoint, ids };
  }

  for (const file of files) {
    const rows = JSON.parse(await readFile(join(PREVIOUS, file), 'utf8'));
    for (const row of rows) {
      if (!row?.id) continue;
      ids.add(row.id);
      putUnique(byEndpoint, ambiguousEndpoints, endpointKey(row), row.id);
      for (const key of provenanceKeys(row)) putUnique(bySource, ambiguousSources, key, row.id);
    }
  }

  return { bySource, byEndpoint, ids };
}

function choosePreviousId(row, previous) {
  const candidates = [];
  const endpointId = previous.byEndpoint.get(endpointKey(row));
  if (endpointId) candidates.push(endpointId);
  for (const key of provenanceKeys(row)) {
    const id = previous.bySource.get(key);
    if (id) candidates.push(id);
  }
  if (!candidates.length) return null;

  const counts = new Map();
  for (const id of candidates) counts.set(id, (counts.get(id) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

function newStableId(row, salt = '') {
  const keys = provenanceKeys(row);
  const identity = keys.length
    ? `source-provenance-v1\n${keys.join('\n')}${salt}`
    : `endpoint-fallback-v1\n${endpointKey(row)}${salt}`;
  return hashId(identity);
}

function m3u(rows) {
  const lines = ['#EXTM3U'];
  for (const row of rows) {
    const name = String(row.name || '').replace(/[\r\n]+/g, ' ').replaceAll('"', "'");
    lines.push(`#EXTINF:-1 station-id="${row.stationId}" stream-id="${row.id}" codec="${row.codec || ''}" bitrate="${row.bitrate}",${name}`);
    lines.push(row.url);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const previous = await loadPrevious();
  const files = (await readdir(STREAM_DATA)).filter((name) => /^[A-Z]{2}\.json$/.test(name)).sort();
  const rowsByFile = new Map();
  const allRows = [];

  for (const file of files) {
    const rows = JSON.parse(await readFile(join(STREAM_DATA, file), 'utf8'));
    rowsByFile.set(file, rows);
    for (const row of rows) {
      const prior = choosePreviousId(row, previous);
      row.id = prior || newStableId(row);
      allRows.push({ file, row });
    }
  }

  // A previously merged endpoint can later split into multiple URLs. In that
  // case only one branch may retain the old ID; the others receive new stable
  // source-derived IDs so the dataset never contains duplicate stream IDs.
  const byId = new Map();
  for (const item of allRows) {
    const list = byId.get(item.row.id) || [];
    list.push(item);
    byId.set(item.row.id, list);
  }

  const used = new Set();
  for (const [id, items] of [...byId].sort(([a], [b]) => a.localeCompare(b))) {
    if (items.length === 1) {
      used.add(id);
      continue;
    }

    items.sort((a, b) => {
      const aExact = previous.byEndpoint.get(endpointKey(a.row)) === id ? 1 : 0;
      const bExact = previous.byEndpoint.get(endpointKey(b.row)) === id ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      const aRb = a.row.sources?.includes('radio-browser') ? 1 : 0;
      const bRb = b.row.sources?.includes('radio-browser') ? 1 : 0;
      if (aRb !== bRb) return bRb - aRb;
      return endpointKey(a.row).localeCompare(endpointKey(b.row));
    });

    used.add(id);
    for (let i = 1; i < items.length; i++) {
      let attempt = 0;
      let replacement;
      do {
        replacement = newStableId(items[i].row, `\nsplit:${attempt++}\n${endpointKey(items[i].row)}`);
      } while (used.has(replacement));
      items[i].row.id = replacement;
      used.add(replacement);
    }
  }

  let reused = 0;
  let created = 0;
  for (const { row } of allRows) {
    if (previous.ids.has(row.id)) reused++;
    else created++;
  }

  for (const [file, rows] of rowsByFile) {
    await writeFile(join(STREAM_DATA, file), pretty(rows));
    const code = file.slice(0, 2).toLowerCase();
    await writeFile(join(PLAYLISTS, `${code}.m3u`), m3u(rows));
  }

  const indexPath = join(DATA, 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  index.idStrategy = 'source-provenance-v1';
  index.quality = {
    ...(index.quality || {}),
    identityReused: reused,
    identityNew: created,
  };
  await writeFile(indexPath, pretty(index));

  process.stdout.write(`Stable stream IDs: ${reused} reused, ${created} new\n`);
}

await main();
