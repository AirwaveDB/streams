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
const errors = [];

function fail(message) {
  if (errors.length < 200) errors.push(message);
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function unique(values) {
  return Array.isArray(values) && new Set(values).size === values.length;
}

async function main() {
  const files = (await readdir(STREAM_DATA)).filter((name) => /^[A-Z]{2}\.json$/.test(name)).sort();
  if (!files.length) fail('data/streams: no country files found');

  const ids = new Set();
  const countryCounts = new Map();
  let streamCount = 0;
  let withCodec = 0;
  let withBitrate = 0;
  let hls = 0;
  let sourceCheckOk = 0;

  for (const file of files) {
    const code = file.slice(0, 2);
    const rows = await json(join(STREAM_DATA, file));
    if (!Array.isArray(rows)) {
      fail(`${file}: expected JSON array`);
      continue;
    }
    countryCounts.set(code, rows.length);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const where = `${file}[${i}]`;
      streamCount++;

      if (!STREAM_ID.test(row.id)) fail(`${where}: invalid stream id ${row.id}`);
      if (ids.has(row.id)) fail(`${where}: duplicate stream id ${row.id}`);
      ids.add(row.id);
      if (!STATION_ID.test(row.stationId)) fail(`${where}: invalid station id ${row.stationId}`);
      if (row.country !== code || !COUNTRY.test(row.country)) fail(`${where}: country does not match filename`);
      if (!row.name || typeof row.name !== 'string') fail(`${where}: empty station name`);
      if (row.codec !== null && typeof row.codec !== 'string') fail(`${where}: invalid codec`);
      if (!Number.isInteger(row.bitrate) || row.bitrate < 0) fail(`${where}: invalid bitrate`);
      if (typeof row.hls !== 'boolean') fail(`${where}: hls must be boolean`);
      if (typeof row.lastCheckOk !== 'boolean') fail(`${where}: lastCheckOk must be boolean`);
      if (row.lastCheckedAt && Number.isNaN(Date.parse(row.lastCheckedAt))) fail(`${where}: invalid lastCheckedAt ${row.lastCheckedAt}`);

      if (!Array.isArray(row.sources) || !row.sources.length) fail(`${where}: missing sources`);
      if (!Array.isArray(row.sourceIds) || !row.sourceIds.length) fail(`${where}: missing sourceIds`);
      if (row.sources?.length !== row.sourceIds?.length) fail(`${where}: sources/sourceIds length mismatch`);
      if (!unique(row.sources)) fail(`${where}: duplicate source names`);
      const provenance = (row.sources || []).map((source, index) => `${source}:${row.sourceIds?.[index] || ''}`);
      if (!unique(provenance)) fail(`${where}: duplicate provenance pair`);
      if (provenance.some((value) => value.endsWith(':'))) fail(`${where}: empty source id`);

      try {
        const url = new URL(row.url);
        if (!['http:', 'https:'].includes(url.protocol)) fail(`${where}: unsupported URL protocol`);
        if (row.protocol !== url.protocol.slice(0, -1)) fail(`${where}: protocol field does not match URL`);
      } catch {
        fail(`${where}: invalid stream URL`);
      }

      if (row.codec) withCodec++;
      if (row.bitrate > 0) withBitrate++;
      if (row.hls) hls++;
      if (row.lastCheckOk) sourceCheckOk++;
    }

    try {
      const playlist = await readFile(join(PLAYLISTS, `${code.toLowerCase()}.m3u`), 'utf8');
      if (!playlist.startsWith('#EXTM3U\n')) fail(`${code}: playlist is missing #EXTM3U header`);
      const entries = playlist.split('\n').filter((line) => line.startsWith('#EXTINF:')).length;
      if (entries !== rows.length) fail(`${code}: playlist entry count ${entries} != ${rows.length}`);
    } catch {
      fail(`${code}: missing country playlist`);
    }
  }

  const index = await json(join(DATA, 'index.json'));
  if (Number(index.schemaVersion) !== 1) fail(`index.json: unsupported schemaVersion ${index.schemaVersion}`);
  if (!index.databaseGeneratedAt || Number.isNaN(Date.parse(index.databaseGeneratedAt))) {
    fail(`index.json: invalid databaseGeneratedAt ${index.databaseGeneratedAt}`);
  }
  if (Number(index.streamCount) !== streamCount) fail(`index.json: streamCount ${index.streamCount} != ${streamCount}`);
  if (index.countries?.length !== countryCounts.size) fail(`index.json: country count ${index.countries?.length} != ${countryCounts.size}`);
  for (const item of index.countries || []) {
    const actual = countryCounts.get(item.code);
    if (actual === undefined) fail(`index.json: missing country file for ${item.code}`);
    else if (actual !== Number(item.streamCount)) fail(`index.json: count mismatch for ${item.code}: ${item.streamCount} != ${actual}`);
  }

  const quality = index.quality || {};
  if (Number(quality.withCodec) !== withCodec) fail(`index.json: quality.withCodec ${quality.withCodec} != ${withCodec}`);
  if (Number(quality.withBitrate) !== withBitrate) fail(`index.json: quality.withBitrate ${quality.withBitrate} != ${withBitrate}`);
  if (Number(quality.hls) !== hls) fail(`index.json: quality.hls ${quality.hls} != ${hls}`);
  if (Number(quality.sourceCheckOk) !== sourceCheckOk) fail(`index.json: quality.sourceCheckOk ${quality.sourceCheckOk} != ${sourceCheckOk}`);
  if (Number(quality.unknownCountry) !== (countryCounts.get('ZZ') || 0)) {
    fail(`index.json: quality.unknownCountry ${quality.unknownCountry} != ${countryCounts.get('ZZ') || 0}`);
  }

  if (errors.length) {
    for (const error of errors) process.stderr.write(`ERROR ${error}\n`);
    process.stderr.write(`Validation failed with ${errors.length}${errors.length === 200 ? '+' : ''} errors\n`);
    process.exit(1);
  }

  process.stdout.write(`Validated ${streamCount} streams and ${countryCounts.size} country playlists\n`);
}

await main();
