import { test } from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/game.js";
import { buy, grantReward } from "../src/shop.js";
import { loadTestCampaign } from "./helpers.js";

const campaign = loadTestCampaign();

function arena(camera = 0) {
  const game = new Game(campaign);
  game.start(3);
  game.assets = { ...game.assets, events: [], background: [] };
  game.miniboss.dead = true;
  game.endCamera = 0;
  game.camera = game.control.camera = camera;
  game.control.ceiling = camera + 16;
  game.shipTouchesTerrain = () => false;
  return game;
}

function stationary(game) {
  game.update();
  for (const actor of game.boss.parts) {
    actor.motion.step = () => {};
    actor.motion.xFixed = (actor.index ? 60 : 180) * 65536;
    actor.motion.yFixed = (actor.index ? 100 : 60) * 65536;
    actor.frameTicks = 0;
  }
  game.boss.update(game);
}

function shoot(game, actor) {
  const box = actor.bounds();
  const shot = { x: box.x + Math.floor(box.w / 2), y: box.y + Math.floor(box.h / 2),
    dx: 0, dy: 0, point: true, damage: 1 };
  game.shots.push(shot);
  game.update();
  return shot;
}

test("the final worm activates at camera 208 with eleven delayed components and cannot be bypassed", () => {
  const game = arena(210);
  game.update();
  assert.equal(game.boss.active, false);
  game.update();
  assert.equal(game.boss.active, true);
  assert.equal(game.camera, 208);
  assert.equal(game.boss.parts.length, 11);
  const root = game.boss.parts[0];
  assert.ok(game.boss.parts.slice(1).every((part) => part.motion.remaining < 0));
  assert.ok(root.motion.remaining > 0);
  for (let tick = 0; tick < 650; tick++) {
    game.invincible = 999;
    game.update();
    for (const actor of game.boss.parts) assert.ok(game.sprite(actor.frame));
  }
  assert.equal(game.camera, 0);
  assert.equal(game.control.ceiling, 32);
  assert.equal(game.boss.dead, false);
  assert.equal(game.status, "playing");
  assert.equal(game.endWait, 0);
});

test("only the worm head takes shots; segments absorb them and Z spares the whole chain", () => {
  const game = arena();
  stationary(game);
  const boss = game.boss;
  assert.equal(shoot(game, boss.parts[3]).dead, true);
  assert.equal(boss.health, 80);
  assert.equal(shoot(game, boss.parts[0]).dead, true);
  assert.equal(boss.health, 79);
  assert.ok(boss.parts.every((part) => part.hit));
  game.bullets.push({ x: 120, y: 120, dx: 0, dy: 1 });
  grantReward(game, 18);
  assert.equal(game.bullets.length, 0);
  assert.equal(boss.health, 79);
  assert.ok(boss.parts.every((part) => !part.dead));
});

test("the tail gates reappearance while head health persists and the rotating path selector leaves RNG untouched", () => {
  const game = arena();
  game.update();
  const boss = game.boss, original = boss.parts, seed = game.seed;
  boss.health--;
  let headGone = false;
  for (let tick = 0; tick < 500 && boss.parts === original; tick++) {
    game.invincible = 999;
    game.update();
    if (original[0].dead && !original.at(-1).dead) {
      headGone = true;
      assert.equal(boss.parts, original);
    }
  }
  assert.ok(headGone);
  assert.notEqual(boss.parts, original);
  assert.equal(boss.health, 79);
  assert.equal(boss.pathCounter, 1);
  assert.notEqual(boss.pathSeed, 0xe496);
  assert.equal(game.seed, seed);
});

