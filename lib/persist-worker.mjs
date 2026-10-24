import process from "node:process";
import { StateDatabase } from "./database.mjs";

let database = null;
process.on("message", message => {
  if (message?.type !== "persist" || !message.databasePath || !message.state) return;
  try {
    database ||= new StateDatabase(message.databasePath);
    database.persistState(message.state);
    process.send?.({ type: "done" });
  } catch (error) {
    process.send?.({ type: "error", error: error.message || String(error) });
  }
});

process.on("disconnect", () => {
  database?.close();
  process.exit(0);
});
