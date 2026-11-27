import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DOS_ASSET_PATHS } from "../src/assets.js";
import { Game, TICK_RATE } from "../src/game.js";
import { HeadlessGame, performShopAction, validateAction, validateShopAction, validateStep } from "../src/headless.js";
import { GameReplay, parseRecording } from "../src/replay.js";
import { createHeadlessRun } from "../tools/headless.mjs";
import { playWithFoundry } from "../tools/foundry-local.mjs";
import { loadTestCampaign } from "./helpers.js";

const root = new URL("../", import.meta.url);
const campaign = DOS_ASSET_PATHS.every((path) => existsSync(new URL(path, root))) ? loadTestCampaign() : undefined;
const withAssets = (name, fn) => test(name, { skip: !campaign && "Supply the original DOS game assets." }, fn);
const cli = fileURLToPath(new URL("../tools/headless.mjs", import.meta.url));

function shopRun(stage = 1, destination = stage) {
  const session = new HeadlessGame(campaign, { stage });
  const run = {
    observe: () => ({ observation: session.observe() }),
    step: (input, ticks) => session.step(input, ticks),
  };
  session.game.openShop(destination);
  return {
    session, run,
    open() {
      session.syncScreen();
      for (let tick = 0; tick < 1000 && session.shopScreen.busy; tick++) session.step({});
      assert.equal(session.shopScreen.busy, false);
    },
  };
}

test("headless controls reject invalid buttons, contradictory movement and unbounded action lengths", () => {
  for (const input of [null, [], { fire: 1 }, { target: { x: 10 } }, { left: true, right: true },
    { up: true, down: true }]) assert.throws(() => validateAction(input, 1));
  for (const ticks of [0, -1, 121, 1.5, Infinity, NaN, "4"]) {
    assert.throws(() => validateAction({ fire: true }, ticks));
  }
  assert.doesNotThrow(() => validateAction({ right: true, up: true, fire: true }, 120));
});

test("shop and lifecycle controls reject mixed modes, malformed choices and invalid slots", () => {
  for (const input of [{ activate: -1 }, { activate: 22 }, { activate: "1" },
    { activate: 1, fire: true }, { confirm: 1 }, { confirm: true, dive: true }, [], null]) {
    assert.throws(() => validateStep(input, 1));
  }
  for (const action of [null, [], {}, { action: "buy", id: 1 }, { action: "buy", id: "3" },
    { action: "sell", slot: 7 }, { action: "buy", id: 3, slot: 0 }, { action: "exit", ticks: 120 }]) {
    assert.throws(() => validateShopAction(action));
  }
  assert.doesNotThrow(() => validateStep({ activate: 21 }, 4));
  assert.doesNotThrow(() => validateStep({ confirm: true }, 1));
});

