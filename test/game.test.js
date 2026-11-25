import { test } from "node:test";
import assert from "node:assert/strict";
import { Game, frameAt } from "../src/game.js";
import { loadTestAssets, loadTestCampaign } from "./helpers.js";

const assets = loadTestAssets();
const emptyGame = () => {
  const game = new Game({ ...assets, events: [] });
  game.start();
  return game;
};
const finishDeath = (game) => {
  for (let tick = 0; tick < 16; tick++) game.update({ right: true, fire: true });
};

test("pausing freezes simulation and restart clears combat and input-dependent state", () => {
  const game = emptyGame();
  game.update({ right: true, fire: true });
  const snapshot = game.snapshot();
  game.togglePause();
  for (let i = 0; i < 10; i++) game.update({ left: true, fire: true });
  assert.deepEqual(game.snapshot(), { ...snapshot, status: "paused" });
  game.togglePause();
  game.update({ right: true });
  assert.ok(game.player.x > snapshot.x);
  game.start();
  assert.equal(game.status, "playing");
  assert.equal(game.player.x, 160);
  assert.equal(game.shots.length, 0);
  assert.equal(game.tick, 0);
});

test("held fire respects its cooldown, and diving prevents firing and damage", () => {
  const game = emptyGame();
  game.update({ fire: true });
  const first = game.shots.length;
  game.update({ fire: true });
  assert.equal(game.shots.length, first);
  for (let i = 0; i < 7; i++) game.update({ fire: true });
  assert.equal(game.shots.length, first + 1);
  game.update({ dive: true, fire: true });
  assert.deepEqual([game.divePhase, game.divePose, game.diveTime], [1, 0, 136]);
  game.sounds.length = 0;
  game.damage();
  assert.equal(game.player.health, 39);
  for (let i = 0; i < 20; i++) game.update({ fire: true });
  assert.ok(!game.sounds.includes("shot"));
  assert.deepEqual([game.divePhase, game.divePose, game.diveMasked, game.diveTime], [4, 4, true, 116]);
});

test("dive paints its last ascent pose before surfacing and needs no charge to cancel", () => {
  for (const cancel of [false, true]) {
    const game = emptyGame();
    game.map.fill(0);
    game.player.dives = 1;
    game.update({ dive: true });
    assert.deepEqual(game.sounds.splice(0), ["dive"]);
    const poses = [], cues = [];
    for (let i = 0; i < 136 && game.diveTime; i++) {
      game.update({ dive: cancel && i === 6 });
      poses.push(game.divePose);
      if (game.sounds.splice(0).includes("dive")) cues.push(i + 1);
    }
    assert.deepEqual(poses.slice(0, 4), [1, 2, 3, 4]);
    assert.equal(poses.length, cancel ? 8 : 136);
    assert.deepEqual(cues, [cancel ? 8 : 136]);
    for (const pose of [4, 3, 2, 1]) {
      game.update();
      assert.equal(game.divePose, pose);
      assert.equal(game.diveMasked, false);
      assert.equal(game.divePhase, pose - 1);
    }
    assert.equal(game.terrainRecovery, -15);
    game.update({ dive: true });
    assert.equal(game.terrainRecovery, 0);
    assert.equal(game.divePose, 0);
    assert.equal(game.divePhase, 0);
    assert.equal(game.player.dives, 0);
    assert.ok(!game.sounds.includes("dive"));
  }
});

test("the dive meter cancels on death while Shades continues through its empty frame", () => {
  const game = emptyGame();
  game.player.shades = 4;
  const dronePass = [];
  game.updateDroneRounds = () => dronePass.push([game.shadesMeterTime, game.diveMeterTime, game.diveStep]);

  game.update({ dive: true });
  game.update({ dive: true });
  assert.equal(game.diveTime, 1);
  assert.deepEqual(game.sounds.splice(0), ["dive"]);
  game.killPlayer();
  for (let tick = 0; tick < 3; tick++) game.update({ dive: true });

  assert.deepEqual(dronePass, [
    [3, undefined, 0], [2, 135, 1], [1, undefined, 1], [0, undefined, 1], [undefined, undefined, 1],
  ]);
  assert.equal(game.diveTime, 0);
  assert.equal(game.player.dives, 2);
  assert.ok(!game.sounds.includes("dive"));
});

test("surfacing inside terrain rewinds recorded positions and dies after two blocked samples", () => {
  for (const escape of [false, true]) {
    const game = emptyGame();
    game.map.fill(0);
    game.camera = game.endCamera = game.control.ceiling = 4000;
    game.player.x = 155;
    game.resetDive();
    game.update({ dive: true });
    for (let i = 0; i < 9; i++) game.update({ right: true, dive: i === 3 });
    assert.equal(game.divePhase, 0);
    const [current, previous] = game.shipHistory;
    assert.equal(game.shipTouchesTerrain(), false);
    const solid = game.assets.terrainMasks.findIndex((tile) => tile.every((bits) => bits === 0xffff));
    const fill = (from, to) => {
      for (let row = 259; row <= 261; row++) for (let col = from; col <= to; col++) {
        game.map[row * 20 + col] = solid << 6;
      }
    };
    fill(escape ? 12 : 9, 12);
    assert.equal(game.player.x, current.x);
    assert.equal(game.shipTouchesTerrain(), true);
    game.update({ right: true });
    assert.equal(game.player.x, previous.x);
    assert.equal(game.terrainRecovery, -16);
    game.update({ right: true });
    assert.equal(game.terrainRecovery, -17);
    game.update();
    assert.equal(game.status, escape ? "playing" : "dying");
    assert.equal(game.player.health, escape ? 39 : 0);
  }
});

