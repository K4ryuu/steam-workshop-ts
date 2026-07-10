import { expect, test, describe, mock } from "bun:test";
import { SteamWorkshopClient } from "../src/api.js";
import { SteamCmdWrapper } from "../src/steamcmd.js";
import type { DownloadProgress } from "../src/steamcmd.js";

// Mock child_process for SteamCmdWrapper tests
mock.module("child_process", () => {
  return {
    execFile: (file: string, args: string[], cb: Function) => {
      const argStr = Array.isArray(args) ? args.join(" ") : "";

      // steamcmd extraction: write dummy binaries so chmodSync/binPath resolution work
      const isExtract = file === "tar" || argStr.includes("Expand-Archive");
      if (isExtract) {
        let dir = "";
        if (file === "tar") {
          const i = args.indexOf("-C");
          dir = args[i + 1] || "";
        } else {
          const m = argStr.match(/-DestinationPath '([^']+)'/);
          dir = m?.[1] || "";
        }

        if (dir) {
          try {
            const fs = require("fs");
            const path = require("path");
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "steamcmd"), "dummy binary");
            fs.writeFileSync(path.join(dir, "steamcmd.exe"), "dummy binary");
          } catch {}
        }

        setTimeout(() => cb(null, "", ""), 10);
        return;
      }

      const isDf = file === "df";
      const isPowerShell = argStr.includes("Get-Volume");
      const stdout = isDf
        ? "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/disk1s1 100000000 50000000 50000000 50% /"
        : isPowerShell
          ? "50000000000"
          : "";

      setTimeout(() => cb(null, stdout, ""), 10);
    },
    spawn: (bin: string, args: string[]) => {
      // Mock events emitter
      const listeners: { [key: string]: Function[] } = {};
      const stdoutListeners: { [key: string]: Function[] } = {};
      const stderrListeners: { [key: string]: Function[] } = {};

      const proc = {
        stdin: {
          write: () => {
            // Simulator writes success after receiving Guard code
            if (args.includes("88888")) {
              setTimeout(() => {
                if (stdoutListeners["data"]) {
                  stdoutListeners["data"]!.forEach((cb) =>
                    cb(
                      Buffer.from(
                        'Success. Downloaded item 88888 to "/mock/path/88888" (100 bytes)\n',
                      ),
                    ),
                  );
                }

                if (listeners["close"])
                  listeners["close"]!.forEach((cb) => cb(0));
              }, 5);
            }
          },
        },
        stdout: {
          on: (event: string, cb: Function) => {
            stdoutListeners[event] = stdoutListeners[event] || [];
            stdoutListeners[event]!.push(cb);
          },
        },
        stderr: {
          on: (event: string, cb: Function) => {
            stderrListeners[event] = stderrListeners[event] || [];
            stderrListeners[event]!.push(cb);
          },
        },
        on: (event: string, cb: Function) => {
          listeners[event] = listeners[event] || [];
          listeners[event]!.push(cb);
        },
        kill: (sig: string) => {
          if (listeners["close"]) {
            listeners["close"]!.forEach((cb) =>
              cb(sig === "SIGKILL" ? 137 : 0),
            );
          }
        },
      };

      // Defer execution of mocked success/failure output
      setTimeout(() => {
        const isErrorTest = args.includes("99999");
        const isGuardTest = args.includes("88888");
        const isTimeoutTest = args.includes("77777");

        if (isTimeoutTest) {
          // Do nothing to trigger timeout
          return;
        }

        if (isErrorTest) {
          if (stderrListeners["data"]) {
            stderrListeners["data"]!.forEach((cb) =>
              cb(Buffer.from("Failed to download item")),
            );
          }

          if (listeners["close"])
            listeners["close"]!.forEach((cb) => cb(1));
        } else if (isGuardTest) {
          if (stdoutListeners["data"]) {
            stdoutListeners["data"]!.forEach((cb) =>
              cb(Buffer.from("Enter Steam Guard code:\n")),
            );
          }
        } else {
          // Extract item IDs from args
          const itemIds: string[] = [];
          for (let i = 0; i < args.length; i++) {
            if (args[i] === "+workshop_download_item") {
              const id = args[i + 2];
              if (id)
                itemIds.push(id);
            }
          }

          if (stdoutListeners["data"]) {
            // 55555 triggers a progress line to exercise onProgress parsing
            if (itemIds.includes("55555")) {
              stdoutListeners["data"]!.forEach((cb) =>
                cb(Buffer.from("Update state (0x61) downloading, progress: 50.00 (5 / 10)\n")),
              );
            }

            stdoutListeners["data"]!.forEach((cb) => {
              for (const id of itemIds) {
                const pathVal = bin === "docker"
                  ? `/root/Steam/steamapps/workshop/content/730/${id}`
                  : `/mock/path/steamcmd/steamapps/workshop/content/730/${id}`;
                cb(Buffer.from(`Success. Downloaded item ${id} to "${pathVal}" (10485760 bytes)\n`));
              }
            });
          }

          if (listeners["close"])
            listeners["close"]!.forEach((cb) => cb(0));
        }
      }, 10);

      return proc;
    },
  };
});

