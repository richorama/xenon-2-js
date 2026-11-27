import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { DOS_ASSET_PATHS } from "../src/assets.js";
import { TICK_RATE } from "../src/game.js";
import { HeadlessGame, performShopAction } from "../src/headless.js";
import { GameReplay, parseRecording } from "../src/replay.js";
import { loadTestCampaign } from "./helpers.js";
import { playWithFoundry } from "../tools/foundry-local.mjs";
import { createDecisionClient } from "../tools/foundry-decision.mjs";

const root = new URL("../", import.meta.url);
const campaign = DOS_ASSET_PATHS.every((path) => existsSync(new URL(path, root))) ? loadTestCampaign() : undefined;
const withAssets = (name, fn) => test(name, { skip: !campaign && "Supply the original DOS game assets." }, fn);
const encode = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
const header = () => ({
  type: "start", format: "xenon2-actions", version: 1, seed: 42, stage: 1,
  tickRate: TICK_RATE, decisionTicks: 4, observation: { elapsedTicks: 0 },
});
const action = () => ({
  type: "step", input: { right: true, fire: true }, ticksRequested: 4, ticksAdvanced: 4,
  observation: { elapsedTicks: 4 },
});

const screenHash = (session) => {
  const pixels = session.shopScreen?.draw() ?? session.game.runScreen?.pixels;
  return pixels ? createHash("sha256").update(pixels).digest("hex") : null;
};

function recordedRun(assets, decisionTicks = 4) {
  const session = new HeadlessGame(assets, { seed: 42 });
  const records = [{ ...header(), version: 2, decisionTicks, observation: session.observe() }];
  const trajectory = [];
  const run = {
    decisionTicks,
    observe: () => ({ observation: session.observe() }),
    step(input = {}, ticks = decisionTicks) {
      const result = session.step(input, ticks, (game) => {
        trajectory.push({ snapshot: game.snapshot(), seed: game.seed, screen: screenHash(session) });
      });
      records.push({ type: "step", input, ticksRequested: ticks, ...result });
      return result;
    },
    shop: (action) => performShopAction(run, action),
  };
  return { session, run, records, trajectory };
}

function replayTrajectory(assets, records, trajectory) {
  const replay = new GameReplay(assets, parseRecording(encode(records)));
  for (const expected of trajectory) {
    assert.equal(replay.advance(), true);
    assert.equal(replay.game.seed, expected.seed);
    assert.deepEqual(replay.game.snapshot(), expected.snapshot);
    assert.equal(screenHash(replay.session), expected.screen);
  }
  assert.equal(replay.done, true);
  return replay;
}

test("recording parsing preserves exact action durations and accepts original unversioned logs", () => {
  const parsed = parseRecording(encode([header(), action()]));
  assert.equal(parsed.totalTicks, 4);
  assert.equal(parsed.tickRate, TICK_RATE);
  assert.deepEqual(parsed.actions[0].input, { right: true, fire: true });
  const legacy = header();
  delete legacy.format;
  delete legacy.version;
  delete legacy.tickRate;
  legacy.observation.tickRate = TICK_RATE;
  assert.equal(parseRecording("\n" + encode([legacy, action()])).totalTicks, 4);
});

test("version two recordings accept pulsed shop/menu controls, but legacy logs do not", () => {
  for (const input of [{ activate: 20 }, { confirm: true }]) {
    const records = [{ ...header(), version: 2 }, { ...action(), input }];
    assert.equal(parseRecording(encode(records)).totalTicks, 4);
    assert.throws(() => parseRecording(encode([header(), records[1]])));
  }
});

test("recording parsing rejects malformed files, unsupported versions and inconsistent timelines", () => {
  assert.throws(() => parseRecording("not json"), /line 1/);
  assert.throws(() => parseRecording(""), /start record/);
  for (const change of [{ type: "step" }, { version: 3 }, { format: "other" },
    { tickRate: 60 }, { stage: 6 }, { seed: -1 }, { decisionTicks: 0 },
    { observation: { elapsedTicks: 2 } }]) {
    assert.throws(() => parseRecording(encode([{ ...header(), ...change }])));
  }
  for (const change of [{ type: "unknown" }, { input: { fire: 1 } }, { ticksRequested: 0 },
    { ticksAdvanced: -1 }, { ticksAdvanced: 5 }, { observation: { elapsedTicks: 3 } }]) {
    assert.throws(() => parseRecording(encode([header(), { ...action(), ...change }])));
  }
});