test("terrain contact rewinds one world position even when the obstacle disappears", () => {
  const game = emptyGame();
  game.camera = game.control.ceiling = 4000;
  game.player.x = 159;
  game.resetDive();
  game.map.fill(0);
  for (let row = 259; row <= 261; row++) game.map[row * 20 + 11] = 64;

  game.update({ right: true });
  assert.deepEqual([game.player.x, game.control.bank, game.terrainRecovery], [162, 0, 1]);
  assert.equal(game.control.ceiling, 4015);
  assert.equal(game.player.health, 39);
  game.map.fill(0);
  game.update({ right: true });
  assert.deepEqual([game.player.x, game.player.y, game.terrainRecovery], [159, 175, -1]);
  game.update({ left: true });
  assert.deepEqual([game.player.x, game.terrainRecovery], [156, 0]);
});

test("unrecoverable terrain contact costs a life even with invulnerability", () => {
  const game = emptyGame();
  game.camera = game.control.ceiling = 4000;
  game.player.x = 162;
  game.resetDive();
  game.map.fill(0);
  for (let row = 259; row <= 261; row++) game.map[row * 20 + 11] = 64;
  game.grantInvulnerability();
  game.update({ right: true });
  for (let i = 0; i < 17; i++) game.update();
  assert.equal(game.status, "playing");
  assert.equal(game.terrainRecovery, -17);
  assert.equal(game.player.y, 176);
  game.update();
  assert.equal(game.status, "dying");
  assert.equal(game.player.health, 0);
});

test("the stage-one wall pushes the ship back without costing health", () => {
  const game = new Game(assets);
  game.start();
  for (let i = 0; i < 46; i++) game.update({ left: true });
  assert.deepEqual([game.player.x, game.player.y, game.terrainRecovery], [22, 174, 1]);
  game.update();
  assert.deepEqual([game.player.x, game.player.y, game.terrainRecovery], [25, 176, -1]);
  game.update({ right: true });
  assert.deepEqual([game.player.x, game.player.health, game.terrainRecovery], [28, 39, 0]);
});

test("a real enemy sprite hit consumes the shot and awards its recovered score once", () => {
  const game = emptyGame();
  game.spawn(assets.events.find((event) => event[1] === 8));
  game.enemies = [game.enemies[0]];
  const enemy = game.enemies[0];
  enemy.speed = 0;
  enemy.motion.xFixed = 160 * 65536;
  enemy.motion.yFixed = 90 * 65536;
  const sprite = game.sprite(game.enemyFrame(enemy));
  const bounds = game.bounds(sprite, 160, 90);
  game.shots.push({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 + 6 });
  game.update();
  assert.equal(game.enemies.length, 0);
  assert.equal(game.shots.length, 0);
  assert.equal(game.score, enemy.parts[0].score);
  game.destroy(enemy);
  assert.equal(game.score, enemy.parts[0].score);
});

test("only clearing an entire formation without escapes awards a credit globe", () => {
  for (const escaped of [false, true]) {
    const game = emptyGame();
    game.spawn(assets.events.find((event) => event[1] === 8));
    game.enemies[0].formation.escaped = escaped;
    for (const enemy of game.enemies) game.destroy(enemy);
    assert.equal(game.pickups.length, escaped ? 0 : 1);
    if (!escaped) {
      assert.equal(game.pickups[0].kind, "credit");
      assert.ok([50, 100].includes(game.pickups[0].value));
    }
    assert.equal(game.effects.length, game.enemies.length);
  }
});

test("regular enemies explode without becoming pickups, including every third and fifteenth kill", () => {
  for (const previousKills of [0, 2, 14]) {
    const game = emptyGame();
    game.kills = previousKills;
    const event = [...assets.events.find((entry) => entry[1] === 8)];
    event[2] = 2;
    game.spawn(event);
    const enemy = game.enemies[0];
    game.destroy(enemy);
    assert.equal(game.pickups.length, 0);
    assert.equal(game.effects.length, 1);
    assert.equal(game.score, enemy.parts[0].score);
    assert.equal(enemy.dead, true);
  }
});

test("only supply pods release their assigned reward, once", () => {
  const game = emptyGame();
  const event = assets.events.find((entry) => entry[1] === 0);
  game.spawn(event);
  const pod = game.enemies[0];
  game.destroy(pod);
  game.destroy(pod);
  assert.equal(game.pickups.length, 1);
  assert.equal(game.pickups[0].kind, "reward");
  assert.equal(game.pickups[0].reward, event[6]);
  assert.deepEqual([game.pickups[0].x, game.pickups[0].y], [pod.motion.x, pod.motion.y]);
  assert.equal(game.effects.length, 0);
});

test("pod rewards drift toward the center before circling and falling away", () => {
  const game = emptyGame();
  game.spawn([0, 0, 1, 1, 0, 0, 11]);
  const pod = game.enemies[0];
  pod.motion.xFixed = 126 * 65536;
  pod.motion.yFixed = 100 * 65536;
  game.destroy(pod);
  const [reward] = game.pickups;
  game.update();
  assert.deepEqual([reward.x, reward.y, reward.state], [126, 98, 8]);
  game.update();
  assert.deepEqual([reward.x, reward.y, reward.direction], [128, 98, 2]);
  let circled = false;
  for (let tick = 0; tick < 100 && !reward.dead; tick++) {
    game.update();
    circled ||= reward.state < 0;
  }
  assert.ok(circled && reward.dead);
  assert.equal(game.pickups.length, 0);
});

