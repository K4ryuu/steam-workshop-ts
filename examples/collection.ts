import { SteamWorkshopClient } from "../src/index.js";

// Resolve a Workshop collection to the full details of every child item.
// No API key needed. Pass a collection ID as the first CLI argument, or use the default.
const collectionId = process.argv[2] || "2753947063";

const client = new SteamWorkshopClient();

console.log(`Resolving collection ${collectionId}...`);
try {
  const items = await client.getCollectionItems(collectionId);
  if (items.length === 0) {
    console.log("Collection is empty or not found.");
  } else {
    console.log(`${items.length} item(s):\n`);
    for (const item of items) {
      const sizeMb = item.file_size ? (parseInt(item.file_size, 10) / 1024 / 1024).toFixed(1) : "?";
      console.log(`- ${item.title} (${item.publishedfileid}) ${sizeMb} MB`);
    }
  }
} catch (err: unknown) {
  const error = err as Error;
  console.error("Failed to resolve collection:", error.message);
}
