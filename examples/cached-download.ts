import { SteamWorkshopClient, SteamCmdWrapper } from "../src/index.js";

// End-to-end cached download with a live progress bar, then a cache prune.
// Client is configured to retry transient API errors and memo-cache item details.
const client = new SteamWorkshopClient(undefined, {
  maxRetries: 5,
  cacheTtlMs: 60_000,
});

const steamcmd = new SteamCmdWrapper({
  useDocker: true, // macOS-friendly, no host pollution
});

const targetDir = "./cached_workshop_content";
const wantedItems = [3070244462]; // Aim Botz (CS2)

console.log("Downloading (only if missing or outdated)...");
try {
  const paths = await client.downloadItemsCached(730, wantedItems, steamcmd, targetDir);
  for (const [id, path] of Object.entries(paths))
    console.log(`  ${id} -> ${path}`);

  // Drop anything in the cache that is no longer in our wanted list.
  const removed = client.pruneCache(targetDir, wantedItems);
  console.log(`Pruned ${removed.length} stale item(s) from the cache.`);
} catch (err: unknown) {
  const error = err as Error;
  console.error("Cached download failed:", error.message);
}

// A single item download can report byte-level progress as SteamCMD runs.
console.log("\nDownloading one item with progress reporting...");
try {
  await steamcmd.downloadItem(730, 3070244462, {
    onProgress: (p) => {
      process.stdout.write(`\r  ${p.percent.toFixed(1)}% (${p.downloadedBytes}/${p.totalBytes})   `);
    },
  });
  console.log("\n  Done.");
} catch (err: unknown) {
  const error = err as Error;
  console.error("\nDownload failed:", error.message);
}
