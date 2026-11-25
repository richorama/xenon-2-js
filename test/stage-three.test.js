import { test } from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/game.js";
import { GroundArm, GroundSkater, GroundCrawler, GroundTurret } from "../src/stage-three-ground.js";
import { Renderer } from "../src/renderer.js";
import { grantReward } from "../src/shop.js";
import { loadTestCampaign } from "./helpers.js";

const campaign = loadTestCampaign();

function scene() {
  const game = new Game(campaign);
  game.start(3);
  game.miniboss = undefined;
  game.endCamera = 224;
  game.camera = 1000;
  game.control.ceiling = 1016;
  game.assets = { ...game.assets, events: [], background: [] };
  game.shipTouchesTerrain = () => false;
  return game;
}

test("stage-three camera births defer the wave, skater, turret tiles and 17-part miniboss until the next frame", () => {
  const game = new Game(campaign);
  game.start(3);
  game.camera = 2817;
  game.control.ceiling = 2832;
  game.player.x = 300;
  game.player.y = 24;
  game.shipTouchesTerrain = () => false;
  game.assets = { ...game.assets, events: [[2816, 1, 1, 23, 0, 0, 3]], background: [
    [2816, 2, 0, 0, 56, 2924, 0],
    [2816, 5, 0, 0, 136, 2872, 0],
    game.assets.background.find((event) => event[1] === 3),
  ] };
  const sprites = [], tiles = [];
  const renderer = Object.assign(Object.create(Renderer.prototype), {
    assets: game.assets, map: game.map, mapRevision: 0,
    world: { getContext: () => ({ drawImage: (...args) => tiles.push(args) }) },
    tileImages: game.assets.tiles.map((_, i) => i),
    context: Object.fromEntries(["drawImage", "save", "beginPath", "rect", "clip", "restore", "fillRect", "fillText"]
      .map((name) => [name, () => {}])),
    drawSprite(sprite) { if (sprite !== game.shipSprite(game.divePose)) sprites.push(sprite); },
  });

  game.update();

  const [skater, turret] = game.ground, [enemy] = game.enemies;
  const { parts } = game.miniboss;
  assert.equal(parts.length, 17);
  assert.deepEqual([enemy.age, skater.motion.x, turret.fireCounter, parts[0].fireCounter], [0, 48, 0, 0]);
  assert.equal(game.map[turret.cell], turret.patches[0]);
  renderer.draw(game);
  assert.deepEqual(sprites, []);
  assert.deepEqual(tiles, []);

  game.update();

  assert.equal(enemy.age, 1);
  assert.equal(skater.motion.x, 50);
  assert.ok(parts[0].fireCounter);
  renderer.draw(game);
  assert.deepEqual(sprites, [skater.frame, ...parts.map((part) => part.frame), game.enemyFrame(enemy)]
    .map((frame) => game.sprite(frame)));
  assert.ok(tiles.some(([tile, x]) => tile === game.map[turret.cell] >>> 6 && x === turret.x));
});

test("stage-three arms retract, extend near the player and share one health pool and death callback", () => {
  const game = scene();
  const arm = new GroundArm([1120, 1, 0, 0, 56, 1108, 0],
    game.assets.groundLogic.get(1), game.camera, (frame) => game.sprite(frame));
  game.ground = arm.chain;
  game.player.y = 170;
  game.update();
  assert.ok(arm.chain.slice(0, 7).every((part) => part.hidden));
  game.player.y = 120;
  for (let tick = 0; tick < 4; tick++) game.update();
  assert.equal(arm.length, 8);
  assert.equal(arm.chain[7].motion.x, arm.baseX + 56);
  assert.ok(arm.chain.every((part) => !part.hidden));
  const box = arm.chain[7].bounds();
  game.shots.push({ x: box.x + box.w - 2, y: box.y + 4, dx: 0, dy: 0, point: true, damage: 1 });
  game.update();
  assert.ok(arm.chain.every((part) => part.health === 11 && part.hit));
  grantReward(game, 18);
  assert.ok(arm.chain.every((part) => part.dead));
  assert.equal(game.score, 400);
  assert.equal(game.effects.length, 8);
  assert.ok(game.effects.every((effect) => !effect.large));
});

test("both skaters stop for their original attack and return outward after one corridor shot", () => {
  for (const right of [false, true]) {
    const game = scene(), d = game.assets.groundLogic.get(2);
    const actor = new GroundSkater([1120, 2, 0, 0, right ? 248 : 56, 1108, 0],
      d, 1000, (frame) => game.sprite(frame));
    let shot, resumed = false;
    for (let tick = 0; tick < 100; tick++) {
      const bullet = actor.update(1000, 1016, () => game.randomWord(), game.player, tick, 0);
      if (bullet) { assert.ok(!shot); shot = bullet; }
      if (shot && !actor.attack) { resumed = true; break; }
    }
    assert.ok(shot && resumed);
    assert.equal(shot.direction, right ? 5 : 3);
    assert.equal(shot.x, right ? 189 : 131);
    assert.equal(actor.motion.x, right ? 216 : 104);
    assert.equal(actor.dx, right ? 2 : -2);
    assert.ok(game.sprite(shot.frame));
  }
});