withAssets("replay reconstructs every gameplay tick, including held movement, firing and a single dive press", () => {
  const session = new HeadlessGame(campaign, { seed: 42 });
  const records = [{ ...header(), observation: session.observe() }];
  const trajectory = [];
  for (const [input, ticks] of [[{ right: true, fire: true }, 4], [{ left: true, fire: true }, 7],
    [{ dive: true, fire: true }, 12], [{ up: true }, 3], [{}, 6]]) {
    const result = session.step(input, ticks, (game) => {
      trajectory.push({ snapshot: game.snapshot(), seed: game.seed });
    });
    records.push({ type: "step", input, ticksRequested: ticks, ...result });
  }
  const replay = new GameReplay(campaign, parseRecording(encode(records)));
  for (const expected of trajectory) {
    assert.equal(replay.advance(), true);
    assert.deepEqual(replay.game.snapshot(), expected.snapshot);
    assert.equal(replay.game.seed, expected.seed);
  }
  assert.equal(replay.done, true);
  assert.equal(replay.advance(), false);
  const finalState = replay.game.snapshot();
  replay.reset();
  assert.equal(replay.elapsedTicks, 0);
  while (replay.advance()) {}
  assert.deepEqual(replay.game.snapshot(), finalState);
});

withAssets("real-time Decision HTTP latency replays as actual neutral and held input ticks", async (t) => {
  const { session, run, records, trajectory } = recordedRun(campaign);
  const step = run.step;
  let release, delivered;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    assert.match(body.questions.action.instructions, /game keeps ticking while you decide/);
    assert.deepEqual(body.state.realtime.heldInput, {});
    release = () => response.end(JSON.stringify({
      answers: { action: { type: "choice", choice: "right_dive", probabilities: { right_dive: 1 } } },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((accept) => server.close(accept));
  });
  const client = createDecisionClient({
    endpoint: `http://127.0.0.1:${server.address().port}`, model: "test", apiKey: "test-only",
  });
  run.step = (input, ticks) => {
    const result = step(input, ticks);
    if (session.elapsedTicks >= 3 && release) {
      release();
      release = undefined;
    }
    return result;
  };
  const result = await playWithFoundry(run, client, {
    realtime: true, maxDecisions: 1, onDecision: (entry) => { delivered = entry; },
  });
  assert.ok(delivered.receivedAtTick >= 3);
  assert.equal(delivered.appliedAtTick, delivered.receivedAtTick + 1);
  assert.equal(result.observation.elapsedTicks, delivered.receivedAtTick + 4);
  assert.deepEqual(records.slice(1, 4).map(({ input }) => input), [{}, {}, {}]);
  assert.equal(records.filter(({ input }) => input?.dive).length, 1);
  const replay = replayTrajectory(campaign, records, trajectory);
  assert.equal(replay.elapsedTicks, result.observation.elapsedTicks);
  assert.deepEqual(replay.game.snapshot(), session.game.snapshot());
});

withAssets("replay honors interrupted actions and zero-tick commands at a terminal screen", () => {
  const session = new HeadlessGame(campaign, { lifecycle: false });
  const records = [{ ...header(), seed: 0x5845, observation: session.observe() }];
  for (let attempt = 0; attempt < 4; attempt++) {
    records.push({
      type: "step", input: { fire: true }, ticksRequested: 120, ...session.step({ fire: true }, 120),
    });
  }
  assert.ok(records.some((record) => record.ticksAdvanced > 0 && record.ticksAdvanced < 120));
  assert.equal(records.at(-1).ticksAdvanced, 0);
  const replay = new GameReplay(campaign, parseRecording(encode(records)));
  while (replay.advance()) {}
  assert.equal(replay.elapsedTicks, session.elapsedTicks);
  assert.deepEqual(replay.game.snapshot(), session.game.snapshot());
});

withAssets("replay reports divergence instead of silently playing a different trajectory", () => {
  const session = new HeadlessGame(campaign);
  const start = { ...header(), seed: 0x5845, observation: session.observe() };
  const step = { type: "step", input: { right: true }, ticksRequested: 4, ...session.step({ right: true }, 4) };
  step.observation.player.health--;
  const replay = new GameReplay(campaign, parseRecording(encode([start, step])));
  assert.throws(() => { while (replay.advance()) {} }, /diverged at tick 4/);
});

withAssets("AI shop decisions replay every click and animation with identical native pixels, equipment and RNG", async () => {
  const assets = {
    ...campaign,
    stages: campaign.stages.map((stage, index) => index ? stage : {
      ...stage, logic: { ...stage.logic, shopCheckpoint: { ...stage.logic.shopCheckpoint, worldY: 5000 } },
    }),
  };
  const { session, run, records, trajectory } = recordedRun(assets);
  const shopping = [{ action: "exit" }, { action: "buy", id: 3 }, { action: "exit" }];
  const phases = [];
  let flights = 0;
  const result = await playWithFoundry(run, { async complete(packet) {
    if (packet.scene.status === "shop") {
      phases.push(packet.scene.shop.phase);
      assert.equal(packet.scene.enemies, undefined);
      const action = shopping.shift();
      assert.ok(packet.scene.shop.legalActions.some((legal) => JSON.stringify(legal) === JSON.stringify(action)));
      return { content: JSON.stringify({ shop: action }) };
    }
    if (++flights === 2) {
      assert.equal(packet.motionInterval, null);
      assert.deepEqual(packet.previousScenes, []);
      assert.ok(packet.recentDecisions.some(({ shop }) => shop?.action === "buy"));
    }
    return { content: '{"input":{"fire":true}}' };
  } }, { maxDecisions: 5 });
  assert.equal(result.decisions, 5);
  assert.deepEqual(phases, ["sell", "buy", "buy"]);
  assert.equal(session.game.player.speed, 1);
  assert.ok(records.some(({ input }) => input?.activate === 21));
  assert.ok(trajectory.some(({ screen }) => screen !== null));
  const replay = replayTrajectory(assets, records, trajectory);
  assert.equal(replay.game.player.speed, 1);
  replay.reset();
  while (replay.advance()) {}
  assert.equal(replay.game.seed, session.game.seed);
});

withAssets("AI life loss, high-score entry, respawns and finite continues replay exactly until game over", async () => {
  const assets = {
    ...campaign, runScreenArt: {
      ...campaign.runScreenArt,
      scores: campaign.runScreenArt.scores.map((entry, index, scores) =>
        index === scores.length - 1 ? { ...entry, score: -1 } : entry),
    },
  };
  for (const autoContinue of [false, true]) {
    const { session, run, records, trajectory } = recordedRun(assets, 120);
    let calls = 0;
    const result = await playWithFoundry(run, { async complete(packet) {
      calls++;
      assert.equal(packet.scene.status, "playing");
      return { content: '{"input":{"fire":true}}' };
    } }, { maxDecisions: 500, autoContinue });
    assert.equal(result.decisions, calls);
    assert.equal(result.observation.status, autoContinue ? "gameover" : "continue");
    assert.equal(result.observation.continues, autoContinue ? 0 : 2);
    assert.equal(result.observation.life, autoContinue ? 9 : 3);
    assert.ok(records.some(({ observation }) => observation.status === "score-entry"));
    assert.ok(records.some(({ observation }) => observation.status === "turn-ready"));
    assert.ok(records.some(({ input }) => input?.confirm));
    const replay = replayTrajectory(assets, records, trajectory);
    assert.equal(replay.game.seed, session.game.seed);
    assert.equal(replay.game.status, session.game.status);
  }
});

withAssets("first-death benchmark preserves the fatal native frame and stops before spending a life or continue", async () => {
  const { session, run, records, trajectory } = recordedRun(campaign);
  const result = await playWithFoundry(run, { async complete() {
    return { content: '{"input":{"fire":true}}' };
  } }, { maxDecisions: 500, stopOnDeath: true });
  assert.equal(result.observation.status, "dying");
  assert.equal(result.observation.player.health, 0);
  assert.equal(result.observation.player.lives, 3);
  assert.equal(result.observation.continues, 2);
  assert.equal(result.benchmark.survivedTurns, result.decisions - 1);
  assert.equal(result.benchmark.fatalTurn, result.decisions);
  assert.ok(records.slice(1, -1).every(({ observation }) => observation.status === "playing"));
  assert.ok(records.slice(1).every(({ input }) => !input.confirm));
  const replay = replayTrajectory(campaign, records, trajectory);
  assert.equal(replay.game.status, "dying");
  assert.equal(replay.game.seed, session.game.seed);
});

withAssets("version two replay detects equipment divergence even when position and credits match", () => {
  const { run, records } = recordedRun(campaign);
  run.step({ fire: true });
  records.at(-1).observation.player.weapons[0].upgradeLevel++;
  const replay = new GameReplay(campaign, parseRecording(encode(records)));
  assert.throws(() => { while (replay.advance()) {} }, /diverged/);
});