test("a pod reward uses its moving sprite bounds and cannot collect during a dive", () => {
  for (const [x, dive, collected] of [[137, false, false], [141, false, true], [141, true, false]]) {
    const game = emptyGame();
    if (dive) game.update({ dive: true });
    game.pickups.push({ kind: "reward", reward: 0, x, y: 158, age: 0, state: 0, direction: 0 });
    game.update();
    assert.equal(game.player.speed, Number(collected));
    assert.equal(game.pickups.length, Number(!collected));
    assert.equal(game.score, 0);
  }
});

test("pod rewards and counted credits test the cached hull before steering", () => {
  const campaign = loadTestCampaign();
  for (const [stage, pickup, oldEdge, newEdge] of [
    [1, { kind: "reward", reward: 16 }, 197, 151],
    [4, { kind: "credit", value: 50, counted: true }, 185, 154],
    [5, { kind: "credit", value: 100, counted: true }, 191, 158],
  ]) {
    const game = new Game(campaign);
    game.start(stage);
    game.eventStreamsClosed = true;
    game.shopVisited = true;
    game.camera = game.endCamera = 1000;
    game.shipTouchesTerrain = () => false;
    const at = (y) => ({ ...pickup, x: 160, y, state: -2, direction: 0, age: 0 });
    const before = at(oldEdge), after = at(newEdge);
    const credits = game.credits;
    game.addPickup(after);
    game.addPickup(before);

    game.update({ up: true });

    assert.equal(game.player.y, 171);
    assert.deepEqual(game.pickups, [after], `stage ${stage}`);
    assert.equal(game.credits - credits, pickup.value ?? 0);
    assert.equal(game.countedCredits, Number(Boolean(pickup.counted)));
    assert.equal(Boolean(game.invincible), pickup.kind === "reward");
  }
});

test("the last ascent pose is still painted when a reward can be collected", () => {
  const game = emptyGame();
  game.map.fill(0);
  game.update({ dive: true });
  for (let i = 0; i < 4; i++) game.update();
  game.update({ dive: true });
  for (let i = 0; i < 4; i++) game.update();
  assert.equal(game.divePhase, 1);
  game.pickups.push({ kind: "reward", reward: 0, x: 141, y: 158, age: 0, state: 0, direction: 0 });
  game.update();
  assert.equal(game.divePose, 1);
  assert.equal(game.player.speed, 1);
  assert.equal(game.pickups.length, 0);
});

test("ship contact opens a pod once after eight energy damage, including protected contact", () => {
  for (const protection of ["none", "invincible", "shield", "dive", "fatal"]) {
    const game = emptyGame();
    game.assets.paths = { bytes: new Uint8Array(Int16Array.of(10, 160, 160, 4, 100, 0).buffer), offsets: [0] };
    game.spawn([0, 0, 1, 1, 0, 0, 0]);
    const pod = game.enemies[0];
    if (protection === "invincible") game.invincible = 50;
    if (protection === "shield") game.player.protection = true;
    if (protection === "dive") game.divePhase = 4;
    if (protection === "fatal") game.player.health = 8;
    game.update();
    const opened = !["dive", "fatal"].includes(protection);
    assert.equal(Boolean(pod.dead), opened, protection);
    assert.equal(game.player.speed, opened ? 1 : 0, protection);
    assert.equal(game.player.health, { fatal: 0, none: 31, shield: 35, invincible: 39, dive: 39 }[protection]);
    assert.equal(game.status, protection === "fatal" ? "dying" : "playing");
    if (opened) {
      game.destroy(pod);
      assert.equal(game.pickups.length, 0, "an already opened pod cannot duplicate rewards");
    }
  }
});

test("ramming an ordinary stage-three ship destroys it only if the player survives", () => {
  const campaign = loadTestCampaign();
  for (const health of [39, 8]) {
    const game = new Game(campaign);
    game.start(3);
    game.assets = { ...game.assets, events: [], background: [],
      paths: { bytes: new Uint8Array(Int16Array.of(10, 160, 160, 4, 100, 0).buffer), offsets: [0] } };
    game.map.fill(0);
    game.player.health = health;
    game.spawn([0, 5, 1, 1, 0, 0, 0]);
    const [enemy] = game.enemies;
    game.update();
    assert.equal(game.player.health, health - 8);
    assert.equal(Boolean(enemy.dead), health > 8);
    assert.equal(game.score, health > 8 ? 100 : 0);
    if (health > 8) {
      game.update();
      assert.equal(game.player.health, 31);
    }
  }
});

test("repeated hits still cost energy; invulnerability and counted rewards prevent damage", () => {
  const game = emptyGame();
  game.damage();
  assert.equal(game.player.health, 31);
  game.damage();
  assert.equal(game.player.health, 23);
  game.invincible = 1;
  game.damage(39);
  assert.equal(game.player.health, 23);
  game.invincible = 0;
  game.countedCredits = 1;
  game.damage(39);
  assert.equal(game.player.health, 23);
});

