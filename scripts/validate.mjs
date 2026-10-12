#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const STREAM_DATA = join(DATA, 'streams');
const PLAYLISTS = join(ROOT, 'streams');
const STREAM_ID = /^aws_[0-9a-f]{20}$/;
const STATION_ID = /^awb_[0-9a-f]{20}$/;
const COUNTRY = /^[A-Z]{2}$/;
const HEADERS = ['id','station_id','name','country','url','codec','bitrate','protocol','hls','sources','source_ids','last_check_ok','last_checked_at'];
const errors = [];

function fail(message) {
  if (errors.length < 200) errors.push(message);
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
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows.shift();
  return {
    headers,
    rows: rows.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))),
  };
}

async function csvFile(path) {
  return parseCsv(await readFile(path, 'utf8'));
}

async function main() {
  const files = (await readdir(STREAM_DATA)).filter((name) => /^[A-Z]{2}\.csv$/.test(name)).sort();
  if (!files.length) fail('data/streams: no country files found');

  const ids = new Set();
  const countryCounts = new Map();
  let streamCount = 0;

  for (const file of files) {
    const code = file.slice(0, 2);
    const parsed = await csvFile(join(STREAM_DATA, file));
    if (parsed.headers.join(',') !== HEADERS.join(',')) fail(`${file}: unexpected header`);
    countryCounts.set(code, parsed.rows.length);

    for (let i = 0; i < parsed.rows.length; i++) {
      const row = parsed.rows[i];
      const where = `${file}:${i + 2}`;
      streamCount++;
      if (!STREAM_ID.test(row.id)) fail(`${where}: invalid stream id ${row.id}`);
      if (ids.has(row.id)) fail(`${where}: duplicate stream id ${row.id}`);
      ids.add(row.id);
      if (!STATION_ID.test(row.station_id)) fail(`${where}: invalid station id ${row.station_id}`);
      if (row.country !== code || !COUNTRY.test(row.country)) fail(`${where}: country does not match filename`);
      if (!row.name) fail(`${where}: empty station name`);
      if (!/^\d+(?:\.\d+)?$/.test(row.bitrate) || Number(row.bitrate) < 0) fail(`${where}: invalid bitrate`);
      if (!['true', 'false'].includes(row.hls)) fail(`${where}: invalid hls flag`);
      if (!['true', 'false'].includes(row.last_check_ok)) fail(`${where}: invalid last_check_ok flag`);
      if (!row.sources || !row.source_ids) fail(`${where}: missing provenance`);
      try {
        const url = new URL(row.url);
        if (!['http:', 'https:'].includes(url.protocol)) fail(`${where}: unsupported URL protocol`);
        if (row.protocol !== url.protocol.slice(0, -1)) fail(`${where}: protocol field does not match URL`);
      } catch {
        fail(`${where}: invalid stream URL`);
      }
    }

    try {
      const playlist = await readFile(join(PLAYLISTS, `${code.toLowerCase()}.m3u`), 'utf8');
      const entries = playlist.split('\n').filter((line) => line.startsWith('#EXTINF:')).length;
      if (entries !== parsed.rows.length) fail(`${code}: playlist entry count ${entries} != ${parsed.rows.length}`);
    } catch {
      fail(`${code}: missing country playlist`);
    }
  }

  const index = JSON.parse(await readFile(join(DATA, 'index.json'), 'utf8'));
  if (Number(index.stream_count) !== streamCount) fail(`index.json: stream_count ${index.stream_count} != ${streamCount}`);
  if (index.countries?.length !== countryCounts.size) fail(`index.json: country count ${index.countries?.length} != ${countryCounts.size}`);
  for (const item of index.countries || []) {
    const actual = countryCounts.get(item.code);
    if (actual === undefined) fail(`index.json: missing country file for ${item.code}`);
    else if (actual !== Number(item.stream_count)) fail(`index.json: count mismatch for ${item.code}: ${item.stream_count} != ${actual}`);
  }

  if (errors.length) {
    for (const error of errors) process.stderr.write(`ERROR ${error}\n`);
    process.stderr.write(`Validation failed with ${errors.length}${errors.length === 200 ? '+' : ''} errors\n`);
    process.exit(1);
  }

  process.stdout.write(`Validated ${streamCount} streams and ${countryCounts.size} country playlists\n`);
}

await main();
