import { copyFile, open, rename, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

export async function writeStateAtomic(statePath, state) {
  const directory = dirname(statePath);
  const temporaryPath = join(directory, `.${basename(statePath)}.${process.pid}.${Date.now()}.tmp`);
  const backupPath = `${statePath}.bak`;
  const contents = `${JSON.stringify(state, null, 2)}\n`;
  let file;

  try {
    file = await open(temporaryPath, "wx");
    await file.writeFile(contents, "utf8");
    await file.sync();
    await file.close();
    file = null;

    try {
      await copyFile(statePath, backupPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    await rename(temporaryPath, statePath);
  } catch (error) {
    if (file) await file.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