describe("SteamWorkshopClient", () => {
  test("getItemDetails mock test", async () => {
    // Mock global fetch
    const originalFetch = global.fetch;
    global.fetch = mock(async () => {
      return {
        ok: true,
        json: async () => ({
          response: {
            publishedfiledetails: [
              {
                publishedfileid: "3167383610",
                result: 1,
                title: "Mock Map",
                file_size: "100000",
              },
            ],
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const client = new SteamWorkshopClient();
    const details = await client.getItemDetails("3167383610");

    expect(details.length).toBe(1);
    expect(details[0]!.title).toBe("Mock Map");
    expect(details[0]!.publishedfileid).toBe("3167383610");

    global.fetch = originalFetch;
  });

  test("queryItems mock test", async () => {
    // Mock global fetch
    const originalFetch = global.fetch;
    global.fetch = mock(async () => {
      return {
        ok: true,
        json: async () => ({
          response: {
            total: 15,
            publishedfiledetails: [
              {
                publishedfileid: "12345",
                result: 1,
                title: "Queried Map",
              },
            ],
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const client = new SteamWorkshopClient("mock-api-key");
    const result = await client.queryItems({
      appId: 730,
      searchText: "surf",
    });

    expect(result.total).toBe(15);
    expect(result.items[0]!.title).toBe("Queried Map");

    global.fetch = originalFetch;
  });

  test("getCollectionDetails and getCollectionItems mock test", async () => {
    const originalFetch = global.fetch;
    let callCount = 0;

    global.fetch = mock(async (url) => {
      callCount++;
      if (String(url).includes("GetCollectionDetails")) {
        return {
          ok: true,
          json: async () => ({
            response: {
              collectioncount: 1,
              collectiondetails: [
                {
                  publishedfileid: "col-123",
                  result: 1,
                  children: [
                    { publishedfileid: "child-1" },
                    { publishedfileid: "child-2" },
                  ],
                },
              ],
            },
          }),
        } as Response;
      } else if (String(url).includes("GetPublishedFileDetails")) {
        return {
          ok: true,
          json: async () => ({
            response: {
              publishedfiledetails: [
                { publishedfileid: "child-1", result: 1, title: "Child Map 1" },
                { publishedfileid: "child-2", result: 1, title: "Child Map 2" },
              ],
            },
          }),
        } as Response;
      }

      return { ok: false } as Response;
    }) as unknown as typeof fetch;

    const client = new SteamWorkshopClient();

    // 1. Test getCollectionDetails directly
    const details = await client.getCollectionDetails("col-123");
    expect(details.length).toBe(1);
    expect(details[0]!.publishedfileid).toBe("col-123");
    expect(details[0]!.children?.length).toBe(2);

    // 2. Test getCollectionItems full resolution helper
    const items = await client.getCollectionItems("col-123");
    expect(items.length).toBe(2);
    expect(items[0]!.title).toBe("Child Map 1");
    expect(items[1]!.title).toBe("Child Map 2");
    expect(callCount).toBe(3);

    global.fetch = originalFetch;
  });

  test("downloadItemCached mock test", async () => {
    const originalFetch = global.fetch;

    // Mock Web API details
    global.fetch = mock(async () => {
      return {
        ok: true,
        json: async () => ({
          response: {
            publishedfiledetails: [
              { publishedfileid: "123", result: 1, time_updated: 500 },
            ],
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const client = new SteamWorkshopClient();
    // Mock copyDirSync to prevent disk copying errors during mock run
    client["copyDir"] = mock(() => {});

    const wrapper = new SteamCmdWrapper({ binPath: "mockcmd" });

    // Clean target dir first
    const fs = await import("fs");
    try {
      fs.unlinkSync("./test-cache-dir/workshop_manifest.json");
      fs.rmdirSync("./test-cache-dir/cached-123");
      fs.rmdirSync("./test-cache-dir");
    } catch {}

    // First download: calls wrapper.downloadItem
    const path1 = await client.downloadItemCached(
      730,
      123,
      wrapper,
      "./test-cache-dir",
    );
    expect(path1).toBe("test-cache-dir/123");

    // Mock the download to throw if called again, to verify it uses the cache
    wrapper.downloadItemsManaged = mock(async () => {
      throw new Error(
        "downloadItemsManaged was called but cache should have been hit!",
      );
    });

    // Second download: should hit cache and not call downloadItem
    const path2 = await client.downloadItemCached(
      730,
      123,
      wrapper,
      "./test-cache-dir",
    );
    expect(path2).toBe("test-cache-dir/123");

    // Clean up
    try {
      fs.unlinkSync("./test-cache-dir/workshop_manifest.json");
      fs.rmdirSync("./test-cache-dir/123");
      fs.rmdirSync("./test-cache-dir");
    } catch {}

    global.fetch = originalFetch;
  });

  test("downloadItemsCached mock test", async () => {
    const originalFetch = global.fetch;

    // Mock Web API details for multiple items
    global.fetch = mock(async () => {
      return {
        ok: true,
        json: async () => ({
          response: {
            publishedfiledetails: [
              { publishedfileid: "123", result: 1, time_updated: 500, file_size: "1000" },
              { publishedfileid: "456", result: 1, time_updated: 600, file_size: "2000" },
            ],
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const client = new SteamWorkshopClient();
    client["copyDir"] = mock(() => {});

    const wrapper = new SteamCmdWrapper({ binPath: "mockcmd" });
    // Mock the managed download
    wrapper.downloadItemsManaged = mock(async (_appId, itemIds) => {
      const paths: { [itemId: number]: string } = {};
      for (const id of itemIds)
        paths[id] = `/mock/path/${id}`;

      return { paths, cleanup: () => {} };
    });

    const fs = await import("fs");
    try {
      fs.unlinkSync("./test-cache-dir/workshop_manifest.json");
      fs.rmdirSync("./test-cache-dir/123");
      fs.rmdirSync("./test-cache-dir/456");
      fs.rmdirSync("./test-cache-dir");
    } catch {}

    // First download: calls wrapper.downloadItems
    const paths = await client.downloadItemsCached(
      730,
      [123, 456],
      wrapper,
      "./test-cache-dir",
    );
    expect(paths[123]).toBe("test-cache-dir/123");
    expect(paths[456]).toBe("test-cache-dir/456");
    expect(wrapper.downloadItemsManaged).toHaveBeenCalledTimes(1);

    // Mock the managed download to throw if called again, to verify it uses the cache
    wrapper.downloadItemsManaged = mock(async () => {
      throw new Error("downloadItemsManaged was called but cache should have been hit!");
    });

    // Second download: should hit cache
    const paths2 = await client.downloadItemsCached(
      730,
      [123, 456],
      wrapper,
      "./test-cache-dir",
    );
    expect(paths2[123]).toBe("test-cache-dir/123");
    expect(paths2[456]).toBe("test-cache-dir/456");

    // Clean up
    try {
      fs.unlinkSync("./test-cache-dir/workshop_manifest.json");
      fs.rmdirSync("./test-cache-dir/123");
      fs.rmdirSync("./test-cache-dir/456");
      fs.rmdirSync("./test-cache-dir");
    } catch {}

    global.fetch = originalFetch;
  });

  test("downloadItemsCached forwards DownloadOptions (onProgress) to SteamCMD", async () => {
    const originalFetch = global.fetch;
    global.fetch = mock(async () => {
      return {
        ok: true,
        json: async () => ({
          response: { publishedfiledetails: [{ publishedfileid: "123", result: 1, time_updated: 1, file_size: "10" }] },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const client = new SteamWorkshopClient();
    client["copyDir"] = mock(() => {});

    const wrapper = new SteamCmdWrapper({ binPath: "mockcmd" });
    let seenOptions: DownloadProgress | undefined;
    const onProgress = (p: DownloadProgress) => { seenOptions = p; };
    let forwarded: unknown;
    wrapper.downloadItemsManaged = mock(async (_appId: number, itemIds: number[], options?: unknown) => {
      forwarded = options;
      return { paths: Object.fromEntries(itemIds.map((id) => [id, `/mock/${id}`])), cleanup: () => {} };
    });

    const fs = await import("fs");
    try {
      fs.rmSync("./test-fwd-dir", { recursive: true, force: true });
    } catch {}

    await client.downloadItemsCached(730, [123], wrapper, "./test-fwd-dir", { onProgress });
    expect((forwarded as { onProgress?: unknown }).onProgress).toBe(onProgress);
    expect(seenOptions).toBeUndefined(); // mock never invokes it, just forwards

    try {
      fs.rmSync("./test-fwd-dir", { recursive: true, force: true });
    } catch {}

    global.fetch = originalFetch;
  });

  test("getItemDetails retries transient 5xx then succeeds", async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = mock(async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          headers: { get: () => null },
        } as unknown as Response;
      }

      return {
        ok: true,
        json: async () => ({
          response: { publishedfiledetails: [{ publishedfileid: "1", result: 1, title: "OK" }] },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const client = new SteamWorkshopClient(undefined, { retryDelayMs: 1 });
    const details = await client.getItemDetails("1");
    expect(calls).toBe(2);
    expect(details[0]!.title).toBe("OK");

    global.fetch = originalFetch;
  });

  test("getItemDetails chunks requests above 100 IDs per call", async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = mock(async (_url, init) => {
      calls++;
      const body = new URLSearchParams((init as RequestInit).body as string);
      const count = parseInt(body.get("itemcount") || "0", 10);
      expect(count).toBeLessThanOrEqual(100);

      const items: { publishedfileid: string; result: number }[] = [];
      for (let i = 0; i < count; i++)
        items.push({ publishedfileid: body.get(`publishedfileids[${i}]`) || "", result: 1 });

      return { ok: true, json: async () => ({ response: { publishedfiledetails: items } }) } as Response;
    }) as unknown as typeof fetch;

    const client = new SteamWorkshopClient();
    const ids = Array.from({ length: 150 }, (_, i) => String(i + 1));
    const details = await client.getItemDetails(ids);
    expect(calls).toBe(2); // 150 IDs -> two chunks of <=100
    expect(details.length).toBe(150);

    global.fetch = originalFetch;
  });

  test("getItemDetails serves from the TTL cache without refetching", async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = mock(async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({
          response: { publishedfiledetails: [{ publishedfileid: "42", result: 1, title: "Cached" }] },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const client = new SteamWorkshopClient(undefined, { cacheTtlMs: 60000 });
    const first = await client.getItemDetails("42");
    const second = await client.getItemDetails("42");
    expect(first[0]!.title).toBe("Cached");
    expect(second[0]!.title).toBe("Cached");
    expect(calls).toBe(1); // second call served from the memo cache

    global.fetch = originalFetch;
  });

  test("pruneCache removes stale items and rewrites the manifest", async () => {
    const fs = await import("fs");
    const dir = "./test-prune-dir";
    fs.mkdirSync(`${dir}/111`, { recursive: true });
    fs.mkdirSync(`${dir}/222`, { recursive: true });
    fs.writeFileSync(`${dir}/workshop_manifest.json`, JSON.stringify({ "111": 1, "222": 2 }));

    const client = new SteamWorkshopClient();
    const removed = client.pruneCache(dir, [111]);
    expect(removed).toEqual([222]);
    expect(fs.existsSync(`${dir}/222`)).toBe(false);
    expect(fs.existsSync(`${dir}/111`)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(`${dir}/workshop_manifest.json`, "utf-8"));
    expect(manifest["222"]).toBeUndefined();
    expect(manifest["111"]).toBe(1);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("SteamCmdWrapper", () => {
  test("onProgress receives parsed SteamCMD progress", async () => {
    const wrapper = new SteamCmdWrapper({ binPath: "mockcmd" });
    const events: DownloadProgress[] = [];
    await wrapper.downloadItem(730, 55555, { onProgress: (p) => events.push(p) });

    expect(events.length).toBeGreaterThan(0);
    const p = events[0]!;
    expect(p.percent).toBe(50);
    expect(p.downloadedBytes).toBe(5);
    expect(p.totalBytes).toBe(10);
    expect(p.itemId).toBe(55555);
  });

  test("Successful download path extraction", async () => {
    const wrapper = new SteamCmdWrapper({ binPath: "mockcmd" });
    const path = await wrapper.downloadItem(730, 3167383610);
    expect(path).toBe(
      "/mock/path/steamcmd/steamapps/workshop/content/730/3167383610",
    );
  });

  test("Failure handling", async () => {
    const wrapper = new SteamCmdWrapper({ binPath: "mockcmd" });
    expect(wrapper.downloadItem(730, 99999)).rejects.toThrow();
  });

  test("autoInstall mock test", async () => {
    const originalFetch = global.fetch;
    global.fetch = mock(async () => {
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      } as Response;
    }) as unknown as typeof fetch;

    const wrapper = new SteamCmdWrapper();
    const path = await wrapper.autoInstall("./mock-steamcmd-dir");

    expect(path).toContain("steamcmd");

    // Clean up created files/dirs if any
    const fs = await import("fs");
    try {
      fs.rmSync("./mock-steamcmd-dir", { recursive: true, force: true });
    } catch {}

    global.fetch = originalFetch;
  });

  test("Timeout handling", async () => {
    const wrapper = new SteamCmdWrapper({ binPath: "mockcmd" });
    // Use 77777 to trigger timeout test in mock spawn
    const downloadPromise = wrapper.downloadItem(730, 77777, { timeout: 10 });
    expect(downloadPromise).rejects.toThrow(/timed out/);
  });

  test("Steam Guard 2FA handling", async () => {
    const wrapper = new SteamCmdWrapper({ binPath: "mockcmd" });
    // Use 88888 to trigger Guard prompt in mock spawn
    const codeCallback = mock(() => "12345");
    const path = await wrapper.downloadItem(730, 88888, {
      onSteamGuardRequired: codeCallback,
    });

    expect(path).toBe("/mock/path/88888");
    expect(codeCallback).toHaveBeenCalledTimes(1);
  });

  test("getFreeDiskSpace returns a numeric value or Infinity", async () => {
    const { getFreeDiskSpace } = await import("../src/index.js");
    const space = await getFreeDiskSpace(".");
    expect(typeof space).toBe("number");
    expect(space).toBeGreaterThan(0);
  });

  test("Insufficient disk space triggers rejection", async () => {
    const originalFetch = global.fetch;

    // Mock Web API details with a huge file size (100 Terabytes)
    global.fetch = mock(async () => {
      return {
        ok: true,
        json: async () => ({
          response: {
            publishedfiledetails: [
              {
                publishedfileid: "123",
                result: 1,
                file_size: "100000000000000",
                time_updated: 500,
              },
            ],
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const client = new SteamWorkshopClient();
    const wrapper = new SteamCmdWrapper({ binPath: "mockcmd" });

    const downloadPromise = client.downloadItemCached(
      730,
      123,
      wrapper,
      "./test-cache-dir",
    );
    expect(downloadPromise).rejects.toThrow(/Insufficient disk space/);

    global.fetch = originalFetch;
  });

  test("Docker sandbox download works", async () => {
    const wrapper = new SteamCmdWrapper({ useDocker: true });
    const path = await wrapper.downloadItem(730, 3167383610);
    expect(path).toContain("steamapps/workshop/content/730/3167383610");
    const fs = require("fs");
    try {
      const parts = path.split("/steamapps/");
      fs.rmSync(parts[0]!, { recursive: true, force: true });
    } catch {}
  });

  test("steamCacheDir is used as a persistent mount and survives cleanup", async () => {
    const fs = require("fs");
    const cacheDir = "./test-steamcache";
    fs.rmSync(cacheDir, { recursive: true, force: true });

    const wrapper = new SteamCmdWrapper({ useDocker: true, steamCacheDir: cacheDir });
    const { paths, cleanup } = await wrapper.downloadItemsManaged(730, [3167383610]);

    expect(paths[3167383610]).toContain("steamapps/workshop/content/730/3167383610");
    expect(fs.existsSync(cacheDir)).toBe(true);

    cleanup();
    expect(fs.existsSync(cacheDir)).toBe(true); // persistent cache is not deleted on cleanup

    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  test("downloadItemsManaged cleanup removes the docker sandbox temp dir", async () => {
    const fs = require("fs");
    const wrapper = new SteamCmdWrapper({ useDocker: true });
    const { paths, cleanup } = await wrapper.downloadItemsManaged(730, [3167383610]);

    const tempRoot = paths[3167383610]!.split("/steamapps/")[0]!;
    expect(fs.existsSync(tempRoot)).toBe(true); // temp dir kept until we copy files out

    cleanup();
    expect(fs.existsSync(tempRoot)).toBe(false); // no leak after cleanup
  });

  test("Temp dir sandbox download works", async () => {
    const originalFetch = global.fetch;
    global.fetch = mock(async () => {
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      } as Response;
    }) as unknown as typeof fetch;

    const wrapper = new SteamCmdWrapper({ useTempDir: true });
    const path = await wrapper.downloadItem(730, 3167383610);
    expect(path).toBe(
      "/mock/path/steamcmd/steamapps/workshop/content/730/3167383610",
    );

    global.fetch = originalFetch;
  });
});