test("the worm emits eight fast quantized shots that cycle through the recovered two-tick animation", () => {
  const game = arena(208), boss = game.boss;
  game.control.scroll = 1;
  game.control.delta = 0;
  let volley;
  for (let tick = 0; tick < 13; tick++) {
    game.bullets = [];
    boss.update(game);
    if (game.bullets.length) volley = game.bullets.slice();
  }
  assert.equal(volley.length, 8);
  assert.deepEqual(volley.map((bullet) => bullet.direction), [7, 6, 5, 4, 3, 2, 1, 0]);
  for (const bullet of volley) { bullet.x = 160; bullet.y = 96; }
  const horizontal = volley.find((bullet) => bullet.direction === 2);
  assert.equal(horizontal.frame, boss.definition.bullet[0]);
  game.bullets = volley;
  game.camera = 0;
  game.control.ceiling = 32;
  for (const index of [0, 1, 1, 2, 2, 3, 3, 0, 0, 1]) {
    game.invincible = 999;
    game.update();
    assert.equal(horizontal.frame, boss.definition.bullet[index]);
  }
  assert.ok(volley.some((bullet) => bullet.dead));
  assert.ok(Math.max(...volley.map((bullet) => Math.abs(bullet.dx))) === 12);
});

test("worm contact costs eight energy without running the head's death callback", () => {
  for (const mode of ["normal", "protected", "diving", "fatal"]) {
    const game = arena();
    stationary(game);
    const root = game.boss.parts[0];
    game.player.x = root.box.x + Math.floor(root.box.w / 2);
    game.player.y = root.box.y + 21;
    game.player.protection = mode === "protected";
    if (mode === "diving") game.divePhase = 4;
    if (mode === "fatal") game.player.health = 8;
    game.update();
    assert.equal(game.player.health, { fatal: 0, normal: 31, protected: 35, diving: 39 }[mode], mode);
    assert.equal(game.status, mode === "fatal" ? "dying" : "playing", mode);
    assert.equal(game.boss.health, 80);
    assert.equal(game.boss.dead, false);
    assert.ok(game.boss.parts.every((part) => !part.dead));
  }
});

test("worm death clears main actors but preserves projectiles and delays rewards until the next arena update", () => {
  const game = arena();
  game.update();
  const boss = game.boss;
  game.enemies = [{}];
  game.ground = [{}];
  game.bullets = [{ x: 100, y: 100, dx: 0, dy: 1 }];
  game.shots = [{ x: 100, y: 150, dx: 0, dy: -6 }];
  boss.health = 0;
  game.destroy(boss.parts[0]);
  assert.equal(boss.dead, true);
  assert.equal(boss.rewardsPending, true);
  assert.equal(game.effects.length, 20);
  assert.ok(game.effects.every((effect) => effect.large && effect.x >= 0 && effect.x < 320
    && effect.y >= 0 && effect.y < 192));
  assert.equal(game.score, 0);
  assert.equal(game.enemies.length, 0);
  assert.equal(game.ground.length, 0);
  assert.equal(game.bullets.length, 1);
  assert.equal(game.shots.length, 1);
  assert.equal(game.countedCredits, 0);
  game.camera = game.control.camera = 220;
  game.control.ceiling = 236;
  game.invincible = 999;
  game.update();
  assert.equal(boss.rewardsPending, true);
  assert.equal(game.status, "playing");
  game.camera = game.control.camera = 0;
  game.control.ceiling = 32;
  game.update();
  assert.equal(boss.rewardsPending, false);
  assert.equal(game.countedCredits, 20);
  assert.equal(game.status, "playing");
  assert.equal(boss.targets.length, 0);
});

test("twenty counted rewards gate the stage-four shop and purchase/continue retains equipment and score", () => {
  const game = arena();
  game.update();
  game.boss.health = 0;
  game.destroy(game.boss.parts[0]);
  for (let tick = 0; tick < 500 && game.status === "playing"; tick++) {
    game.invincible = 999;
    game.update();
    if (game.countedCredits) assert.equal(game.status, "playing");
  }
  assert.equal(game.status, "shop");
  assert.equal(game.shopStage, 4);
  assert.equal(game.countedCredits, 0);
  const { inventory, score } = game;
  assert.equal(buy(game, 3).ok, true);
  assert.equal(game.continueRun(), true);
  assert.equal(game.stage, 4);
  assert.equal(game.camera, 0x1200);
  assert.equal(game.inventory, inventory);
  assert.equal(game.player.speed, 1);
  assert.equal(game.score, score);
});
