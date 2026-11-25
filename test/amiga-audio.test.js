import { test } from "node:test";
import assert from "node:assert/strict";
import { AmigaAudio } from "../src/amiga-audio.js";
import { Game } from "../src/game.js";
import { loadTestAssets } from "./helpers.js";

function harness(options = {}) {
  const sources = [];
  const requests = [];
  const states = [];
  let contexts = 0;
  const context = {
    currentTime: 0, state: "suspended", destination: {},
    resume() { this.state = "running"; return Promise.resolve(); },
    createGain() { return { gain: {}, connect() {} }; },
    async decodeAudioData(data) { return { duration: 100, file: data }; },
    createBufferSource() {
      const source = {
        stopCount: 0,
        connect(node) { this.connectedTo = node; },
        disconnect() {},
        start(when, offset) { this.offset = offset; this.when = when; },
        stop() { this.stopCount++; },
      };
      sources.push(source);
      return source;
    },
  };
  const audio = new AmigaAudio({
    createContext: () => { contexts++; return context; },
    fetch: async (url) => {
      requests.push(url.pathname);
      await options.gate;
      return { ok: !options.fail, arrayBuffer: async () => url.pathname };
    },
    onState: (state) => states.push(state),
  });
  return { audio, context, sources, requests, states, contexts: () => contexts };
}

test("gesture unlock loads Amiga assets once and concurrent resumes never duplicate the looping music", async () => {
  const h = harness();
  h.audio.setActive(true);
  const first = h.audio.unlock();
  assert.equal(h.context.state, "running");
  await Promise.all([first, h.audio.unlock(), h.audio.unlock()]);
  assert.equal(h.contexts(), 1);
  assert.equal(h.requests.length, 9);
  assert.equal(h.sources.length, 1);
  assert.ok(h.sources[0].buffer.file.endsWith("/amiga/audio/megablast.ogg"));
  assert.equal(h.sources[0].loop, true);
  assert.equal(h.sources[0].offset, 0);
});

test("default fetch retains the browser global receiver", async () => {
  const original = globalThis.fetch;
  const { context } = harness();
  try {
    globalThis.fetch = async function (url) {
      assert.equal(this, globalThis);
      return { ok: true, arrayBuffer: async () => url.pathname };
    };
    const audio = new AmigaAudio({ createContext: () => context });
    audio.setActive(true);
    await audio.unlock();
    assert.equal(audio.state, "ready", audio.error?.message);
    assert.ok(audio.music);
  } finally {
    globalThis.fetch = original;
  }
});

test("pause and mute stop effects and preserve music position; restart resets without losing mute preference", async () => {
  const { audio, context, sources } = harness();
  audio.setActive(true);
  await audio.unlock();
  audio.playFrame(["shot"]);
  context.currentTime = 112;
  audio.setActive(false);
  assert.equal(audio.offset, 12);
  assert.ok(sources.every((source) => source.stopCount === 1));
  context.currentTime = 150;
  audio.setActive(true);
  assert.equal(sources.at(-1).offset, 12);
  context.currentTime = 153;
  audio.setEnabled(false);
  assert.equal(audio.offset, 15);
  audio.playFrame(["explosion"]);
  const before = sources.length;
  audio.restart();
  await audio.unlock();
  assert.equal(audio.enabled, false);
  assert.equal(audio.offset, 0);
  assert.equal(sources.length, before);
  audio.setEnabled(true);
  assert.equal(sources.at(-1).offset, 0);
  const previous = sources.at(-1);
  audio.restart();
  assert.equal(previous.stopCount, 1);
  assert.equal(sources.at(-1).offset, 0);
  assert.equal(sources.filter((source) => !source.stopCount).length, 1);
});

test("late loading cannot start music after pause or mute, including a restart during loading", async () => {
  let loaded;
  const gate = new Promise((resolve) => { loaded = resolve; });
  const { audio, sources } = harness({ gate });
  audio.setActive(true);
  const loading = audio.unlock();
  audio.setActive(false);
  audio.setEnabled(false);
  audio.restart();
  loaded();
  await loading;
  assert.equal(sources.length, 0);
  audio.setActive(true);
  assert.equal(sources.length, 0);
  audio.setEnabled(true);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].offset, 0);
});

