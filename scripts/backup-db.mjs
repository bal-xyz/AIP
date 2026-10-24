import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const sourcePath = process.env.AIP_DB_PATH || resolve(root, "data/aip-monitor.sqlite");
const backupDirectory = process.env.AIP_BACKUP_DIR || resolve(root, "data/backups");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetPath = resolve(backupDirectory, `${basename(sourcePath, ".sqlite")}-${stamp}.sqlite`);

await mkdir(dirname(targetPath), { recursive: true });
const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
try {
  await database.backup(targetPath);
} finally {
  database.close();
}

const verification = new Database(targetPath, { readonly: true, fileMustExist: true });
try {
  const integrity = verification.pragma("integrity_check", { simple: true });
  const foreignKeys = verification.pragma("foreign_key_check");
  if (integrity !== "ok" || foreignKeys.length) throw new Error(`备份校验失败：${integrity}`);
  process.stdout.write(`${JSON.stringify({ sourcePath, targetPath, integrity, foreignKeys }, null, 2)}\n`);
} finally {
  verification.close();
}

