import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  unpack, decodeMap, decodeSprites, decodeTiles, decodeEvents, decodeShopArt,
} from "../src/formats.js";
import { read, loadTestAssets } from "./helpers.js";

// Independently obtained by executing CS:011c in the original executable.
const originalHashes = {
  "X2SPR.DAT": "bdb7ace3207f2a386cfab6627b8a7cd7ec86c7e454d4696c90caff4f7627a684",
  "X2WEAPS.DAT": "5014f827cf3834b28aa305dec3b0e923932e37cda7fe583268410de171e16cc5",
  "SHOP.DAT": "b4f2b7715357482595d82f5ae93b289b619a9e7974fe10d07bf3bca445e6886c",
  "GR.DAT": "f5b278cd804d5e54e4572fd30f219be6a467f7ad9e552e335c4e706ea2965c73",
};

test("native decompressor matches all four original decompressed banks", () => {
  for (const [file, hash] of Object.entries(originalHashes)) {
    assert.equal(createHash("sha256").update(unpack(read(file))).digest("hex"), hash, file);
  }
});

test("compressed input rejects truncated streams and unreasonable allocation", () => {
  assert.throws(() => unpack(read("X2SPR.DAT").subarray(0, 100)), /Truncated/);
  const corrupt = Buffer.from(read("X2SPR.DAT"));
  corrupt.writeUInt32LE(0xffffffff, 11);
  assert.throws(() => unpack(corrupt), /Invalid unpacked size/);
});

test("map runs preserve little-endian tile words and reject incomplete/overflow runs", () => {
  const bytes = [1, 0x41, 0x12, 255];
  let zeros = 6000 - 256;
  while (zeros) {
    const run = Math.min(255, zeros);
    bytes.push(0, run);
    zeros -= run;
  }
  const decoded = decodeMap(Uint8Array.from(bytes));
  assert.equal(decoded[0], 0x1241);
  assert.ok(decoded.subarray(1).every((value) => value === 0));
  assert.throws(() => decodeMap(Uint8Array.from(bytes.slice(0, -1))), /Truncated/);
  assert.throws(() => decodeMap(new Uint8Array([0, 0])), /Empty map run/);
  assert.throws(() => decodeMap(Uint8Array.from(Array(24).fill([0, 255]).flat())), /overflow/);
});

test("tile decoder reads scanline-interleaved big-endian bitplanes", () => {
  const bytes = new Uint8Array(128);
  bytes[0] = 0x80;
  bytes[2] = 0x40;
  bytes[4] = 0x20;
  bytes[6] = 0x10;
  bytes[15] = 1;
  const [tile] = decodeTiles(bytes);
  assert.deepEqual(Array.from(tile.subarray(0, 5)), [1, 2, 4, 8, 0]);
  assert.equal(tile[31], 8);
  assert.throws(() => decodeTiles(bytes.subarray(1)), /Partial/);
});

test("shop portrait decodes planar rows, masked edges and original overlay sprite pointers", () => {
  const graphics = new Uint8Array(50544);
  graphics[0x8430] = 1;
  graphics[0x8433] = 0x80;
  graphics[0x8434 + 8] = 0x80;
  graphics[0x91c0 + 7 * 8 - 1] = 1;
  graphics[0x8f90 + 6 * 8] = 0x80;
  const exe = read("XENON2.EXE");
  const sprites = decodeSprites(unpack(read("SHOP.DAT")), 32);
  const art = decodeShopArt(exe, graphics, sprites);
  assert.equal(art.pixels[7], 1);
  assert.equal(art.pixels[8], 2);
  assert.equal(art.pixels[16], 4);
  assert.equal(art.pixels[86 * 112 + 96], 1);
  assert.equal(art.alpha[6], 0);
  assert.equal(art.alpha[7], 255);
  assert.equal(art.alpha[103], 255);
  assert.equal(art.alpha[104], 0);
  assert.ok(art.decorations.every((entry) => entry.frames.length >= 4
    && entry.frames.every((sprite) => sprites.includes(sprite))));
  assert.throws(() => decodeShopArt(exe, graphics.subarray(0, 0x91c0), sprites), /Truncated/);
});

test("sprite decoder honors mask planes, inclusive height, signed origins and word padding", () => {
  const bytes = new Uint8Array(44);
  const data = new DataView(bytes.buffer);
  for (const start of [0, 22]) {
    data.setInt16(start + 8, -2, true);
    data.setUint16(start + 12, 8, true);
    bytes[start + 16] = 0x81;
    bytes[start + 17] = 0x80;
    bytes[start + 20] = 0x01;
  }
  const sprites = decodeSprites(bytes);
  assert.equal(sprites.length, 2);
  assert.equal(sprites[1].offset, 22);
  assert.equal(sprites[0].originX, -2);
  assert.equal(sprites[0].height, 1);
  assert.deepEqual(Array.from(sprites[0].alpha), [255, 0, 0, 0, 0, 0, 0, 255]);
  assert.deepEqual(Array.from(sprites[0].pixels), [1, 0, 0, 0, 0, 0, 0, 8]);
  assert.throws(() => decodeSprites(bytes.subarray(0, 20)), /Truncated/);
});

test("all five original map and sprite banks decode without losing record alignment", () => {
  const counts = [112, 129, 203, 211, 208];
  for (let stage = 1; stage <= 5; stage++) {
    const tiles = decodeTiles(read(`S${stage}/MODS.VGA`));
    const map = decodeMap(read(`S${stage}/MAP.CMP`));
    assert.ok(map.every((word) => word >>> 6 < tiles.length), `stage ${stage} tile references`);
    const sprites = decodeSprites(read(`S${stage}/SPRITES.VGA`), 32);
    assert.equal(sprites.length, counts[stage - 1]);
    assert.ok(sprites.every((sprite) => sprite.pixels.length === sprite.alpha.length));
    assert.ok(decodeEvents(read(`S${stage}/EVENTS.PC`)).length > 0);
  }
});

test("all extracted stage-one enemy animations resolve to real sprite headers", () => {
  const assets = loadTestAssets();
  for (const parts of assets.logic.templates.values()) {
    for (const part of parts) {
      assert.ok(part.frames.length > 0);
      for (const frame of part.frames) {
        assert.ok(assets.lookup[frame.bank].has(frame.offset), `frame ${frame.offset.toString(16)}`);
      }
    }
  }
});