test("a frame starts only the winning request on each lane, and a pending cue suppresses the normal shot", async () => {
  const { audio, sources } = harness();
  audio.setActive(true);
  await audio.unlock();
  audio.playFrame(["shot", "credit", "shot", "explosion", "explosion-large", "shot"]);
  const [credit, explosion] = sources.slice(1);
  assert.equal(sources.length, 3);
  assert.match(credit.buffer.file, /sfx-credit\.wav$/);
  assert.match(explosion.buffer.file, /sfx-explosion-large\.wav$/);
  assert.equal(audio.effects.get(2), credit);
  assert.equal(audio.effects.get(1), explosion);
  audio.playFrame(["shot", "shot"]);
  assert.equal(sources.length, 4);
  const shot = sources.at(-1);
  assert.match(shot.buffer.file, /sfx-shot\.wav$/);
  assert.equal(credit.stopCount, 1);
  assert.equal(explosion.stopCount, 0);
  credit.onended();
  assert.equal(audio.effects.get(2), shot);
  const before = sources.length;
  audio.playFrame(["hit", "unknown"]);
  assert.equal(sources.length, before);
  audio.setActive(false);
  audio.playFrame(["shot"]);
  assert.equal(sources.length, before);
});

test("a death cue occupies two independent half-volume voices that other effects can replace separately", async () => {
  const { audio, sources, context } = harness();
  audio.setActive(true);
  await audio.unlock();
  context.currentTime = 3;
  audio.playFrame(["death"]);
  const [right, left] = [audio.effects.get(2), audio.effects.get(1)];
  assert.notEqual(right, left);
  assert.equal(right.buffer, left.buffer);
  assert.match(right.buffer.file, /sfx-death\.wav$/);
  assert.equal(right.connectedTo.gain.value, 0.5);
  assert.equal(left.connectedTo, right.connectedTo);
  assert.equal(left.when, right.when);
  audio.playFrame(["health"]);
  assert.equal(right.stopCount, 1);
  assert.equal(left.stopCount, 0);
  right.onended();
  assert.equal(audio.effects.get(1), left);
  assert.match(audio.effects.get(2).buffer.file, /sfx-health\.wav$/);
  audio.playFrame(["death", "explosion"]);
  assert.equal(left.stopCount, 1);
  assert.match(audio.effects.get(1).buffer.file, /sfx-explosion\.wav$/);
  assert.match(audio.effects.get(2).buffer.file, /sfx-death\.wav$/);
  assert.equal(sources.filter((source) => !source.stopCount).length, 3);
});

test("missing Amiga assets or unsupported Web Audio report failure without a PC-speaker fallback", async () => {
  const h = harness({ fail: true });
  h.audio.setActive(true);
  await h.audio.unlock();
  assert.equal(h.audio.state, "error");
  assert.match(h.audio.error.message, /Could not load Amiga audio/);
  assert.equal(h.sources.length, 0);
  assert.equal(h.states.at(-1), "error");
  const unavailable = new AmigaAudio({ createContext() { throw new Error("Unsupported"); } });
  await unavailable.unlock();
  assert.equal(unavailable.state, "error");
  assert.equal(unavailable.error.message, "Unsupported");
});

test("game emits distinct Amiga explosion, death, credit and health events", () => {
  const game = new Game(loadTestAssets());
  game.start();
  game.explode(10, 10);
  game.explode(10, 10, true);
  assert.deepEqual(game.sounds.splice(0), ["explosion", "explosion-large"]);
  game.damage(39);
  assert.deepEqual(game.sounds.splice(0), ["hit", "death"]);
  for (let i = 0; i < 16; i++) game.update();
  game.invincible = 999;
  game.pickups.push(
    { x: game.player.x, y: game.player.y - 12, kind: "credit", age: 0 },
    { x: game.player.x, y: game.player.y - 12, kind: "health", age: 0 },
  );
  game.update();
  assert.deepEqual(game.sounds, ["credit", "health"]);
});
