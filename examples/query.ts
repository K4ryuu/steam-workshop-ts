import { SteamWorkshopClient } from "../src/index.js";

// Searching the Workshop requires a Steam Web API key.
// Get one at https://steamcommunity.com/dev/apikey and export it:
//   STEAM_API_KEY=xxxx bun run examples/query.ts
const apiKey = process.env.STEAM_API_KEY;
if (!apiKey) {
  console.error("Set STEAM_API_KEY to run this example.");
  process.exit(1);
}

const client = new SteamWorkshopClient(apiKey);

console.log("Searching CS2 Workshop for 'surf' maps...");
try {
  const result = await client.queryItems({
    appId: 730, // CS2
    searchText: "surf",
    numPerPage: 10,
    requiredTags: ["Map"],
  });

  console.log(`Found ${result.total} item(s), showing ${result.items.length}:\n`);
  for (const item of result.items)
    console.log(`- ${item.title} (${item.publishedfileid})`);
} catch (err: unknown) {
  const error = err as Error;
  console.error("Query failed:", error.message);
}
