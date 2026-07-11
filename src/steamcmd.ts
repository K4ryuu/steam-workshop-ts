import { spawn, execFile } from "child_process";
import { writeFileSync, mkdirSync, chmodSync, unlinkSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** Configuration for a {@link SteamCmdWrapper} instance. */
export interface SteamCmdOptions {
  /**
   * Path to the steamcmd executable.
   * Defaults to "steamcmd" (resolving via PATH).
   */
  binPath?: string;
  /**
   * Steam account username.
   * @default "anonymous"
   */
  username?: string;
  /**
   * Steam account password. Required if not downloading anonymously.
   */
  password?: string;
  /**
   * Use a temporary Docker container to run SteamCMD.
   * Solves macOS compatibility and prevents host pollution.
   */
  useDocker?: boolean;
  /**
   * Automatically install SteamCMD into a temporary folder and clean it up after download.
   */
  useTempDir?: boolean;
  /**
   * Docker image to use when useDocker is true.
   * Defaults to "ghcr.io/sonroyaalmerol/steamcmd-arm64" on arm64 architectures (e.g. Apple Silicon),
   * and "steamcmd/steamcmd" on other architectures.
   */
  dockerImage?: string;
  /**
   * Persistent host directory to mount as the Steam root in Docker mode, instead of a
   * throwaway temp dir. Reused across runs so Steam's depot cache survives, enabling
   * incremental updates and saving bandwidth. It is NOT removed on cleanup.
   * Only affects `useDocker` runs.
   */
  steamCacheDir?: string;
}

/** Download progress parsed from SteamCMD output during a download. */
export interface DownloadProgress {
  /** Item ID this progress refers to, when a single item is being downloaded. */
  itemId?: number;
  /** Completion percentage reported by SteamCMD (0-100). */
  percent: number;
  /** Bytes downloaded so far. */
  downloadedBytes: number;
  /** Total bytes to download. */
  totalBytes: number;
  /** The raw SteamCMD stdout line the progress was parsed from. */
  raw: string;
}

/** Per-run options for a SteamCMD download. */
export interface DownloadOptions {
  /**
   * Timeout in milliseconds before killing the SteamCMD process.
   * Defaults to no timeout.
   */
  timeout?: number;
  /**
   * Callback to handle Steam Guard 2FA codes dynamically.
   * If not provided, the process is killed if Steam Guard is required.
   */
  onSteamGuardRequired?: (attempt: number) => Promise<string> | string;
  /**
   * Called with download progress as SteamCMD reports it on stdout.
   * `itemId` is only set when a single item is being downloaded (otherwise ambiguous).
   */
  onProgress?: (progress: DownloadProgress) => void;
  /**
   * Use Docker container for this download run.
   */
  useDocker?: boolean;
  /**
   * Use a temporary SteamCMD installation for this download run.
   */
  useTempDir?: boolean;
  /**
   * Persistent Steam-root mount for this Docker run (see {@link SteamCmdOptions.steamCacheDir}).
   */
  steamCacheDir?: string;
}

/** Matches SteamCMD lines like: `... progress: 45.32 (12345678 / 27182818)`. */
const PROGRESS_REGEX = /progress:\s*([\d.]+)\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)/i;

/**
 * Result of a managed download: the resolved paths plus a `cleanup` callback that
 * removes any sandbox temp directories (Docker mount or temporary SteamCMD install)
 * created for this run. Call `cleanup()` only after the files have been copied out.
 */
export interface ManagedDownloadResult {
  /** Map of Item ID to its absolute download path on the host. */
  paths: { [itemId: number]: string };
  /** Removes sandbox temp dirs created for this run. No-op in non-sandbox mode. */
  cleanup: () => void;
}

/**
 * Wrapper for SteamCMD CLI automation.
 */
export class SteamCmdWrapper {
  private binPath: string;
  private username: string;
  private password: string | undefined;
  private useDocker: boolean;
  private useTempDir: boolean;
  private dockerImage: string;
  private steamCacheDir: string | undefined;

  constructor(options: SteamCmdOptions = {}) {
    this.binPath = options.binPath || "steamcmd";
    this.username = options.username || "anonymous";
    this.password = options.password;
    this.useDocker = options.useDocker || false;
    this.useTempDir = options.useTempDir || false;
    this.dockerImage = options.dockerImage || (process.arch === "arm64" ? "ghcr.io/sonroyaalmerol/steamcmd-arm64" : "steamcmd/steamcmd");
    this.steamCacheDir = options.steamCacheDir;
  }

