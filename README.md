# AirwaveDB Streams

Canonical stream data for the AirwaveDB internet radio directory.

This repository stores playable stream endpoints linked to stable station IDs from [`AirwaveDB/database`](https://github.com/AirwaveDB/database). Consumer applications should use [`AirwaveDB/api`](https://github.com/AirwaveDB/api).

## Data

- `data/streams/<CC>.json` — stream metadata split by ISO 3166-1 alpha-2 country code
- `streams/<cc>.m3u` — country playlists
- `data/index.json` — stream counts, source database snapshot, identity strategy, quality counters, and country index

## Stream schema

The canonical machine-readable schema is [`schema/stream.schema.json`](schema/stream.schema.json), using JSON Schema 2020-12.

```json
{
  "id": "aws_ff0d260f65138a051d9e",
  "stationId": "awb_c89923852f31a58c4a4c",
  "name": "Example Radio",
  "country": "JP",
  "url": "https://example.com/live.mp3",
  "codec": "mp3",
  "bitrate": 128,
  "protocol": "https",
  "hls": false,
  "sources": ["radio-browser"],
  "sourceIds": ["source-record-id"],
  "lastCheckOk": true,
  "lastCheckedAt": "2026-10-13T00:00:00Z"
}
```

`sources` and `sourceIds` are provenance sets. They record which upstream datasets and upstream identifiers contributed to the endpoint; their array positions are not a source-to-ID mapping contract.

Stream IDs are stabilized from upstream provenance and the previous canonical snapshot. A broadcaster can rotate or sign its playback URL without forcing a new AirwaveDB stream ID when the upstream stream identity is still known. If a previously merged endpoint later splits into multiple endpoints, one branch keeps the old ID and the others receive new deterministic IDs so IDs remain unique.

An endpoint listed here is not hosted or proxied by AirwaveDB. Availability can change at any time.

## Playlists

Country playlists use lowercase ISO country codes:

```text
streams/jp.m3u
streams/us.m3u
streams/de.m3u
```

Each M3U entry includes `station-id`, `stream-id`, codec, and bitrate attributes.

## Public API

The consumer-facing API is maintained in [`AirwaveDB/api`](https://github.com/AirwaveDB/api).

Routes include:

```text
/v1/stations/:id
/v1/countries/:code
/v1/categories/:id
/v1/languages/:code
```

## Sources

The automated import currently uses Radio Browser and verified-radio-streams. Source records are matched through `AirwaveDB/database/data/source_map.json`, keeping station identity separate from stream identity.

## Updates

Streams are rebuilt automatically after the database update window. `data/index.json` records the exact `databaseGeneratedAt` snapshot used by the build so downstream API builds can reject mismatched database/stream generations. A large unexpected reduction is rejected instead of replacing a healthy snapshot with incomplete upstream data.

## License

AirwaveDB's directory data is released under CC0 1.0. Stream URLs and broadcasts are controlled by their respective operators and rights holders.
