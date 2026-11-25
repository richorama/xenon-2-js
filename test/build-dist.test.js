import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AMIGA_AUDIO_PATHS } from "../src/amiga-audio.js";
import { DOS_ASSET_PATHS } from "../src/assets.js";

const script = fileURLToPath(new URL("../tools/build-dist.mjs", import.meta.url));
const paths = [...DOS_ASSET_PATHS, ...Object.values(AMIGA_AUDIO_PATHS)];

async function fixture(t, separate = true) {
  const cwd = await mkdtemp(join(tmpdir(), "xenon2-dist-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const assets = separate ? join(cwd, "assets") : cwd;
  const dist = join(cwd, "dist");
  for (const path of paths) {
    const file = join(assets, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `Test fixture for ${path}`);
  }
  const run = () => spawnSync(process.execPath, separate ? [script, assets] : [script],
    { cwd, encoding: "utf8" });
  return { cwd, assets, dist, run };
}

test("standalone build copies the web runtime and only the required game and audio files", async (t) => {
  const { assets, dist, run } = await fixture(t, false);
  await writeFile(join(assets, "amiga/audio/megablast.wav"), "Not needed");
  await writeFile(join(assets, "README.txt"), "Not needed");
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const entries = await readdir(dist, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile())
    .map((entry) => relative(dist, join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
  assert.deepEqual(files.filter((file) => !file.startsWith("src/")).sort(),
    ["index.html", "styles.css", "LICENSE", ...paths].sort());
  assert.ok(files.includes("src/main.js"));
  for (const path of paths) {
    assert.equal(await readFile(join(dist, path), "utf8"), `Test fixture for ${path}`);
  }
});

test("missing or empty audio stops the build before creating dist", async (t) => {
  const { cwd, assets, run } = await fixture(t);
  await unlink(join(assets, "amiga/audio/megablast.ogg"));
  await writeFile(join(assets, "amiga/audio/sfx-shot.wav"), "");
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /megablast\.ogg/);
  assert.match(result.stderr, /sfx-shot\.wav/);
  assert.deepEqual(await readdir(cwd), ["assets"]);
});

test("an existing distribution is left unchanged", async (t) => {
  const { dist, run } = await fixture(t);
  await mkdir(dist);
  await writeFile(join(dist, "index.html"), "Previous build");
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists/);
  assert.deepEqual(await readdir(dist), ["index.html"]);
  assert.equal(await readFile(join(dist, "index.html"), "utf8"), "Previous build");
});
