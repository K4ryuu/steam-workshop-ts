import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from "fs";
import { join } from "path";
import { SteamCmdWrapper } from "./steamcmd.js";
import type { DownloadOptions } from "./steamcmd.js";
import { getFreeDiskSpace } from "./utils.js";

export interface PublishedFileDetails {
  publishedfileid: string;
  result: number;
  creator?: string;
  creator_app_id?: number;
  consumer_app_id?: number;
  filename?: string;
  file_size?: string;
  file_url?: string;
  hcontent_file?: string;
  preview_url?: string;
  hcontent_preview?: string;
  title?: string;
  description?: string;
  time_created?: number;
  time_updated?: number;
  visibility?: number;
  banned?: number;
  ban_reason?: string;
  subscriptions?: number;
  favorited?: number;
  lifetime_subscriptions?: number;
  lifetime_favorited?: number;
  views?: number;
  tags?: { tag: string }[];
}

export interface QueryItemsOptions {
  /** Steam Web API Key. Required for query queries. */
  apiKey?: string;
  /** App ID of the game (e.g. 730 for CS2/CS:GO) */
  appId: number;
  /** Query type (0: RankedByVote, 1: RankedByPublicationDate, 3: RankedByTrend, 9: AcceptedForGame, etc.) */
  queryType?: number;
  /** Page number, starting at 1 */
  page?: number;
  /** Number of items per page (max 100) */
  numPerPage?: number;
  /** Search text */
  searchText?: string;
  /** Filter by tags (e.g. ["map", "standard"]) */
  requiredTags?: string[];
  /** Exclude these tags */
  excludedTags?: string[];
  /** Filter by creator App ID */
  creatorAppId?: number;
}

export interface QueryItemsResult {
  total: number;
  items: PublishedFileDetails[];
}

export interface CollectionDetails {
  publishedfileid: string;
  result: number;
  children?: {
    publishedfileid: string;
    sortorder: number;
    filetype: number;
  }[];
}

/** Item ID -> last known `time_updated`, persisted next to the cached content. */
type Manifest = Record<string, number>;

/** Options controlling client-wide behaviour like retries and metadata caching. */
export interface SteamWorkshopClientOptions {
  /** Retries for transient Web API failures (429/5xx/network). @default 3 */
  maxRetries?: number;
  /** Base backoff between retries in ms (grows exponentially). @default 500 */
  retryDelayMs?: number;
  /**
   * TTL for the in-memory item-details cache, in ms. `0` disables caching.
   * Steam's POST endpoints don't emit ETags, so this is a client-side memo cache
   * that spares repeated lookups (e.g. from `downloadItemCached`) within the window.
   * @default 0
   */
  cacheTtlMs?: number;
}

/** Default timeout for Steam Web API requests, in milliseconds. */
const WEB_API_TIMEOUT_MS = 30_000;
/** Steam's GetPublishedFileDetails accepts many IDs per call; chunk to stay safe. */
const MAX_IDS_PER_REQUEST = 100;
/** HTTP statuses worth retrying (rate limit + transient server errors). */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));

  return out;
}

/**
 * Client for Steam Workshop Web API.
 */
export class SteamWorkshopClient {
  private apiKey: string | undefined;
  private maxRetries: number;
  private retryDelayMs: number;
  private cacheTtlMs: number;
  private detailsCache = new Map<string, { data: PublishedFileDetails; expires: number }>();

  constructor(apiKey?: string, options: SteamWorkshopClientOptions = {}) {
    this.apiKey = apiKey;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.cacheTtlMs = options.cacheTtlMs ?? 0;
  }