test("headless CLI help and invalid arguments do not need game assets", () => {
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--interactive/);
  for (const args of [["--ticks", "0"], ["--ticks", "NaN"], ["--ticks", "1.5"],
    ["--ticks", "4", "--interactive"], ["--unknown"], ["--no-frames"], ["--decision-ticks", "0"],
    ["--decision-ticks", "121"], ["--decision-ticks", "1.5"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  }
});

test("invalid default decision intervals are rejected before loading assets", async () => {
  for (const decisionTicks of [0, -1, 121, 1.5, NaN, "4"]) {
    await assert.rejects(createHeadlessRun({ decisionTicks }), /Action ticks/);
  }
  await assert.rejects(createHeadlessRun({ tapFire: "true" }), /tapFire must be a boolean/);
});

withAssets("headless stepping matches direct simulation, pulses dive once, and freezes between actions", async () => {
  const session = new HeadlessGame(campaign, { seed: 1234 });
  const direct = new Game(campaign);
  direct.start();
  direct.seed = 1234;
  for (const [input, ticks] of [[{ right: true, fire: true }, 4], [{ left: true, fire: true }, 8],
    [{ fire: true, dive: true }, 9], [{}, 12]]) {
    assert.equal(session.step(input, ticks).ticksAdvanced, ticks);
    for (let tick = 0; tick < ticks; tick++) {
      direct.update({ ...input, dive: Boolean(input.dive && tick === 0) });
    }
    assert.deepEqual(session.game.snapshot(), direct.snapshot());
    assert.equal(session.game.seed, direct.seed);
    assert.equal(session.game.sounds.length, 0);
  }
  const before = session.observe();
  await setTimeout(30);
  assert.deepEqual(session.observe(), before);
  assert.throws(() => session.step({ fire: "true" }, 4));
  assert.deepEqual(session.observe(), before);
});

withAssets("headless pickup outcomes distinguish native collection and expiration without allocating extra actor IDs", () => {
  const session = new HeadlessGame(campaign);
  const collected = { kind: "health", x: 100, y: 100, age: 0 };
  const missed = { kind: "reward", x: 140, y: 100, age: 0, reward: 0 };
  session.game.pickups.push(collected, missed);
  const observed = session.observe(), nextId = session.nextId;
  const healthId = observed.pickups.find(({ kind }) => kind === "health").id;
  session.game.updatePickup(collected, { x: 90, y: 90, w: 20, h: 20 });
  session.game.resolvePickup(missed, false);
  const outcomes = session.observe().pickupOutcomes;
  assert.equal(outcomes.find(({ id }) => id === healthId).collected, true);
  assert.equal(outcomes.find(({ kind }) => kind === "reward").collected, false);
  assert.equal(session.nextId, nextId);
  session.game.resolvePickup({ kind: "health", x: 10, y: 10 }, false);
  assert.equal(session.observe().pickupOutcomes.length, 2, "Unseen drops must not leak into observations.");
  session.game.damage(8);
  session.game.player.health = 39;
  assert.equal(session.observe().energyLost, 8, "Restoring health must not erase the observed hit.");
});

withAssets("actions stop at death and lifecycle boundaries, and confirmation resumes a life or continue", () => {
  for (const lives of [1, 2]) {
    const session = new HeadlessGame(campaign);
    session.game.player.health = 1;
    session.game.player.lives = lives;
    session.game.bullets.push({ x: 160, y: 160, dx: 0, dy: 0, damage: 100 });
    const death = session.step({ fire: true }, 120);
    assert.equal(death.ticksAdvanced, 1);
    assert.equal(death.observation.status, "dying");
    const respawn = session.step({}, 120);
    assert.equal(respawn.ticksAdvanced, 16);
    assert.equal(respawn.observation.status, lives === 1 ? "continue" : "turn-ready");
    assert.equal(respawn.observation.life, 1);
    assert.throws(() => session.step({ fire: true }, 120), /Flight controls/);
    assert.deepEqual(session.observe(), respawn.observation);
    const confirmed = session.step({ confirm: true }, 120);
    assert.equal(confirmed.ticksAdvanced, 1);
    assert.equal(confirmed.observation.status, lives === 1 ? "turn-ready" : "playing");
    assert.equal(confirmed.observation.continues, lives === 1 ? 1 : 2);
    assert.equal(confirmed.observation.player.lives, lives === 1 ? 3 : 1);
    if (lives === 1) assert.equal(session.step({ confirm: true }).observation.status, "playing");
  }
});

withAssets("observations expose visible geometry with stable IDs and a camera-aligned conservative terrain grid", () => {
  const session = new HeadlessGame(campaign);
  const game = session.game;
  const enemy = (box, extra = {}) => ({ ground: true, bounds() { return this.box; }, box, ...extra });
  const shown = enemy({ x: 70, y: 80, w: 12, h: 14 });
  game.ground.push(shown, enemy({ x: 80, y: 20, w: 8, h: 8 }, { hidden: true }),
    enemy({ x: 80, y: 20, w: 8, h: 8 }, { dead: true }),
    enemy({ x: 80, y: -20, w: 8, h: 8 }));
  game.bullets.push({ x: 50, y: 60 }, { x: -30, y: 60 });
  game.pickups.push({ kind: "credit", x: 120, y: 130 }, { kind: "credit", x: 120, y: 300 });
  game.camera--;
  game.map.fill(0);
  game.assets = { ...game.assets, terrainMasks: [Array(16).fill(0), [1, ...Array(15).fill(0)]] };
  game.map[Math.floor(game.camera / 16) * 20 + 3] = 64;
  const before = { seed: game.seed, tick: game.tick };
  const observation = session.observe();
  assert.equal(observation.enemies.length, 1);
  assert.deepEqual(observation.enemies[0].bounds, shown.box);
  assert.equal(observation.bullets.length, 1);
  assert.equal(observation.pickups.length, 1);
  assert.equal(observation.terrain.y, -15);
  assert.equal(observation.terrain.rows.length, 13);
  assert.equal(observation.terrain.rows[0], "00010000000000000000");
  assert.ok(observation.terrain.rows.slice(1).every((row) => row === "00000000000000000000"));
  assert.deepEqual(JSON.parse(JSON.stringify(observation)), observation);
  shown.box.x++;
  assert.equal(session.observe().enemies[0].id, observation.enemies[0].id);
  assert.equal(observation.enemies[0].bounds.x, 70);
  assert.deepEqual({ seed: game.seed, tick: game.tick }, before);
});

withAssets("headless sessions can start and step each of the five stages", () => {
  for (let stage = 1; stage <= 5; stage++) {
    const session = new HeadlessGame(campaign, { stage, seed: 0 });
    assert.equal(session.step({ fire: true }, 20).observation.stage, stage);
  }
  for (const options of [{ stage: 0 }, { stage: 6 }, { seed: -1 }, { seed: 65536 }, { seed: NaN }]) {
    assert.throws(() => new HeadlessGame(campaign, options));
  }
});

withAssets("visible stage-one boss entrance is observed before contact activation without allocating actor IDs", () => {
  const session = new HeadlessGame(campaign), game = session.game, boss = game.boss;
  assert.equal(session.observe().boss, undefined);
  game.camera = 100;
  boss.motion.y = boss.worldY - game.camera;
  const before = game.snapshot(), nextId = session.nextId;
  const entrance = session.observe().boss;
  assert.equal(entrance.kind, "stage-one-boss");
  assert.equal(entrance.bounds.y, -84);
  assert.ok(entrance.bounds.y + entrance.bounds.h > 0);
  assert.equal(entrance.contactBounds, null);
  assert.equal(entrance.weakPoint, null);
  assert.equal(session.nextId, nextId);
  assert.deepEqual(game.snapshot(), before);
  game.camera = 48;
  boss.updateCore(game.camera, game.control, game.tick, () => {}, 0);
  const active = session.observe().boss;
  assert.deepEqual(active.contactBounds, boss.bodyBox);
  assert.deepEqual(active.weakPoint, { x: 152, y: boss.weakY, w: 16, h: 14 });
  boss.dead = true;
  assert.equal(session.observe().boss, undefined);
});

withAssets("terrain navigation checks the native hull without treating partial tiles as solid or revealing offscreen rock", () => {
  const session = new HeadlessGame(campaign), game = session.game;
  game.map.fill(0);
  game.assets = { ...game.assets, terrainMasks: [Array(16).fill(0), Array(16).fill(1)] };
  game.map[((game.camera + 80) >> 4) * 20 + 10] = 64;
  const original = game.snapshot();
  assert.equal(game.shipTouchesTerrain({ x: 144, y: 80 }), false);
  assert.equal(game.shipTouchesTerrain({ x: 176, y: 80 }), true);
  const observation = session.observe(), navigation = observation.terrain.navigation;
  const at = (x, y) => navigation.rows[(y - navigation.y) / navigation.cellSize][(x - navigation.x) / navigation.cellSize];
  assert.equal(observation.terrain.rows[5][10], "1");
  assert.equal(at(144, 80), "0");
  assert.equal(at(176, 80), "1");
  assert.deepEqual(game.snapshot(), original);
  const firstRow = game.camera >> 4;
  game.map.fill(64, (firstRow - 1) * 20, firstRow * 20);
  game.map.fill(64, (firstRow + 12) * 20, (firstRow + 13) * 20);
  assert.deepEqual(session.observe().terrain.navigation, navigation);
  game.terrainRecovery = -1;
  assert.equal(session.observe().terrain.recovering, true);
});

withAssets("native progress retains between-decision peaks through backtracking and miniboss floor changes", () => {
  const session = new HeadlessGame(campaign);
  session.step({ fire: true }, 8);
  const advanced = session.observe();
  session.step({ down: true }, 8);
  const backtracked = session.observe();
  assert.ok(backtracked.levelProgress < advanced.levelProgress);
  assert.equal(backtracked.furthestProgress.elapsedTicks, 9);
  assert.ok(backtracked.furthestProgress.progress > advanced.furthestProgress.progress);
  assert.equal(backtracked.maxProgressStallTicks, 7);
  session.game.endCamera = session.game.camera - 100;
  const changedFloor = session.observe();
  assert.notEqual(changedFloor.progress, backtracked.progress);
  assert.equal(changedFloor.levelProgress, backtracked.levelProgress);
});

withAssets("observations distinguish sealed supply pods from released rewards without revealing their contents", () => {
  const session = new HeadlessGame(campaign);
  const game = session.game;
  const event = game.assets.events.find(([, type]) => type === 0);
  game.spawn(event);
  const pod = game.enemies.at(-1);
  pod.motion.xFixed = 160 * 65536;
  pod.motion.yFixed = 80 * 65536;
  const observation = session.observe();
  const target = observation.enemies.find(({ kind }) => kind === "supply-pod");
  assert.ok(target);
  assert.equal(target.reward, undefined);
  assert.deepEqual(observation.pickups, []);
  game.destroy(pod);
  const opened = session.observe();
  assert.ok(!opened.enemies.some(({ id }) => id === target.id));
  assert.equal(opened.pickups.length, 1);
  assert.equal(opened.pickups[0].kind, "reward");
  assert.equal(opened.pickups[0].reward, undefined);
});

withAssets("capture produces real PNGs and a replayable action log on the simulation clock", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "xenon2-headless-test-"));
  const runs = [];
  t.after(async () => {
    for (const run of runs) run.close();
    await rm(temp, { recursive: true, force: true });
  });
  const output = join(temp, "run");
  const run = await createHeadlessRun({ output, seed: 42 });
  runs.push(run);
  const initial = run.screenshot();
  const result = run.step({ fire: true, right: true }, 5);
  run.close();
  assert.equal(result.ticksAdvanced, 5);
  const png = await readFile(join(output, result.frame));
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.readUInt32BE(16), 320);
  assert.equal(png.readUInt32BE(20), 200);
  assert.deepEqual(run.screenshot(), png);
  assert.notDeepEqual(png, initial);
  assert.equal((await readdir(output)).filter((name) => name.endsWith(".png")).length, 6);
  const frames = (await readFile(join(output, "frames.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(frames.map(({ elapsedTicks }) => elapsedTicks), [0, 1, 2, 3, 4, 5]);
  assert.equal(frames.at(-1).time, 5 / TICK_RATE);
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.elapsedTicks, 5);
  assert.equal(manifest.frameCount, 6);
  assert.equal(manifest.tickRate, TICK_RATE);
  assert.equal(manifest.closed, true);
  const actions = (await readFile(join(output, "actions.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const replay = await createHeadlessRun({ seed: actions[0].seed, stage: actions[0].stage, capture: true });
  runs.push(replay);
  for (const action of actions.slice(1)) {
    assert.deepEqual(replay.step(action.input, action.ticksRequested).observation, action.observation);
  }
  assert.deepEqual(replay.screenshot(), png);
  const stateOnly = await createHeadlessRun({ seed: 42 });
  runs.push(stateOnly);
  assert.deepEqual(stateOnly.step({ fire: true, right: true }, 5).observation, result.observation);
  assert.throws(() => stateOnly.screenshot(), /Enable capture/);
  assert.throws(() => run.step(), /closed/);
  await writeFile(join(output, "keep.txt"), "Do not replace.");
  await assert.rejects(createHeadlessRun({ output }), { code: "EEXIST" });
  assert.equal(await readFile(join(output, "keep.txt"), "utf8"), "Do not replace.");
});

withAssets("tap fire preserves its phase across odd actions and increases native firing without changing cooldowns", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "xenon2-tap-fire-rate-"));
  const runs = [];
  t.after(async () => {
    for (const run of runs) run.close();
    await rm(temp, { recursive: true, force: true });
  });
  for (const tapFire of [false, true]) {
    const output = join(temp, String(tapFire));
    const run = await createHeadlessRun({ output, capture: false, tapFire });
    runs.push(run);
    for (const ticks of [3, 5, 7, 9, 8]) assert.equal(run.step({ fire: true }, ticks).ticksAdvanced, ticks);
    run.close();
    const recording = parseRecording(await readFile(join(output, "actions.jsonl"), "utf8"));
    const replay = new GameReplay(campaign, recording);
    const addRound = replay.game.addPlayerRound;
    let rounds = 0;
    replay.game.addPlayerRound = function (...args) {
      rounds++;
      return addRound.apply(this, args);
    };
    while (replay.advance()) {}
    assert.equal(rounds, tapFire ? 16 : 4);
    assert.equal(replay.game.firePeriod, 8);
    assert.deepEqual(replay.session.observe(), run.observe().observation);
    if (tapFire) {
      assert.equal(recording.actions.length, 32);
      assert.ok(recording.actions.every((action, index) => action.input.fire === (index % 2 === 0)));
      assert.ok(recording.actions.every((action) => action.ticksRequested === 1));
    } else {
      assert.deepEqual(recording.actions.map((action) => action.ticksRequested), [3, 5, 7, 9, 8]);
      assert.ok(recording.actions.every((action) => action.input.fire));
    }
  }
});

