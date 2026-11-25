import { test } from "node:test";
import assert from "node:assert/strict";
import { PathMotion } from "../src/motion.js";
import { decodePaths, decodeStageOneLogic } from "../src/formats.js";
import { read } from "./helpers.js";

const paths = decodePaths(read("S1/PATHS.BIN"));
const { sine } = decodeStageOneLogic(read("XENON2.EXE"));

// CS:4871 run with seven substeps/tick; each tuple is x, y, angle, turn,
// remaining segment duration, and bytecode cursor at ticks 1, 10 and 20.
const oracle = [
  [[2490368, -3014656, 4194304, 0, 67, 246], [2490368, 1114112, 4194304, 0, 4, 246], [2383872, 5647360, 3559424, -22528, 339, 256]],
  [[18204672, -2164736, 4082432, 40192, 121, 314], [16671744, 1473536, 6614528, 40192, 58, 314], [12494848, 2022400, 9192850, -88596, 154, 324]],
  [[-2228224, 9795584, 140673, -17621, 121, 412], [1801216, 9119744, 15676915, -21842, 58, 412], [5161984, 6200320, 14200832, 9216, 116, 422]],
  [[22092800, 10086400, 8583936, 27904, 121, 500], [18401280, 8628224, 10341888, 27904, 58, 500], [16239616, 4782080, 11572224, -18688, 51, 510]],
  [[7456768, 14031872, 12466134, 2034, 163, 578], [7368704, 9967616, 12590370, 1908, 100, 578], [7450624, 5451776, 12719100, 1768, 30, 578]],
];

test("five native movement paths match original 8086 traces, including signed turn acceleration", () => {
  for (let path = 1; path <= 5; path++) {
    const motion = new PathMotion(paths, path, sine);
    const trace = [];
    for (let tick = 1; tick <= 20; tick++) {
      motion.step(7);
      if ([1, 10, 20].includes(tick)) {
        trace.push([motion.xFixed, motion.yFixed, motion.heading,
          motion.turn, motion.remaining, motion.cursor]);
      }
    }
    assert.deepEqual(trace, oracle[path - 1], `path ${path}`);
  }
});

test("formation delays consume movement substeps without moving early", () => {
  const leader = new PathMotion(paths, 1, sine);
  const follower = new PathMotion(paths, 1, sine, { delay: 32, offsetX: 48 });
  const start = [follower.xFixed, follower.yFixed];
  follower.step(28);
  assert.deepEqual([follower.xFixed, follower.yFixed], start);
  follower.step(11);
  leader.step(7);
  assert.equal(follower.xFixed, leader.xFixed + 48 * 65536);
  assert.equal(follower.yFixed, leader.yFixed);
});

test("path bytecode rejects cyclic branches instead of hanging the browser", () => {
  const bytes = new Uint8Array(234);
  new DataView(bytes.buffer).setInt16(230, 8, true);
  const motion = new PathMotion({ bytes, offsets: [230] }, 1, sine);
  assert.throws(() => motion.step(7), /Path command loop/);
});

test("path termination preserves the original signed duration when a tick crosses the segment end", () => {
  const bytes = new Uint8Array(18);
  const data = new DataView(bytes.buffer);
  [10, 0, 0, 2, 0, 0, 0, 3, 0].forEach((word, i) => data.setInt16(i * 2, word, true));
  const crossed = new PathMotion({ bytes, offsets: [0] }, 1, sine);
  crossed.step(4);
  assert.equal(crossed.active, false);
  assert.equal(crossed.remaining, -1);
  const exact = new PathMotion({ bytes, offsets: [0] }, 1, sine);
  exact.step(3);
  assert.equal(exact.active, true);
  exact.step(1);
  assert.equal(exact.active, false);
  assert.equal(exact.remaining, 0);
});
