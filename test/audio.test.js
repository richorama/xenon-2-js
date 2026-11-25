import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SpeakerDriver } from "../src/audio.js";
import { read } from "./helpers.js";

const bytes = read("XENON2.EXE").subarray(0x800 + 0x14b90, 0x800 + 0x15650);
// All state bytes independently compared against 8086 execution by verify-audio.py.
const original = [
  "0258af9bd5d6810de3b06da8fdc5f9983f1e3dd22c6da7339672004c3097c637",
  "e70c989b9516361333113df264af41c8182dad2a9201c19dc2161d7a30174edf",
];

test("both tunes and all 26 effects match 221184 independently verified original driver ticks", () => {
  for (const track of [0, 1]) {
    const hash = createHash("sha256");
    for (const effect of [null, ...Array.from({ length: 26 }, (_, i) => i)]) {
      const driver = new SpeakerDriver(bytes);
      driver.start(track);
      for (let tick = 0; tick < 4096; tick++) {
        if (tick === 17 && effect !== null) driver.effect(effect);
        driver.tick();
        for (const [start, end] of [[0x22, 0x30], [0x100, 0x130], [0x40d, 0x41f]]) {
          hash.update(driver.memory.subarray(start, end));
        }
      }
    }
    assert.equal(hash.digest("hex"), original[track], `track ${track}`);
  }
});

test("muting the driver stops both music and effects without an invalid speaker frequency", () => {
  const driver = new SpeakerDriver(bytes);
  driver.start(0);
  driver.effect(7);
  driver.tick();
  driver.stop();
  assert.equal(driver.tick(), 2);
  assert.throws(() => driver.start(2), /Invalid music/);
  assert.throws(() => driver.effect(26), /Invalid sound/);
});