test("skater bullets reverse horizontal travel at the original 128/192 corridor boundaries", () => {
  const game = scene(), d = game.assets.groundLogic.get(2);
  const bullet = { x: 190, y: 30, dx: 4, dy: 4, fixed: true, frame: d.bulletFrames[0], corridor: d };
  game.bullets.push(bullet);
  game.invincible = 999;
  game.update();
  assert.equal(bullet.direction, 5);
  assert.ok(bullet.dx < 0 && bullet.dy > 0);
  assert.equal(bullet.frame, d.bulletFrames[1]);
  for (let tick = 0; tick < 20 && bullet.direction === 5; tick++) game.update();
  assert.equal(bullet.direction, 3);
  assert.ok(bullet.dx > 0 && bullet.dy > 0);
  assert.equal(bullet.frame, d.bulletFrames[0]);
});

test("wall crawlers follow supporting terrain and turn around empty or obstructed grid corners", () => {
  for (const mode of ["supported", "empty", "blocked"]) {
    const game = scene(), d = game.assets.groundLogic.get(6);
    const actor = new GroundCrawler([1120, 6, 0, 0, 56, 1108, 0],
      d, 1000, (frame) => game.sprite(frame));
    actor.motion.x = 63;
    const map = new Uint16Array(6000);
    const cell = Math.floor((actor.motion.y + 1000) / 16) * 20 + 4;
    if (mode === "supported") map[cell - 20] = 1;
    if (mode === "blocked") map[cell] = 1;
    actor.update(1000, 1016, () => game.randomWord(), game.player, 0, 0, map);
    assert.equal(actor.direction, mode === "supported" ? 0 : 5);
    assert.equal(actor.motion.x, mode === "supported" ? 64 : mode === "blocked" ? 57 : 58);
    assert.ok(game.sprite(actor.frame));
  }
});

test("terrain turrets retain a separate core after Z and fire eight animated shots before final destruction", () => {
  const game = scene(), d = game.assets.groundLogic.get(5);
  const actor = new GroundTurret([1120, 5, 0, 0, 136, 1108, 0], d, game.camera);
  game.ground.push(actor);
  game.patchGround(actor, actor.patches);
  assert.deepEqual(Array.from(game.map.slice(actor.cell, actor.cell + 4)), d.initial.slice(0, 4));
  grantReward(game, 18);
  assert.equal(actor.core, 1);
  assert.equal(actor.dead, false);
  assert.equal(actor.health, 24);
  assert.equal(actor.hit, 0);
  assert.equal(game.score, 500);
  for (let tick = 0; tick < 4; tick++) { game.invincible = 999; game.update(); }
  assert.equal(game.bullets.length, 8);
  assert.deepEqual(game.bullets.map((bullet) => bullet.direction), [7, 6, 5, 4, 3, 2, 1, 0]);
  assert.ok(game.bullets.every((bullet) => bullet.frames.length === 4 && game.sprite(bullet.frame)));
  grantReward(game, 18);
  assert.equal(actor.dead, true);
  assert.equal(game.score, 1000);
  assert.equal(game.effects.length, 2);
  assert.ok(game.effects.every((effect) => effect.large));
  for (const offset of [0, 1, 2, 3, 20, 21, 22, 23, 40, 41, 42, 43, 60, 61, 62, 63, 80, 81, 82, 83, 101, 102]) {
    assert.equal(game.map[actor.cell + offset], 0);
  }
});

test("large skater contact costs sixteen energy and dispatches fatal damage unless diving or killed", () => {
  for (const mode of ["normal", "protected", "diving", "fatal"]) {
    const game = scene();
    const actor = new GroundSkater([1120, 2, 0, 0, 168, 1108, 0],
      game.assets.groundLogic.get(2), game.camera, (frame) => game.sprite(frame));
    game.ground.push(actor);
    game.player.x = actor.box.x + 8;
    game.player.y = actor.box.y + 22;
    game.player.protection = mode === "protected";
    if (mode === "diving") game.divePhase = 4;
    if (mode === "fatal") game.player.health = 16;
    game.update();
    assert.equal(actor.dead, !["diving", "fatal"].includes(mode));
    assert.equal(game.player.health, { fatal: 0, normal: 23, protected: 31, diving: 39 }[mode]);
    assert.equal(game.status, mode === "fatal" ? "dying" : "playing");
  }
});

test("stage three schedules every supported background event once without missing sprites or replay on reverse", () => {
  const game = new Game(campaign);
  game.start(3);
  game.miniboss = undefined;
  game.endCamera = 224;
  game.assets = { ...game.assets, events: [] };
  game.shipTouchesTerrain = () => false;
  const seen = new Set();
  let dispatches = 0;
  const saveActorPaint = game.saveActorPaint.bind(game);
  game.saveActorPaint = () => { dispatches++; saveActorPaint(); };
  for (let tick = 0; tick < 4500; tick++) {
    game.invincible = 999;
    game.update();
    for (const actor of game.ground) {
      seen.add(actor.definition.kind);
      if (actor.spriteActor) assert.ok(game.sprite(actor.frame));
    }
  }
  assert.deepEqual([...seen].sort(), ["arm", "burst-gun", "skater", "terrain-turret", "wall-crawler"]);
  const { backgroundEventLimit } = game;
  assert.equal(backgroundEventLimit, game.endCamera);
  const expected = game.assets.background.filter((event) => event[0] >= game.endCamera).length;
  assert.equal(dispatches, expected);
  for (let tick = 0; tick < 30; tick++) { game.invincible = 999; game.update({ down: true }); }
  assert.equal(game.backgroundEventLimit, backgroundEventLimit);
  assert.equal(dispatches, expected);
});
