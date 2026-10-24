import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStateAtomic } from "../lib/state-store.mjs";

test("状态写入替换完整文件并保留上一版本备份", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aip-state-store-"));
  const statePath = join(directory, "state.json");
  const previous = { version: 4, posts: [{ id: "old" }] };
  const next = { version: 5, posts: [{ id: "new" }] };
  await writeFile(statePath, `${JSON.stringify(previous)}\n`);

  await writeStateAtomic(statePath, next);

  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), next);
  assert.deepEqual(JSON.parse(await readFile(`${statePath}.bak`, "utf8")), previous);
});
