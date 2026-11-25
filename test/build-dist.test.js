import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { AMIGA_AUDIO_PATHS } from "../src/amiga-audio.js";
import { ASSET_BUNDLE_NAME, decodeAssetBundle, encodeAssetBundle } from "../src/asset-bundle.js";
import { decodeAssets, DOS_ASSET_PATHS } from "../src/assets.js";

const script = fileURLToPath(new URL("../tools/build-dist.mjs", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));
const paths = [...DOS_ASSET_PATHS, ...Object.values(AMIGA_AUDIO_PATHS)];

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "xenon2-dist-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const assets = join(cwd, "assets");
  const dist = join(cwd, "dist");
  for (const path of paths) {
    const file = join(assets, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `Test fixture for ${path}`);
  }
  const run = (...args) => spawnSync(process.execPath, [script, ...(args.length ? args : [assets])],
    { cwd, encoding: "utf8" });
  return { cwd, assets, dist, run };
}

test("the bundle preserves sprite identity, map keys, undefined fields and typed array views", () => {
  const pixel = Uint8Array.of(10, 0, 255, 20).subarray(1, 3);
  const sprite = { pixel, overlay: undefined };
  const data = { sprite, lookup: new Map([[128, sprite]]), words: Uint16Array.of(512, 65535),
    angles: Int8Array.of(-128, 127) };
  const restored = decodeAssetBundle(encodeAssetBundle(data));
  assert.deepEqual(restored, data);
  assert.strictEqual(restored.sprite, restored.lookup.get(128));
  assert.equal(restored.sprite.pixel.buffer.byteLength, 2);
});

test("standalone build pre-extracts all game and audio data without shipping the original files", {
  skip: !paths.every((path) => existsSync(join(root, path))),
}, async (t) => {
  const { dist, run } = await fixture(t);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const entries = await readdir(dist, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile())
    .map((entry) => relative(dist, join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
  assert.deepEqual(files.filter((file) => !file.startsWith("src/")).sort(),
    ["index.html", "styles.css", "LICENSE", ASSET_BUNDLE_NAME].sort());
  assert.ok(files.includes("src/main.js"));
  assert.match(await readFile(join(dist, "index.html"), "utf8"), /name="xenon-assets" content="game-assets.bin"/);
  const bundlePath = join(dist, ASSET_BUNDLE_NAME);
  const bundle = await readFile(bundlePath);
  const { assets, audio } = decodeAssetBundle(gunzipSync(bundle).toString("utf8"));
  const readAsset = async (path) => new Uint8Array(await readFile(join(root, path)));
  assert.deepEqual(assets, decodeAssets(await Promise.all(DOS_ASSET_PATHS.map(readAsset))));
  for (const [name, path] of Object.entries(AMIGA_AUDIO_PATHS)) assert.deepEqual(audio[name], await readAsset(path));

  const repack = await fixture(t);
  const again = repack.run("--bundle", bundlePath);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(await readFile(join(repack.dist, ASSET_BUNDLE_NAME)), bundle);
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