test("last lives offer at most two timed continues, each restoring three lives and clearing score", () => {
  const game = emptyGame();
  for (let remaining = 2; remaining >= 0; remaining--) {
    game.player.lives = 1;
    game.score = 1234;
    game.invincible = 0;
    game.damage(39);
    assert.equal(game.status, "dying");
    finishDeath(game);
    assert.equal(game.player.lives, 0);
    if (!remaining) break;
    assert.equal(game.status, "continue");
    assert.equal(game.continues, remaining);
    assert.equal(game.continueTicks, 79);
    assert.equal(game.continueRun(), true);
    assert.equal(game.status, "playing");
    assert.equal(game.player.lives, 3);
    assert.equal(game.player.health, 39);
    assert.equal(game.score, 0);
  }
  assert.equal(game.status, "gameover");
  assert.equal(game.continueRun(), false);
  const tick = game.tick;
  game.update({ fire: true });
  assert.equal(game.tick, tick);
});

test("letting the continue timer expire ends the run without accepting held fire", () => {
  const game = emptyGame();
  game.player.lives = 1;
  game.damage(39);
  finishDeath(game);
  for (let tick = 0; tick < 78; tick++) game.update({ fire: true });
  assert.equal(game.status, "continue");
  assert.equal(game.continueTicks, 1);
  game.update();
  assert.equal(game.continueRun(), false);
  assert.equal(game.status, "gameover");
});

test("the continue screen counts down without advancing the checkpoint, then gives way to Get Ready", () => {
  const game = new Game(loadTestCampaign());
  game.start();
  game.player.lives = 1;
  game.killPlayer();
  finishDeath(game);
  const { tick, camera, runScreen } = game;
  const { counter, large } = runScreen.art;
  const digit = counter.indexOf("9");
  const glyph = () => Uint8Array.from({ length: 16 * large.height }, (_, i) =>
    runScreen.pixels[(120 + (i >> 4)) * 320 + digit * 16 + (i & 15)]);
  const expectDigit = (letter) => {
    const expected = large.glyphs.get(letter);
    assert.deepEqual(glyph().map((pixel, i) => expected[i] ? pixel : 0), expected);
  };
  expectDigit("9");
  for (let frame = 0; frame < 8; frame++) game.update();
  expectDigit("8");
  assert.equal(game.tick, tick);
  assert.equal(game.camera, camera);
  assert.equal(game.continueRun(), true);
  assert.equal(game.status, "turn-ready");
  assert.notEqual(game.runScreen, runScreen);
  assert.equal(game.player.lives, 3);
  assert.equal(game.continueRun(), true);
  assert.equal(game.status, "playing");
  assert.equal(game.runScreen, undefined);
  assert.equal(game.tick, tick);
});

test("continue expiry shows 30 game-over frames before returning to attract", () => {
  const game = new Game(loadTestCampaign());
  game.start();
  game.player.lives = 1;
  game.killPlayer();
  finishDeath(game);
  const prompt = game.runScreen;
  for (let frame = 0; frame < 79; frame++) game.update();
  assert.equal(game.status, "gameover");
  const screen = game.runScreen;
  assert.notEqual(screen, prompt);
  const first = screen.pixels.slice();
  for (let frame = 1; frame < 30; frame++) game.update();
  assert.equal(screen.age, 30);
  assert.notDeepEqual(screen.pixels, first);
  const scores = game.highScores;
  const seed = game.seed;
  game.update({ confirm: true });
  assert.equal(game.status, "ready");
  assert.equal(game.highScores, scores);
  assert.notEqual(game.runScreen, screen);
  assert.equal(game.runScreen.age, 1);
  assert.notEqual(game.seed, seed);
  assert.equal(game.openMenu(), true);
});

test("a ranked score takes initials and holds the board before offering a continue", () => {
  const game = new Game(loadTestCampaign());
  game.start();
  game.highScores[0] = { score: 1000, initials: "OLD" };
  game.score = 1000;
  game.player.lives = 1;
  game.killPlayer();
  finishDeath(game);
  const { tick } = game;
  assert.equal(game.status, "score-entry");
  assert.equal(game.continueTicks, 0);
  game.update({ left: true });
  game.update({ confirm: true });
  for (let frame = 0; frame < 5; frame++) game.update({ right: true });
  game.update({ confirm: true });
  game.update({ confirm: true });
  assert.deepEqual(game.highScores.slice(0, 2), [
    { score: 1000, initials: "OLD" }, { score: 1000, initials: "9BB" },
  ]);
  for (let frame = 0; frame < 17; frame++) game.update();
  assert.equal(game.status, "score-entry");
  game.update();
  assert.equal(game.status, "continue");
  assert.equal(game.continueTicks, 79);
  assert.equal(game.tick, tick);
  game.start();
  assert.equal(game.highScores[1].initials, "9BB");
});

test("the read-only score table returns to the start screen without changing the table", () => {
  const game = new Game(loadTestCampaign());
  const scores = game.highScores.map((entry) => ({ ...entry }));
  assert.equal(game.showScores(), true);
  for (let frame = 0; frame < 84; frame++) game.update();
  assert.equal(game.status, "score-table");
  game.update();
  assert.equal(game.status, "ready");
  assert.equal(game.runScreen, undefined);
  assert.deepEqual(game.highScores, scores);
  game.showGameOver();
  assert.equal(game.showScores(), false);
  for (let frame = 0; frame < 30; frame++) game.update();
  const attract = game.runScreen;
  assert.equal(game.showScores(), true);
  game.update({ confirm: true });
  assert.equal(game.status, "ready");
  assert.equal(game.runScreen, attract);
  assert.deepEqual(game.highScores, scores);
});

