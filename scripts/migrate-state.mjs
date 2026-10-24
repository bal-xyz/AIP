import { resolve } from "node:path";
import { StateDatabase } from "../lib/database.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const root = resolve(new URL("..", import.meta.url).pathname);
const sourcePath = process.env.AIP_STATE_PATH || resolve(root, "data/state.json");
const databasePath = process.env.AIP_DB_PATH || resolve(root, "data/aip-monitor.sqlite");

const database = new StateDatabase(databasePath);
try {
  const result = database.importLegacy(sourcePath, { dryRun });
  const output = {
    mode: dryRun ? "dry-run" : "import",
    sourcePath,
    databasePath,
    ...result,
    integrity: dryRun ? undefined : database.integrityReport()
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  database.close();
}

