import { SteamWorkshopClient, SteamCmdWrapper } from "../src/index.js";

// Initialize client
const client = new SteamWorkshopClient();

console.log("Fetching workshop item details...");
try {
  // Query CS2 map (Aim Botz map workshop ID)
  const details = await client.getItemDetails("3070244462");

  if (details && details.length > 0 && details[0]) {
    const item = details[0];
    console.log("--- Item Details ---");
    console.log(`Title:       ${item.title}`);
    console.log(`File Name:   ${item.filename}`);
    console.log(`File Size:   ${item.file_size ? (parseInt(item.file_size) / 1024 / 1024).toFixed(2) + " MB" : "Unknown"}`);
    console.log(`URL:         ${item.file_url || "Not available"}`);
    console.log(`Tags:        ${item.tags?.map((t) => t.tag).join(", ") || "None"}`);
  } else {
    console.log("No details found or item is private.");
  }
} catch (err: unknown) {
  const error = err as Error;
  console.error("Error fetching details:", error.message);
}

// SteamCMD Sandbox download (Docker-based)
console.log("\nDownloading workshop item via isolated Docker Sandbox...");
const steamcmd = new SteamCmdWrapper({
  useDocker: true, // Prevents host pollution and guarantees compatibility on macOS
});

try {
  // Downloads active items and validates free disk space before starting
  const downloadPaths = await client.downloadItemsCached(
    730,
    [3070244462],
    steamcmd,
    "./cached_workshop_content",
  );
  console.log("Success! Cached maps are ready:", downloadPaths);
} catch (err: unknown) {
  const error = err as Error;
  console.error("Docker Sandbox batch download failed:", error.message);
}