test("the attract loop shows the starfield and credits without starting flight", () => {
  const game = new Game(loadTestCampaign());
  game.openAttract();
  const screen = game.runScreen;
  const after = (frame) => {
    while (screen.age <= frame) game.update();
    return screen.pixels.subarray(120 * 320, 142 * 320).filter((color) => color > 7).length;
  };
  assert.equal(after(17), 0);
  assert.ok(after(18) > 200);
  while (screen.age <= 433) game.update();
  assert.ok(screen.pixels.subarray(38 * 320, 200 * 320).filter((color) => color > 7).length > 500);
  assert.equal(after(518), 0);
  assert.equal(game.status, "ready");
  assert.equal(game.tick, 0);
});

test("the launcher wraps selections, repeats after eight held updates, and resumes after viewing scores", () => {
  const game = new Game(loadTestCampaign());
  game.openAttract();
  assert.equal(game.openMenu(), true);
  assert.equal(game.menuSelection, 0);
  game.moveMenu(-1);
  assert.equal(game.menuSelection, 2);
  for (let frame = 0; frame < 7; frame++) game.update({ up: true, music: false });
  assert.equal(game.menuSelection, 2);
  game.update({ up: true, music: false });
  assert.equal(game.menuSelection, 1);
  const menu = game.runScreen;
  assert.equal(game.showScores(), true);
  assert.equal(game.closeScores(), true);
  assert.equal(game.status, "menu");
  assert.equal(game.runScreen, menu);
  assert.equal(game.menuSelection, 1);
  assert.equal(game.tick, 0);
});

test("two players alternate on death and restore their own map, equipment, score and checkpoint", () => {
  const first = new Game(loadTestCampaign());
  first.start(1, 2);
  const second = first.partner;
  assert.equal(first.status, "turn-ready");
  assert.equal(first.continueRun(), true);
  first.score = 1234;
  first.credits = 450;
  first.inventory[0].power = 2;
  first.saveCheckpoint([3200, 0, 0, 0, 148, 3376]);
  const tile = first.map[100] ^ 64;
  first.patchGround({ cell: 100 }, [tile]);
  first.killPlayer();
  first.finishDeath();
  assert.equal(first.activeGame, second);
  assert.equal(second.status, "turn-ready");
  assert.equal(second.player.lives, 3);
  assert.equal(second.player.power, 1);
  assert.notEqual(second.map[100], tile);
  assert.equal(second.continueRun(), true);
  const seed = first.seed;
  assert.equal(second.randomWord(), (seed * 0x6255 + 0x3619) & 65535);
  assert.equal(first.seed, second.seed);
  second.killPlayer();
  finishDeath(second);
  assert.equal(second.activeGame, first);
  assert.equal(first.status, "turn-ready");
  assert.equal(first.player.lives, 2);
  assert.equal(first.player.x, 148);
  assert.equal(first.camera, 3200);
  assert.equal(first.inventory[0].power, 2);
  assert.equal(first.map[100], tile);
  assert.equal(first.score, 1234);
  assert.equal(first.credits, 450);
});

test("a two-player continue restores the eliminated turn's lives before passing control", () => {
  const first = new Game(loadTestCampaign());
  first.start(1, 2);
  first.continueRun();
  const second = first.partner;
  first.player.lives = 1;
  first.killPlayer();
  finishDeath(first);
  assert.equal(first.status, "continue");
  assert.equal(first.continueRun(), true);
  assert.equal(first.player.lives, 3);
  assert.equal(first.continues, 1);
  assert.equal(first.activeGame, second);
  assert.equal(second.continues, 2);
  assert.equal(second.continueRun(), true);
  second.player.lives = 1;
  second.killPlayer();
  finishDeath(second);
  for (let frame = 0; frame < 79; frame++) second.update();
  assert.equal(second.status, "turn-over");
  for (let frame = 0; frame < 29; frame++) second.update();
  assert.equal(second.activeGame, second);
  second.update();
  assert.equal(second.status, "eliminated");
  assert.equal(second.activeGame, first);
  assert.equal(first.continueRun(), true);
  first.player.lives = 2;
  first.killPlayer();
  finishDeath(first);
  assert.equal(first.activeGame, first);
  assert.equal(first.status, "turn-ready");
  first.player.lives = 1;
  first.continues = 0;
  first.continueRun();
  first.killPlayer();
  finishDeath(first);
  assert.equal(first.status, "gameover");
  for (let frame = 0; frame < 29; frame++) first.update();
  assert.equal(first.status, "gameover");
  first.update();
  assert.equal(first.activeGame, first);
  assert.equal(first.status, "ready");
});

test("a winning player waits while their partner finishes and both enter the next stage", () => {
  const first = new Game(loadTestCampaign());
  first.start(1, 2);
  first.continueRun();
  const second = first.partner;
  first.openShop(2);
  first.credits = 700;
  first.player.health = 17;
  first.player.x = 150;
  first.continueRun();
  assert.equal(first.status, "stage-wait");
  assert.equal(first.activeGame, second);
  assert.equal(second.stage, 1);
  second.continueRun();
  second.killPlayer();
  finishDeath(second);
  assert.equal(second.activeGame, second);
  assert.equal(second.status, "turn-ready");
  second.continueRun();
  second.openShop(2);
  second.credits = 800;
  second.player.health = 26;
  second.continueRun();
  assert.equal(second.activeGame, first);
  assert.equal(first.status, "stage-loading");
  assert.equal(second.status, "playing");
  first.update();
  assert.equal(first.status, "turn-ready");
  assert.deepEqual([first, second].map((game) => [game.stage, game.credits, game.player.health]),
    [[2, 0, 17], [2, 0, 26]]);
  assert.equal(first.player.x, 150);
});

