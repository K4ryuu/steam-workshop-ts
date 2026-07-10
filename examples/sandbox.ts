import { SteamCmdWrapper } from "../src/index.js";

// Three ways to run SteamCMD without polluting the host, useful on macOS where the
// 32-bit SteamCMD can't run natively.
const appId = 730;
const itemId = 3070244462;

// 1. Docker sandbox: runs SteamCMD inside a throwaway container.
console.log("Docker sandbox download...");
try {
  const docker = new SteamCmdWrapper({ useDocker: true });
  const path = await docker.downloadItem(appId, itemId);
  console.log(`  Downloaded to: ${path}`);
} catch (err: unknown) {
  const error = err as Error;
  console.error("  Docker download failed:", error.message);
}

// 2. Temp-dir sandbox: installs SteamCMD into an OS temp folder for this run.
console.log("\nTemp-dir sandbox download...");
try {
  const temp = new SteamCmdWrapper({ useTempDir: true });
  const path = await temp.downloadItem(appId, itemId);
  console.log(`  Downloaded to: ${path}`);
} catch (err: unknown) {
  const error = err as Error;
  console.error("  Temp-dir download failed:", error.message);
}

// 3. Persistent Docker cache: reuse Steam's depot cache across runs for incremental,
//    low-bandwidth updates. The cache dir survives between downloads (not cleaned up).
console.log("\nDocker download with a persistent Steam cache...");
try {
  const cached = new SteamCmdWrapper({ useDocker: true, steamCacheDir: "./.steam-cache" });
  const path = await cached.downloadItem(appId, itemId);
  console.log(`  Downloaded to: ${path} (re-run to see the incremental speed-up)`);
} catch (err: unknown) {
  const error = err as Error;
  console.error("  Cached download failed:", error.message);
}

// 4. Explicit install to a directory you control, then reuse it.
console.log("\nInstalling SteamCMD to ./bin/steamcmd...");
try {
  const wrapper = new SteamCmdWrapper();
  const binPath = await wrapper.autoInstall("./bin/steamcmd");
  console.log(`  SteamCMD ready at: ${binPath}`);
} catch (err: unknown) {
  const error = err as Error;
  console.error("  Install failed:", error.message);
}
