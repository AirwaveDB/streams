# AirwaveDB Streams

Canonical stream data for the AirwaveDB internet radio directory.

This repository stores playable stream endpoints linked to stable station IDs from [`AirwaveDB/database`](https://github.com/AirwaveDB/database). Applications should normally consume [`AirwaveDB/api`](https://github.com/AirwaveDB/api) instead of reading the CSV files directly.

## API

Public JSON data is available from:

```text
https://raw.githubusercontent.com/AirwaveDB/api/main/v1
```

Examples:

```text
/streams.json
/countries/jp.json
/countries/us.json
```

## Data

- `data/streams/<CC>.csv` — stream metadata by country
- `streams/<cc>.m3u` — country playlists
- `data/index.json` — stream counts and country index

## Stream schema

| Field | Description |
| --- | --- |
| `id` | Stable AirwaveDB stream identifier derived from station ID and URL |
| `station_id` | Station identifier from AirwaveDB/database |
| `name` | Display name supplied by the upstream directory |
| `country` | ISO 3166-1 alpha-2 country code |
| `url` | Direct stream endpoint |
| `codec` | Reported codec |
| `bitrate` | Reported bitrate in kbit/s, `0` when unknown |
| `protocol` | URL protocol |
| `hls` | Whether the endpoint appears to be HLS |
| `sources` | Upstream datasets that reported the endpoint |
| `source_ids` | Upstream record identifiers |
| `last_check_ok` | Last known upstream availability state |
| `last_checked_at` | Most recent upstream verification timestamp |

An endpoint listed here is not hosted or proxied by AirwaveDB. Availability can change at any time.

## Playlists

Country playlists use lowercase ISO country codes:

```text
streams/jp.m3u
streams/us.m3u
streams/de.m3u
```

Each M3U entry includes `station-id`, `stream-id`, codec, and bitrate attributes.

## Sources

The automated import currently uses Radio Browser and verified-radio-streams. Source records are matched through `AirwaveDB/database/data/source_map.csv`, so station identity remains separate from stream identity.

## Updates

Streams are rebuilt automatically after the database update window. A large unexpected shrink is rejected rather than replacing a healthy snapshot with incomplete upstream data.

## License

AirwaveDB's directory data is released under CC0 1.0. Stream URLs and broadcasts are controlled by their respective operators and rights holders.