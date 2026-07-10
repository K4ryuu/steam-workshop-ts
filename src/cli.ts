#!/usr/bin/env node

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { SteamWorkshopClient, SteamCmdWrapper } from "./index.js";
import type { PublishedFileDetails, QueryItemsOptions, SteamCmdOptions, DownloadOptions, DownloadProgress } from "./index.js";

function getPackageVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const rel of ["../package.json", "../../package.json"]) {
      const path = join(dir, rel);
      if (existsSync(path))
        return JSON.parse(readFileSync(path, "utf8")).version || "1.0.0";
    }
  } catch {}

  return "1.0.0";
}

function printHelp(): void {
  console.log(`
\x1b[36msteam-workshop CLI\x1b[0m - Steam Workshop Web API + SteamCMD automation

\x1b[1mUsage:\x1b[0m
  steam-workshop info <id...>
  steam-workshop query <appId> <search...> [--type <n>] [--page <n>] [--per-page <n>]
  steam-workshop collection <collectionId>
  steam-workshop download <appId> <targetDir> <id...> [--docker] [--temp] [--cache-dir <dir>] [--username <u>] [--password <p>]

\x1b[1mOptions:\x1b[0m
  --type <n>        Query type (0 vote, 1 date, 3 trend, 9 accepted). Default: 0
  --page <n>        Page number (query). Default: 1
  --per-page <n>    Items per page (query, max 100). Default: 20
  --docker          Download inside a temporary Docker container (macOS-friendly)
  --temp            Install SteamCMD into a temp dir and clean it up afterwards
  --cache-dir <dir> Persistent Steam cache dir for Docker mode (incremental updates)
  --username <u>    Steam account (default: anonymous)
  --password <p>    Steam password (for non-anonymous downloads)
  -h, --help        Show this help menu

\x1b[1mEnvironment:\x1b[0m
  STEAM_API_KEY     Steam Web API key, required for 'query'

\x1b[1mExamples:\x1b[0m
  steam-workshop info 3070244462
  steam-workshop query 730 surf --per-page 10
  steam-workshop collection 2753947063
  steam-workshop download 730 ./addons 3070244462 --docker
`);
}