withAssets("tap-fire AI decisions replay every actual input and pixel, without repeating dive or changing decision duration", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "xenon2-tap-fire-replay-"));
  const runs = [];
  t.after(async () => {
    for (const run of runs) run.close();
    await rm(temp, { recursive: true, force: true });
  });
  const output = join(temp, "run");
  const run = await createHeadlessRun({ output, tapFire: true });
  runs.push(run);
  const before = run.observe();
  for (const [input, ticks] of [[{ fire: 1 }, 4], [{ fire: true, activate: 1 }, 4],
    [{ fire: true, left: true, right: true }, 4], [{ fire: true }, 0]]) {
    assert.throws(() => run.step(input, ticks));
    assert.deepEqual(run.observe(), before);
  }
  const actions = [{ right: true, fire: true }, { right: true, fire: true },
    { right: true }, { fire: true, dive: true }, { up: true, fire: true }];
  const intended = structuredClone(actions);
  let calls = 0;
  const result = await playWithFoundry(run, { async complete(packet) {
    assert.equal(packet.decisionTicks, 4);
    assert.equal(packet.scene.elapsedTicks, calls * 4);
    return { content: JSON.stringify({ input: actions[calls++] }) };
  } }, { maxDecisions: actions.length, stopOnDeath: true });
  run.close();
  assert.equal(result.benchmark.tapFire, true);
  assert.equal(result.benchmark.survivedTurns, actions.length);
  assert.equal(result.benchmark.elapsedTicks, actions.length * 4);
  assert.deepEqual(JSON.parse(await readFile(join(output, "benchmark.json"), "utf8")), result.benchmark);
  assert.deepEqual(result.benchmark.progress.furthest, result.observation.furthestProgress);
  assert.equal(result.observation.player.dives, 2);
  assert.equal(result.observation.player.diving, true);
  assert.deepEqual(actions, intended);
  const records = (await readFile(join(output, "actions.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const steps = records.slice(1);
  assert.equal(records[0].tapFire, true);
  assert.equal(JSON.parse(await readFile(join(output, "manifest.json"), "utf8")).tapFire, true);
  assert.equal(steps.filter((action) => action.input.dive).length, 1);
  assert.deepEqual(steps.slice(0, 8).map((action) => action.input.fire), [true, false, true, false, true, false, true, false]);
  assert.ok(steps.filter((action) => action.observation.elapsedTicks <= 8).every((action) => action.input.right));
  const replay = await createHeadlessRun({ capture: true });
  runs.push(replay);
  assert.deepEqual(replay.screenshot(), await readFile(join(output, "frame-000000.png")));
  for (const action of steps) {
    const state = replay.step(action.input, action.ticksRequested);
    assert.deepEqual(state.observation, action.observation);
    assert.deepEqual(replay.screenshot(), await readFile(join(output, action.frame)));
  }
});

withAssets("tapped actions stop at native death and leave lifecycle confirmation untapped", async (t) => {
  const run = await createHeadlessRun({ capture: false, tapFire: true });
  t.after(() => run.close());
  const fatal = run.step({ fire: true }, 120);
  assert.equal(fatal.observation.status, "dying");
  assert.ok(fatal.ticksAdvanced > 0 && fatal.ticksAdvanced < 120);
  assert.equal(fatal.observation.player.lives, 3);
  const ready = run.step({}, 120);
  assert.equal(ready.observation.status, "turn-ready");
  assert.equal(ready.observation.player.lives, 2);
  assert.equal(run.step({ confirm: true }, 1).observation.status, "playing");
  assert.equal(run.step({ fire: true }, 1).ticksAdvanced, 1);
});

withAssets("JSONL control reports invalid commands without ticking and accepts subsequent actions", () => {
  const result = spawnSync(process.execPath, [cli, "--interactive", "--seed", "0x1234"], {
    encoding: "utf8", timeout: 10000,
    input: [
      '{"command":"observe"}', 'not json', '{"input":{"fire":"yes"},"ticks":4}',
      '{"command":"unknown"}', '{"fire":true}', '{"input":null}', '{"ticks":null}',
      '{"input":{"right":true,"fire":true},"ticks":4}',
      '{"command":"observe"}', '{"command":"close"}',
    ].join("\n") + "\n",
  });

  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(responses[0].type, "ready");
  assert.equal(responses[1].observation.elapsedTicks, 0);
  assert.ok(responses.slice(2, 8).every((response) => response.error));
  assert.equal(responses[8].ticksAdvanced, 4);
  assert.equal(responses[9].observation.elapsedTicks, 4);
  assert.equal(responses[10].type, "closed");
});

withAssets("action-only recording supports a four-tick default and configurable decision intervals", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "xenon2-action-log-test-"));
  const runs = [];
  t.after(async () => {
    for (const run of runs) run.close();
    await rm(temp, { recursive: true, force: true });
  });
  const standard = await createHeadlessRun();
  runs.push(standard);
  assert.equal(standard.step({ fire: true }).ticksAdvanced, 4);
  const output = join(temp, "run");
  const configured = await createHeadlessRun({ output, capture: false, decisionTicks: 7 });
  runs.push(configured);
  assert.equal(configured.step({ fire: true }).ticksAdvanced, 7);
  assert.equal(configured.step({ fire: true }, 2).ticksAdvanced, 2);
  configured.close();
  assert.throws(() => configured.screenshot(), /Enable capture/);
  assert.deepEqual((await readdir(output)).sort(), ["actions.jsonl", "manifest.json"]);
  const actions = (await readFile(join(output, "actions.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(actions[0].format, "xenon2-actions");
  assert.equal(actions[0].version, 2);
  assert.equal(actions[0].decisionTicks, 7);
  assert.deepEqual(actions.slice(1).map(({ ticksAdvanced }) => ticksAdvanced), [7, 2]);
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.frameCount, 0);
  assert.equal(manifest.initialFrame, false);
  assert.equal(manifest.decisionTicks, 7);
  assert.equal(manifest.elapsedTicks, 9);

  const cliOutput = join(temp, "cli");
  const baseline = spawnSync(process.execPath, [cli, "--ticks", "10", "--decision-ticks", "3",
    "--output", cliOutput, "--no-frames"], { encoding: "utf8", timeout: 10000 });
  assert.equal(baseline.status, 0, baseline.stderr);
  const cliActions = (await readFile(join(cliOutput, "actions.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(cliActions.slice(1).map(({ ticksAdvanced }) => ticksAdvanced), [3, 3, 3, 1]);
});

withAssets("shop decisions use real sale slots, visit stock caps and purchase constraints without invalid-action side effects", () => {
  const { session, run, open } = shopRun();
  session.game.credits = 10000;
  session.game.replaceWeapon(5, { id: 8, power: 1 });
  open();
  const selling = session.observe();
  assert.equal(selling.shop.offers[0].slot, 5);
  assert.equal(selling.shop.offers[0].upgradeLevel, 1);
  assert.throws(() => performShopAction(run, { action: "buy", id: 3 }), /not currently available/);
  assert.deepEqual(session.observe(), selling);
  const sold = performShopAction(run, { action: "sell", slot: 5 });
  assert.equal(session.game.inventory[5], null);
  assert.equal(sold.observation.credits, 10000 + selling.shop.offers[0].price);
  assert.throws(() => performShopAction(run, { action: "sell", slot: 5 }), /not currently available/);
  performShopAction(run, { action: "exit" });
  const buying = session.observe();
  assert.equal(buying.shop.phase, "buy");
  assert.deepEqual(buying.shop.offers.map(({ id }) => id), [2, 3, 4, 5, 6]);
  assert.ok(buying.shop.offers.find(({ id }) => id === 4).problem);
  const seed = session.game.seed;
  for (const action of [{ action: "buy", id: 9 }, { action: "buy", id: 4 }, { action: "more" }]) {
    assert.throws(() => performShopAction(run, action), /not currently available/);
    assert.deepEqual(session.observe(), buying);
    assert.equal(session.game.seed, seed);
  }
  const purchased = performShopAction(run, { action: "buy", id: 3 });
  assert.equal(purchased.observation.player.speedLevel, 1);
  assert.equal(purchased.observation.credits, buying.credits - 500);
  assert.ok(purchased.ticksAdvanced > 1);
  assert.notEqual(session.game.seed, seed);
  performShopAction(run, { action: "exit" });
  assert.equal(session.game.status, "playing");
  assert.equal(session.game.tick, 0);
});

withAssets("shop decisions follow stage-five discounts, real pagination, wallet updates and occupied mount rules", () => {
  const { session, run, open } = shopRun(5);
  session.game.credits = session.game.shopBudget = 10000;
  session.game.replaceWeapon(5, { id: 9, power: 1 });
  open();
  performShopAction(run, { action: "exit" });
  const buying = session.observe().shop;
  assert.equal(buying.offers.find(({ id }) => id === 3).price, 250);
  assert.ok(buying.offers.find(({ id }) => id === 9).problem);
  assert.throws(() => performShopAction(run, { action: "buy", id: 9 }), /not currently available/);
  assert.equal(buying.canPage, true);
  performShopAction(run, { action: "more" });
  assert.deepEqual(session.observe().shop.offers.map(({ id }) => id), [21, 22, 23, 24, 25]);
  const lives = session.game.player.lives;
  performShopAction(run, { action: "buy", id: 22 });
  assert.equal(session.game.player.lives, lives + 1);
  performShopAction(run, { action: "more" });
  assert.equal(session.observe().shop.page, 0);
  session.game.credits = 500;
  performShopAction(run, { action: "buy", id: 3 });
  assert.equal(session.game.credits, 250);
  assert.equal(session.observe().shop.canPage, false);
});

withAssets("shop departure and loading preserve stage transitions through Get Ready", () => {
  const { session, run, open } = shopRun(1, 2);
  open();
  performShopAction(run, { action: "exit" });
  const leaving = performShopAction(run, { action: "exit" });
  assert.equal(leaving.observation.status, "stage-loading");
  assert.equal(leaving.observation.stage, 2);
  assert.equal(leaving.observation.shop, null);
  assert.equal(session.step({}, 120).observation.status, "turn-ready");
  assert.equal(session.step({ confirm: true }, 120).observation.status, "playing");
});

withAssets("victory animates through the native ending and loads the next campaign round", () => {
  const session = new HeadlessGame(campaign, { stage: 5 });
  session.game.beginVictory();
  session.syncScreen();
  let ticks = 0;
  while (session.game.status === "ending" && ticks < 2000) ticks += session.step({}, 120).ticksAdvanced;
  assert.equal(session.game.status, "stage-loading");
  assert.equal(session.game.stage, 1);
  assert.equal(session.game.campaignRound, 2);
  assert.equal(session.game.continues, 3);
  assert.equal(session.step({}).observation.status, "turn-ready");
  assert.equal(session.step({ confirm: true }).observation.status, "playing");
});

withAssets("interactive commands use the configured decision interval unless ticks are explicit", () => {
  for (const decisionTicks of [4, 7]) {
    const args = decisionTicks === 4 ? [] : ["--decision-ticks", String(decisionTicks)];
    const result = spawnSync(process.execPath, [cli, "--interactive", ...args], {
      encoding: "utf8", timeout: 10000,
      input: '{"input":{"fire":true}}\n{"input":{"right":true},"ticks":2}\n',
    });
    assert.equal(result.status, 0, result.stderr);
    const responses = result.stdout.trim().split("\n").map(JSON.parse);
    assert.equal(responses[0].decisionTicks, decisionTicks);
    assert.equal(responses[1].ticksAdvanced, decisionTicks);
    assert.equal(responses[2].observation.elapsedTicks, decisionTicks + 2);
  }
});