test("two-player victory plays once, awards both players a continue, and restarts the shared campaign", () => {
  const first = new Game(loadTestCampaign());
  first.start(5, 2);
  first.continueRun();
  const second = first.partner;
  first.beginVictory();
  assert.equal(first.status, "stage-wait");
  assert.equal(first.continues, 3);
  assert.equal(first.activeGame, second);
  second.continueRun();
  second.beginVictory();
  assert.equal(second.status, "ending");
  second.finishVictory();
  assert.equal(second.activeGame, first);
  assert.deepEqual([first, second].map((game) => [game.stage, game.campaignRound, game.continues]),
    [[1, 2, 3], [1, 2, 3]]);
});

test("a waiting winner advances if the other player loses their last life", () => {
  const first = new Game(loadTestCampaign());
  first.start(1, 2);
  first.continueRun();
  first.openShop(2);
  first.continueRun();
  const second = first.activeGame;
  second.continueRun();
  second.player.lives = 1;
  second.continues = 0;
  second.killPlayer();
  finishDeath(second);
  for (let frame = 0; frame < 30; frame++) second.update();
  assert.equal(second.activeGame, first);
  assert.equal(second.status, "eliminated");
  assert.equal(first.status, "stage-loading");
  first.update();
  assert.equal(first.status, "turn-ready");
  assert.equal(first.stage, 2);
  assert.equal(first.continues, 2);
});

test("camera event scans use exclusive upper limits, preserve file order and skip backtracking", () => {
  const game = new Game(loadTestCampaign());
  game.start();
  game.checkpoint.camera = 2000;
  game.restoreCheckpoint();
  game.assets = { ...game.assets,
    events: [1995, 2001, 2000, 1997].map((y) => [y, 8]),
    background: [1999, 2192, 2000, 2191, 1997, 1995].map((y) => [y, 0]),
  };
  const seen = [];
  game.spawn = ([y]) => seen.push(["foreground", y]);
  game.saveCheckpoint = ([y]) => seen.push(["background", y]);
  const scan = (camera) => {
    game.camera = camera;
    game.dispatchCameraEvents();
    return seen.splice(0);
  };

  assert.deepEqual(scan(2001), []);
  assert.deepEqual(scan(2000), [["foreground", 2000], ["background", 2000], ["background", 2191]]);
  assert.deepEqual(scan(2003), []);
  assert.deepEqual(scan(2000), []);
  assert.deepEqual(scan(1995), [
    ["foreground", 1995], ["foreground", 1997], ["background", 1999], ["background", 1997], ["background", 1995],
  ]);
});

test("checkpoint respawn rolls back credits and equipment and re-enters only the original event bands", () => {
  const game = new Game(loadTestCampaign());
  game.start();
  const foreground = assets.events.find((event) => event[1] === 8);
  const camera = 4032;
  const marker = [camera, 0, 0, 0, 168, 4216];
  const ground = (y, x) => [y, 1, 0, 0, x, 4024, 0];
  game.assets = { ...game.assets,
    events: [camera + 1, camera, camera - 4].map((y) => [y, ...foreground.slice(1)]),
    background: [ground(camera + 192, 72), ground(camera + 191, 88), marker, ground(camera + 1, 56)],
  };
  game.camera = camera + 1;
  game.inventory[0].power = 2;
  game.inventory[6] = { id: 23, power: 0 };
  game.credits = 70000;
  game.update();
  assert.deepEqual([game.checkpoint.camera, game.checkpoint.x, game.checkpoint.worldY],
    [camera, 168, 4216]);
  game.inventory[0].power = 0;
  game.credits = 12;
  game.score = 900;
  game.player.autofire = 2;
  game.camera -= 8;
  game.update({ fire: true });
  game.invincible = 0;
  game.damage(39);
  finishDeath(game);
  assert.equal(game.player.lives, 2);
  assert.equal(game.status, "turn-ready");
  assert.deepEqual([game.camera, game.control.ceiling, game.player.x, game.player.y], [camera, camera, 168, 176]);
  assert.deepEqual(game.playerTrail, Array.from({ length: 3 }, () => ({ x: 168, y: 176 })));
  assert.deepEqual([game.score, game.credits, game.player.power, game.player.autofire], [900, 70000, 3, 0]);
  assert.equal(game.firePeriod, 30);
  assert.equal(game.enemies.length + game.ground.length + game.shots.length + game.bullets.length, 0);
  const { waves, tick, runScreen } = game;
  const firstFrame = runScreen.pixels.slice();
  for (let frame = 0; frame < 5; frame++) game.update({ right: true, fire: true });
  assert.notDeepEqual(runScreen.pixels, firstFrame);
  assert.equal(game.status, "turn-ready");
  assert.equal(game.tick, tick);
  assert.equal(game.player.x, 168);
  assert.equal(game.waves, waves);
  assert.equal(game.continueRun(), true);
  assert.equal(game.runScreen, undefined);
  assert.equal(game.tick, tick);
  assert.equal(game.shots.length, 0);
  game.update();
  assert.equal(game.waves, waves + 1);
  assert.deepEqual(game.ground.map((gun) => gun.x), [80, 48]);
  assert.ok(game.foregroundEventLimit > camera - 4);
  assert.equal(game.checkpoint.credits, 70000);
});

