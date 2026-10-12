#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
const SOURCE_MAP_URL = 'https://raw.githubusercontent.com/AirwaveDB/database/main/data/source_map.csv';
const VERIFIED_URL = 'https://raw.githubusercontent.com/eyalev/verified-radio-streams/main/stations/all.json';
const USER_AGENT = 'AirwaveDB-streams/1.0 (+https://github.com/AirwaveDB/streams)';
const PAGE_SIZE = 5000;
const TIMEOUT_MS = 20_000;
const MIN_STREAMS = 40_000;
const MIN_KEEP_RATIO = 0.80;
const ALLOW_SHRINK = process.env.ALLOW_SHRINK === '1';

const LINE_BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const BIDI = /[\u202a-\u202e\u2066-\u2069\ufeff]/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clean(value, max = 1000) {
  return Array.from(String(value ?? '').replace(LINE_BREAKS, ' ').replace(BIDI, '').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

function validUrl(value) {
  try {
    const u = new URL(clean(value, 3000));
    return ['http:', 'https:'].includes(u.protocol) ? u.href : '';
  } catch { return ''; }
}

function countryCode(value) {
  const code = clean(value, 2).toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : 'ZZ';
}

function q(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function csv(headers, rows) {
  return [headers.join(','), ...rows.map((row) => headers.map((h) => q(row[h])).join(','))].join('\n') + '\n';
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift();
  return rows.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

async function fetchWithTimeout(url, accept = 'application/json') {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res;
}

async function radioBrowser(path) {
  const errors = [];
  for (const base of MIRRORS) {
    try { return await (await fetchWithTimeout(base + path)).json(); }
    catch (error) { errors.push(`${base}: ${error.message}`); }
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
  if (Array.isArray(node)) { for (const item of node) collectVerified(item, out, inherited); return; }
  if (!node || typeof node !== 'object') return;
  const context = { countryCode: node.countryCode || node.code || inherited.countryCode || '' };
  if (typeof node.name === 'string' && typeof node.stream === 'string') { out.push({ ...node, ...context }); return; }
  for (const value of Object.values(node)) collectVerified(value, out, context);
}

async function fetchVerified() {
  try {
    const data = await (await fetchWithTimeout(VERIFIED_URL)).json();
    const out = [];
    collectVerified(data, out);
    return out;
  } catch (error) {
    process.stderr.write(`Verified source unavailable: ${error.message}\n`);
    return [];
  }
}

async function loadSourceMap() {
  const text = await (await fetchWithTimeout(SOURCE_MAP_URL, 'text/csv')).text();
  const rows = parseCsv(text);
  if (rows.length < MIN_STREAMS) throw new Error(`Database source map contains only ${rows.length} rows`);
  return new Map(rows.map((r) => [`${r.source}:${r.source_id}`, { stationId: r.station_id, country: r.country || 'ZZ' }]));
}

async function previousCount() {
  try {
    const index = JSON.parse(await readFile(join(DATA, 'index.json'), 'utf8'));
    return Number(index.stream_count || 0);
  } catch { return 0; }
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
  return {
    id: streamId(map.stationId, url), station_id: map.stationId, name: clean(s.name, 160), country: countryCode(map.country),
    url, codec: clean(s.codec, 24).toLowerCase(), bitrate: Math.max(0, Number(s.bitrate || 0)), protocol: new URL(url).protocol.slice(0, -1),
    hls: /\.m3u8(?:$|[?#])/i.test(url) ? 'true' : 'false', sources: 'radio-browser', source_ids: sourceId,
    last_check_ok: 'true', last_checked_at: clean(s.lastchecktime_iso8601 || s.lastchecktime || '', 40),
  };
}

function verifiedStream(s, mapping) {
  const sourceId = `${countryCode(s.countryCode)}:${clean(s.id, 200)}`;
  const map = mapping.get(`verified-radio-streams:${sourceId}`);
  const url = validUrl(s.stream);
  if (!map || !url) return null;
  return {
    id: streamId(map.stationId, url), station_id: map.stationId, name: clean(s.name, 160), country: countryCode(map.country),
    url, codec: clean(s.codec, 24).toLowerCase(), bitrate: Math.max(0, Number(s.bitrate || 0)), protocol: new URL(url).protocol.slice(0, -1),
    hls: /\.m3u8(?:$|[?#])/i.test(url) ? 'true' : 'false', sources: 'verified-radio-streams', source_ids: sourceId,
    last_check_ok: 'true', last_checked_at: clean(s.verified, 20),
  };
}

function mergeStreams(rows) {
  const merged = new Map();
  for (const row of rows.filter(Boolean)) {
    const key = `${row.station_id}\n${row.url}`;
    const old = merged.get(key);
    if (!old) { merged.set(key, row); continue; }
    old.sources = [...new Set(`${old.sources};${row.sources}`.split(';'))].sort().join(';');
    old.source_ids = [...new Set(`${old.source_ids};${row.source_ids}`.split(';'))].sort().join(';');
    if (!old.codec && row.codec) old.codec = row.codec;
    if ((!old.bitrate || row.bitrate > old.bitrate) && row.bitrate) old.bitrate = row.bitrate;
    if (row.last_checked_at > old.last_checked_at) old.last_checked_at = row.last_checked_at;
  }
  return [...merged.values()];
}

function m3u(rows) {
  const lines = ['#EXTM3U'];
  for (const r of rows) {
    const name = clean(r.name, 160).replaceAll('"', "'");
    lines.push(`#EXTINF:-1 station-id="${r.station_id}" stream-id="${r.id}" codec="${r.codec}" bitrate="${r.bitrate}",${name}`);
    lines.push(r.url);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const [mapping, rb, verified, oldCount] = await Promise.all([loadSourceMap(), fetchRadioBrowser(), fetchVerified(), previousCount()]);
  const streams = mergeStreams([
    ...rb.map((s) => rbStream(s, mapping)),
    ...verified.map((s) => verifiedStream(s, mapping)),
  ]);
  if (streams.length < MIN_STREAMS && !ALLOW_SHRINK) throw new Error(`Only ${streams.length} streams were produced; refusing to replace the dataset`);
  if (oldCount && streams.length < oldCount * MIN_KEEP_RATIO && !ALLOW_SHRINK) throw new Error(`Stream count dropped from ${oldCount} to ${streams.length}; refusing to overwrite the dataset`);

  await mkdir(DATA, { recursive: true });
  await rm(STREAM_DATA, { recursive: true, force: true });
  await rm(PLAYLISTS, { recursive: true, force: true });
  await mkdir(STREAM_DATA, { recursive: true });
  await mkdir(PLAYLISTS, { recursive: true });

  const byCountry = new Map();
  for (const stream of streams) {
    const list = byCountry.get(stream.country) || [];
    list.push(stream); byCountry.set(stream.country, list);
  }
  const headers = ['id','station_id','name','country','url','codec','bitrate','protocol','hls','sources','source_ids','last_check_ok','last_checked_at'];
  const countries = [];
  for (const [code, rows] of [...byCountry].sort(([a],[b]) => a.localeCompare(b))) {
    rows.sort((a,b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.url.localeCompare(b.url));
    await writeFile(join(STREAM_DATA, `${code}.csv`), csv(headers, rows));
    await writeFile(join(PLAYLISTS, `${code.toLowerCase()}.m3u`), m3u(rows));
    countries.push({ code, stream_count: rows.length });
  }
  await writeFile(join(DATA, 'index.json'), JSON.stringify({ generated_at: new Date().toISOString(), stream_count: streams.length, countries }, null, 2) + '\n');
  process.stdout.write(`Streams: ${streams.length} across ${countries.length} country buckets\n`);
}

await main();
