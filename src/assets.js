import {
  unpack, decodeMap, decodePalette, decodeTiles, decodeSprites,
  decodeEvents, decodePaths, decodeStageLogic, decodeShop, decodeAdvice, decodeRewards,
  decodeGroundLogic, decodePlayerShots, decodeRunScreenArt, decodeShopArt,
} from "./formats.js";

export function decodeStage(exe, number, files, shared, weapons) {
  const [tiles, sprites, map, events, background, paths] = files;
  const banks = [shared, decodeSprites(sprites, 32)];
  const last = shared.at(-1);
  const sharedSize = (last.offset + 16 + Math.ceil(last.width / 8) * last.height * 5 + 1) & ~1;
  const lookup = banks.map((bank) => new Map(bank.map((sprite) => [sprite.offset, sprite])));
  for (const sprite of weapons) lookup[0].set(sharedSize + sprite.offset, sprite);
  const playerShots = decodePlayerShots(exe);
  const tilePixels = decodeTiles(tiles);
  return {
    number, palette: decodePalette(exe, number), banks, weapons,
    lookup,
    tiles: tilePixels, map: decodeMap(map),
    terrainMasks: tilePixels.map((pixels) => Array.from({ length: 16 }, (_, row) => {
      let bits = 0;
      for (let x = 0; x < 16; x++) bits = (bits << 1) | Number(pixels[row * 16 + x] !== 0);
      return bits;
    })),
    events: decodeEvents(events), background: decodeEvents(background), paths: decodePaths(paths),
    logic: decodeStageLogic(exe, number),
    rewards: decodeRewards(exe),
    groundLogic: decodeGroundLogic(exe, number),
    playerShots, rearShots: playerShots.rear,
  };
}

export const DOS_ASSET_PATHS = Object.freeze([
  "XENON2.EXE", "X2SPR.DAT", "X2WEAPS.DAT", "SHOP.DAT",
  ...Array.from({ length: 5 }, (_, i) =>
    ["MODS.VGA", "SPRITES.VGA", "MAP.CMP", "EVENTS.PC", "EVENTSBG.PC", "PATHS.BIN"]
      .map((name) => `S${i + 1}/${name}`)).flat(),
  "GR.DAT",
]);

export async function loadAssets(onProgress = () => {}) {
  let loaded = 0;
  const files = await Promise.all(DOS_ASSET_PATHS.map(async (name) => {
    const response = await fetch(new URL(`../${name}`, import.meta.url));
    if (!response.ok) throw new Error(`Could not load ${name}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress(++loaded, DOS_ASSET_PATHS.length);
    return bytes;
  }));
  return decodeAssets(files);
}

export function decodeAssets(files) {
  const [exe, global, weapons, shop] = files;
  const shared = decodeSprites(unpack(global), 32);
  const weaponBank = decodeSprites(unpack(weapons), 32);
  const shopSprites = decodeSprites(unpack(shop), 32);
  const graphics = unpack(files.at(-1));
  const stages = Array.from({ length: 5 }, (_, i) =>
    decodeStage(exe, i + 1, files.slice(4 + i * 6, 10 + i * 6), shared, weaponBank));
  return {
    ...stages[0], stages, shop: decodeShop(exe), shopSprites,
    shopArt: decodeShopArt(exe, graphics, shopSprites),
    runScreenArt: decodeRunScreenArt(exe, graphics),
    advice: decodeAdvice(exe),
  };
}
