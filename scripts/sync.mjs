#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const STREAM_DATA = join(DATA, 'streams');
const PLAYLISTS = join(ROOT, 'streams');
const MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
  'https://all.api.radio-browser.info',
];
const DATABASE_RAW = 'https://raw.githubusercontent.com/AirwaveDB/database/main/data';
const SOURCE_MAP_JSON = `${DATABASE_RAW}/source_map.json`;
const DATABASE_INDEX_JSON = `${DATABASE_RAW}/index.json`;
const VERIFIED_URL = 'https://raw.githubusercontent.com/eyalev/verified-radio-streams/main/stations/all.json';
const USER_AGENT = 'AirwaveDB-streams/1.2 (+https://github.com/AirwaveDB/streams)';
const PAGE_SIZE = 5000;
const TIMEOUT_MS = 20_000;
const MIN_STREAMS = 40_000;
const MIN_KEEP_RATIO = 0.80;
const ALLOW_SHRINK = process.env.ALLOW_SHRINK === '1';

const LINE_BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const BIDI = /[\u202a-\u202e\u2066-\u2069\ufeff]/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pretty = (value) => JSON.stringify(value, null, 2) + '\n';

function clean(value, max = 1000) {
  return Array.from(String(value ?? '').replace(LINE_BREAKS, ' ').replace(BIDI, '').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

function validUrl(value) {
  try {
    const u = new URL(clean(value, 3000));
    return ['http:', 'https:'].includes(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}

function countryCode(value) {
  const code = clean(value, 2).toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : 'ZZ';
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sourceBoolean(value, fallback = false) {
  if (value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === false || value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
  return fallback;
}

async function fetchWithTimeout(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res;
}

async function radioBrowser(path) {
  const errors = [];
  for (const base of MIRRORS) {
    try {
      return await (await fetchWithTimeout(base + path)).json();
    } catch (error) {
      errors.push(`${base}: ${error.message}`);
    }
  }
  throw new Error(`Radio Browser request failed: ${path}\n${errors.join('\n')}`);
}

async function fetchRadioBrowser() {
  const out = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await radioBrowser(`/json/stations/search?hidebroken=true&order=name&limit=${PAGE_SIZE}&offset=${offset}`);
    if (!Array.isArray(page)) throw new Error('Radio Browser returned an unexpected response');
    out.push(...page);
    process.stdout.write(`Radio Browser: ${out.length}\n`);
    if (page.length < PAGE_SIZE) break;
  }
  return out;
}

function collectVerified(node, out, inherited = {}) {
  if (Array.isArray(node)) {
    for (const item of node) collectVerified(item, out, inherited);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const context = { countryCode: node.countryCode || node.code || inherited.countryCode || '' };
  if (typeof node.name === 'string' && typeof node.stream === 'string') {
    out.push({ ...node, ...context });
    return;
  }
  for (const value of Object.values(node)) collectVerified(value, out, context);
}

async function fetchVerified() {
  const data = await (await fetchWithTimeout(VERIFIED_URL)).json();
  const out = [];
  collectVerified(data, out);
  if (!out.length) throw new Error('verified-radio-streams returned no stream records');
  process.stdout.write(`Verified streams: ${out.length}\n`);
  return out;
}

async function loadDatabase() {
  const [rows, index] = await Promise.all([
    (await fetchWithTimeout(SOURCE_MAP_JSON)).json(),
    (await fetchWithTimeout(DATABASE_INDEX_JSON)).json(),
  ]);
  if (!Array.isArray(rows)) throw new Error('Database source map is not an array');
  if (rows.length < MIN_STREAMS) throw new Error(`Database source map contains only ${rows.length} rows`);

  const mapping = new Map();
  for (const row of rows) {
    const key = `${row.source}:${row.sourceId}`;
    if (!row.source || !row.sourceId || !row.stationId || mapping.has(key)) {
      throw new Error(`Invalid or duplicate database source mapping: ${key}`);
    }
    mapping.set(key, { stationId: row.stationId, country: row.country || 'ZZ' });
  }
  return { mapping, index };
}

async function previousCount() {
  try {
    const index = JSON.parse(await readFile(join(DATA, 'index.json'), 'utf8'));
    return Number(index.streamCount ?? 0);
  } catch {
    return 0;
  }
}

function streamId(stationId, url) {
  return `aws_${createHash('sha256').update(`${stationId}\n${url}`).digest('hex').slice(0, 20)}`;
}

function rbStream(s, mapping) {
  if (!UUID_RE.test(String(s.stationuuid ?? ''))) return null;
  const sourceId = String(s.stationuuid).toLowerCase();
  const map = mapping.get(`radio-browser:${sourceId}`);
  const url = validUrl(s.url_resolved || s.url);
  if (!map || !url) return null;

  const bitrate = Math.max(0, Math.trunc(safeNumber(s.bitrate)));
  const hls = sourceBoolean(s.hls, false) || /\.m3u8(?:$|[?#])/i.test(url);
  const lastCheckOk = sourceBoolean(s.lastcheckok, true);

  return {
    id: streamId(map.stationId, url),
    stationId: map.stationId,
    name: clean(s.name, 160),
    country: countryCode(map.country),
    url,
    codec: clean(s.codec, 24).toLowerCase() || null,
    bitrate,
    protocol: new URL(url).protocol.slice(0, -1),
    hls,
    sources: ['radio-browser'],
    sourceIds: [sourceId],
    lastCheckOk,
    lastCheckedAt: clean(s.lastchecktime_iso8601 || s.lastchecktime || '', 40) || null,
  };
}

function verifiedStream(s, mapping) {
  const localId = clean(s.id, 200);
  if (!localId) return null;
  const sourceId = `${countryCode(s.countryCode)}:${localId}`;
  const map = mapping.get(`verified-radio-streams:${sourceId}`);
  const url = validUrl(s.stream);
  if (!map || !url) return null;

  return {
    id: streamId(map.stationId, url),
    stationId: map.stationId,
    name: clean(s.name, 160),
    country: countryCode(map.country),
    url,
    codec: clean(s.codec, 24).toLowerCase() || null,
    bitrate: Math.max(0, Math.trunc(safeNumber(s.bitrate))),
    protocol: new URL(url).protocol.slice(0, -1),
    hls: sourceBoolean(s.hls, false) || /\.m3u8(?:$|[?#])/i.test(url),
    sources: ['verified-radio-streams'],
    sourceIds: [sourceId],
    lastCheckOk: true,
    lastCheckedAt: clean(s.verified, 40) || null,
  };
}

function mergeStreams(rows) {
  const merged = new Map();
  for (const row of rows.filter(Boolean)) {
    const key = `${row.stationId}\n${row.url}`;
    const old = merged.get(key);
    if (!old) {
      merged.set(key, row);
      continue;
    }

    const provenance = new Map();
    for (let i = 0; i < old.sources.length; i++) provenance.set(`${old.sources[i]}\0${old.sourceIds[i]}`, [old.sources[i], old.sourceIds[i]]);
    for (let i = 0; i < row.sources.length; i++) provenance.set(`${row.sources[i]}\0${row.sourceIds[i]}`, [row.sources[i], row.sourceIds[i]]);
    const pairs = [...provenance.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    old.sources = pairs.map(([source]) => source);
    old.sourceIds = pairs.map(([, sourceId]) => sourceId);

    if (!old.codec && row.codec) old.codec = row.codec;
    if (row.bitrate > old.bitrate) old.bitrate = row.bitrate;
    old.hls ||= row.hls;
    old.lastCheckOk ||= row.lastCheckOk;
    if ((row.lastCheckedAt || '') > (old.lastCheckedAt || '')) old.lastCheckedAt = row.lastCheckedAt;
  }
  return [...merged.values()];
}

function m3u(rows) {
  const lines = ['#EXTM3U'];
  for (const row of rows) {
    const name = clean(row.name, 160).replaceAll('"', "'");
    lines.push(`#EXTINF:-1 station-id="${row.stationId}" stream-id="${row.id}" codec="${row.codec || ''}" bitrate="${row.bitrate}",${name}`);
    lines.push(row.url);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const [{ mapping, index: databaseIndex }, rb, verified, oldCount] = await Promise.all([
    loadDatabase(),
    fetchRadioBrowser(),
    fetchVerified(),
    previousCount(),
  ]);

  const streams = mergeStreams([
    ...rb.map((source) => rbStream(source, mapping)),
    ...verified.map((source) => verifiedStream(source, mapping)),
  ]);

  if (streams.length < MIN_STREAMS && !ALLOW_SHRINK) {
    throw new Error(`Only ${streams.length} streams were produced; refusing to replace the dataset`);
  }
  if (oldCount && streams.length < oldCount * MIN_KEEP_RATIO && !ALLOW_SHRINK) {
    throw new Error(`Stream count dropped from ${oldCount} to ${streams.length}; refusing to overwrite the dataset`);
  }

  await mkdir(DATA, { recursive: true });
  await rm(STREAM_DATA, { recursive: true, force: true });
  await rm(PLAYLISTS, { recursive: true, force: true });
  await mkdir(STREAM_DATA, { recursive: true });
  await mkdir(PLAYLISTS, { recursive: true });

  const byCountry = new Map();
  let withCodec = 0;
  let withBitrate = 0;
  let hls = 0;
  let sourceCheckOk = 0;

  for (const stream of streams) {
    if (stream.codec) withCodec++;
    if (stream.bitrate > 0) withBitrate++;
    if (stream.hls) hls++;
    if (stream.lastCheckOk) sourceCheckOk++;

    const list = byCountry.get(stream.country) || [];
    list.push(stream);
    byCountry.set(stream.country, list);
  }

  const countries = [];
  for (const [code, rows] of [...byCountry].sort(([a], [b]) => a.localeCompare(b))) {
    rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.url.localeCompare(b.url));
    await writeFile(join(STREAM_DATA, `${code}.json`), pretty(rows));
    await writeFile(join(PLAYLISTS, `${code.toLowerCase()}.m3u`), m3u(rows));
    countries.push({ code, streamCount: rows.length });
  }

  await writeFile(join(DATA, 'index.json'), pretty({
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    databaseGeneratedAt: databaseIndex.generatedAt || null,
    streamCount: streams.length,
    quality: {
      withCodec,
      withBitrate,
      hls,
      sourceCheckOk,
      unknownCountry: byCountry.get('ZZ')?.length || 0,
    },
    countries,
  }));

  for (const legacy of ['index.csv']) await rm(join(DATA, legacy), { force: true });
  for (const file of await readdir(DATA)) {
    if (file.endsWith('.csv')) await rm(join(DATA, file), { force: true });
  }

  process.stdout.write(`Streams: ${streams.length} across ${countries.length} country buckets\n`);
}

await main();