function fail(message: string): never {
  console.error(`\x1b[31mError:\x1b[0m ${message}`);
  process.exit(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`;

  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`;

  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;

  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0)
    return "--:--";

  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Builds an onProgress handler that redraws a single-line progress bar on stderr,
 * with a moving-average download speed and ETA. Only meaningful on a TTY.
 */
function createProgressBar(): (p: DownloadProgress) => void {
  const width = 22;
  let lastBytes = 0;
  let lastTime = Date.now();
  let speed = 0;

  return (p) => {
    const now = Date.now();
    const dt = (now - lastTime) / 1000;
    if (dt >= 0.25) {
      const delta = p.downloadedBytes - lastBytes;
      if (delta >= 0)
        speed = delta / dt;

      lastBytes = p.downloadedBytes;
      lastTime = now;
    }

    const pct = Math.max(0, Math.min(100, p.percent));
    const filled = Math.round((pct / 100) * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    const eta = speed > 0 ? (p.totalBytes - p.downloadedBytes) / speed : Infinity;
    const line = `  \x1b[36m[${bar}]\x1b[0m ${pct.toFixed(1).padStart(5)}%  ${formatBytes(p.downloadedBytes)} / ${formatBytes(p.totalBytes)}  \x1b[33m${formatBytes(speed)}/s\x1b[0m  ETA ${formatEta(eta)}`;
    process.stderr.write(`\r\x1b[K${line}`);
  };
}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const valueFlags = new Set(["--type", "--page", "--per-page", "--username", "--password", "--cache-dir"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }

    if (valueFlags.has(arg)) {
      const value = argv[++i];
      if (value === undefined)
        fail(`Missing value for ${arg}`);

      flags.set(arg, value);
    } else {
      flags.set(arg, true);
    }
  }

  return { positional, flags };
}

function printItem(item: PublishedFileDetails): void {
  console.log(`\x1b[1m${item.title || "(untitled)"}\x1b[0m  \x1b[90m${item.publishedfileid}\x1b[0m`);
  if (item.filename)
    console.log(`  File:  ${item.filename}`);

  if (item.file_size)
    console.log(`  Size:  ${formatBytes(parseInt(item.file_size, 10))}`);

  if (item.file_url)
    console.log(`  URL:   ${item.file_url}`);

  if (item.tags && item.tags.length > 0)
    console.log(`  Tags:  ${item.tags.map((t) => t.tag).join(", ")}`);
}

async function cmdInfo(args: ParsedArgs): Promise<void> {
  const ids = args.positional;
  if (ids.length === 0)
    fail("Usage: steam-workshop info <id...>");

  const client = new SteamWorkshopClient();
  const details = await client.getItemDetails(ids);
  if (details.length === 0)
    fail("No details found (items may be private or the IDs are invalid).");

  for (const item of details)
    printItem(item);
}

async function cmdQuery(args: ParsedArgs): Promise<void> {
  const [appId, ...searchParts] = args.positional;
  if (!appId)
    fail("Usage: steam-workshop query <appId> <search...>");

  const apiKey = process.env.STEAM_API_KEY;
  if (!apiKey)
    fail("query requires a Steam Web API key in the STEAM_API_KEY environment variable.");

  const options: QueryItemsOptions = { appId: parseInt(appId, 10) };
  const search = searchParts.join(" ");
  if (search)
    options.searchText = search;

  const type = numFlag(args, "--type");
  if (type !== undefined)
    options.queryType = type;

  const page = numFlag(args, "--page");
  if (page !== undefined)
    options.page = page;

  const perPage = numFlag(args, "--per-page");
  if (perPage !== undefined)
    options.numPerPage = perPage;

  const client = new SteamWorkshopClient(apiKey);
  const result = await client.queryItems(options);

  console.log(`\x1b[32mFound ${result.total} item(s), showing ${result.items.length}:\x1b[0m\n`);
  for (const item of result.items)
    printItem(item);
}

async function cmdCollection(args: ParsedArgs): Promise<void> {
  const [collectionId] = args.positional;
  if (!collectionId)
    fail("Usage: steam-workshop collection <collectionId>");

  const client = new SteamWorkshopClient();
  const items = await client.getCollectionItems(collectionId);
  if (items.length === 0)
    fail("Collection is empty or not found.");

  console.log(`\x1b[32m${items.length} item(s) in collection ${collectionId}:\x1b[0m\n`);
  for (const item of items)
    printItem(item);
}

async function cmdDownload(args: ParsedArgs): Promise<void> {
  const [appId, targetDir, ...ids] = args.positional;
  if (!appId || !targetDir || ids.length === 0)
    fail("Usage: steam-workshop download <appId> <targetDir> <id...>");

  const steamOptions: SteamCmdOptions = {
    useDocker: args.flags.has("--docker"),
    useTempDir: args.flags.has("--temp"),
  };
  const username = strFlag(args, "--username");
  if (username !== undefined)
    steamOptions.username = username;

  const password = strFlag(args, "--password");
  if (password !== undefined)
    steamOptions.password = password;

  const cacheDir = strFlag(args, "--cache-dir");
  if (cacheDir !== undefined)
    steamOptions.steamCacheDir = cacheDir;

  // Cache item details so downloadItemsCached reuses our size lookup below.
  const client = new SteamWorkshopClient(undefined, { cacheTtlMs: 30_000 });
  const steamcmd = new SteamCmdWrapper(steamOptions);
  const numericIds = ids.map((id) => parseInt(id, 10));

  // SteamCMD reports no live byte progress for workshop items, so we fetch the total
  // size up front and show a spinner + elapsed time, then the average speed at the end.
  let expectedBytes = 0;
  try {
    const details = await client.getItemDetails(ids);
    for (const d of details)
      expectedBytes += parseInt(d.file_size || "0", 10);
  } catch {}

  const isTty = process.stderr.isTTY === true;
  const startedAt = Date.now();
  const downloadOptions: DownloadOptions = {};
  let sawProgress = false;
  if (isTty) {
    const bar = createProgressBar();
    downloadOptions.onProgress = (p) => {
      sawProgress = true;
      bar(p);
    };
  }

  const totalLabel = expectedBytes ? ` (${formatBytes(expectedBytes)})` : "";
  console.log(`\x1b[36mDownloading ${ids.length} item(s) for app ${appId}${totalLabel}...\x1b[0m`);

  let spinner: ReturnType<typeof setInterval> | undefined;
  if (isTty) {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    spinner = setInterval(() => {
      if (sawProgress)
        return; // real progress lines are driving the bar instead

      const secs = Math.floor((Date.now() - startedAt) / 1000);
      const of = expectedBytes ? ` / ${formatBytes(expectedBytes)}` : "";
      process.stderr.write(`\r\x1b[K  \x1b[36m${frames[i++ % frames.length]!}\x1b[0m downloading${of}  ${secs}s`);
    }, 120);
  }

  let paths: { [itemId: number]: string };
  try {
    paths = await client.downloadItemsCached(parseInt(appId, 10), numericIds, steamcmd, targetDir, downloadOptions);
  } finally {
    if (spinner)
      clearInterval(spinner);

    if (isTty)
      process.stderr.write("\r\x1b[K");
  }

  const elapsed = (Date.now() - startedAt) / 1000;
  let summary: string;
  if (elapsed < 1) {
    // Returned almost instantly: nothing was downloaded, the cache was already current.
    summary = expectedBytes ? ` (up to date, ${formatBytes(expectedBytes)})` : " (up to date)";
  } else if (expectedBytes) {
    summary = `: ${formatBytes(expectedBytes)} in ${elapsed.toFixed(1)}s (${formatBytes(expectedBytes / elapsed)}/s)`;
  } else {
    summary = ` in ${elapsed.toFixed(1)}s`;
  }

  console.log(`\x1b[32mDone\x1b[0m${summary}`);
  for (const [id, path] of Object.entries(paths))
    console.log(`  ${id} -> ${path}`);
}

function numFlag(args: ParsedArgs, name: string): number | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? parseInt(value, 10) : undefined;
}

function strFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "info":
      await cmdInfo(args);
      break;
    case "query":
      await cmdQuery(args);
      break;
    case "collection":
      await cmdCollection(args);
      break;
    case "download":
      await cmdDownload(args);
      break;
    case "-v":
    case "--version":
      console.log(getPackageVersion());
      break;
    default:
      printHelp();
      process.exit(command && command !== "-h" && command !== "--help" ? 1 : 0);
  }
}

main().catch((err: unknown) => fail((err as Error).message));