  /**
   * Performs a Steam Web API request and parses the JSON body.
   * Applies a per-attempt timeout, and retries transient failures (429/5xx/network)
   * with exponential backoff, honouring a `Retry-After` header when present.
   */
  private async fetchJson<T>(url: string, errorLabel: string, init?: RequestInit): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(WEB_API_TIMEOUT_MS) });
      } catch (err: unknown) {
        const e = err as Error;
        if (attempt < this.maxRetries) {
          await sleep(this.backoff(attempt));
          continue;
        }

        throw new Error(`${errorLabel}: ${e.name === "TimeoutError" ? "request timed out" : e.message}`);
      }

      if (response.ok)
        return (await response.json()) as T;

      if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
        const retryAfter = this.parseRetryAfter(response.headers.get("retry-after"));
        await sleep(retryAfter ?? this.backoff(attempt));
        continue;
      }

      throw new Error(`${errorLabel}: ${response.statusText} (${response.status})`);
    }
  }

  private backoff(attempt: number): number {
    return this.retryDelayMs * 2 ** attempt;
  }

  /** Parses a numeric (seconds) `Retry-After` header into ms, ignoring HTTP-date form. */
  private parseRetryAfter(header: string | null): number | undefined {
    if (!header)
      return undefined;

    const seconds = parseInt(header, 10);
    return isNaN(seconds) ? undefined : seconds * 1000;
  }

  /**
   * Fetches metadata for specific workshop item(s) by ID.
   * Automatically chunks requests above the API's per-call limit (100), fetches
   * chunks in parallel, and serves fresh entries from the memo cache when enabled.
   * Does NOT require an API key.
   *
   * @returns Details in the requested ID order; IDs Steam has no data for are omitted.
   */
  public async getItemDetails(ids: string | string[]): Promise<PublishedFileDetails[]> {
    const idArray = Array.isArray(ids) ? ids : [ids];
    if (idArray.length === 0)
      return [];

    const now = Date.now();
    const byId = new Map<string, PublishedFileDetails>();
    const toFetch: string[] = [];

    for (const id of idArray) {
      const cached = this.cacheTtlMs > 0 ? this.detailsCache.get(id) : undefined;
      if (cached && cached.expires > now)
        byId.set(id, cached.data);
      else
        toFetch.push(id);
    }

    if (toFetch.length > 0) {
      const chunks = chunk(toFetch, MAX_IDS_PER_REQUEST);
      const responses = await Promise.all(chunks.map((c) => this.fetchItemDetailsChunk(c)));
      for (const item of responses.flat()) {
        if (!item.publishedfileid)
          continue;

        byId.set(item.publishedfileid, item);
        if (this.cacheTtlMs > 0)
          this.detailsCache.set(item.publishedfileid, { data: item, expires: now + this.cacheTtlMs });
      }
    }

    // Preserve requested order, drop IDs Steam returned nothing for.
    const result: PublishedFileDetails[] = [];
    for (const id of idArray) {
      const item = byId.get(id);
      if (item)
        result.push(item);
    }

    return result;
  }

  /** Single GetPublishedFileDetails call for up to {@link MAX_IDS_PER_REQUEST} IDs. */
  private async fetchItemDetailsChunk(ids: string[]): Promise<PublishedFileDetails[]> {
    const params = new URLSearchParams();
    params.append("itemcount", String(ids.length));
    ids.forEach((id, index) => {
      params.append(`publishedfileids[${index}]`, id);
    });

    const data = await this.fetchJson<{ response: { publishedfiledetails?: PublishedFileDetails[] } }>(
      "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
      "Failed to fetch workshop item details",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      },
    );

    return data.response.publishedfiledetails || [];
  }

  /**
   * Queries and searches the Steam Workshop.
   * Requires a Steam Web API key.
   */
  public async queryItems(options: QueryItemsOptions): Promise<QueryItemsResult> {
    const apiKey = options.apiKey || this.apiKey;
    if (!apiKey)
      throw new Error("Steam Web API Key is required for queryItems");

    const params = new URLSearchParams();
    params.append("key", apiKey);
    params.append("appid", String(options.appId));
    params.append("query_type", String(options.queryType ?? 0));
    params.append("page", String(options.page ?? 1));
    params.append("numperpage", String(options.numPerPage ?? 20));
    params.append("return_tags", "1");
    params.append("return_vote_data", "1");
    params.append("return_short_description", "1");

    if (options.searchText)
      params.append("search_text", options.searchText);

    if (options.creatorAppId)
      params.append("creator_appid", String(options.creatorAppId));

    if (options.requiredTags) {
      options.requiredTags.forEach((tag, idx) => {
        params.append(`requiredtags[${idx}]`, tag);
      });
    }

    if (options.excludedTags) {
      options.excludedTags.forEach((tag, idx) => {
        params.append(`excludedtags[${idx}]`, tag);
      });
    }

    const url = `https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/?${params.toString()}`;
    const data = await this.fetchJson<{ response: { total?: number; publishedfiledetails?: PublishedFileDetails[] } }>(
      url,
      "Failed to query workshop items",
    );

    return {
      total: data.response.total || 0,
      items: data.response.publishedfiledetails || [],
    };
  }

  /**
   * Fetches the children IDs for a specific workshop collection (or list of collections).
   * Does NOT require an API key.
   */
  public async getCollectionDetails(ids: string | string[]): Promise<CollectionDetails[]> {
    const idArray = Array.isArray(ids) ? ids : [ids];
    if (idArray.length === 0)
      return [];

    const params = new URLSearchParams();
    params.append("collectioncount", String(idArray.length));
    idArray.forEach((id, index) => {
      params.append(`publishedfileids[${index}]`, id);
    });

    const data = await this.fetchJson<{ response: { collectiondetails?: CollectionDetails[] } }>(
      "https://api.steampowered.com/ISteamRemoteStorage/GetCollectionDetails/v1/",
      "Failed to fetch collection details",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      },
    );

    return data.response.collectiondetails || [];
  }

  /**
   * Helper that resolves a collection ID to all its child items' details.
   * Performs two API calls under the hood: one to fetch children IDs, and one to get item details.
   */
  public async getCollectionItems(collectionId: string): Promise<PublishedFileDetails[]> {
    const collections = await this.getCollectionDetails(collectionId);
    const collection = collections[0];
    if (!collection || !collection.children || collection.children.length === 0)
      return [];

    const childIds = collection.children.map((c) => c.publishedfileid);
    return this.getItemDetails(childIds);
  }

  /**
   * Downloads a workshop item if the local cached version is missing or outdated.
   * Compares the Web API's `time_updated` timestamp with the local manifest.
   * Copies the downloaded content into targetDir/itemId folder and cleans up any
   * sandbox temp directory used by SteamCMD.
   *
   * @returns Path to the cached workshop item directory.
   */
  public async downloadItemCached(
    appId: number,
    itemId: number,
    steamcmd: SteamCmdWrapper,
    targetDir: string,
    options?: DownloadOptions,
  ): Promise<string> {
    const manifestPath = join(targetDir, "workshop_manifest.json");
    const manifest = this.readManifest(manifestPath);

    // 1. Get updated time from Web API
    const details = await this.getItemDetails(String(itemId));
    const item = details[0];
    if (!item)
      throw new Error(`Workshop item ${itemId} not found on Steam.`);

    const timeUpdated = item.time_updated || 0;
    const localDir = join(targetDir, String(itemId));

    // 2. Check if local directory exists and is up to date according to manifest
    if (existsSync(localDir) && manifest[itemId] === timeUpdated)
      return localDir;

    // 3. Pre-flight free disk space validation
    const fileSize = parseInt(item.file_size || "0", 10);
    if (fileSize > 0) {
      const freeSpace = await getFreeDiskSpace(targetDir);
      if (fileSize > freeSpace) {
        throw new Error(
          `Insufficient disk space on the host machine. Required: ${fileSize} bytes, Available: ${freeSpace} bytes.`,
        );
      }
    }

    // 4. Download via SteamCMD, copy into targetDir/itemId, then clean the sandbox
    const { paths, cleanup } = await steamcmd.downloadItemsManaged(appId, [itemId], options);
    try {
      const tempDownloadPath = paths[itemId];
      if (!tempDownloadPath)
        throw new Error(`Failed to download item ${itemId}`);

      mkdirSync(localDir, { recursive: true });
      this.copyDir(tempDownloadPath, localDir);
    } finally {
      cleanup();
    }

    // 5. Update local manifest
    manifest[itemId] = timeUpdated;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    return localDir;
  }

  /**
   * Downloads multiple workshop items if their local cached versions are missing or outdated.
   * Compares the Web API's `time_updated` timestamps with the local manifest in a single batch,
   * then copies fresh content in and cleans up the SteamCMD sandbox.
   *
   * @returns A map of Item ID to its cached directory path on the host.
   */
  public async downloadItemsCached(
    appId: number,
    itemIds: number[],
    steamcmd: SteamCmdWrapper,
    targetDir: string,
    options?: DownloadOptions,
  ): Promise<{ [itemId: number]: string }> {
    if (itemIds.length === 0)
      return {};

    const manifestPath = join(targetDir, "workshop_manifest.json");
    const manifest = this.readManifest(manifestPath);

    // 1. Get details for all items in a single Web API call
    const details = await this.getItemDetails(itemIds.map(String));
    const detailsMap = new Map<number, PublishedFileDetails>();
    for (const item of details) {
      if (item.publishedfileid)
        detailsMap.set(parseInt(item.publishedfileid, 10), item);
    }

    const results: { [itemId: number]: string } = {};
    const toDownload: number[] = [];
    let totalRequiredSize = 0;

    for (const itemId of itemIds) {
      const item = detailsMap.get(itemId);
      if (!item)
        throw new Error(`Workshop item ${itemId} not found on Steam.`);

      const timeUpdated = item.time_updated || 0;
      const localDir = join(targetDir, String(itemId));

      if (existsSync(localDir) && manifest[itemId] === timeUpdated) {
        results[itemId] = localDir;
      } else {
        toDownload.push(itemId);
        totalRequiredSize += parseInt(item.file_size || "0", 10);
      }
    }

    // 2. If nothing needs downloading, return immediately
    if (toDownload.length === 0)
      return results;

    // 3. Pre-flight free disk space validation for the batch
    if (totalRequiredSize > 0) {
      const freeSpace = await getFreeDiskSpace(targetDir);
      if (totalRequiredSize > freeSpace) {
        throw new Error(
          `Insufficient disk space on the host machine. Required: ${totalRequiredSize} bytes, Available: ${freeSpace} bytes.`,
        );
      }
    }

    // 4. Batch download all outdated/missing items in a single SteamCMD process,
    //    copy each into place, then clean up the sandbox temp dir.
    const { paths: downloadPaths, cleanup } = await steamcmd.downloadItemsManaged(appId, toDownload, options);
    try {
      for (const itemId of toDownload) {
        const tempDownloadPath = downloadPaths[itemId];
        if (!tempDownloadPath)
          continue;

        const localDir = join(targetDir, String(itemId));
        mkdirSync(localDir, { recursive: true });
        this.copyDir(tempDownloadPath, localDir);

        manifest[itemId] = detailsMap.get(itemId)?.time_updated || 0;
        results[itemId] = localDir;
      }
    } finally {
      cleanup();
    }

    // 5. Save updated manifest
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    return results;
  }

  /**
   * Removes cached workshop items no longer in `keepIds` from `targetDir`:
   * deletes each stale item directory and its manifest entry, then rewrites the manifest.
   *
   * @returns The Item IDs that were pruned.
   */
  public pruneCache(targetDir: string, keepIds: number[]): number[] {
    const manifestPath = join(targetDir, "workshop_manifest.json");
    const manifest = this.readManifest(manifestPath);
    const keep = new Set(keepIds.map(String));
    const removed: number[] = [];

    for (const id of Object.keys(manifest)) {
      if (keep.has(id))
        continue;

      try {
        rmSync(join(targetDir, id), { recursive: true, force: true });
      } catch {}

      delete manifest[id];
      removed.push(parseInt(id, 10));
    }

    if (removed.length > 0)
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    return removed;
  }

  /** Reads the cache manifest, tolerating a missing or corrupt file. */
  private readManifest(manifestPath: string): Manifest {
    if (!existsSync(manifestPath))
      return {};

    try {
      return JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
    } catch {
      return {};
    }
  }

  /** Recursively copies a directory tree using the Node stdlib. */
  private copyDir(src: string, dest: string): void {
    cpSync(src, dest, { recursive: true });
  }
}
