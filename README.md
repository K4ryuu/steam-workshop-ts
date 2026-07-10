<a name="readme-top"></a>

<!-- BADGES -->
<div align="center">

![NPM Version](https://img.shields.io/npm/v/steam-workshop-ts?style=for-the-badge&label=NPM)
![GitHub License](https://img.shields.io/github/license/K4ryuu/steam-workshop-ts?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Bundle Size](https://img.shields.io/bundlephobia/minzip/steam-workshop-ts?style=for-the-badge&label=Bundle%20Size)

</div>

<!-- PROJECT TITLE -->
<br />
<div align="center">
  <h1 align="center">steam-workshop-ts</h1>
  <p align="center">
    Ultra-lightweight, zero-dependency client for Steam Workshop Web API and SteamCMD automation
    <br />
    <strong>Zero runtime dependencies • Pure TypeScript • Automatic Path Extraction • Fully Type-Safe</strong>
    <br />
    <br />
    <a href="#installation"><strong>Get Started »</strong></a>
  </p>
</div>

## About The Project

Managing Steam Workshop items (maps, mods, plugins) programmatically for game servers like Counter-Strike 2 (CS2), CS:GO, Garry's Mod (GMod), or Dota 2 is usually clunky.

This library is a modern, lightweight, pure TypeScript package to:
1. Query Workshop item details using Steam's Web API.
2. Search and filter the Workshop and resolve collections.
3. Download and update workshop items via `steamcmd`, with automatic path extraction, caching, and a CLI.

It runs on Node.js and Bun with absolutely zero runtime dependencies.

## Why this package is special

- **Zero runtime dependencies** - Only development dependencies are used.
- **Smart path parser** - Automatically starts a SteamCMD subprocess, downloads files, parses stdout, and returns the absolute directory path of the downloaded workshop item.
- **Caching & incremental updates** - Manifest-based cache with pre-flight disk-space checks, plus an optional persistent Steam depot cache (`steamCacheDir`) for fast, low-bandwidth re-downloads.
- **Batteries included** - A `steam-workshop` CLI, automatic retries with backoff, Steam Guard 2FA support, collection resolution, and Docker/temp-dir sandbox modes (macOS-friendly).
- **Supports Bun and Node.js** - Fully cross-compatible, with complete type safety over Steam's query and details responses.

## Installation

```bash
npm install steam-workshop-ts
pnpm add steam-workshop-ts
bun add steam-workshop-ts
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Quick example

### 1. Fetching Workshop Item Details

No API Key is required to fetch details for public items:

```typescript
import { SteamWorkshopClient } from "steam-workshop-ts";

const client = new SteamWorkshopClient();
const details = await client.getItemDetails("3167383610");

if (details.length > 0) {
  const map = details[0];
  console.log(`Title: ${map.title}`);
  console.log(`Size:  ${map.file_size} bytes`);
  console.log(`URL:   ${map.file_url}`);
}
```

### 2. Searching/Querying Workshop Items

Requires a Steam Web API Key:

```typescript
import { SteamWorkshopClient } from "steam-workshop-ts";

const client = new SteamWorkshopClient("YOUR_STEAM_API_KEY");

const results = await client.queryItems({
  appId: 730, // CS2
  searchText: "surf",
  numPerPage: 10,
});

console.log(`Found ${results.total} surf maps.`);
for (const item of results.items) {
  console.log(`- ${item.title} (${item.publishedfileid})`);
}
```

### 3. Programmatic Download via SteamCMD

```typescript
import { SteamCmdWrapper } from "steam-workshop-ts";

const steamcmd = new SteamCmdWrapper({
  binPath: "/usr/games/steamcmd", // Defaults to resolving "steamcmd" from PATH
});

// Downloads item 3167383610 (CS2 map VPK) and returns absolute folder path
const downloadPath = await steamcmd.downloadItem(730, 3167383610);
console.log(`Map downloaded and saved at: ${downloadPath}`);
```

### 4. Resolving Workshop Collections

A workshop collection is a list of child items. You can resolve the children IDs and fetch details for all of them in one helper call:

```typescript
import { SteamWorkshopClient } from "steam-workshop-ts";

const client = new SteamWorkshopClient();

// Get details for all maps inside a collection
const items = await client.getCollectionItems("YOUR_COLLECTION_ID");
for (const item of items) {
  console.log(`Child Map: ${item.title} (${item.publishedfileid})`);
}
```

### 5. SteamCMD Auto-Installation

If SteamCMD is not installed on the system, you can download and install it programmatically to a local directory:

```typescript
import { SteamCmdWrapper } from "steam-workshop-ts";

const steamcmd = new SteamCmdWrapper();

// Automatically detects process.platform, downloads zip/tar.gz from Steam CDN, 
// extracts it to the local directory, and makes the binary executable.
const binPath = await steamcmd.autoInstall("./bin/steamcmd");
console.log(`SteamCMD binary ready at: ${binPath}`);

// Now downloadItem will use the auto-installed binary automatically!
const path = await steamcmd.downloadItem(730, 3167383610);
```

### 6. Sandbox Download Modes (Docker & Temp Dir)

Prevent host system pollution or compatibility issues (especially on macOS which cannot run the 32-bit SteamCMD locally):

```typescript
import { SteamCmdWrapper, SteamWorkshopClient } from "steam-workshop-ts";

// 1. Docker Sandbox Mode (Uses official steamcmd/steamcmd Docker image)
const steamcmdDocker = new SteamCmdWrapper({
  useDocker: true
});

// 2. Temp Directory Sandbox Mode (Installs SteamCMD to OS temp folder and auto-deletes it)
const steamcmdTemp = new SteamCmdWrapper({
  useTempDir: true
});

// The wrapper automatically handles downloading and self-cleaning!
const client = new SteamWorkshopClient();
const path = await client.downloadItemCached(730, 3167383610, steamcmdDocker, "./addons");
```

### 7. Pre-flight Disk Space Validation

Before starting any download via `downloadItemCached`, the client queries the Web API for `file_size` and compares it to the remaining disk space using native system commands (`df` or PowerShell):

```typescript
import { SteamWorkshopClient, SteamCmdWrapper } from "steam-workshop-ts";

const client = new SteamWorkshopClient();
const steamcmd = new SteamCmdWrapper();

try {
  // Throws an error before executing SteamCMD if disk is full
  await client.downloadItemCached(730, 3167383610, steamcmd, "./addons");
} catch (err) {
  console.error((err as Error).message); // "Insufficient disk space on the host machine..."
}
```

### 8. Steam Guard 2FA Support & Timeout Options

Set process execution timeouts and supply Steam Guard 2FA authentication codes dynamically on demand to prevent hanging scripts:

```typescript
import { SteamCmdWrapper } from "steam-workshop-ts";

const steamcmd = new SteamCmdWrapper({
  username: "my_steam_account",
  password: "my_password"
});

const path = await steamcmd.downloadItem(730, 3167383610, {
  timeout: 60000, // Kill process if it takes longer than 60 seconds
  onSteamGuardRequired: async (attempt) => {
    // Fetch code from SMS, email, or stdin
    return "12AB3";
  }
});
```
### 9. Download Progress, Retries & Caching

```typescript
import { SteamWorkshopClient, SteamCmdWrapper } from "steam-workshop-ts";

// Retries transient 429/5xx with backoff, and memo-caches item details for 60s
const client = new SteamWorkshopClient(undefined, { maxRetries: 5, cacheTtlMs: 60_000 });
const steamcmd = new SteamCmdWrapper();

await steamcmd.downloadItem(730, 3167383610, {
  onProgress: (p) => {
    process.stdout.write(`\r${p.percent.toFixed(1)}% (${p.downloadedBytes}/${p.totalBytes})`);
  },
});
```

> Note: SteamCMD does not report byte-level progress for `workshop_download_item`, so `onProgress` stays silent for workshop items (it fires only when SteamCMD emits progress, e.g. app content). For a progress indicator, use the total size from `getItemDetails` (`file_size`) with a spinner, as the CLI does.

### 10. Persistent Cache & Pruning

```typescript
// Reuse Steam's depot cache across runs (Docker mode) for incremental, low-bandwidth updates
const fast = new SteamCmdWrapper({ useDocker: true, steamCacheDir: "./.steam-cache" });
await client.downloadItemsCached(730, [3070244462], fast, "./addons");

// Remove every cached item except the ones still in use; returns the pruned IDs
const removed = client.pruneCache("./addons", [3070244462, 3167383610]);
console.log(`Freed ${removed.length} stale item(s).`);
```

```typescript
// Remove every cached item except the ones still in use; returns the pruned IDs
const removed = client.pruneCache("./addons", [3070244462, 3167383610]);
console.log(`Freed ${removed.length} stale item(s).`);
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## CLI

Installed as `steam-workshop` (also runnable with `npx steam-workshop`):

```bash
steam-workshop info 3070244462                       # metadata for one or more item IDs
steam-workshop query 730 surf --per-page 10          # search (needs STEAM_API_KEY)
steam-workshop collection 2753947063                 # list a collection's items
steam-workshop download 730 ./addons 3070244462 --docker   # download into ./addons
steam-workshop download 730 ./addons 3070244462 --docker --cache-dir ./.steam-cache  # incremental
```

`query` reads the Steam Web API key from the `STEAM_API_KEY` environment variable. `download` accepts `--docker`, `--temp`, `--cache-dir <dir>`, `--username` and `--password`, and shows a spinner with elapsed time plus the final average speed.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## API

### `SteamWorkshopClient`

| Member | Description |
|---|---|
| `new SteamWorkshopClient(apiKey?, options?)` | Create a client; the API key is only needed for `queryItems`. Options: `maxRetries`, `retryDelayMs`, `cacheTtlMs` |
| `getItemDetails(ids)` | Metadata for one or many item IDs (no key required); auto-chunks >100 IDs and caches when `cacheTtlMs` is set |
| `queryItems(options)` | Search/filter/page the Workshop (`QueryFiles`, key required) |
| `getCollectionDetails(ids)` | Raw child IDs of one or many collections |
| `getCollectionItems(collectionId)` | Resolve a collection to its children's full details |
| `downloadItemCached(appId, itemId, steamcmd, targetDir)` | Download one item into `targetDir/itemId` only if missing/outdated; validates disk space and cleans the SteamCMD sandbox |
| `downloadItemsCached(appId, itemIds, steamcmd, targetDir)` | Batched cached download; one Web API call + one SteamCMD session |
| `pruneCache(targetDir, keepIds)` | Delete cached items not in `keepIds` (dir + manifest entry); returns the pruned IDs |

### `SteamCmdWrapper`

| Member | Description |
|---|---|
| `new SteamCmdWrapper(options?)` | Configure bin path, credentials, sandbox mode (`useDocker` / `useTempDir`), and `steamCacheDir` (persistent Docker cache for incremental updates) |
| `downloadItem(appId, itemId, options?)` | Download one item, returns its absolute path. Options: `timeout`, `onProgress`, `onSteamGuardRequired` |
| `downloadItems(appId, itemIds, options?)` | Batch download in a single session, returns an ID → path map |
| `downloadItemsManaged(appId, itemIds, options?)` | Like `downloadItems`, but returns `{ paths, cleanup }` so you can remove the sandbox temp dir after copying |
| `autoInstall(targetDir)` | Download + extract SteamCMD for the current platform |

### Utilities

| Member | Description |
|---|---|
| `getFreeDiskSpace(path)` | Free bytes on the disk holding `path`, or `Infinity` if the probe fails |

All types (`PublishedFileDetails`, `QueryItemsOptions`, `QueryItemsResult`, `CollectionDetails`, `SteamWorkshopClientOptions`, `SteamCmdOptions`, `DownloadOptions`, `DownloadProgress`, `ManagedDownloadResult`) are exported.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Examples

Runnable from the repo root:

```bash
bun run examples/basic.ts                 # fetch item details + a Docker sandbox download
STEAM_API_KEY=xxxx bun run examples/query.ts   # search the Workshop (needs a Web API key)
bun run examples/collection.ts [collectionId]  # resolve a collection to its items
bun run examples/cached-download.ts       # cached download + progress bar + cache prune
bun run examples/sandbox.ts               # Docker / temp-dir / explicit-install download modes
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Testing

```bash
bun test          # unit tests with mocked SteamCMD + Web API (no network, no real download)
bun run lint      # eslint on src, test, examples
bun run type-check
```

## Contributing

Please check [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

Distributed under the MIT License. See `LICENSE` for more information.
