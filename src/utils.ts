import { execFile } from "child_process";

/**
 * Returns the free disk space of the disk containing the specified path, in bytes.
 * Uses `execFile` (no shell) so the path can't be interpreted by a shell.
 *
 * @param path - a path on the disk to probe
 * @returns the free bytes, or `Infinity` if the probe fails (so callers never block on it)
 */
export function getFreeDiskSpace(path: string): Promise<number> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const driveLetter = path.substring(0, 1);
      // Get-Volume only accepts a single drive letter; anything else (e.g. a relative
      // path or UNC share) can't be probed this way, so fall back to Infinity.
      if (!/^[A-Za-z]$/.test(driveLetter))
        return resolve(Infinity);

      execFile("powershell", ["-NoProfile", "-Command", `Get-Volume -DriveLetter ${driveLetter} | Select-Object -ExpandProperty SizeRemaining`], (err, stdout) => {
        if (err || !stdout)
          return resolve(Infinity);

        const bytes = parseInt(stdout.trim(), 10);
        resolve(isNaN(bytes) ? Infinity : bytes);
      });
    } else {
      execFile("df", ["-k", path], (err, stdout) => {
        if (err || !stdout)
          return resolve(Infinity);

        const lines = stdout.trim().split("\n");
        const lastLine = lines[lines.length - 1];
        if (!lastLine)
          return resolve(Infinity);

        const parts = lastLine.split(/\s+/);
        const availableKB = parseInt(parts[3] || "0", 10);
        resolve(isNaN(availableKB) ? Infinity : availableKB * 1024);
      });
    }
  });
}