  /**
   * Downloads a workshop item for a specific App ID and Item ID.
   * Programmatically parses SteamCMD stdout to find the downloaded folder path.
   *
   * In sandbox mode (`useDocker`/`useTempDir`) the returned path points into a temp
   * directory that is NOT auto-removed, so the path stays valid. Copy the files out
   * yourself, or use `SteamWorkshopClient.downloadItemCached` which copies and cleans up.
   *
   * @param appId - the game's App ID
   * @param itemId - the workshop item ID
   * @param options - timeout, progress, Steam Guard callback, and per-run sandbox mode
   * @returns the absolute path to the downloaded folder
   * @throws if SteamCMD fails, times out, or reports no successful download
   */
  public async downloadItem(appId: number, itemId: number, options: DownloadOptions = {}): Promise<string> {
    const { paths } = await this.downloadItemsManaged(appId, [itemId], options);
    const path = paths[itemId];
    if (!path)
      throw new Error(`Failed to download item ${itemId}`);

    return path;
  }

  /**
   * Downloads multiple workshop items in a single SteamCMD session.
   * Efficiently batches requests to avoid multiple login/startup overheads.
   *
   * In sandbox mode the returned paths point into a temp directory that is NOT
   * auto-removed (see {@link downloadItem}). Prefer {@link downloadItemsManaged}
   * when you need the temp dirs cleaned after copying the files out.
   *
   * @param appId - the game's App ID
   * @param itemIds - the workshop item IDs to download
   * @param options - timeout, progress, Steam Guard callback, and per-run sandbox mode
   * @returns a map of Item ID to its absolute download path
   * @throws if SteamCMD fails, times out, or reports no successful download
   */
  public async downloadItems(
    appId: number,
    itemIds: number[],
    options: DownloadOptions = {},
  ): Promise<{ [itemId: number]: string }> {
    const { paths } = await this.downloadItemsManaged(appId, itemIds, options);
    return paths;
  }

