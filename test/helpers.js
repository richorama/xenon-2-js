import { readFileSync } from "node:fs";
import { unpack, decodeSprites, decodeShop, decodeAdvice, decodeRunScreenArt, decodeShopArt } from "../src/formats.js";
import { decodeStage } from "../src/assets.js";

export const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url));

export function loadTestAssets() {
  const { background, groundLogic, ...assets } = decodeStage(read("XENON2.EXE"), 1,
    stageFiles(1), decodeSprites(unpack(read("X2SPR.DAT")), 32),
    decodeSprites(unpack(read("X2WEAPS.DAT")), 32));
  return assets;
}

const stageFiles = (number) => ["MODS.VGA", "SPRITES.VGA", "MAP.CMP", "EVENTS.PC", "EVENTSBG.PC", "PATHS.BIN"]
  .map((file) => read(`S${number}/${file}`));

export function loadTestCampaign() {
  const exe = read("XENON2.EXE");
  const shared = decodeSprites(unpack(read("X2SPR.DAT")), 32);
  const weapons = decodeSprites(unpack(read("X2WEAPS.DAT")), 32);
  const shopSprites = decodeSprites(unpack(read("SHOP.DAT")), 32);
  const graphics = unpack(read("GR.DAT"));
  const stages = Array.from({ length: 5 }, (_, i) => decodeStage(exe, i + 1,
    stageFiles(i + 1), shared, weapons));
  return {
    ...stages[0], stages, shop: decodeShop(exe), advice: decodeAdvice(exe), shopSprites,
    shopArt: decodeShopArt(exe, graphics, shopSprites),
    runScreenArt: decodeRunScreenArt(exe, graphics),
    audio: exe.subarray(0x800 + 0x14b90, 0x800 + 0x15650),
  };
}
