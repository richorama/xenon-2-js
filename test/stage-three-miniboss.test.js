import { test } from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/game.js";
import { buy, grantReward } from "../src/shop.js";
import { loadTestCampaign } from "./helpers.js";

const campaign = loadTestCampaign();

function arena() {
  const game = new Game(campaign);
  game.start(3);
  game.camera = game.control.camera = 2800;
  game.control.ceiling = 2816;
  game.assets = { ...game.assets, events: [], background: [] };
  game.shipTouchesTerrain = () => false;
  game.miniboss.spawn();
  const root = game.miniboss.parts[0].motion;
  root.xFixed = 140 * 65536;
  root.yFixed = 32 * 65536;
  root.step = () => {};
  game.miniboss.update(game);
  return game;
}

function shoot(game, actor, damage = 1) {
  const box = game.bounds(game.sprite(actor.frame), actor.motion.x, actor.motion.y);
  game.shots.push({ x: box.x + Math.floor(box.w / 2), y: box.y + Math.floor(box.h / 2),
    dx: 0, dy: 0, damage, point: true });
}

test("stage-three event creates one moving 17-part miniboss and holds the original camera floor", () => {
  const game = new Game(campaign);
  game.start(3);
  game.assets = { ...game.assets, events: [],
    background: game.assets.background.filter((event) => event[1] === 3) };
  game.shipTouchesTerrain = () => false;
  assert.equal(game.miniboss.active, false);
  const positions = new Set();
  let attacks = 0, bullets = 0;
  for (let tick = 0; tick < 2400; tick++) {
    game.invincible = 999;
    game.update();
    for (const actor of game.miniboss.parts) {
      assert.ok(game.sprite(actor.frame));
      if (actor.amplitude) attacks++;
    }
    if (game.miniboss.active) positions.add(game.miniboss.parts[0].motion.xFixed);
    bullets += game.bullets.filter((bullet) => bullet.frames).length;
  }
  assert.equal(game.miniboss.parts.length, 17);
  assert.ok(positions.size > 100 && attacks > 0 && bullets > 0);
  assert.equal(game.camera, 2800);
  assert.equal(game.endCamera, 2800);
  assert.equal(game.status, "playing");
  assert.equal(game.backgroundEventLimit, 2800);
  const parts = game.miniboss.parts;
  for (let tick = 0; tick < 40; tick++) { game.invincible = 999; game.update({ down: true }); }
  assert.equal(game.miniboss.parts, parts);
});

test("closed eyes and the first opening tick reject shots, then each eye takes independent damage", () => {
  const game = arena(), boss = game.miniboss, eye = boss.parts[3], other = boss.parts[4];
  shoot(game, eye);
  game.update();
  assert.equal(eye.health, 20);
  assert.equal(eye.enabled, false);
  game.shots.length = 0;
  eye.fireCounter = 240;
  shoot(game, eye);
  game.update();
  assert.equal(eye.frame, boss.definition.eyeOpen[0]);
  assert.equal(eye.enabled, false);
  assert.equal(eye.health, 20);
  game.shots.length = 0;
  shoot(game, eye);
  game.update();
  assert.equal(eye.enabled, true);
  assert.equal(eye.health, 19);
  assert.equal(other.health, 20);
  assert.ok(boss.parts.every((part) => part.hit));
  boss.setFrames(eye, [boss.definition.eyeOpen[2]]);
  shoot(game, eye, 19);
  game.update();
  assert.equal(eye.destroyed, true);
  assert.equal(boss.remaining, 1);
  assert.equal(boss.dead, false);
  assert.equal(game.score, 0);
  game.update();
  assert.equal(eye.frame, boss.definition.deadEyes[0]);
  assert.equal(eye.bounds().w, 0);
});

test("indestructible body absorbs shots while Z spares the entire composite and clears hostile fire", () => {
  const game = arena(), boss = game.miniboss, root = boss.parts[0];
  const shot = { x: root.box.x + 4, y: root.box.y + 4, dx: 0, dy: 0, damage: 127, point: true };
  game.shots.push(shot);
  game.update();
  assert.equal(shot.dead, true);
  assert.equal(root.health, 20);
  game.bullets.push({ x: 120, y: 120, dx: 0, dy: 1 });
  grantReward(game, 18);
  assert.equal(game.bullets.length, 0);
  assert.equal(boss.remaining, 2);
  assert.ok(boss.parts.every((part) => !part.dead && part.health === 20));
});

test("large composite contact costs sixteen energy but never destroys a boss component", () => {
  for (const mode of ["normal", "protected", "diving", "fatal"]) {
    const game = arena(), root = game.miniboss.parts[0];
    game.player.x = root.box.x + Math.floor(root.box.w / 2);
    game.player.y = root.box.y + 21;
    game.player.protection = mode === "protected";
    if (mode === "diving") game.divePhase = 4;
    if (mode === "fatal") game.player.health = 16;
    game.update();
    assert.equal(game.player.health, { fatal: 0, normal: 23, protected: 31, diving: 39 }[mode], mode);
    assert.equal(game.status, mode === "fatal" ? "dying" : "playing", mode);
    assert.equal(game.miniboss.remaining, 2);
    assert.ok(game.miniboss.parts.every((part) => !part.dead));
  }
});

test("last eye creates the original chained effects and credits without prematurely ending stage three", () => {
  const game = arena(), boss = game.miniboss;
  game.bullets.push({ x: 120, y: 120, dx: 0, dy: 1 });
  for (const index of [4, 3]) {
    boss.parts[index].health = 0;
    game.destroy(boss.parts[index]);
  }
  assert.equal(game.score, 1000);
  assert.equal(game.effects.filter((effect) => !effect.large).length, 2);
  assert.equal(game.effects.filter((effect) => effect.large).length, 17);
  assert.equal(game.countedCredits, 10);
  assert.deepEqual(game.pickups.map((pickup) => pickup.value), [50, 100, 50, 100, 50, 100, 50, 100, 50, 100]);
  assert.equal(game.bullets.length, 1);
  assert.ok(boss.parts.every((part) => part.dead));
  assert.equal(boss.targets.length, 0);
  game.invincible = 999;
  game.update();
  assert.equal(game.endCamera, 2800);
  assert.equal(game.status, "playing");
  game.update();
  assert.equal(game.endCamera, 0);
  assert.equal(game.status, "playing");
});

test("ten counted rewards gate the same-stage shop and purchase/resume preserves stage progress", () => {
  const game = arena(), boss = game.miniboss;
  for (const index of [3, 4]) { boss.parts[index].health = 0; game.destroy(boss.parts[index]); }
  for (let tick = 0; tick < 500 && game.status === "playing"; tick++) {
    game.invincible = 999;
    game.update();
    if (game.countedCredits) assert.equal(game.status, "playing");
  }
  assert.equal(game.countedCredits, 0);
  assert.equal(game.status, "shop");
  assert.equal(game.shopStage, 3);
  const { camera, stageWaves, inventory, map } = game;
  const { backgroundEventLimit } = game;
  assert.equal(buy(game, 3).ok, true);
  assert.equal(game.continueRun(), true);
  assert.equal(game.stage, 3);
  assert.equal(game.camera, camera);
  assert.equal(game.stageWaves, stageWaves);
  assert.equal(game.inventory, inventory);
  assert.equal(game.map, map);
  assert.equal(game.backgroundEventLimit, backgroundEventLimit);
  assert.equal(game.player.speed, 1);
  assert.equal(boss.dead, true);
  for (let tick = 0; tick < 10; tick++) game.update();
  assert.ok(game.camera < camera);
  assert.equal(game.status, "playing");
});