  /**
   * Like {@link downloadItems}, but returns a `cleanup()` callback alongside the paths.
   * The paths may point into a sandbox temp directory (Docker mount or temporary
   * SteamCMD install); call `cleanup()` after copying the files out to remove it.
   * On failure the sandbox is removed automatically before the error is thrown.
   *
   * @param appId - the game's App ID
   * @param itemIds - the workshop item IDs to download
   * @param options - timeout, progress, Steam Guard callback, and per-run sandbox mode
   * @returns the download paths plus a `cleanup()` to remove the sandbox temp dir
   * @throws if SteamCMD fails, times out, or reports no successful download
   */
  public async downloadItemsManaged(
    appId: number,
    itemIds: number[],
    options: DownloadOptions = {},
  ): Promise<ManagedDownloadResult> {
    if (itemIds.length === 0)
      return { paths: {}, cleanup: () => {} };

    const useDocker = options.useDocker ?? this.useDocker;
    const useTempDir = options.useTempDir ?? this.useTempDir;
    const steamCacheDir = options.steamCacheDir ?? this.steamCacheDir;

    let binPath = this.binPath;
    let tempBinDir = "";

    if (useTempDir && !useDocker) {
      tempBinDir = mkdtempSync(join(tmpdir(), "steamcmd-temp-bin-"));
      const installer = new SteamCmdWrapper({ binPath: "steamcmd" });
      binPath = await installer.autoInstall(tempBinDir);
    }

    return new Promise<ManagedDownloadResult>((resolve, reject) => {
      let tempHostDir = "";
      // A user-supplied steamCacheDir is persistent: mount it but never delete it.
      let persistentMount = false;
      let args: string[] = [];
      let execBin = binPath;

      if (useDocker) {
        if (steamCacheDir) {
          tempHostDir = steamCacheDir;
          mkdirSync(tempHostDir, { recursive: true });
          persistentMount = true;
        } else {
          tempHostDir = mkdtempSync(join(tmpdir(), "steamcmd-docker-"));
        }

        execBin = "docker";
        args = ["run", "--rm", "-i"];
        if (process.platform === "darwin" && this.dockerImage === "steamcmd/steamcmd")
          args.push("--platform", "linux/amd64");

        const mountDir = this.dockerImage.includes("steamcmd-arm64") ? "/home/steam/Steam" : "/root/Steam";
        args.push(
          "-v",
          `${tempHostDir}:${mountDir}`,
          this.dockerImage,
        );

        if (this.dockerImage.includes("steamcmd-arm64"))
          args.push("./steamcmd.sh");
      }

      args.push("+login", this.username);
      if (this.password)
        args.push(this.password);

      for (const itemId of itemIds)
        args.push("+workshop_download_item", String(appId), String(itemId));

      args.push("+quit");

      const proc = spawn(execBin, args);

      let stdout = "";
      let stderr = "";
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;

      // Removes any sandbox temp dirs created for this run. Called on failure, or
      // handed to the caller as `cleanup()` on success so it runs after the copy.
      // A persistent steamCacheDir mount is never removed.
      const removeSandbox = () => {
        for (const dir of [tempBinDir, persistentMount ? "" : tempHostDir]) {
          if (!dir)
            continue;

          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {}
        }
      };

      const clearTimer = () => {
        if (timeoutId)
          clearTimeout(timeoutId);
      };

      const fail = (error: Error) => {
        timedOut = true;
        clearTimer();
        removeSandbox();
        proc.kill("SIGKILL");
        reject(error);
      };

      const startTimeout = () => {
        if (!options.timeout)
          return;

        timeoutId = setTimeout(() => fail(new Error(`SteamCMD process timed out after ${options.timeout}ms`)), options.timeout);
      };

      const resetTimeout = () => {
        if (options.timeout && timeoutId) {
          clearTimeout(timeoutId);
          startTimeout();
        }
      };

      startTimeout();

      let guardAttempt = 0;
      proc.stdout.on("data", async (data) => {
        const str = data.toString();
        stdout += str;

        // Reset timeout if SteamCMD is actively self-updating
        if (
          str.includes("Updating steam launcher...") ||
          str.includes("Downloading update...") ||
          str.includes("Verifying installation...")
        )
          resetTimeout();

        if (options.onProgress) {
          for (const line of str.split("\n")) {
            const m = line.match(PROGRESS_REGEX);
            if (!m)
              continue;

            resetTimeout(); // active download counts as progress
            const progress: DownloadProgress = {
              percent: parseFloat(m[1]!),
              downloadedBytes: parseInt(m[2]!, 10),
              totalBytes: parseInt(m[3]!, 10),
              raw: line.trim(),
            };
            if (itemIds.length === 1)
              progress.itemId = itemIds[0]!;

            try {
              options.onProgress(progress);
            } catch {}
          }
        }

        if (str.includes("Enter Steam Guard code:")) {
          if (options.onSteamGuardRequired) {
            guardAttempt++;
            try {
              const code = await options.onSteamGuardRequired(guardAttempt);
              proc.stdin.write(`${code}\n`);
            } catch (err: unknown) {
              const error = err as Error;
              fail(new Error(`Failed to retrieve Steam Guard code: ${error.message}`));
            }
          } else {
            fail(new Error("SteamCMD requires a Steam Guard 2FA code, but no onSteamGuardRequired callback was provided."));
          }
        }
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (timedOut)
          return;

        clearTimer();

        if (code !== 0) {
          const diag = this.getDiagnostics(stdout, stderr);
          removeSandbox();
          return reject(
            new Error(
              `SteamCMD exited with code ${code}. Diagnostics: ${diag}\nStderr: ${stderr}\nStdout: ${stdout}`,
            ),
          );
        }

        const paths: { [itemId: number]: string } = {};

        const resolvePath = (rawPath: string): string => {
          if (!useDocker)
            return rawPath;

          const relativePath = rawPath.replace(/^\/(root|home\/steam)\/Steam\/?/i, "");
          return join(tempHostDir, relativePath);
        };

        // Parse matches from stdout (quoted paths first, then bare paths)
        for (const m of stdout.matchAll(/Downloaded\s+item\s+(\d+)\s+to\s+"([^"]+)"/ig))
          paths[parseInt(m[1]!, 10)] = resolvePath(m[2]!);

        for (const m of stdout.matchAll(/Downloaded\s+item\s+(\d+)\s+to\s+([^\s(]+)/ig)) {
          const id = parseInt(m[1]!, 10);
          if (!paths[id])
            paths[id] = resolvePath(m[2]!);
        }

        // Fallback for any items that succeeded but regex failed
        for (const itemId of itemIds) {
          if (paths[itemId])
            continue;

          if (useDocker) {
            paths[itemId] = join(tempHostDir, "steamapps", "workshop", "content", String(appId), String(itemId));
          } else if (stdout.includes(`Success. Downloaded item ${itemId}`)) {
            const sep = process.platform === "win32" ? "\\" : "/";
            const binDir = binPath.includes("/") || binPath.includes("\\")
              ? binPath.substring(0, binPath.lastIndexOf(sep))
              : ".";
            paths[itemId] = join(binDir, "steamapps", "workshop", "content", String(appId), String(itemId));
          }
        }

        if (Object.keys(paths).length === 0) {
          removeSandbox();
          return reject(
            new Error(`SteamCMD completed but did not report any successful downloads.\nStdout: ${stdout}`),
          );
        }

        resolve({ paths, cleanup: removeSandbox });
      });

      proc.on("error", (err) => {
        fail(new Error(`Failed to start SteamCMD process: ${err.message}`));
      });
    });
  }

  private getDiagnostics(stdout: string, stderr: string): string {
    if (stdout.includes("Login Failed") || stdout.includes("Incorrect password") || stdout.includes("Incorrect jelszo"))
      return "Steam login failed: Invalid username or password.";

    if (stdout.includes("Steam Guard code") || stdout.includes("Enter Steam Guard code"))
      return "Steam login failed: Steam Guard 2FA authentication code required.";

    if (stdout.includes("Disk space") || stdout.includes("disk full") || stdout.includes("Not enough space"))
      return "SteamCMD failed: Insufficient disk space on the host machine.";

    if (stdout.includes("App") && stdout.includes("not owned"))
      return "SteamCMD failed: Base game app not owned by this Steam account.";

    if (stdout.includes("Failed to write") || stderr.includes("Permission denied"))
      return "SteamCMD failed: Permission denied or write error.";

    return "Unknown SteamCMD error occurred.";
  }

  /**
   * Downloads, extracts, and installs SteamCMD to a target directory.
   * Updates the wrapper's `binPath` to point to the installed executable.
   *
   * @param targetDir - directory where SteamCMD should be installed
   * @returns the absolute path to the installed SteamCMD executable
   * @throws if the download, extraction, or permission step fails
   */
  public async autoInstall(targetDir: string): Promise<string> {
    const platform = process.platform;
    let url = "";
    let archiveName = "";
    let executableName = "";

    if (platform === "win32") {
      url = "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip";
      archiveName = "steamcmd.zip";
      executableName = "steamcmd.exe";
    } else if (platform === "darwin") {
      url = "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz";
      archiveName = "steamcmd_osx.tar.gz";
      executableName = "steamcmd";
    } else {
      url = "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz";
      archiveName = "steamcmd_linux.tar.gz";
      executableName = "steamcmd";
    }

    mkdirSync(targetDir, { recursive: true });
    const archivePath = join(targetDir, archiveName);
    const binaryPath = join(targetDir, executableName);

    // Download archive
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Failed to download SteamCMD: ${response.statusText}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(archivePath, buffer);

    // Decompress archive. execFile with an argument array (no shell) so paths
    // containing spaces or shell metacharacters can't break out into commands.
    return new Promise((resolve, reject) => {
      const bin = platform === "win32" ? "powershell" : "tar";
      const cmdArgs = platform === "win32"
        ? ["-NoProfile", "-Command", `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`]
        : ["-xzf", archivePath, "-C", targetDir];

      execFile(bin, cmdArgs, (err) => {
        // Cleanup archive
        try {
          unlinkSync(archivePath);
        } catch {}

        if (err)
          return reject(new Error(`Failed to decompress SteamCMD: ${err.message}`));

        // Set executable permissions for Unix systems
        if (platform !== "win32") {
          try {
            chmodSync(binaryPath, 0o755);
          } catch (chmodErr: unknown) {
            const err = chmodErr as Error;
            return reject(new Error(`Failed to set execution permissions on steamcmd binary: ${err.message}`));
          }
        }

        this.binPath = binaryPath;
        resolve(binaryPath);
      });
    });
  }
}