test("ship death retires normal rounds in stages three and five but leaves the Drone flying", () => {
  const campaign = loadTestCampaign();
  for (const stage of [3, 5]) {
    const game = new Game(campaign);
    game.start(stage);
    game.replaceWeapon(1, { id: 15, power: 0 });
    for (let frame = 0; frame < 24 && !game.shots.some((shot) => shot.cannon); frame++) {
      game.update({ fire: true });
    }
    assert.ok(game.shots.some((shot) => shot.cannon));
    assert.ok(game.shots.some((shot) => shot.point));
    const positions = game.shots.map(({ x, y }) => [x, y]);
    const shots = game.shots.slice();
    game.addDroneVolley(160, 100, [[0, 0, 0, -6]]);
    game.damage(39);
    game.update({ fire: true });
    assert.equal(game.status, "dying");
    assert.equal(game.shots.length, 0);
    assert.deepEqual(shots.map(({ x, y }) => [x, y]), positions);
    assert.equal(game.droneShots[0]?.y, 94);
  }
});

test("death preserves stage-four miniboss damage and the arena checkpoint override", () => {
  const game = new Game(loadTestCampaign());
  game.start(4);
  const { eventType, reverseLimit } = game.miniboss.definition;
  const event = game.assets.background.find((entry) => entry[1] === eventType);
  game.assets = { ...game.assets, events: [], background: [event] };
  game.credits = 800;
  game.inventory[1] = { id: 15, power: 0 };
  game.camera = event[0] + 1;
  game.update();
  assert.equal(game.checkpoint.camera, reverseLimit);
  const core = game.miniboss.parts[4];
  const turret = game.miniboss.parts[17];
  game.miniboss.destroy(game.miniboss.parts[16], game);
  game.invincible = 0;
  game.damage(39);
  for (let tick = 0; tick < 15; tick++) game.update();
  const y = turret.motion.y, camera = game.camera;
  game.update();
  assert.equal(game.camera, reverseLimit);
  assert.equal(turret.motion.y, y + camera - reverseLimit);
  assert.equal(game.miniboss.parts[4], core);
  assert.equal(game.miniboss.parts[16].dead, true);
  assert.equal(game.miniboss.remaining, 4);
  assert.deepEqual(game.inventory[1], { id: 15, power: 0 });
  assert.equal(game.credits, 0);
});

test("the final arena restores the core and guards in place without replaying either event stream", () => {
  const game = new Game(loadTestCampaign());
  game.start(5);
  game.boss.spawn(game);
  const { camera } = game.boss.definition;
  const guard = game.boss.parts.find((part) => part.definition.kind === "gun");
  const core = game.boss.parts.find((part) => part.definition.kind === "core");
  game.destroy(guard);
  core.health -= 5;
  const health = core.health;
  game.camera -= 24;
  game.boss.y += 24;
  game.invincible = 0;
  game.damage(39);
  finishDeath(game);
  assert.equal(game.camera, camera);
  assert.equal(game.boss.y, game.boss.definition.y);
  assert.equal(game.boss.remaining, 17);
  assert.equal(guard.destroyed, true);
  assert.equal(core.health, health);
  assert.equal(game.continueRun(), true);
  for (let tick = 0; tick < 5; tick++) game.update();
  assert.equal(game.waves, 0);
  assert.equal(game.backgroundEventLimit, 0x7fee);
});

test("power and health pickups apply their provisional effects and are removed", () => {
  const game = emptyGame();
  game.player.health = 10;
  game.pickups.push(
    { x: 160, y: 160, age: 0, kind: "power" },
    { x: 160, y: 160, age: 0, kind: "health" },
  );
  game.update();
  assert.equal(game.player.power, 2);
  assert.equal(game.player.health, 26);
  assert.equal(game.pickups.length, 0);
});

test("every foreground event runs to completion without invalid paths or missing animation frames", () => {
  const game = new Game(assets);
  game.start();
  game.shipTouchesTerrain = () => false;
  for (let i = 0; i < 6000 && game.status === "playing"; i++) {
    game.invincible = 2;
    if (game.boss.phase) {
      game.shots.push({ x: 160, y: game.boss.weakY + 7, dx: 0, dy: 0, damage: 1, point: true });
    }
    game.update({ fire: true, left: i % 300 < 150, right: i % 300 >= 150 });
    for (const enemy of game.enemies) {
      assert.ok(Number.isFinite(enemy.motion.xFixed));
      for (let part = 0; part < enemy.parts.length; part++) {
        assert.ok(game.sprite(game.enemyFrame(enemy, part)));
      }
    }
    game.sounds.length = 0;
    if (game.status === "shop") game.continueRun();
  }
  assert.equal(game.status, "complete");
  assert.equal(game.waves, assets.events.length);
  assert.equal(game.progress, 1);
  assert.ok(game.score > 0);
});

test("foreground counters use the shared RNG and can fire before entering the screen", () => {
  const game = emptyGame();
  game.spawn([0, 2, 2, 1, 0, 30, 0]);
  const [enemy, other] = game.enemies;
  assert.deepEqual([enemy.fireCounter, other.fireCounter], [2, 195]);
  enemy.motion.xFixed = -65536;
  enemy.motion.yFixed = 45 * 65536;
  enemy.fireCounter = 240;
  const seed = game.seed;
  game.updateForeground(enemy, 0);
  const reset = (seed * 0x6255 + 0x3619) & 65535;
  assert.equal(enemy.fireCounter, reset & 63);
  assert.equal(game.seed, (reset * 0x6255 + 0x3619) & 65535);
  const [bullet] = game.bullets;
  assert.deepEqual([bullet.x, bullet.y, bullet.direction, bullet.frame],
    [-1, 45, game.seed & 7, assets.logic.foregroundShot.frame]);
});

