import { copyFile, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AMIGA_AUDIO_PATHS } from "../src/amiga-audio.js";
import { DOS_ASSET_PATHS } from "../src/assets.js";

async function build() {
  if (process.argv.length > 3) {
    throw new Error("Usage: node tools/build-dist.mjs [assets-folder]");
  }
  const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  const assets = await realpath(process.argv[2] ?? ".");
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

  const modules = await readdir(join(root, "src"), { withFileTypes: true });
  const site = ["index.html", "styles.css", "LICENSE",
    ...modules.filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => `src/${entry.name}`)];
  const output = resolve("dist");
  try {
    await mkdir(output);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`${output} already exists. Move it aside before building again.`);
  }
  for (const [source, paths] of [[root, site], [assets, required]]) {
    for (const path of paths) {
      const destination = join(output, path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(source, path), destination);
    }
  }
  console.log(`Built ${output} with ${required.length} game and audio files.`);
}

try {
  await build();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
