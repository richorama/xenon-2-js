import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { AMIGA_AUDIO_PATHS } from "../src/amiga-audio.js";
import { ASSET_BUNDLE_NAME, decodeAssetBundle, encodeAssetBundle } from "../src/asset-bundle.js";
import { decodeAssets, DOS_ASSET_PATHS } from "../src/assets.js";

async function extractBundle(folder) {
  const assets = await realpath(folder);
  if (!(await stat(assets)).isDirectory()) {
    throw new Error("The asset path must be a folder.");
  }

  const required = [...DOS_ASSET_PATHS, ...Object.values(AMIGA_AUDIO_PATHS)];
  const invalid = [];
  for (const path of required) {
    const source = join(assets, path);
    try {
      if (await realpath(source) !== source) {
        invalid.push(path);
        continue;
      }
      const info = await stat(source);
      if (!info.isFile() || !info.size) invalid.push(path);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      invalid.push(path);
    }
  }
  if (invalid.length) throw new Error(`Missing or invalid asset files:\n${invalid.join("\n")}`);

  const readAsset = async (path) => new Uint8Array(await readFile(join(assets, path)));
  const files = await Promise.all(DOS_ASSET_PATHS.map(readAsset));
  const audio = Object.fromEntries(await Promise.all(Object.entries(AMIGA_AUDIO_PATHS)
    .map(async ([name, path]) => [name, await readAsset(path)])));
  return gzipSync(encodeAssetBundle({ assets: decodeAssets(files), audio }));
}

async function readBundle(path) {
  const bundle = await readFile(path);
  const { assets, audio } = decodeAssetBundle(gunzipSync(bundle).toString("utf8"));
  if (assets?.stages?.length !== 5 || !Object.keys(AMIGA_AUDIO_PATHS)
    .every((name) => audio?.[name] instanceof Uint8Array && audio[name].length > 0)) {
    throw new Error("The game asset bundle is incomplete.");
  }
  return bundle;
}

async function build(args) {
  const fromBundle = args[0] === "--bundle";
  if (fromBundle ? args.length !== 2 : args.length > 1 || args[0]?.startsWith("--")) {
    throw new Error("Usage: node tools/build-dist.mjs [assets-folder | --bundle path]");
  }
  const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  const output = resolve("dist");
  const exists = await lstat(output).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (exists) throw new Error(`${output} already exists. Move it aside before building again.`);
  const bundle = fromBundle ? await readBundle(args[1]) : await extractBundle(args[0] ?? ".");
  const html = await readFile(join(root, "index.html"), "utf8");

  const modules = await readdir(join(root, "src"), { withFileTypes: true });
  const site = ["styles.css", "LICENSE",
    ...modules.filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => `src/${entry.name}`)];
  await mkdir(output);
  for (const path of site) {
    const destination = join(output, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, path), destination);
  }
  await writeFile(join(output, "index.html"), html.replace("</head>",
    `  <meta name="xenon-assets" content="${ASSET_BUNDLE_NAME}">\n</head>`));
  await writeFile(join(output, ASSET_BUNDLE_NAME), bundle);
  console.log(`Built ${output} with one asset bundle (${bundle.length.toLocaleString("en")} bytes).`);
}

try {
  await build(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
