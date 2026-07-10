# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-07-11

- Initial release
- Modern, zero-dependency TypeScript wrapper for the Steam Workshop Web API
- `GetPublishedFileDetails` support for querying item metadata (auto-chunks >100 IDs, fetched in parallel)
- `QueryFiles` support for advanced searching, filtering, and paging of workshop items
- Collection resolution: `getCollectionDetails` + `getCollectionItems`
- `SteamCmdWrapper` for programmatic downloads/updates via SteamCMD, with automatic download-path parsing
- Docker and temp-dir sandbox download modes with correct temp cleanup (`downloadItemsManaged` returns `{ paths, cleanup }`)
- Cached downloads (`downloadItemCached` / `downloadItemsCached`) with pre-flight disk-space validation, plus `pruneCache` to evict unused items
- Persistent Docker Steam cache (`steamCacheDir`) for incremental, low-bandwidth updates
- Download progress via `onProgress` (for SteamCMD progress output), Steam Guard 2FA callback, and per-run timeouts
- CLI `download` shows a spinner with elapsed time and the final average speed (workshop items report no byte progress via SteamCMD)
- Automatic retries with exponential backoff for transient Web API failures (429/5xx/network), honouring `Retry-After`
- Optional in-memory item-details cache (`cacheTtlMs`)
- `steam-workshop` CLI: `info`, `query`, `collection`, `download`
- Uses `execFile` (no shell) for SteamCMD extraction and disk-space probing