test("aimed foreground shots target the player's position regardless of inherited register state", () => {
  const campaign = loadTestCampaign();
  for (let stage = 1; stage <= 5; stage++) {
    const game = new Game(campaign);
    game.start(stage);
    game.spawn([0, 1, 1, 1, 0, 105, 0]);
    const [enemy] = game.enemies;
    enemy.motion.step = (_budget, operand) => operand;
    enemy.motion.xFixed = 160 * 65536;
    enemy.motion.yFixed = 96 * 65536;
    for (const [dx, dy, direction] of [[0, 60, 4], [0, -60, 0], [60, 0, 2],
      [-60, 0, 6], [60, 60, 3], [-60, -60, 7]]) {
      game.player.x = 160 + dx;
      game.player.y = 96 + dy;
      for (const operand of [-1200, 0xdead]) {
        game.bullets = [];
        enemy.fireCounter = 255;
        game.updateForeground(enemy, operand);
        assert.equal(game.bullets.length, 1);
        assert.equal(game.bullets[0].direction, direction,
          `stage ${stage}, target ${dx}/${dy}, inherited operand ${operand}`);
      }
    }
  }
});

test("ordinary stage-two shots use the original zero-size box and pass through a dive", () => {
  for (const dive of [false, true]) {
    const game = new Game(loadTestCampaign());
    game.start(2);
    game.eventStreamsClosed = true;
    if (dive) game.update({ dive: true });
    const shot = (x) => ({ x, y: 170, dx: 0, dy: 0, fixed: true, foreground: true,
      damage: 4, frame: game.assets.logic.foregroundShot.frame });
    const edge = shot(153), inside = shot(160);
    game.bullets.push(edge, inside);
    game.update();
    assert.ok(game.bullets.includes(edge));
    assert.equal(game.bullets.includes(inside), dive);
    assert.equal(game.player.health, dive ? 39 : 35);
  }
});

test("ordinary foreground shots in the other stages test the pre-steering hull and flash on impact", () => {
  const campaign = loadTestCampaign();
  for (const [stage, oldEdge, newEdge] of [[1, 183, 155], [3, 186, 158], [4, 186, 159], [5, 187, 158]]) {
    const game = new Game(campaign);
    game.start(stage);
    game.eventStreamsClosed = true;
    game.camera = game.endCamera = 1000;
    game.shipTouchesTerrain = () => false;
    game.shopVisited = true;
    const shot = (y) => ({ x: 160, y, dx: 0, dy: 0, fixed: true, foreground: true,
      frame: game.assets.logic.foregroundShot.frame });
    const before = shot(oldEdge), after = shot(newEdge);
    game.bullets.push(after, before);

    game.update({ up: true });

    assert.equal(game.player.y, 171);
    assert.deepEqual(game.bullets, [after], `stage ${stage}`);
    assert.equal(game.player.health, 35);
    assert.equal(game.shipHitFlash, true);
  }
});

test("attached foreground parts animate at the root's current position", () => {
  const game = emptyGame();
  game.spawn([0, 7, 1, 10, 32, 0, 7]);
  const [enemy] = game.enemies;
  const [attachment] = enemy.children;
  const start = [enemy.motion.x, enemy.motion.y];
  const frame = game.enemyFrame(enemy, 1);
  game.update();
  assert.notDeepEqual([enemy.motion.x, enemy.motion.y], start);
  assert.deepEqual([attachment.motion.x, attachment.motion.y], [enemy.motion.x, enemy.motion.y]);
  for (let tick = 0; tick < 6; tick++) game.update();
  assert.notEqual(game.enemyFrame(enemy, 1), frame);
});

test("stage-three foreground worm segments follow delayed paths and share the head's death", () => {
  const game = new Game(loadTestCampaign());
  game.start(3);
  game.eventStreamsClosed = true;
  game.spawn([0, 3, 1, 22, 0, 0, 6]);
  const [head] = game.enemies;
  const tail = head.children.at(-1);
  const frame = game.enemyFrame(tail);
  for (let tick = 0; tick < 21; tick++) game.update();
  assert.notEqual(head.motion.y, tail.motion.y);
  assert.notEqual(game.enemyFrame(tail), frame);
  const tailBox = game.targetBounds(tail);
  const shot = { x: tailBox.x + 3, y: tailBox.y + 3, w: 1, h: 1 };
  const health = head.health;
  assert.ok(game.hitFirstInBox({ damage: 1 }, shot));
  assert.equal(head.health, health - 1);
  assert.ok(!tail.dead);
  assert.ok(game.hitFirstInBox({ damage: 127 }, shot));
  assert.ok(head.dead && head.children.every((part) => part.dead));
  assert.equal(game.effects.length, 1);
  assert.equal(game.score, head.parts[0].score);
  assert.deepEqual(game.pickups.map(({ x, y, state }) => [x, y, state]),
    [[head.motion.x, head.motion.y, 7]]);
});

test("animations loop at recovered durations and hold on zero-duration terminal frames", () => {
  const frames = [{ offset: 1, duration: 2 }, { offset: 2, duration: 3 }];
  assert.equal(frameAt(frames, 1).offset, 1);
  assert.equal(frameAt(frames, 2).offset, 2);
  assert.equal(frameAt(frames, 5).offset, 1);
  const terminal = [...frames, { offset: 3, duration: 0 }];
  assert.equal(frameAt(terminal, 4).offset, 2);
  assert.equal(frameAt(terminal, 500).offset, 3);
});
