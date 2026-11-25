import { test } from "node:test";
import assert from "node:assert/strict";
import { Game, frameAt } from "../src/game.js";
import { movePlayer, scrollMap } from "../src/controls.js";
import { GroundGun, GroundPatrol, GroundCreature } from "../src/ground.js";
import { buy, grantReward } from "../src/shop.js";
import { fireWeapons, weaponAttachment } from "../src/weapons.js";
import { Renderer } from "../src/renderer.js";
import { ActorList, ActorPool } from "../src/actor-pool.js";
import { loadTestCampaign } from "./helpers.js";

const campaign = loadTestCampaign();

function terrainWormScene(camera) {
  const game = new Game(campaign);
  game.start();
  game.assets = { ...game.assets, events: [], background: [] };
  game.camera = game.control.camera = camera;
  game.endCamera = camera - 32;
  game.shipTouchesTerrain = () => false;
  return game;
}

test("stage-one scroll opens five worm routes only inside the camera window and reveals trailing segments", () => {
  const game = terrainWormScene(3345);
  const worms = game.terrainWorms;
  const hatch = worms.data.openings[14];
  game.update();
  assert.equal(game.camera, 3344);
  assert.equal(worms.targets.length, 0);

  game.update();
  assert.deepEqual(worms.groups.map((group) => group.index), [14, 9, 11, 2, 3]);
  assert.equal(game.map[hatch.cell], hatch.tiles[3]);
  const { parts, driver } = worms.groups[0];
  assert.equal(parts.filter((part) => !part.hidden).length, 2);
  const [x, y] = [driver.x, driver.y];
  game.update();
  assert.deepEqual(parts[0].motion, { x, y: y + 1 });
  assert.equal(parts.filter((part) => !part.hidden).length, 3);
  assert.equal(game.map[hatch.cell], hatch.tiles[2]);
});

test("reused terrain worm records keep the driver's fractions and the segments' initial headings", () => {
  const game = terrainWormScene(3200);
  const fresh = terrainWormScene(3200);
  for (const scene of [game, fresh]) scene.terrainWorms.present.fill(true, 1);
  const worms = game.terrainWorms;
  const pool = game.run.actorPool;
  const [, driverAddress, headAddress] = pool.free.slice().reverse();
  pool.subpixels.set(driverAddress, [0xf000, 0x9000]);
  pool.headings.set(driverAddress, 96);
  pool.headings.set(headAddress, 192);
  for (const scene of [game, fresh]) {
    scene.terrainWorms.dispatch(scene, scene.camera);
    if (scene === game) assert.equal(worms.groups[0].driver.actorAddress, driverAddress);
    scene.terrainWorms.update(scene, 0);
  }
  const { driver, parts } = worms.groups[0];
  const { driver: baseline } = fresh.terrainWorms.groups[0];
  assert.equal(driver.xFixed - baseline.xFixed, 0xf000);
  assert.equal(driver.yFixed - baseline.yFixed, 0x9000);
  assert.equal(parts[0].heading, 96);
  assert.equal(parts[1].heading, 192);
  assert.equal(parts[0].frame, worms.data.frames[0][3]);
  assert.equal(parts[1].frame, worms.data.frames[1][6]);
});

test("a retiring worm reopens the terrain cell named by its exit, not the spawn cell", () => {
  const game = terrainWormScene(3000);
  const worms = game.terrainWorms;
  worms.rotations[0] = 2 << 3;
  worms.present.fill(true, 1);
  worms.dispatch(game, game.camera);
  worms.update(game, 0);
  assert.equal(worms.openTicks[2], 19);
  const exit = worms.data.openings[8];
  const tileBefore = game.map[exit.cell];
  const driverAddress = worms.groups[0].driver.actorAddress;
  for (let tick = 0; tick < 240 && !worms.openTicks[8]; tick++) {
    worms.present.fill(true, 1);
    worms.dispatch(game, game.camera);
    worms.update(game, 0);
  }
  assert.equal(worms.openTicks[2], 0);
  assert.equal(worms.openTicks[8], 20);
  assert.ok(game.run.actorPool.free.includes(driverAddress));
  assert.equal(game.map[exit.cell], tileBefore);
  worms.present.fill(true, 1);
  worms.dispatch(game, game.camera);
  assert.equal(game.map[exit.cell], exit.tiles[3]);
});

test("a basic round kills only the hit worm segment, and respawning clears its drifting corpse", () => {
  const game = terrainWormScene(3200);
  game.endCamera = game.camera;
  const worms = game.terrainWorms;
  worms.rotations[0] = 14 << 3;
  const update = () => {
    worms.present.fill(true, 1);
    game.update();
  };
  for (let i = 0; i < 10; i++) update();
  const { parts: [head, body, follower], driver } = worms.groups[0];
  game.shots.push({ x: driver.x + 2, y: driver.y, dy: 0, point: true, damage: 1 });
  update();
  assert.equal(head.dead, true);
  assert.equal(game.score, 250);
  assert.equal(body.health, 1);
  assert.equal(follower.health, 1);
  assert.equal(game.shots.length, 0);
  const [record] = game.actorLists.get(ActorList.transient);
  const corpse = record.actor;
  assert.ok(corpse);
  const before = { x: corpse.x, y: corpse.y };
  assert.ok(!game.run.actorPool.free.includes(head.actorAddress));
  update();
  assert.notDeepEqual({ x: corpse.x, y: corpse.y }, before);
  assert.notEqual(corpse.frame, corpse.frames[0]);
  assert.equal(worms.groups[0].parts[0], body);
  assert.ok(game.run.actorPool.free.includes(head.actorAddress));

  game.restoreCheckpoint();
  assert.ok(game.run.actorPool.free.includes(body.actorAddress));
  assert.ok(game.run.actorPool.free.includes(record.address));
  assert.equal(worms.targets.length, 0);
  assert.equal(worms.rotations[0] & 15, 14);
});

test("a saturated terrain worm death marks its self-reused corpse and frees it without movement", () => {
  const game = terrainWormScene(3240);
  const worms = game.terrainWorms;
  const pool = game.run.actorPool;
  worms.rotations[0] = 9 << 3;
  worms.present.fill(true, 1);
  worms.dispatch(game, game.camera);
  worms.update(game, 1);
  const tail = worms.groups[0].parts.at(-1);
  tail.motion = { x: 160, y: 96 };
  pool.free.length = 0;
  const seed = game.seed;

  game.hitWithWeapon(tail, { damage: 1 });
  const [record] = game.actorLists.get(ActorList.transient);
  const corpse = record.actor;
  assert.equal(record.address, tail.actorAddress);
  assert.equal(corpse.dead, true);
  assert.equal(game.score, 50);
  assert.equal(game.seed, (seed * 0x6255 + 0x3619) & 65535);
  assert.equal(pool.headings.get(record.address), game.seed & 255);
  assert.ok(!game.actorLists.get(ActorList.main).some(({ actor }) => actor === tail));
  game.updateTransientActor(record);
  assert.deepEqual([corpse.x, corpse.y, corpse.age], [160, 96, 0]);
  assert.deepEqual(pool.free, [record.address]);
});

test("terrain worm rams use the old hull before steering and update the corpse in the same tick", () => {
  for (const [mode, health, flash, killed] of [
    ["ram", 31, true, true], ["steer-in", 39, false, false], ["fatal", 0, false, false],
  ]) {
    const game = terrainWormScene(3240);
    game.endCamera = game.camera;
    const worms = game.terrainWorms;
    worms.rotations[0] = 9 << 3;
    worms.present.fill(true, 1);
    worms.dispatch(game, game.camera);
    worms.update(game, 1);
    game.eventStreamsClosed = true;
    const rightEdge = Math.max(...worms.targets.filter((part) => !part.hidden)
      .map((part) => { const { x, w } = part.bounds(); return x + w - 1; }));
    game.player.x = rightEdge - game.bounds(game.shipSprite(), 0, 0).x + Number(mode === "steer-in");
    game.player.y = 80;
    if (mode === "fatal") game.player.health = 8;
    const startX = game.player.x;

    game.update({ right: mode !== "steer-in", left: mode === "steer-in" });

    assert.equal(game.player.health, health, mode);
    assert.equal(game.shipHitFlash, flash, mode);
    assert.equal(game.kills, Number(killed), mode);
    assert.equal(game.player.x, startX + (mode === "fatal" ? 0 : mode === "steer-in" ? -3 : 3), mode);
    const corpse = game.actorLists.get(ActorList.transient)?.[0]?.actor;
    assert.equal(corpse?.age, killed ? 1 : undefined, mode);
  }
});

test("straight rounds hit the first raw worm segment and are consumed by its marked record", () => {
  const game = terrainWormScene(3240);
  game.endCamera = game.camera;
  const worms = game.terrainWorms;
  worms.rotations[0] = 9 << 3;
  worms.present.fill(true, 1);
  worms.dispatch(game, game.camera);
  worms.update(game, 1);
  game.eventStreamsClosed = true;
  const { parts } = worms.groups[0];
  const tail = parts.at(-1);
  assert.equal(tail.hidden, true);
  game.shots.push(...Array.from({ length: 2 }, () => ({ x: 120, y: 80, dy: 0, point: true, damage: 1 })));

  game.update();

  assert.equal(tail.dead, true);
  assert.ok(parts.slice(0, -1).every((part) => !part.dead));
  assert.equal(game.score, 50);
  assert.equal(game.shots.length, 0);
});

test("a stage-one round creates a corpse at the list head without advancing it on the killing tick", () => {
  for (const saturated of [false, true]) {
    const game = terrainWormScene(3240);
    game.endCamera = game.camera;
    const worms = game.terrainWorms;
    worms.rotations[0] = 9 << 3;
    worms.present.fill(true, 1);
    worms.dispatch(game, game.camera);
    worms.update(game, 1);
    game.eventStreamsClosed = true;
    const shot = { x: 120, y: 80, dx: 0, dy: 0, point: true, damage: 1, age: 0 };
    game.addPlayerRound(shot);
    const [round] = game.actorLists.get(ActorList.transient) || [];
    assert.equal(round?.actor, shot);
    if (saturated) game.run.actorPool.free.length = 0;

    game.update();

    const [record, ...remaining] = game.actorLists.get(ActorList.transient);
    const corpse = record.actor;
    assert.equal(corpse.kind, "terrain-worm-corpse");
    assert.equal(corpse.age, 0);
    assert.equal(record.address === round.address, saturated);
    assert.deepEqual(remaining, saturated ? [] : [round]);
    assert.equal(shot.dead, true);
    assert.equal(game.score, 50);

    game.update();

    assert.equal(corpse.age, 1);
    assert.ok(!game.actorLists.get(ActorList.transient).includes(round));
  }
});

test("Shades use the cached worm group gate and stop at a marked segment", () => {
  const game = terrainWormScene(3240);
  const worms = game.terrainWorms;
  worms.rotations[0] = 9 << 3;
  worms.present.fill(true, 1);
  worms.dispatch(game, game.camera);
  worms.update(game, 1);
  game.eventStreamsClosed = true;
  game.player.shades = 5;
  game.player.x = 120;
  game.player.y = 80;
  const { parts } = worms.groups[0];
  parts.at(-1).dead = true;

  game.update();

  assert.equal(game.score, 0);
  assert.ok(parts.slice(0, -1).every((part) => !part.dead));
  assert.equal(game.player.health, 39);
});

test("stage-one wall guns allocate before the mounts, and mixed fire and overlays paint in linked order", () => {
  for (const [orders, positions] of [
    [[14, 8, 15], [[166, 75], [155, 75], [160, 123]]],
    [[15, 8, 14], [[160, 123], [166, 75], [155, 75]]],
  ]) {
    const game = terrainWormScene(4300);
    game.endCamera = game.camera;
    game.control.ceiling = 4316;
    game.eventStreamsClosed = true;
    game.player.y = 96;
    game.credits = 100000;
    game.openShop(1);
    for (const id of orders) assert.ok(buy(game, id).ok);
    game.continueRun();
    game.posture = 0;
    const gun = new GroundGun([4300, 1, 0, 0, 72, 4340, 0], game.assets.groundLogic);
    game.run.actorPool.allocate(game.actorLists, ActorList.main, 0xec, gun);
    gun.fireCounter = 255;
    game.ground.push(gun);

    game.update({ fire: true });

    const transient = game.actorLists.get(ActorList.transient);
    assert.deepEqual(transient.map(({ type }) => type), [0x10, 0x10, 0x10, 0x14, 0x40]);
    assert.deepEqual(transient.slice(0, 3).map(({ actor }) => [actor.x, actor.y]), positions);
    assert.ok(transient.slice(0, 3).every(({ address }) => address > transient[3].address));
    game.update();
    const records = game.actorLists.get(ActorList.transient);
    assert.equal(records[0].type, 0x30);

    const draws = [];
    const renderer = Object.assign(Object.create(Renderer.prototype), {
      assets: game.assets, map: game.map, mapRevision: game.mapRevision, world: {},
      context: Object.fromEntries(["fillRect", "drawImage", "save", "beginPath", "rect",
        "clip", "restore", "fillText"].map((name) => [name, () => {}])),
      drawShip() { draws.push("ship"); },
      drawMountFrame(_, frame) { draws.push(frame); },
      drawPlayerRound(_, actor) { draws.push(actor); },
      drawEnemyRound(_, actor) { draws.push(actor); },
    });
    const cannon = weaponAttachment(game, 1, game.inventory[1]);
    const rear = weaponAttachment(game, 5, game.inventory[5]);
    const front = weaponAttachment(game, 0, game.inventory[0]);
    const poses = orders[0] === 14 ? [cannon, rear, front] : [front, rear, cannon];
    assert.ok(cannon.overlay);
    renderer.draw(game);
    assert.deepEqual(draws, [
      "ship", ...poses.map(({ frames, age }) => frameAt(frames, age)),
      ...records.slice(0, -1).map(({ actor }) => actor), frameAt(cannon.overlay, cannon.age),
    ]);
  }
});

function mixedStageOneTargets(gunFirst) {
  const game = terrainWormScene(3240);
  game.endCamera = game.camera;
  game.eventStreamsClosed = true;
  const worms = game.terrainWorms;
  const gun = new GroundGun([3240, 1, 0, 0, 118, 3324, 0], game.assets.groundLogic);
  function addGun() {
    game.run.actorPool.allocate(game.actorLists, ActorList.main, 0xec, gun);
    game.ground.push(gun);
    game.updateGroundActor(gun);
  }
  if (!gunFirst) addGun();
  worms.rotations[0] = 9 << 3;
  worms.present.fill(true, 1);
  worms.dispatch(game, game.camera);
  worms.update(game, 1);
  if (gunFirst) addGun();
  return { game, gun, tail: worms.groups[0].parts.at(-1) };
}

test("stage-one point and rectangle attacks honor the linked gun and worm order", () => {
  for (const [gunFirst, marked] of [[true, false], [false, false], [true, true]]) {
    for (const mode of ["straight", "cannon", "shades", "drone"]) {
      const { game, gun, tail } = mixedStageOneTargets(gunFirst);
      const bounds = { x: 120, y: 80, w: 1, h: 1 };
      const shot = { cannon: mode === "cannon", damage: 2 };
      if (marked) gun.dead = true;
      if (mode === "shades") game.hitFirstInBox({ shades: true, damage: 127 }, bounds);
      else if (mode === "drone") {
        game.droneShots[0] = { x: 120, y: 80, dx: 0, dy: 0, age: 0, damage: 2 };
        game.updateDroneRounds();
        assert.equal(game.droneShots[0], null);
      } else {
        game.hitPlayerRound(shot, bounds);
        assert.equal(Boolean(shot.dead), mode === "straight");
      }
      assert.equal(game.score, marked ? 0 : gunFirst ? 100 : 50, mode);
      assert.equal(gun.dead, gunFirst, mode);
      assert.equal(Boolean(tail.dead), !gunFirst, mode);
    }
  }
});

test("stage-one ram uses the previous gun update's inclusive right and bottom edges", () => {
  const { game, gun, tail } = mixedStageOneTargets(true);
  game.camera++;
  game.shipContactBox = { x: 138, y: 104, w: 1, h: 1 };

  assert.equal(game.contactStageOneShip(), true);
  assert.equal(game.player.health, 31);
  assert.equal(game.shipHitFlash, true);
  assert.equal(gun.dead, true);
  assert.ok(!tail.dead);
  assert.equal(game.score, 100);
});

function finalBossScene() {
  const game = new Game(campaign);
  game.start(2);
  game.assets = { ...game.assets, events: [], background: [] };
  game.miniboss.dead = true;
  for (const eye of game.miniboss.eyes) eye.dead = true;
  game.endCamera = 0;
  game.shipTouchesTerrain = () => false;
  return game;
}

test("stage-two final boss requires the player-world trigger and only its mouth takes shots", () => {
  const game = finalBossScene();
  game.camera = 161;
  game.player.y = 17;
  game.update();
  assert.equal(game.boss.active, false);
  game.update();
  assert.equal(game.boss.active, true);
  assert.equal(game.boss.bounds().x, 1000, "activation returns before enabling the weak point");
  game.update();
  assert.equal(game.boss.bounds().w, 16);
  game.shots.push({ x: 130, y: 30, dx: 0, dy: 0, point: true, damage: 75 });
  game.update();
  assert.equal(game.boss.health, 75);
  game.shots.push({ x: 160, y: game.boss.weakY + 5, dx: 0, dy: 0, point: true, damage: 1 });
  game.update();
  assert.equal(game.boss.health, 74);
  grantReward(game, 18);
  assert.equal(game.boss.health, 74);
});

test("surviving the final boss at the map floor never opens a provisional next-stage shop", () => {
  const game = finalBossScene();
  game.camera = 0;
  for (let tick = 0; tick < 650; tick++) { game.invincible = 999; game.update(); }
  assert.equal(game.camera, 0);
  assert.equal(game.control.ceiling, 288);
  assert.equal(game.boss.dead, false);
  assert.equal(game.status, "playing");
  assert.equal(game.endWait, 0);
});

test("the full main list follows a successor recycled into a boss round before the transient pass", () => {
  const game = new Game(campaign);
  game.start(2);
  game.miniboss = undefined;
  game.eventStreamsClosed = true;
  game.camera = game.endCamera = 100;
  game.shipTouchesTerrain = () => false;
  game.player.x = game.player.y = 16;
  game.seed = 0x5845;
  const { boss } = game;
  Object.assign(boss, { moveTicks: 2, fireCounter: 255, wait: 340 });
  const pool = game.run.actorPool, reserved = new Map();
  const core = game.actorLists.get(ActorList.main).find(({ actor }) => actor === boss);
  const gun = new GroundGun([100, 1, 0, 0, 72, 200, 0], game.assets.groundLogic);
  pool.allocate(game.actorLists, ActorList.main, 0xec, gun, core);
  while (pool.free.length) pool.allocate(reserved, ActorList.hud, 0xc4);

  game.update();

  assert.equal(game.bullets.length, 1);
  const [round] = game.bullets;
  assert.equal(round.actorAddress, gun.actorAddress);
  assert.equal(round.y, 108 + 2 * round.dy);
  assert.equal(round.frame, boss.definition.bullets[0][2]);
  assert.ok(gun.dead);
  assert.equal(pool.free.length, 0);
});

test("the final boss fires both animated downward shots and sixteen-direction volleys while spawning eggs", () => {
  const game = finalBossScene(), boss = game.boss;
  let seed = 0x5845, single = false, ring = false, egg = false, crawler = false;
  for (let tick = 1; tick <= 1400; tick++) {
    const allBullets = boss.update(100, { ceiling: 288, delta: 0 },
      () => seed = (seed * 0x6255 + 0x3619) & 65535, { x: 160, y: 16 }, tick);
    const bullets = allBullets.filter((bullet) => boss.definition.bullets.includes(bullet.frames));
    if (bullets.length === 1) {
      single = true;
      assert.equal(bullets[0].direction, 4);
    }
    if (bullets.length === 16) {
      ring = true;
      assert.deepEqual(bullets.map((bullet) => bullet.direction),
        Array.from({ length: 16 }, (_, i) => 15 - i));
    }
    for (const bullet of allBullets) assert.ok(game.sprite(bullet.frame));
    egg ||= boss.children.some((actor) => actor.kind === "egg");
    crawler ||= boss.children.some((actor) => actor.kind === "crawler");
    for (const child of boss.children) assert.ok(game.sprite(child.frame));
  }
  assert.ok(single && ring && egg && crawler);
});

test("the stage-two arena allocates a new crawler slot before retiring its egg", () => {
  const game = finalBossScene();
  game.camera = game.endCamera = 100;
  game.player.x = game.player.y = 16;
  let hatch;
  for (let tick = 0; tick < 900 && !hatch; tick++) {
    const previous = game.boss.children.slice();
    game.invincible = 999;
    game.update();
    const egg = previous.find((actor) => actor.kind === "egg" && actor.dead);
    if (egg) hatch = { egg, crawler: game.boss.children.find((actor) => actor.kind === "crawler"
      && !previous.includes(actor)) };
  }
  assert.ok(hatch?.crawler, "the live arena must hatch a crawler");
  assert.equal(hatch.crawler.kind, "crawler");
  assert.notEqual(hatch.crawler.actorAddress, hatch.egg.actorAddress);
  const main = game.actorLists.get(ActorList.main);
  assert.ok(main.some(({ actor }) => actor === hatch.crawler));
  assert.ok(main.some(({ actor }) => actor === hatch.egg));
  game.update();
  assert.ok(!game.actorLists.get(ActorList.main).some(({ actor }) => actor === hatch.egg));
  const bossSlot = game.boss.actorAddress;
  game.restoreCheckpoint();
  assert.deepEqual(game.actorLists.get(ActorList.main).map(({ address }) => address), [bossSlot]);
  assert.equal(game.boss.children.length, 0);
});

test("reused stage-two round slots retain the fractional coordinate words", () => {
  const game = finalBossScene();
  const round = () => ({ x: 30, y: 30, dx: 1.75, dy: -1.5, fixed: true,
    frame: game.assets.logic.foregroundShot.frame });
  const first = round();
  game.addPooledHostileRound(first);
  game.update();
  first.dead = true;
  game.update();
  const second = round();
  game.addPooledHostileRound(second);
  assert.equal(second.actorAddress, first.actorAddress);
  game.update();
  assert.deepEqual([second.x, second.y], [32, 30]);
});

test("stage-two forward fire hits the newest overlapping target and keeps its marked slot until the next pass", () => {
  const game = new Game(campaign);
  game.start(2);
  game.camera = game.endCamera = 1000;
  game.shipTouchesTerrain = () => false;
  const event = [1000, 1, 0, 0, 160, 1120, 0];
  game.assets = { ...game.assets, events: [], background: [event, event] };
  game.player.y = 131;
  game.invincible = 999;
  game.update();
  game.update({ fire: true });

  const [older, newer] = game.ground;
  assert.equal(older.health, older.definition.health);
  assert.equal(newer.health, newer.definition.health - 1);
  const records = game.actorLists.get(ActorList.transient);
  const [round] = records;
  assert.equal(round.type, 0x10);
  assert.equal(round.actor.y, 116);
  assert.equal(round.actor.dead, true);
  assert.equal(game.shots.length, 0);

  game.update();
  assert.ok(!records.includes(round));
  assert.equal(game.run.actorPool.free.at(-1), round.address);
});

test("a pooled Cannon round hits only the first target each tick and persists until the death flush", () => {
  const game = new Game(campaign);
  game.start(2);
  game.camera = game.endCamera = 1000;
  game.shipTouchesTerrain = () => false;
  const event = [1000, 1, 0, 0, 160, 1120, 0];
  game.assets = { ...game.assets, events: [], background: [event, event] };
  game.player.x = 186;
  game.player.y = 148;
  game.invincible = 999;
  game.posture = 0;
  game.credits = 10000;
  game.openShop(2);
  assert.equal(buy(game, 15).ok, true);
  game.continueRun();
  game.update({ fire: true });
  const [older, newer] = game.ground;
  game.update();
  const records = game.actorLists.get(ActorList.transient);
  const round = records.find(({ type }) => type === 0x30);
  assert.deepEqual([round.actor.x, round.actor.y], [160, 143]);
  game.update();
  assert.equal(newer.health, 2);
  const secondRound = { ...round.actor };
  game.addPlayerRound(secondRound, 0x30);
  game.update();
  assert.equal(newer.dead, true);
  assert.equal(older.health, 4, "a marked target still blocks another round in the same pass");
  assert.ok(game.shots.includes(secondRound));
  assert.ok(game.shots.includes(round.actor));

  game.killPlayer();
  game.update();
  assert.ok(round.actor.dead && records.includes(round));
  game.update();
  assert.ok(!records.includes(round));
});

test("a pooled Laser hits both overlapping targets and retires on the next pass after death", () => {
  const game = new Game(campaign);
  game.start(2);
  game.camera = game.endCamera = 1000;
  game.shipTouchesTerrain = () => false;
  const event = [1000, 1, 0, 0, 160, 1120, 0];
  game.assets = { ...game.assets, events: [], background: [event, event] };
  game.player.x = 186;
  game.invincible = 999;
  game.posture = 0;
  game.credits = 100000;
  game.openShop(2);
  assert.equal(buy(game, 18).ok, true);
  game.continueRun();
  game.inventory[0] = null;

  for (let tick = 1; tick <= 11; tick++) {
    game.update({ fire: tick === 1 || tick === 9 });
    if (tick === 3) assert.deepEqual(game.ground.map((gun) => gun.health), [1, 1]);
  }
  assert.equal(game.ground.length, 0, "a fatal hit does not prevent damage to the next live target");
  assert.equal(game.score, 200);
  const records = game.actorLists.get(ActorList.transient);
  const beam = records.find(({ type }) => type === 0x24);
  assert.equal(beam.actor.beam.length, 64);
  game.killPlayer();
  game.update();
  assert.ok(beam.actor.dead && records.includes(beam));
  assert.ok(!game.shots.includes(beam.actor));
  game.update();
  assert.ok(!records.includes(beam));
});

test("a pooled Bomb marks its charge, allocates four fresh blasts and hits both overlapping guns", () => {
  const game = new Game(campaign);
  game.start(2);
  game.camera = game.endCamera = 1000;
  game.shipTouchesTerrain = () => false;
  const event = [1000, 1, 0, 0, 160, 1078, 0];
  game.assets = { ...game.assets, events: [], background: [event, event] };
  game.invincible = 999;
  game.posture = 0;
  game.credits = 100000;
  game.openShop(2);
  assert.ok(buy(game, 21).ok);
  game.continueRun();
  game.inventory[0] = null;
  game.update({ fire: true });

  const records = game.actorLists.get(ActorList.transient);
  const charge = records.find(({ type }) => type === 0x28);
  assert.equal(charge.actor.y, 156);
  for (let tick = 2; tick < 18; tick++) game.update();
  assert.equal(game.ground.length, 2);
  game.update();
  const explosions = records.filter(({ type }) => type === 0x0c);
  assert.equal(explosions.length, 6, "four blast effects plus two gun explosions");
  assert.ok(explosions.every(({ actor }) => actor.age === 0));
  assert.ok(charge.actor.dead && records.includes(charge));
  assert.equal(game.score, 200);
  assert.equal(game.ground.length, 0);

  game.update();
  assert.ok(!records.includes(charge));
  assert.ok(explosions.every(({ actor }) => actor.age === 1));
});

test("a pooled Mine holds its fuse during fire and releases ordered blasts after four unheld ticks", () => {
  const game = new Game(campaign);
  game.start(2);
  game.camera = game.endCamera = 1000;
  game.shipTouchesTerrain = () => false;
  const event = [1000, 1, 0, 0, 160, 1013, 0];
  game.assets = { ...game.assets, events: [], background: [event, event] };
  game.invincible = 999;
  game.credits = 100000;
  game.openShop(2);
  assert.ok(buy(game, 9).ok);
  game.continueRun();
  game.inventory[0] = null;
  game.player.y = 96;
  game.posture = 0;
  for (let tick = 0; tick < 14; tick++) game.update({ fire: true });

  const records = game.actorLists.get(ActorList.transient);
  const charge = records.find(({ type }) => type === 0x38);
  assert.equal(charge.actor.fuse, -4);
  game.update();
  game.update({ fire: true });
  assert.equal(charge.actor.fuse, -3);
  for (let tick = 0; tick < 2; tick++) game.update();
  assert.equal(game.ground.length, 2);
  game.update();

  assert.equal(game.score, 200);
  assert.equal(game.run.mineChargeCount, 0);
  assert.ok(charge.actor.dead && records.includes(charge));
  const effects = records.filter(({ type }) => type === 0x0c);
  assert.equal(effects.length, 6);
  assert.ok(effects.every(({ actor }) => actor.age === 0));
  game.update();
  assert.ok(!records.includes(charge));
});

test("the pooled Flamer retires the damaging plume on contact but leaves the visual plume in flight", () => {
  const game = new Game(campaign);
  game.start(2);
  game.camera = game.endCamera = 1000;
  game.shipTouchesTerrain = () => false;
  const event = [1000, 1, 0, 0, 160, 1120, 0];
  game.assets = { ...game.assets, events: [], background: [event, event] };
  game.invincible = 999;
  game.posture = 0;
  game.credits = 100000;
  game.openShop(2);
  assert.ok(buy(game, 20).ok);
  const starter = game.actorLists.get(ActorList.mounts).find(({ actor }) => actor.weapon.id === 1);
  game.continueRun();
  game.dispatchCameraEvents();
  game.update({ fire: true });

  const records = game.actorLists.get(ActorList.transient);
  const [visual, damaging] = records.filter(({ type }) => type === 0xb4);
  assert.notEqual(damaging.address, starter.address);
  assert.equal(game.run.actorPool.free.at(-1), starter.address);
  assert.equal(visual.actor.damaging, false);
  assert.equal(damaging.actor.damaging, true);
  game.update();
  game.update();
  assert.deepEqual(game.ground.map((gun) => gun.health), [4, 3]);
  assert.ok(records.includes(damaging) && damaging.actor.dead);
  assert.ok(game.shots.includes(visual.actor));
  assert.equal(game.run.actorPool.subpixels.get(damaging.address)[0], damaging.actor.xFixed & 65535);

  game.update();
  assert.ok(!records.includes(damaging));
  game.update({ fire: true });
  assert.ok(records.some(({ address, actor }) => address === damaging.address && actor.damaging));
  game.killPlayer();
  game.update();
  assert.ok(records.every(({ type, actor }) => type !== 0xb4 || actor.dead));
  assert.ok(!game.shots.some((shot) => shot.flame));
});

test("pooled Homing Missiles lock by slot, then burst after their last target leaves the list", () => {
  const game = new Game(campaign);
  game.start(2);
  game.camera = game.endCamera = 1000;
  game.shipTouchesTerrain = () => false;
  const event = [1000, 1, 0, 0, 160, 1086, 0];
  game.assets = { ...game.assets, events: [], background: [event, event] };
  game.player.y = 150;
  game.invincible = 999;
  game.posture = 0;
  game.credits = 100000;
  game.openShop(2);
  assert.ok(buy(game, 23).ok);
  game.continueRun();
  game.inventory[0] = null;
  game.update({ fire: true });

  const records = game.actorLists.get(ActorList.transient);
  const rockets = records.filter(({ type }) => type === 0x48);
  assert.deepEqual(rockets.map(({ actor }) => actor.direction), [1, 3, 5, 7]);
  for (let tick = 2; tick <= 14; tick++) game.update();
  assert.deepEqual(new Set(rockets.map(({ actor }) => actor.targetAddress)),
    new Set(game.ground.map((gun) => gun.actorAddress)));
  assert.ok(rockets.every(({ actor }) => actor.phase < 0));

  for (const gun of game.ground) gun.dead = true;
  game.update();
  const blasts = records.filter(({ type }) => type === 0x0c);
  assert.equal(blasts.length, 4);
  assert.ok(blasts.every(({ actor }) => actor.age === 0));
  assert.ok(rockets.every((record) => record.actor.dead && records.includes(record)));
  game.update();
  assert.ok(rockets.every((record) => !records.includes(record)));
});

test("a Homing Missile keeps its lock on a patrol after it moves to the transient list", () => {
  const game = new Game(campaign);
  game.start(2);
  game.eventStreamsClosed = true;
  game.camera = game.endCamera = 1000;
  game.shipTouchesTerrain = () => false;
  game.player.x = 300;
  game.player.y = 100;
  game.seed = 0x5845;
  const event = [1000, 3, 3, 0, 72, 1108, 0];
  const patrol = new GroundPatrol(event, game.assets.groundLogic.get(3), game.camera, (frame) => game.sprite(frame));
  game.addStageTwoBossActor(patrol, 0x104);
  game.ground.push(patrol);
  const rocket = { x: 110, y: 60, homing: true, direction: 7, launch: true, phase: 0, age: 0,
    targetAddress: patrol.actorAddress };
  game.addPlayerRound(rocket, 0x48);

  game.update();

  assert.ok(patrol.firing);
  assert.ok(game.actorLists.get(ActorList.transient).some(({ actor }) => actor === patrol));
  assert.equal(rocket.targetAddress, patrol.actorAddress);
  assert.equal(rocket.direction, 6);
  assert.equal(rocket.x, 105);
  assert.ok(!rocket.dead);
  assert.equal(game.effects.length, 0);
  assert.equal(game.seed, 0xef02, "only the patrol rolls the RNG");
});

test("a Homing Missile follows a recycled crawler slot but rejects a boss egg in that slot", () => {
  for (const hatch of [false, true]) {
    const game = new Game(campaign);
    game.start(2);
    game.camera = 100;
    const event = [100, 3, 3, 0, 72, 208, 0];
    const patrol = new GroundPatrol(event, game.assets.groundLogic.get(3), game.camera, (frame) => game.sprite(frame));
    const record = game.addStageTwoBossActor(patrol, 0x104);
    const rocket = { x: 110, y: 60, homing: true, direction: 7, launch: true, phase: 0, age: 0,
      targetAddress: record.address };
    game.addPlayerRound(rocket, 0x48);
    game.run.actorPool.release(game.actorLists, ActorList.main, record);
    const allocate = (actor, type) => game.addStageTwoBossActor(actor, type);
    const replacement = hatch
      ? game.boss.spawnCrawler({ motion: { x: 160, y: 124 }, direction: 2 }, allocate)
      : game.boss.spawnEgg(game.camera, () => game.randomWord(), allocate);
    assert.equal(replacement.actorAddress, rocket.targetAddress);

    game.updatePlayerRound(rocket, 1);

    if (hatch) {
      assert.equal(game.seed, 0x5845);
      assert.deepEqual([rocket.x, rocket.y, rocket.direction, rocket.phase], [105, 60, 6, -3]);
      assert.equal(game.effects.length, 0);
    } else {
      assert.equal(game.seed, 0x55c3);
      assert.ok(rocket.dead);
      assert.deepEqual(game.effects.map(({ x, y }) => [x, y]), [[110, 60]]);
    }
  }
});

test("a stage-two corpse inherits the recycled slot's bounds for existing missile locks only", () => {
  const game = new Game(campaign);
  game.start(2);
  game.camera = 100;
  const patrol = new GroundPatrol([100, 3, 3, 0, 72, 208, 0], game.assets.groundLogic.get(3), game.camera,
    (frame) => game.sprite(frame));
  const record = game.addStageTwoBossActor(patrol, 0x104);
  const rocket = (targetAddress) => {
    const shot = { x: 110, y: 60, homing: true, direction: 7, launch: true, phase: 0, age: 0, targetAddress };
    game.addPlayerRound(shot, 0x48);
    return shot;
  };
  const locked = rocket(record.address);
  const seeker = rocket();
  game.run.actorPool.release(game.actorLists, ActorList.main, record);
  game.miniboss.destroy({ wave: true, part: 0, side: 0, type: 0x114, motion: { x: 280, y: 100 } }, game);
  const [corpse] = game.miniboss.corpses;
  assert.equal(corpse.actorAddress, record.address);
  game.miniboss.updateCorpse(corpse);
  const seed = game.seed;

  game.updatePlayerRound(locked, 1);
  assert.equal(game.seed, seed);
  assert.equal(locked.targetAddress, record.address);
  assert.deepEqual([locked.x, locked.y, locked.direction, locked.phase], [105, 60, 6, -3]);
  game.updatePlayerRound(seeker, 1);
  assert.ok(seeker.dead);
  assert.deepEqual(game.effects.map(({ x, y }) => [x, y]), [[110, 60]]);
});

test("a full-pool miniboss wave death frees a corpse that reused its own slot without moving it", () => {
  const game = new Game(campaign);
  game.start(2);
  const wave = { wave: true, part: 0, side: 0, type: 0x114, motion: { x: 280, y: 100 } };
  game.addStageTwoBossActor(wave, wave.type);
  const pool = game.run.actorPool;
  const reserved = new Map();
  while (pool.free.length) pool.allocate(reserved, ActorList.hud, 0xc4);

  game.miniboss.destroy(wave, game);
  const [record] = game.actorLists.get(ActorList.transient);
  assert.equal(record.address, wave.actorAddress);
  assert.equal(record.actor.dead, true);
  assert.equal(game.seed, 0xef02, "the corpse constructor still consumes its heading RNG");
  game.updateTransientActor(record);
  assert.deepEqual(pool.free, [record.address]);
  assert.deepEqual([record.actor.x, record.actor.y, record.actor.age], [280, 100, 0]);
});

for (const successorBlast of [true, false]) {
  const victim = successorBlast ? "its successor's" : "its own";
  test(`a targetless Homing Missile bursts into ${victim} slot when the pool is full`, () => {
    const game = new Game(campaign);
    game.start(2);
    game.eventStreamsClosed = true;
    game.camera = game.endCamera = 1000;
    game.shipTouchesTerrain = () => false;
    const pool = game.run.actorPool;
    const round = { x: 30, y: 40, dx: 2, dy: 0, fixed: true, frame: game.assets.logic.foregroundShot.frame };
    game.addPooledHostileRound(round);
    if (successorBlast) game.explode(40, 50);
    const oldBlast = game.effects[0];
    const rocket = { x: 80, y: 60, homing: true, direction: 7, launch: true, phase: 0, age: 0 };
    game.addPlayerRound(rocket, 0x48);
    const reserved = new Map();
    while (pool.free.length) pool.allocate(reserved, ActorList.hud, 0xc4);

    game.update();

    const records = game.actorLists.get(ActorList.transient);
    assert.deepEqual(records.map(({ address, type }) => [address, type]),
      [[(oldBlast ?? rocket).actorAddress, 0x0c], [round.actorAddress, 0x14]]);
    assert.equal(round.x, 32);
    if (successorBlast) {
      assert.equal(records[0].actor.age, 1);
      assert.deepEqual(game.effects, [records[0].actor]);
      assert.deepEqual(pool.free, [rocket.actorAddress]);
    } else {
      assert.equal(records[0].actor.dead, true);
      assert.deepEqual(game.effects, []);
      assert.deepEqual(pool.free, []);
      game.update();
      assert.deepEqual(records.map(({ actor }) => actor), [round]);
      assert.deepEqual(pool.free, [rocket.actorAddress]);
      assert.equal(round.x, 34);
    }
  });
}

test("the stage-two Electro Ball hits the newest wall gun before the starter allocates its shot", () => {
  const game = new Game(campaign);
  game.start(2);
  game.camera = game.endCamera = 1000;
  game.shipTouchesTerrain = () => false;
  const event = [1000, 1, 0, 0, 160, 1118, 0];
  game.assets = { ...game.assets, events: [], background: [event, event] };
  game.player.y = 90;
  game.credits = 100000;
  game.openShop(2);
  assert.ok(buy(game, 11).ok);
  game.continueRun();
  game.playerTrail = Array.from({ length: 3 }, () => ({ x: 160, y: 90 }));
  game.invincible = 999;
  game.posture = 0;
  game.dispatchCameraEvents();
  game.update({ fire: true });

  const guns = game.actorLists.get(ActorList.main).filter(({ type }) => type === 0xec);
  assert.deepEqual(guns.map(({ actor }) => [Boolean(actor.dead), actor.health]), [[true, 0], [false, 4]]);
  const transient = game.actorLists.get(ActorList.transient);
  assert.deepEqual(transient.map(({ type }) => type), [0x10, 0x0c]);
  assert.equal(transient[1].actor.age, 1);
  assert.equal(game.score, 100);

  game.update();
  assert.equal(game.electroBall.phase, "returning");
  assert.equal(game.score, 100);
});

test("maneuver jets switch pairs with steering, advance while hidden, and cut out for a dive", () => {
  const game = new Game(campaign);
  game.start(2);
  game.eventStreamsClosed = true;
  game.shipTouchesTerrain = () => false;
  game.player.y = 90;
  game.resetDive();
  const renderer = Object.assign(Object.create(Renderer.prototype), { assets: game.assets });
  const draws = [];
  renderer.drawSprite = (sprite, x, y) => draws.push([sprite, x, y]);
  function drawWith(input) {
    draws.length = 0;
    game.update(input);
    renderer.drawManeuverJets(game);
    return draws;
  }
  const [frontLeft, frontRight, rearLeft, rearRight] = game.assets.logic.maneuverJets;
  assert.deepEqual(drawWith({ target: { x: 180, y: 80 } }), [
    [game.sprite(rearLeft.frames[1]), game.player.x + 1, game.player.y],
    [game.sprite(rearRight.frames[1]), game.player.x - 1, game.player.y],
  ]);
  assert.deepEqual(drawWith({}), []);
  assert.deepEqual(drawWith({ down: true }), [
    [game.sprite(frontLeft.frames[1]), game.player.x + 1, game.player.y],
    [game.sprite(frontRight.frames[1]), game.player.x - 1, game.player.y],
  ]);
  assert.equal(drawWith({ up: true, dive: true }).length, 2);
  assert.deepEqual(drawWith({ up: true, down: true }), []);
});

test("the stage-two renderer paints the ship and ordered mounts before the arena actors", () => {
  const game = new Game(campaign);
  game.start(2);
  game.assets = { ...game.assets, events: [], background: [] };
  game.credits = 100000;
  game.openShop(2);
  assert.ok(buy(game, 15).ok);
  assert.ok(buy(game, 18).ok);
  game.continueRun();
  game.resetDive();
  game.camera = 100;
  const boss = game.boss;
  boss.motion.y = boss.worldY - game.camera;
  const egg = boss.spawnEgg(game.camera, () => 0, (actor, type) => game.addStageTwoBossActor(actor, type));
  const crawler = boss.spawnCrawler(egg, (actor, type) => game.addStageTwoBossActor(actor, type));
  const cannon = weaponAttachment(game, 1, game.inventory[1]);
  const laser = weaponAttachment(game, 2, game.inventory[2]);
  const draws = [];
  const renderer = Object.assign(Object.create(Renderer.prototype), {
    assets: game.assets, map: game.map, mapRevision: game.mapRevision, world: {},
    context: Object.fromEntries(["fillRect", "drawImage", "save", "beginPath", "rect",
      "clip", "restore", "fillText"].map((name) => [name, () => {}])),
    drawOverlay({ tiles }) { if (tiles === boss.tiles) draws.push(boss); },
    drawSprite(sprite) { draws.push(sprite); },
  });
  renderer.draw(game);
  assert.deepEqual(draws, [
    game.shipSprite(), game.sprite(laser.frames[0]), game.sprite(cannon.frames[0]),
    game.sprite(crawler.frame), game.sprite(egg.frame), boss, game.sprite(cannon.overlay[0]),
  ]);
});

test("the stage-two renderer paints live transient records head to tail after the ship", () => {
  const game = new Game(campaign);
  game.start(2);
  game.assets = { ...game.assets, events: [], background: [] };
  game.credits = 100000;
  game.openShop(2);
  assert.ok(buy(game, 15).ok);
  game.continueRun();
  game.resetDive();
  const x = 160, y = 110;
  game.addPickup({ x, y, age: 0, value: 100, state: 0, counted: true });
  game.addPlayerRound({ x, y, originalSprite: game.assets.playerShots.forward[0], dx: 0 });
  game.explode(x, y);
  game.addPooledHostileRound({ x, y, frame: game.assets.logic.foregroundShot.frame });
  const records = game.actorLists.get(ActorList.transient);
  assert.deepEqual(records.map(({ type }) => type), [0x14, 0x0c, 0x10, 0x40, 0x18]);

  const renderer = Object.create(Renderer.prototype);
  const draws = [];
  Object.assign(renderer, {
    assets: game.assets, map: game.map, mapRevision: game.mapRevision, world: {},
    context: Object.fromEntries(["fillRect", "drawImage", "save", "beginPath", "rect",
      "clip", "restore", "fillText"].map((name) => [name, () => {}])),
    drawSprite(sprite) { draws.push(sprite); },
  });
  const attachment = weaponAttachment(game, 1, game.inventory[1]);
  const layer = [
    game.sprite(game.bullets[0].frame), game.sprite(game.effects[0].frames[0]), game.shots[0].originalSprite,
    game.sprite(attachment.overlay[0]), game.sprite(game.pickupFrame(game.pickups[0])),
  ];
  renderer.draw(game);
  assert.ok(draws.indexOf(game.shipSprite()) < draws.indexOf(layer[0]));
  assert.deepEqual(draws.filter((sprite) => layer.includes(sprite)), layer);

  records[1].actor.dead = true;
  draws.length = 0;
  renderer.draw(game);
  assert.deepEqual(draws.filter((sprite) => layer.includes(sprite)), layer.filter((_, i) => i !== 1));
});

test("Drone rounds fill the first free entries, stop at capacity, and use point damage even during death", () => {
  const game = new Game(campaign);
  game.start(2);
  game.camera = game.endCamera = 1000;
  game.shipTouchesTerrain = () => false;
  const event = [1000, 1, 0, 0, 160, 1120, 0];
  game.assets = { ...game.assets, events: [], background: [event, event] };
  game.update();

  const volley = game.assets.logic.droneVolleys[2];
  for (let i = 0; i < 6; i++) game.addDroneVolley(220, 90, volley);
  const [first, second] = game.droneShots;
  game.droneShots[1] = null;
  const free = game.run.actorPool.free.length;
  game.addDroneVolley(220, 90, volley);
  assert.equal(game.droneShots[0], first);
  assert.notEqual(game.droneShots[1], second);
  assert.equal(game.droneShots.filter(Boolean).length, 80);
  assert.equal(game.run.actorPool.free.length, free);

  game.droneShots.fill(null);
  game.addDroneVolley(0, 0, [[143, 120, 0, 0], [152, 111, 8, 8], [152, 111, 8, 8]]);
  game.killPlayer();
  game.update();
  assert.deepEqual(game.ground.map((gun) => gun.health), [4], "the second hit reaches the still-linked marked target");
  assert.equal(game.score, 100, "one VGA Drone hit defeats a full-health gun");
  assert.deepEqual(game.droneShots.filter(Boolean).map(({ x, y }) => [x, y]), [[143, 120]], "draw size does not expand the hit point");
  game.restoreCheckpoint();
  assert.ok(!game.droneShots.some(Boolean));
});

test("invulnerable drifting eggs hatch into damageable crawlers with their original small death and score", () => {
  const game = finalBossScene(), boss = game.boss;
  const egg = boss.spawnEgg(100, () => 0);
  grantReward(game, 18);
  assert.equal(egg.dead, false);
  for (let tick = 0; tick < 200 && !egg.dead; tick++) boss.updateEgg(egg, 100, 0, () => game.randomWord());
  assert.equal(egg.dead, true);
  const crawler = boss.children.find((actor) => actor.kind === "crawler");
  assert.equal(crawler.health, 2);
  grantReward(game, 18);
  assert.equal(crawler.dead, true);
  assert.equal(game.score, 30);
  assert.equal(game.effects.length, 1);
  assert.ok(!game.effects[0].large);
  assert.equal(boss.health, 75);
});

test("an egg hatching into its own full-pool slot marks the replacement crawler for release", () => {
  const game = new Game(campaign);
  game.start(2);
  game.eventStreamsClosed = true;
  game.camera = game.endCamera = 1000;
  game.shipTouchesTerrain = () => false;
  const boss = game.boss;
  const egg = boss.spawnEgg(game.camera, () => 2, (actor, type) => game.addStageTwoBossActor(actor, type));
  egg.motion = { x: 164, y: 90 };
  egg.state = 2;
  egg.frames = boss.definition.egg.hatch;
  egg.frameIndex = 4;
  egg.frame = egg.frames[egg.frameIndex];
  egg.frameTicks = 1;
  const pool = game.run.actorPool, reserved = new Map();
  while (pool.free.length) pool.allocate(reserved, ActorList.hud, 0xc4);

  game.update();

  const main = game.actorLists.get(ActorList.main);
  const replacement = main.find(({ address }) => address === egg.actorAddress);
  assert.equal(replacement.actor.kind, "crawler");
  assert.equal(replacement.actor.dead, true);
  assert.equal(boss.children.length, 0);
  assert.equal(pool.free.length, 0);

  game.update();

  assert.ok(!main.includes(replacement));
  assert.deepEqual(pool.free, [egg.actorAddress]);
});

test("arena walls absorb shots, survive Z and are repaired by a passing crawler", () => {
  const game = finalBossScene(), boss = game.boss;
  game.camera = 100;
  const tile = boss.terrain.flat().find((tile) => tile.x === 112 && tile.worldY === 112);
  game.shots.push({ x: 120, y: 20, dx: 0, dy: 0, point: true, damage: 1 });
  game.update();
  assert.equal(tile.intact, false);
  assert.equal(game.map[tile.cell], 0);
  assert.equal(game.shots.length, 0);
  assert.equal(game.score, 0);
  const map = game.map.slice();
  grantReward(game, 18);
  assert.deepEqual(game.map, map);
  const crawler = boss.spawnCrawler({ motion: { x: 120, y: 20 }, direction: 0 });
  boss.updateCrawler(crawler, game.camera, { delta: 0 }, () => game.randomWord(), game.player, 2,
    (cell, value) => game.patchGround({ cell }, [value]));
  assert.equal(tile.intact, true);
  assert.equal(game.map[tile.cell], tile.tile);
});

test("arena wall contact breaks one tile after energy loss, but fatal contact leaves it intact", () => {
  for (const fatal of [false, true]) {
    const game = finalBossScene();
    game.camera = 100;
    game.player.x = 120;
    game.player.y = 32;
    if (fatal) game.player.health = 8;
    game.update();
    assert.equal(game.boss.terrain.flat().filter((tile) => !tile.intact).length, fatal ? 0 : 1);
    assert.equal(game.player.health, fatal ? 0 : 31);
    assert.equal(game.status, fatal ? "dying" : "playing");
  }
});

test("final-boss death clears main actors, preserves bullets and waits for twenty rewards before stage three", () => {
  const game = finalBossScene(), boss = game.boss;
  game.camera = 73;
  boss.spawnEgg(game.camera, () => 0);
  const bullet = { x: 20, y: 20, dx: 0, dy: 0 };
  game.bullets.push(bullet);
  game.destroy(boss);
  assert.equal(boss.children.length, 0);
  assert.ok(game.bullets.includes(bullet));
  assert.equal(game.countedCredits, 20);
  assert.equal(game.effects.length, 30);
  assert.ok(game.effects.every((effect) => effect.y >= boss.worldY - game.camera
    && effect.y < boss.worldY - game.camera + 112));
  assert.equal(game.status, "playing");
  for (let tick = 0; tick < 400 && game.status === "playing"; tick++) {
    game.invincible = 999;
    game.update();
  }
  assert.equal(game.countedCredits, 0);
  assert.equal(game.status, "shop");
  assert.equal(game.shopStage, 3);
  assert.equal(game.continueRun(), true);
  assert.equal(game.stage, 3);
  assert.equal(game.camera, 4608);
});

test("stage-two boss explosions follow its world position and camera instead of map contents", () => {
  for (const [worldY, camera] of [[96, 0], [184, 73], [96, 140]]) {
    const game = finalBossScene(), boss = game.boss;
    game.camera = camera;
    boss.worldY = worldY;
    game.map[0x11ce / 2] = 0xffff;
    game.destroy(boss);
    assert.equal(game.effects.length, 30);
    assert.ok(game.effects.every((effect) => effect.x >= 80 && effect.x < 240
      && effect.y >= worldY - camera && effect.y < worldY - camera + 112));
  }
});

test("stage-two miniboss locks the camera and cannot be bypassed by provisional wave completion", () => {
  const game = new Game(campaign);
  game.start(2);
  game.assets = { ...game.assets, events: [], background: [] };
  game.shipTouchesTerrain = () => false;
  game.camera = 2528;
  game.control.ceiling = 2544;
  game.invincible = 999;
  game.update();
  assert.equal(game.control.delta, 0);
  assert.equal(game.control.scroll, 1);
  assert.equal(game.miniboss.waves.find((actor) => actor.side === 0 && actor.part === 2).motion.y,
    2952 - 1 - 2528, "hatch offset uses requested scroll even when the camera is clamped");
  for (let tick = 0; tick < 620; tick++) {
    game.invincible = 999;
    game.update();
  }
  assert.equal(game.camera, 2528);
  assert.equal(game.status, "playing");
  assert.equal(game.endWait, 0);
  assert.equal(game.miniboss.remaining, 3);
  assert.equal(game.miniboss.busy, 3);
});

test("miniboss eyes use player-side eligibility while opening, hold open and reject busy-state hits", () => {
  const game = new Game(campaign);
  game.start(2);
  game.assets = { ...game.assets, events: [], background: [] };
  game.shipTouchesTerrain = () => false;
  const boss = game.miniboss;
  const [centre, left, right] = boss.eyes;
  game.camera = 2601;
  game.player.x = 64;
  boss.presence.fill(true);
  game.shots.push({ x: 72, y: 32, dx: 0, dy: 0, point: true, damage: 1 });
  game.update();
  assert.equal(left.phase, 0);
  assert.equal(left.health, 11, "opening eyes are not artificially invulnerable");
  assert.equal(right.box.x, 1000);
  assert.equal(centre.box.x, 1000);
  left.phase = 4;
  boss.presence.fill(true);
  game.update();
  assert.equal(left.phase, 4);
  game.player.x = 160;
  boss.presence.fill(true);
  game.update();
  assert.equal(left.box.x, 1000);
  assert.equal(right.box.x, 224);
  boss.remaining = 1;
  left.dead = right.dead = true;
  boss.busy = 3;
  game.camera = game.control.ceiling = 2881;
  game.shots.push({ x: 152, y: 72, dx: 0, dy: 0, point: true, damage: 127 });
  boss.presence.fill(true);
  game.update();
  assert.equal(centre.box.x, 144, "centre bounds remain active while both heads are busy");
  assert.equal(centre.health, 12, "the hit callback independently guards that cached box");
  game.blastBomb({ x: 152, y: 72, bomb: true, damage: 8 });
  assert.equal(centre.health, 12);
});

test("Z kills miniboss wave heads and segments with their custom corpses but spares all eyes", () => {
  const game = new Game(campaign);
  game.start(2);
  const boss = game.miniboss;
  boss.spawn(game, 0, 2800, 1);
  boss.spawn(game, 1, 2800, 1);
  assert.equal(boss.waves.length, 24);
  const heads = boss.waves.filter((actor) => !actor.part);
  game.destroy(heads[0]);
  assert.equal(boss.busy, 1);
  assert.equal(boss.corpses.length, 1);
  grantReward(game, 18);
  assert.equal(boss.busy, 0);
  assert.ok(boss.waves.every((actor) => actor.dead));
  assert.equal(boss.corpses.length, 24);
  assert.equal(game.score, 0, "custom fatal callbacks do not award the actor's unused score field");
  assert.ok(boss.eyes.every((eye) => eye.health === 12 && !eye.dead));
  grantReward(game, 18);
  assert.equal(boss.corpses.length, 24);
  assert.ok(boss.corpses.every((corpse) => game.sprite(corpse.frame)));
});

test("miniboss waves step on birth and corpses keep their own slots until the next pass", () => {
  const game = new Game(campaign);
  game.start(2);
  game.eventStreamsClosed = true;
  game.shipTouchesTerrain = () => false;
  game.camera = game.endCamera = 2672;
  game.update();
  const { miniboss, actorLists, run: { actorPool } } = game;
  const main = actorLists.get(ActorList.main);
  const [waveRecord] = main;
  const wave = waveRecord.actor;
  assert.equal(waveRecord.type, 0x11c);
  assert.equal(wave.motion.remaining, -110 + miniboss.definition.waveSpeed);
  assert.deepEqual(miniboss.presence, [true, true]);

  wave.motion.xFixed = 160 * 65536;
  wave.motion.yFixed = 90 * 65536;
  const nextFree = actorPool.free.at(-1);
  game.destroy(wave);
  const transient = actorLists.get(ActorList.transient);
  const [corpseRecord] = transient;
  const corpse = corpseRecord.actor;
  assert.deepEqual([corpseRecord.address, corpseRecord.type], [nextFree, waveRecord.type]);
  assert.ok(wave.dead && main.includes(waveRecord));
  assert.equal(corpse.age, 0);
  game.update();
  assert.equal(corpse.age, 1);
  assert.equal(actorPool.free.at(-1), waveRecord.address);

  game.restoreCheckpoint();
  assert.deepEqual(actorLists.get(ActorList.main).map(({ type }) => type), [0x54, 0x54, 0x54, 0x50]);
  assert.equal(actorLists.get(ActorList.transient).length, 0);
  assert.deepEqual(miniboss.presence, [false, false]);
  assert.equal(miniboss.waves.length + miniboss.corpses.length, 0);
});

test("miniboss segment contact costs energy and runs its fatal callback unless diving or killed", () => {
  for (const protection of ["none", "shield", "dive", "fatal"]) {
    const game = new Game(campaign);
    game.start(2);
    game.assets = { ...game.assets, events: [], background: [] };
    game.shipTouchesTerrain = () => false;
    const boss = game.miniboss;
    boss.spawn(game, 0, 2800, 1);
    const head = boss.waves.find((actor) => !actor.part);
    for (const actor of boss.waves) if (actor !== head) actor.dead = true;
    boss.presence.fill(true);
    head.bounds = () => ({ x: 154, y: 153, w: 12, h: 17 });
    if (protection === "shield") game.player.protection = true;
    if (protection === "dive") game.divePhase = 4;
    if (protection === "fatal") game.player.health = 8;
    game.update();
    const dead = protection === "none" || protection === "shield";
    assert.equal(head.dead, dead, protection);
    assert.equal(boss.busy, dead ? 0 : 1);
    assert.equal(boss.corpses.length, dead ? 1 : 0);
    assert.equal(game.player.health, { fatal: 0, none: 31, shield: 35, dive: 39 }[protection]);
    assert.equal(game.status, protection === "fatal" ? "dying" : "playing");
    assert.equal(game.score, 0);
  }
});

test("three-eye destruction forces backtracking, releases the floor and waits for rewards before a same-stage shop", () => {
  const game = new Game(campaign);
  game.start(2);
  game.assets = { ...game.assets, events: [], background: [] };
  const boss = game.miniboss;
  game.destroy(boss.eyes[1]);
  game.destroy(boss.eyes[2]);
  assert.equal(boss.remaining, 1);
  assert.equal(game.control.scrollDirection, -1);
  game.camera = 2600;
  game.control.ceiling = 2616;
  boss.presence.fill(true);
  game.update();
  assert.equal(game.camera, 2601);
  assert.equal(game.control.ceiling, 2880);
  assert.equal(boss.eyes[0].acceptsHit(), false);
  boss.spawn(game, 0);
  const wave = boss.waves[0];
  game.destroy(boss.eyes[0]);
  assert.equal(game.control.scrollDirection, 1);
  assert.equal(game.endCamera, 0);
  assert.ok(wave.dead);
  assert.equal(boss.corpses.length, 12, "last-eye cleanup calls the wave parts' death handlers");
  assert.ok(game.actorLists.get(ActorList.main).some(({ actor }) => actor === game.boss && !actor.dead));
  assert.ok(game.map.slice(3240, 3696).every((tile) => tile === 0));
  assert.equal(game.effects.filter((effect) => effect.large).length, 40);
  assert.equal(game.countedCredits, 10);
  assert.deepEqual(game.pickups.map((pickup) => pickup.value), [50, 100, 50, 100, 50, 100, 50, 100, 50, 100]);
  assert.equal(game.status, "playing");
  game.camera = game.control.ceiling = 2880;
  game.update();
  assert.equal(game.camera, 2544);
  const { map } = game;
  for (let tick = 0; tick < 400 && game.status === "playing"; tick++) {
    game.invincible = 999;
    game.update();
  }
  assert.equal(game.countedCredits, 0);
  assert.equal(game.status, "shop");
  assert.equal(game.shopStage, 2);
  assert.ok(game.credits >= game.assets.logic.shopCredits.mid);
  const { foregroundEventLimit, backgroundEventLimit } = game;
  assert.equal(game.continueRun(), true);
  assert.equal(game.map, map);
  assert.equal(game.foregroundEventLimit, foregroundEventLimit);
  assert.equal(game.backgroundEventLimit, backgroundEventLimit);
  for (let tick = 0; tick < 100; tick++) { game.invincible = 999; game.update(); }
  assert.equal(game.status, "playing");
  assert.equal(boss.shopPending, false);
});

test("forced reverse uses forward-only acceleration at the upper edge and never inverts bottom-edge input", () => {
  const player = { x: 160, y: 174, speed: 0 };
  const control = { camera: 2600, ceiling: 2880, bank: 0, reverseTicks: 0, scrollDirection: -1 };
  let result = movePlayer(player, {}, control);
  assert.equal(result.scroll, -1);
  scrollMap(control, result.scroll, result.down, 2528);
  assert.equal(control.camera, 2601);
  assert.equal(control.reverseTicks, 0);
  player.y = 16;
  for (let tick = 0; tick < 35; tick++) {
    result = movePlayer(player, { up: true }, control);
    scrollMap(control, result.scroll, result.down, 2528);
  }
  assert.equal(control.delta, 2);
  player.y = 176;
  result = movePlayer(player, { down: true }, control);
  assert.equal(result.scroll, -1);
  scrollMap(control, result.scroll, result.down, 2528);
  assert.equal(control.reverseTicks, 0);
});

test("stage-two map hatches release the original eight-way burst or two pursuing creatures", () => {
  for (const type of [2, 4, 5]) {
    const game = new Game(campaign);
    game.start(2);
    game.miniboss = undefined;
    game.endCamera = 0xe0;
    const event = game.assets.background.find((entry) => entry[1] === type);
    game.assets = { ...game.assets, events: [], background: [event] };
    game.shipTouchesTerrain = () => false;
    game.camera = event[0] + 1;
    const seen = new Set();
    const advance = (input) => {
      game.update(input);
      for (const creature of game.ground) {
        assert.ok(game.sprite(creature.frame));
        seen.add(creature);
      }
    };
    for (let tick = 0; tick < 260; tick++) {
      game.invincible = 999;
      advance();
    }
    assert.equal(seen.size, type === 2 ? 8 : 2);
    assert.equal(game.scenery.length, 0);
    assert.ok(game.backgroundEventLimit <= event[0]);
    assert.ok(game.mapRevision > 0);
    const emitted = seen.size;
    for (let tick = 0; tick < 16; tick++) {
      game.player.y = 176;
      advance({ down: true });
    }
    assert.equal(seen.size, emitted, "reversing cannot duplicate a spent hatch");
  }
});

test("Z kills released hatchlings but leaves the map-only machinery to complete its second opening", () => {
  const game = new Game(campaign);
  game.start(2);
  game.miniboss = undefined;
  game.endCamera = 0xe0;
  const event = game.assets.background.find((entry) => entry[1] === 5);
  game.assets = { ...game.assets, events: [], background: [event] };
  game.shipTouchesTerrain = () => false;
  game.camera = event[0] + 1;
  game.invincible = 999;
  for (let tick = 0; tick < 180 && !game.ground.length; tick++) game.update();
  assert.equal(game.ground.length, 1);
  const [first] = game.ground;
  assert.equal(game.scenery.length, 1);
  const hatch = game.scenery[0];
  const map = game.map.slice();
  grantReward(game, 18);
  assert.equal(game.score, 300);
  const [explosion] = game.effects;
  assert.ok(explosion.large);
  assert.ok(game.ground[0].dead);
  assert.ok(!hatch.dead);
  assert.deepEqual(game.map, map);
  for (let tick = 0; tick < 80 && !game.ground.some((actor) => actor !== first); tick++) {
    game.invincible = 999;
    game.update();
  }
  const second = game.ground.find((actor) => actor !== first);
  assert.ok(second && !second.dead);
  assert.equal(first.actorAddress, 0x9f4c + 10 * 0x4c);
  assert.equal(second.actorAddress, explosion.actorAddress, "the next hatchling reuses the latest freed slot");
  assert.equal(second.actorPhase, second.actorAddress & 15);
});

test("alternating seats keep their own actor lists and reuse outgoing stage-two slots", () => {
  const game = new Game(campaign);
  game.start(2, 2);
  const pod = game.assets.events.find((event) => event[1] === 0);
  game.continueRun();
  game.spawn(pod);
  const [first] = game.enemies;
  assert.equal(first.actorAddress, 0x9f4c + 18 * 0x4c);
  const arena = game.actorLists.get(ActorList.main).slice(1);
  const outgoingMount = game.actorLists.get(ActorList.mounts)[0].address;
  game.resumeAfterDeath();
  const partner = game.activeGame;
  assert.equal(partner.playerNumber, 2);
  partner.continueRun();
  partner.spawn(pod);
  assert.equal(partner.enemies[0].actorAddress, outgoingMount,
    "checkpoint cleanup frees the outgoing mount after its pod");
  partner.resumeAfterDeath();
  assert.equal(game.activeGame, game);
  assert.equal(game.enemies.length, 0);
  assert.deepEqual(game.actorLists.get(ActorList.main), arena, "a handoff preserves each seat's arena records");
  game.spawn(pod);
  assert.equal(game.enemies[0].actorAddress, outgoingMount);
  game.start(2);
  game.spawn(pod);
  assert.equal(game.enemies[0].actorAddress, 0x9f4c + 9 * 0x4c);
});

test("pool exhaustion prefers marked effects to live bullets and protects inactive slots", () => {
  const pool = new ActorPool();
  const otherSeat = new Map(), seat = new Map();
  for (let i = 0; i < 157; i++) pool.allocate(otherSeat, ActorList.main, 0xd0, {});
  const effect = {}, bullet = {};
  pool.allocate(seat, ActorList.transient, 0x0c, effect);
  pool.allocate(seat, ActorList.transient, 0x14, bullet);
  const record = pool.allocate(seat, ActorList.hud, 0xc4);
  assert.equal(record.address, effect.actorAddress);
  assert.equal(effect.dead, true);
  assert.ok(!bullet.dead);
  assert.equal(pool.allocate(seat, ActorList.hud, 0xc4).address, bullet.actorAddress);
  assert.equal(pool.allocate(seat, ActorList.hud, 0xc4), undefined);
});

test("Z retires a wall patrol's round without removing the patrol; its explosion also frees a slot", () => {
  const game = new Game(campaign);
  game.start(2);
  game.camera = game.endCamera = 1000;
  Object.assign(game.player, { x: 300, y: 100 });
  game.shipTouchesTerrain = () => false;
  game.boss = game.miniboss = undefined;
  game.assets = { ...game.assets, events: [], background: [
    [1000, 1, 0, 0, 72, 1108, 0],
    [1000, 3, 3, 0, 248, 1108, 1],
    [1000, 5, 0, 0, 56, 1108, 0],
  ] };
  game.update();
  game.update();

  const [gun, patrol] = game.ground;
  const [round] = game.bullets;
  assert.ok(patrol.firing);
  assert.equal(patrol.actorAddress, gun.actorAddress + 0x4c);
  assert.deepEqual(game.actorLists.get(ActorList.transient).map(({ actor }) => actor), [round, patrol]);
  assert.ok(!game.targets.includes(patrol));

  grantReward(game, 18);
  assert.ok(gun.dead && round.dead && !patrol.dead);
  assert.equal(game.bullets.length, 0);
  const [explosion] = game.effects;
  game.update();
  assert.equal(game.run.actorPool.free.at(-1), round.actorAddress);
  for (let i = 0; i < 16 && !game.ground.some((actor) => actor instanceof GroundCreature); i++) game.update();
  const hatchling = game.ground.find((actor) => actor instanceof GroundCreature);
  assert.equal(game.effects.length, 0);
  assert.equal(hatchling.actorAddress, explosion.actorAddress);
});

test("a stage-two Z pickup only prevents damage from rounds later in its actor list", () => {
  for (const pickupFirst of [true, false]) {
    const game = new Game(campaign);
    game.start(2);
    game.eventStreamsClosed = true;
    game.shipTouchesTerrain = () => false;
    const round = { x: 160, y: 170, dx: 0, dy: 0, fixed: true, damage: 4,
      frame: game.assets.logic.foregroundShot.frame };
    const reward = { kind: "reward", reward: 18, x: 0, y: 0, state: -2, direction: 0, age: 0 };
    const box = game.bounds(game.sprite(game.pickupFrame(reward)), 0, 0);
    reward.x = 160 - box.x - Math.floor(box.w / 2);
    reward.y = 172 - box.y - Math.floor(box.h / 2);
    if (!pickupFirst) game.addPickup(reward);
    game.addPooledHostileRound(round);
    if (pickupFirst) game.addPickup(reward);
    game.update();
    assert.ok(reward.dead && round.dead);
    assert.equal(game.player.health, pickupFirst ? 39 : 35);
  }
});

test("stage-two pod and boss drops inherit the last direction written to their recycled slot", () => {
  const game = new Game(campaign);
  game.start(2);
  game.eventStreamsClosed = true;
  game.camera = game.endCamera = 1000;
  game.shipTouchesTerrain = () => false;
  game.spawn(game.assets.events.find((event) => event[1] === 0));
  const [pod] = game.enemies;
  const shot = { x: 80, y: 60, dx: -3, dy: -6, dead: true };
  game.addPlayerRound(shot);
  game.update();
  pod.motion.xFixed = 80 * 65536;
  pod.motion.yFixed = 60 * 65536;
  game.destroy(pod);
  const [drop] = game.pickups;
  assert.equal(drop.actorAddress, shot.actorAddress);

  game.update();
  assert.deepEqual([drop.x, drop.y], [78, 62]);
  game.update();
  assert.deepEqual([drop.x, drop.y], [80, 64]);

  drop.dead = true;
  game.update();
  game.destroy(game.boss);
  const [credit] = game.pickups;
  assert.equal(credit.actorAddress, drop.actorAddress);
  const [x, y] = [credit.x, credit.y];
  game.update();
  assert.deepEqual([credit.x, credit.y], [x + 2, y + 2]);
});

test("the boss-credit countdown also advances on an ordinary credit collection or any drop expiry", () => {
  for (const [kind, y, state, opensShop] of [
    ["credit", 174, -2, true], ["reward", 196, 0, true], ["reward", 174, -2, false],
  ]) {
    const game = new Game(campaign);
    game.start(2);
    game.eventStreamsClosed = true;
    game.camera = game.endCamera = 1000;
    game.shipTouchesTerrain = () => false;
    game.miniboss.shopPending = true;
    game.credits = 5000;
    const bossCredit = { kind: "credit", counted: true, value: 100, x: 50, y: 30, age: 0, state: -2, direction: 0 };
    const ordinary = { kind, reward: 0, value: 50, x: 160, y, age: 0, state, direction: 0 };
    game.addPickup(bossCredit);
    game.addPooledHostileRound({ x: 160, y: 170, dx: 0, dy: 0, fixed: true,
      frame: game.assets.logic.foregroundShot.frame });
    game.addPickup(ordinary);

    game.update();

    assert.deepEqual(game.pickups, [bossCredit]);
    assert.equal(game.countedCredits, opensShop ? 0 : 1);
    assert.equal(game.credits, kind === "credit" ? 5050 : 5000);
    assert.equal(game.player.speed, Number(kind === "reward" && state < 0));
    assert.equal(game.player.health, opensShop ? 35 : 39);
    assert.equal(game.status, opensShop ? "shop" : "playing");
    if (opensShop) assert.equal(game.shopStage, 2);
  }
});

test("recycling a boss credit at capacity does not advance the shop countdown", () => {
  const game = new Game(campaign);
  game.start(2);
  game.eventStreamsClosed = true;
  game.camera = game.endCamera = 1000;
  game.shipTouchesTerrain = () => false;
  game.miniboss.shopPending = true;
  game.credits = 5000;
  const bossCredit = { kind: "credit", counted: true, value: 100, x: 50, y: 30, age: 0, state: -2 };
  game.addPickup(bossCredit);
  const pool = game.run.actorPool, reserved = new Map();
  while (pool.free.length) pool.allocate(reserved, ActorList.hud, 0xc4);
  const round = { x: 160, y: 170, dx: 0, dy: 0, fixed: true, frame: game.assets.logic.foregroundShot.frame };
  game.addPooledHostileRound(round);
  assert.equal(round.actorAddress, bossCredit.actorAddress);

  game.update();

  assert.deepEqual(game.pickups, []);
  assert.equal(game.countedCredits, 1);
  assert.equal(game.status, "playing");
  assert.equal(game.player.health, 39);
  assert.ok(round.dead && game.shipHitFlash);

  const ordinary = { kind: "credit", value: 50, x: 160, y: 174, age: 0, state: -2, direction: 0 };
  game.addPickup(ordinary);
  assert.equal(ordinary.actorAddress, round.actorAddress);
  game.update();

  assert.equal(game.countedCredits, 0);
  assert.equal(game.credits, 5050);
  assert.equal(game.status, "shop");
  assert.equal(game.shopStage, 2);
});

test("the stage-two invulnerability ring protects only rounds visited before its expiry", () => {
  for (const ringFirst of [true, false]) {
    const game = new Game(campaign);
    game.start(2);
    game.eventStreamsClosed = true;
    game.shipTouchesTerrain = () => false;
    game.resetDive();
    const round = { x: 160, y: 170, dx: 0, dy: 0, fixed: true, damage: 4,
      frame: game.assets.logic.foregroundShot.frame };
    if (!ringFirst) grantReward(game, 16);
    game.addPooledHostileRound(round);
    if (ringFirst) grantReward(game, 16);
    const records = game.actorLists.get(ActorList.transient);
    const ring = records.find(({ type }) => type === 0x5c);

    game.invincible = 1;
    game.update();
    assert.equal(game.player.health, ringFirst ? 35 : 39);
    assert.equal(game.invulnerabilityMeterTime, 0);
    assert.equal(game.invulnerabilityRing, undefined);
    assert.ok(ring.actor.dead && records.includes(ring));
    game.update();
    assert.ok(!records.includes(ring));
    assert.equal(game.invulnerabilityMeterTime, undefined);
  }
});

test("stage-two ship contact uses the prior sprite box before steering and transient pickups", () => {
  const game = new Game(campaign);
  game.start(2);
  game.camera = game.endCamera = 1000;
  game.shipTouchesTerrain = () => false;
  const gunEvent = [1000, 1, 0, 0, 160, 1174, 0];
  game.assets = { ...game.assets, events: [], background: [gunEvent, gunEvent] };
  game.player.x = 240;
  game.update();
  game.update();
  const [older, newer] = game.ground;
  game.player.x = 174;
  const pickup = { kind: "reward", reward: 16, x: 0, y: 0, state: -2, direction: 0, age: 0 };
  const box = game.bounds(game.sprite(game.pickupFrame(pickup)), 0, 0);
  pickup.x = 177 - box.x - Math.floor(box.w / 2);
  pickup.y = 174 - box.y - Math.floor(box.h / 2);
  game.addPickup(pickup);

  game.update({ right: true });

  assert.equal(game.player.x, 177);
  assert.equal(game.player.health, 31);
  assert.ok(newer.dead && !older.dead);
  assert.equal(game.invincible, 170);
  assert.equal(game.score, 100);
});

test("stage-two rounds and pod rewards hit the cached ship bounds, not its new position", () => {
  for (const [kind, y, contact, phase] of [
    ["round", 187, true, "exposed"], ["round", 165, false, "exposed"],
    ["reward", 197, true, "exposed"], ["reward", 151, false, "exposed"],
    ["round", 187, true, "surfacing"], ["reward", 197, false, "diving"],
  ]) {
    const game = new Game(campaign);
    game.start(2);
    game.eventStreamsClosed = true;
    game.camera = game.endCamera = 1000;
    game.shipTouchesTerrain = () => false;
    game.update();
    if (phase !== "exposed") {
      game.divePhase = phase === "surfacing" ? 1 : 4;
      game.diveStep = phase === "surfacing" ? -1 : 0;
    }
    const round = kind === "round";
    const actor = round
      ? { x: 160, y, dx: 0, dy: 0, fixed: true, frame: game.assets.logic.foregroundShot.frame }
      : { x: 160, y, kind, reward: 16, age: 0, state: -2, direction: 0 };
    if (round) game.addPooledHostileRound(actor);
    else game.addPickup(actor);

    game.update({ up: true });

    assert.equal(game.player.y, 171);
    assert.equal(Boolean(actor.dead), contact, `${phase} ${kind} at ${y}`);
    assert.equal(game.player.health, round && contact ? 35 : 39);
    assert.equal(game.invincible, !round && contact ? 170 : 0);
  }
});

test("a stage-two hostile shot flashes for one tick, including the first fatal-hit frame", () => {
  for (const [health, invincible, counted, remaining, flash] of [
    [39, 0, 0, 35, true], [4, 0, 0, 0, true], [39, 6, 0, 39, false], [39, 0, 1, 39, true],
  ]) {
    const game = new Game(campaign);
    game.start(2);
    game.eventStreamsClosed = true;
    game.camera = game.endCamera = 1000;
    game.shipTouchesTerrain = () => false;
    game.player.health = health;
    game.invincible = invincible;
    game.countedCredits = counted;
    game.addPooledHostileRound({ x: 160, y: 170, dx: 0, dy: 0, fixed: true,
      frame: game.assets.logic.foregroundShot.frame });

    game.update();

    assert.equal(game.player.health, remaining);
    assert.equal(game.shipHitFlash, flash);
    assert.equal(game.status, health === 4 ? "dying" : "playing");
    game.update();
    assert.equal(game.shipHitFlash, false);
  }
});

test("swarm kills and timed expiry award no score, while large/small hatchlings keep original rewards", () => {
  for (const type of [2, 4, 5]) {
    const game = new Game(campaign);
    game.start(2);
    game.assets = { ...game.assets, events: [], background: [] };
    const definition = game.assets.groundLogic.get(type).creature;
    const creature = new GroundCreature({ definition, x: 150, y: 80,
      frames: type === 2 ? definition.spawns[0].frames : definition.frames },
    (frame) => game.sprite(frame));
    game.ground.push(creature);
    grantReward(game, 18);
    assert.equal(game.score, type === 2 ? 0 : type === 4 ? 150 : 300);
    assert.equal(game.effects.length, 1);
    assert.equal(Boolean(game.effects[0].large), type === 5);
    const sprite = game.sprite(creature.frame);
    assert.deepEqual([game.effects[0].x, game.effects[0].y], [
      creature.motion.x - sprite.originX + Math.floor(sprite.width / 2),
      creature.motion.y - sprite.originY + Math.floor((sprite.height - 1) / 2),
    ]);
    if (type !== 2) continue;
    game.effects = [];
    const expiring = new GroundCreature({ definition, x: 150, y: 80, age: 79,
      frames: definition.spawns[0].frames }, (frame) => game.sprite(frame));
    game.ground.push(expiring);
    game.update();
    assert.equal(game.ground.length, 0);
    assert.equal(game.score, 0);
    assert.equal(game.effects.length, 1);
  }
});

test("creature contact keeps distinct energy costs, protection, diving and fatal-hit behaviour", () => {
  for (const [type, protection, damage, dead, score, explosions] of [
    [2, "none", 4, true, 0, 0], [2, "shield", 2, true, 0, 0],
    [2, "dive", 0, false, 0, 0], [4, "none", 8, true, 150, 1],
    [5, "none", 16, true, 300, 1], [5, "fatal", 39, false, 0, 0],
  ]) {
    const game = new Game(campaign);
    game.start(2);
    game.assets = { ...game.assets, events: [], background: [] };
    game.shipTouchesTerrain = () => false;
    const definition = game.assets.groundLogic.get(type).creature;
    const creature = new GroundCreature({ definition, x: 150, y: 80,
      frames: type === 2 ? definition.spawns[0].frames : definition.frames },
    (frame) => game.sprite(frame));
    creature.bounds = () => ({ x: 154, y: 153, w: 12, h: 17 });
    game.ground.push(creature);
    if (protection === "shield") game.player.protection = true;
    if (protection === "dive") game.divePhase = 4;
    if (protection === "fatal") game.player.health = 8;
    game.update();
    assert.equal(game.player.health, 39 - damage, `${type}/${protection}`);
    assert.equal(creature.dead, dead);
    assert.equal(game.score, score);
    assert.equal(game.effects.length, explosions);
    assert.ok(game.effects.every((effect) => Number.isFinite(effect.x) && Number.isFinite(effect.y)));
    assert.equal(game.status, protection === "fatal" ? "dying" : "playing");
  }
});

test("the pooled swarm checks the DOS point after moving, not an overlapping sprite", () => {
  for (const [mode, health, dead, bursts] of [
    ["remote", 35, true, 0], ["invincible", 39, true, 1], ["visible", 39, false, 0],
  ]) {
    const game = new Game(campaign);
    game.start(2);
    game.eventStreamsClosed = true;
    game.camera = game.endCamera = 1000;
    game.shipTouchesTerrain = () => false;
    game.resetDive();
    const visible = mode === "visible", direction = visible ? 4 : 6;
    game.player.y = visible ? 174 : 16;
    const definition = game.assets.groundLogic.get(2).creature;
    const actor = new GroundCreature({ definition, direction,
      x: visible ? 151 : 240, y: 160, frames: definition.spawns[7 - direction].frames },
    (frame) => game.sprite(frame));
    game.addStageTwoBossActor(actor, 0x108);
    game.ground.push(actor);
    if (mode === "invincible") game.invincible = 6;

    game.update();

    assert.equal(game.player.health, health, mode);
    assert.equal(actor.dead, dead, mode);
    assert.equal(game.effects.length, bursts, mode);
    assert.equal(game.score, 0, mode);
  }
});

test("Z damages active wall guns and patrols, patches death tiles, opens pods and spares the boss", () => {
  for (let stage = 1; stage <= 5; stage++) {
    const game = new Game(campaign);
    game.start(stage);
    for (const [type, definition] of game.assets.groundLogic) {
      if (definition.kind && !["patrol", "random-gun", "burst-gun"].includes(definition.kind)) continue;
      for (const event of game.assets.background.filter((entry) => entry[1] === type).slice(0, 2)) {
        const actor = definition.kind === "patrol"
          ? new GroundPatrol(event, definition, game.camera, (frame) => game.sprite(frame))
          : new GroundGun(event, game.assets.groundLogic);
        game.ground.push(actor);
      }
    }
    assert.ok(game.ground.length, `stage ${stage}`);
    const score = game.ground.reduce((total, actor) => total + (actor.definition.score || 100), 0);
    game.spawn(game.assets.events.find((event) => event[1] === 0));
    const pod = game.enemies[0];
    game.enemies = [pod];
    const credit = { kind: "credit", x: 10, y: 10, value: 100, age: 0 };
    game.pickups.push(credit);
    game.bullets.push({ x: 10, y: 20 });
    const bossHealth = game.boss?.health;
    grantReward(game, 18);
    assert.ok(game.ground.every((actor) => actor.dead));
    assert.equal(game.score, score);
    for (const actor of game.ground.filter((entry) => !entry.spriteActor)) {
      for (const [i, tile] of actor.definition.death[actor.side].entries()) {
        assert.equal(game.map[actor.cell + i % 2 + Math.floor(i / 2) * 20], tile);
      }
    }
    assert.equal(pod.dead, true);
    assert.ok(game.pickups.includes(credit));
    assert.equal(game.pickups.filter((pickup) => pickup.kind === "reward").length, 1);
    assert.equal(game.bullets.length, 0);
    assert.equal(game.boss?.health, bossHealth);
    assert.ok(!game.boss?.dead);
  }
});

test("a stage-one map gun reuses a marked round slot and advances the replacement on the firing tick", () => {
  const game = terrainWormScene(4300);
  game.endCamera = game.camera;
  game.assets.background = [[4300, 1, 0, 0, 72, 4340, 0]];
  game.update();
  const [gun] = game.ground;
  assert.equal(game.actorLists.get(ActorList.main)?.[0]?.actor, gun);
  const expired = { x: 260, y: 80, dx: 0, dy: 0, point: true, damage: 1, age: 0 };
  game.addPlayerRound(expired);
  expired.dead = true;
  game.run.actorPool.free.length = 0;
  gun.fireCounter = 255;

  game.update();

  const [round] = game.actorLists.get(ActorList.transient);
  assert.equal(round.address, expired.actorAddress);
  assert.equal(round.type, 0x14);
  const [offsetX, offsetY] = gun.definition.muzzle[0];
  assert.equal(round.actor.x, Math.floor(gun.x + offsetX + gun.definition.bulletSpeed));
  assert.equal(round.actor.y, gun.worldY - game.camera + offsetY);
  assert.equal(game.shots.length, 0);
});

test("stage-one waiting formations aim at the player independently of earlier guns or patrols", () => {
  for (const [mode, rounds, seed] of [
    ["idle", 1, 0xef02],
    ["fire", 2, 0x55c3],
    ["culled", 1, 0xef02],
    ["patrol", 5, 0x55c3],
    ["preserve", 1, 0xef02],
  ]) {
    const game = terrainWormScene(4300);
    game.endCamera = game.camera;
    game.control.ceiling = 4316;
    game.eventStreamsClosed = true;
    game.player.x = 160;
    game.player.y = mode === "patrol" ? 120 : 174;
    game.assets.paths = { bytes: new Uint8Array(Int16Array.of(10, 100, 60, 0).buffer), offsets: [0] };
    game.spawn([0, 1, 1, 1, 0, 105, 3]);
    const [enemy] = game.enemies;
    enemy.motion.remaining = -80;
    enemy.fireCounter = 255;
    const allocate = (type, actor) => {
      game.run.actorPool.allocate(game.actorLists, ActorList.main, type, actor);
      game.ground.push(actor);
    };
    if (mode === "patrol" || mode === "preserve") {
      const event = [4300, 4, 0, 3, 72, 4408, 0];
      allocate(0xd0, new GroundPatrol(event, game.assets.groundLogic.get(4), 4300, (frame) => game.sprite(frame)));
    }
    if (mode !== "patrol") {
      const event = [4300, 1, 0, 0, 40, mode === "culled" ? 4608 : 4388, 0];
      const gun = new GroundGun(event, game.assets.groundLogic);
      gun.fireCounter = mode === "fire" ? 255 : 0;
      allocate(0xec, gun);
    }
    game.seed = 0x5845;

    game.update();

    const shots = game.actorLists.get(ActorList.transient).map(({ actor }) => actor);
    assert.equal(shots.length, rounds, mode);
    assert.equal(shots[0].foreground, true, mode);
    assert.equal(shots[0].direction, 3, mode);
    assert.deepEqual([shots[0].x, shots[0].y], [104, 64], mode);
    assert.equal(game.seed, seed, mode);
  }
});

test("stage-one banking jets do not change a waiting formation's aim at the same player position", () => {
  for (const bank of [-5, 0, 5]) {
    const game = terrainWormScene(4300);
    game.endCamera = game.camera;
    game.eventStreamsClosed = true;
    game.player.x = 120 - Math.sign(bank) * 3;
    game.control.bank = bank;
    game.assets.paths = { bytes: new Uint8Array(Int16Array.of(10, 100, 60, 0).buffer), offsets: [0] };
    game.spawn([0, 1, 1, 1, 0, 105, 3]);
    game.enemies[0].motion.remaining = -80;
    game.enemies[0].fireCounter = 255;

    game.update({ left: bank < 0, right: bank > 0 });

    const [shot] = game.bullets;
    assert.equal(game.player.x, 120);
    assert.equal(shot.direction, 4);
  }
});

test("stage-one worm guard bounds do not override the next formation's player target", () => {
  const game = terrainWormScene(3240);
  game.endCamera = game.camera;
  game.eventStreamsClosed = true;
  game.player.x = 160;
  game.player.y = 20;
  game.assets.paths = { bytes: new Uint8Array(Int16Array.of(10, 100, 60, 0).buffer), offsets: [0] };
  game.spawn([0, 1, 1, 1, 0, 105, 3]);
  game.enemies[0].motion.remaining = -80;
  game.enemies[0].fireCounter = 255;
  const worms = game.terrainWorms;
  worms.rotations[0] = 9 << 3;
  worms.present.fill(true, 1);
  worms.dispatch(game, game.camera);

  game.update();

  const shot = game.bullets.find((bullet) => bullet.foreground);
  assert.equal(shot.direction, 1);
  assert.deepEqual([shot.xFixed, shot.yFixed], [6831640, 3654120]);
});

test("a stage-one foreground volley inherits a marked round's fractions and moves on the firing tick", () => {
  const game = terrainWormScene(4300);
  game.endCamera = game.camera;
  game.assets.paths = { bytes: new Uint8Array(Int16Array.of(10, 100, 60, 2, 64, 0, 0, 1000, 0).buffer), offsets: [0] };
  game.eventStreamsClosed = true;
  game.spawn([0, 1, 1, 1, 0, 30, 3]);
  const [enemy] = game.enemies;
  enemy.fireCounter = 255;
  const spent = { x: 290, y: 80, dx: 0, dy: 0, point: true, damage: 1, age: 0 };
  game.addPlayerRound(spent);
  spent.dead = true;
  const pool = game.run.actorPool;
  pool.subpixels.set(spent.actorAddress, [0xc000, 0x9000]);
  pool.free.length = 0;

  game.update();

  const [record] = game.actorLists.get(ActorList.transient);
  const [bullet] = game.bullets;
  assert.equal(record.address, spent.actorAddress);
  assert.equal(record.type, 0x14);
  assert.equal(record.actor, bullet);
  assert.deepEqual([bullet.xFixed, bullet.yFixed], [
    (enemy.motion.x + bullet.dx) * 65536 + 0xc000,
    (enemy.motion.y + bullet.dy) * 65536 + 0x9000,
  ]);
  assert.equal(pool.free.length, 0);
});

test("stage-one composite formations keep root/attachment links when two formations share the main list", () => {
  const game = terrainWormScene(4300);
  game.endCamera = game.camera;
  game.eventStreamsClosed = true;
  game.spawn([0, 7, 2, 10, 32, 0, 7]);
  const [older, newer] = game.enemies;
  const records = game.actorLists.get(ActorList.main) || [];
  assert.deepEqual(records.map(({ actor }) => actor), [newer, newer.children[0], older, older.children[0], game.boss]);
  assert.equal(older.children[0].actorAddress - older.actorAddress, 0x4c);

  game.update();

  for (const root of [older, newer]) {
    const [attachment] = root.children;
    assert.deepEqual([attachment.motion.x, attachment.motion.y], [root.motion.x, root.motion.y]);
  }
});

test("a stage-one attachment keeps following its root address after the replacement round is unlinked", () => {
  const game = terrainWormScene(4300);
  game.endCamera = game.camera;
  game.eventStreamsClosed = true;
  game.spawn([0, 7, 1, 1, 0, 0, 3]);
  const [root] = game.enemies;
  const [attachment] = root.children;
  game.run.actorPool.free.length = 0;
  const round = { x: 310, y: 80, dx: 6, dy: 0, direction: 2, fixed: true,
    frame: game.assets.logic.foregroundShot.frame };
  game.addPooledHostileRound(round);
  assert.equal(round.actorAddress, root.actorAddress);

  game.update();

  assert.equal(attachment.motion.x, 310);
  assert.equal(round.x, 316);
  assert.deepEqual(game.enemies, []);
  for (let tick = 0; tick < 3; tick++) game.update();
  assert.deepEqual(game.actorLists.get(ActorList.transient), []);
  assert.equal(attachment.motion.x, 322);
  assert.ok(game.actorLists.get(ActorList.main).some(({ actor }) => actor === attachment));

  const blast = game.explode(64, 100, true, true);
  assert.equal(blast.address, root.actorAddress);
  game.update();
  assert.deepEqual([attachment.motion.x, attachment.motion.y], [64, 100]);
});

test("hits on an orphaned stage-one attachment affect the actor at its recycled root address", () => {
  for (const [kind, fullOnDeath] of [
    ["round", false], ["round", true], ["blast", false], ["cannon", false], ["credit", false],
  ]) {
    const game = terrainWormScene(4300);
    game.endCamera = game.camera;
    game.eventStreamsClosed = true;
    game.campaignRound = 2;
    game.spawn([0, 7, 1, 1, 0, 0, 3]);
    const [root] = game.enemies;
    const [attachment] = root.children;
    const pool = game.run.actorPool;
    const free = pool.free.splice(0);
    const round = { x: 150, y: 80, dx: 0, dy: 0, direction: 2, fixed: true,
      frame: game.assets.logic.foregroundShot.frame };
    game.addPooledHostileRound(round, 0);
    let replacement = round;
    if (kind === "blast") replacement = game.explode(150, 80, true, true).actor;
    if (kind === "credit") {
      replacement = { x: 150, y: 80, kind: "credit", value: 50, age: 0, state: 7, direction: game.randomWord() };
      game.addPickup(replacement);
    }
    pool.free.push(...free);
    game.update();
    if (kind === "cannon") {
      const free = pool.free.splice(0);
      const frames = game.assets.logic.cannon.shot;
      replacement = { x: 150, y: 80, cannon: true, dy: -10, damage: 2, frame: frames[0], frames, age: 0 };
      game.addPlayerRound(replacement, 0x30);
      pool.free.push(...free);
    }
    assert.equal(replacement.actorAddress, root.actorAddress);

    const { x, y } = attachment.contactBox;
    const shoot = (full = false) => {
      const shot = { x: x + 1, y: y + 1, dx: 0, dy: 0, point: true, damage: 1, age: 0 };
      game.addPlayerRound(shot);
      if (full) pool.free.length = 0;
      game.updatePlayerRound(shot);
      assert.ok(shot.dead);
      return shot.actorAddress;
    };
    shoot();
    assert.ok(!attachment.dead && !replacement.dead);
    assert.equal(replacement.flashTick, game.tick);
    assert.equal(attachment.flashTick, game.tick);
    assert.equal(game.score, 0);

    const killingAddress = shoot(fullOnDeath);
    assert.ok(attachment.dead && replacement.dead);
    assert.equal(game.score, 200);
    assert.equal(game.pickups.at(-1).kind, "credit");
    assert.deepEqual([game.pickups.at(-1).x, game.pickups.at(-1).y], [replacement.x, replacement.y]);
    if (fullOnDeath) assert.equal(game.pickups.at(-1).actorAddress, killingAddress);
  }
});

test("orphaned stage-one attachments still take damage through marked and released round slots", () => {
  for (const released of [false, true]) {
    const game = terrainWormScene(4300);
    game.endCamera = game.camera;
    game.eventStreamsClosed = true;
    game.campaignRound = 2;
    game.spawn([0, 7, 1, 1, 0, 0, 3]);
    const [root] = game.enemies;
    const [attachment] = root.children;
    const pool = game.run.actorPool;
    const free = pool.free.splice(0);
    const round = { x: 150, y: 80, dx: 0, dy: 0, direction: 2, fixed: true,
      frame: game.assets.logic.foregroundShot.frame };
    game.addPooledHostileRound(round, 0);
    const record = pool.recordsByAddress.get(round.actorAddress);
    pool.free.push(...free);
    game.update();
    round.dead = true;
    if (released) pool.release(game.actorLists, ActorList.transient, record);

    game.hitWithWeapon(attachment, { damage: 1 });

    assert.equal(root.health, 1);
    assert.equal(attachment.flashTick, game.tick);
    const paint = [];
    Renderer.prototype.drawTransient.call({
      drawEnemyRound: (_, actor) => paint.push(actor),
    }, game, game.actorLists.get(ActorList.transient));
    assert.deepEqual(paint, released ? [] : [round]);

    game.hitWithWeapon(attachment, { damage: 1 });

    assert.ok(attachment.dead);
    assert.equal(game.score, 200);
    assert.equal(game.pickups[0].kind, "credit");
    const blast = game.actorLists.get(ActorList.transient).find(({ type }) => type === 0x0c);
    assert.equal(blast.address === root.actorAddress, released);
    assert.equal(Boolean(blast.actor.dead), released);
  }
});

test("stage-one composite hits flash both parts once, with Drone hits appearing on the following tick", () => {
  const game = terrainWormScene(4300);
  game.eventStreamsClosed = true;
  game.campaignRound = 3;
  game.assets.paths = { bytes: new Uint8Array(Int16Array.of(10, 100, 60, 4, 90, 0).buffer), offsets: [0] };
  game.spawn([0, 7, 1, 1, 0, 0, 3]);
  const [root] = game.enemies;
  const [attachment] = root.children;
  const masks = [];
  const renderer = { drawSprite: (_sprite, _x, _y, alpha, mask) => masks.push([alpha, mask]) };
  const draw = () => {
    masks.length = 0;
    for (const actor of [root, attachment]) Renderer.prototype.drawForeground.call(renderer, game, actor, root);
    return masks.slice();
  };
  const normal = [[1, false], [1, false]];
  const flash = [[1, "vga-hit"], [1, "vga-hit"]];

  game.update();
  game.hitWithWeapon(attachment, { damage: 1 });
  assert.deepEqual(draw(), flash);
  game.update();
  assert.deepEqual(draw(), normal);

  game.droneShots[0] = { x: root.contactBox.x + 1, y: root.contactBox.y + 1, dx: 0, dy: 0, damage: 1, age: 0 };
  game.update();
  assert.equal(game.droneShots[0], null);
  assert.deepEqual(draw(), normal);
  game.update();
  assert.deepEqual(draw(), flash);
  game.update();
  assert.deepEqual(draw(), normal);
});

test("the stage-one main pass follows a foreground successor recycled into a hostile round", () => {
  const game = terrainWormScene(4300);
  game.endCamera = game.camera;
  game.eventStreamsClosed = true;
  game.assets.paths = { bytes: new Uint8Array(Int16Array.of(10, 100, 60, 2, 64, 0, 0, 1000, 0).buffer), offsets: [0] };
  game.spawn([0, 1, 1, 1, 0, 0, 3]);
  game.spawn([0, 0, 1, 1, 0, 30, 0]);
  const [victim, pod] = game.enemies;
  const pool = game.run.actorPool;
  pool.free.length = 0;
  pod.fireCounter = 255;

  game.update();

  const [round] = game.bullets;
  assert.equal(round.actorAddress, victim.actorAddress);
  assert.equal(victim.dead, true);
  assert.equal(game.actorLists.get(ActorList.transient)[0].actor, round);
  assert.equal(round.xFixed, (pod.motion.x + 2 * round.dx) * 65536);
  assert.equal(round.yFixed, (pod.motion.y + 2 * round.dy) * 65536);
});

test("a stage-one formation kill at capacity replaces its blast with a globe in the spent shot's slot", () => {
  const game = terrainWormScene(4300);
  game.eventStreamsClosed = true;
  game.spawn([0, 1, 1, 1, 0, 0, 3]);
  const [enemy] = game.enemies;
  const shot = { x: 290, y: 80, point: true, dead: true };
  game.addPlayerRound(shot);
  game.run.actorPool.free.length = 0;

  game.hitWithWeapon(enemy, { damage: 127 });

  const [globe] = game.pickups;
  const [blast] = game.effects;
  assert.ok(blast.dead && shot.dead && enemy.dead);
  assert.equal(globe.actorAddress, shot.actorAddress);
  assert.deepEqual([globe.x, globe.y, globe.state], [enemy.motion.x, enemy.motion.y, 7]);
  assert.deepEqual(game.actorLists.get(ActorList.transient).map(({ actor }) => actor), [globe]);
  game.update();
  assert.equal(globe.age, 1);
});

test("a pod that recycles itself marks its replacement reward before it can move or draw", () => {
  const game = terrainWormScene(4300);
  game.eventStreamsClosed = true;
  game.spawn([0, 0, 1, 1, 0, 0, 16]);
  const [pod] = game.enemies;
  const pool = game.run.actorPool;
  pool.free.length = 0;

  game.hitWithWeapon(pod, { damage: 127 });

  const [reward] = game.pickups;
  assert.equal(reward.actorAddress, pod.actorAddress);
  assert.ok(reward.dead);
  game.update();
  assert.equal(reward.age, 0);
  assert.equal(pool.free.at(-1), pod.actorAddress);
  assert.deepEqual(game.pickups, []);
});

test("stage-one Z dispatches a wall gun before older foreground actors", () => {
  const game = terrainWormScene(4300);
  const event = [4300, 1, 0, 0, 72, 4340, 0];
  game.spawn([0, 0, 1, 1, 0, 0, 16]);
  game.spawn([0, 1, 1, 1, 0, 0, 3]);
  const gun = new GroundGun(event, game.assets.groundLogic);
  game.run.actorPool.allocate(game.actorLists, ActorList.main, 0xec, gun);
  game.ground.push(gun);
  const round = { x: 290, y: 70, dx: 0, dy: 0, fixed: true, frame: game.assets.logic.foregroundShot.frame };
  game.addPooledHostileRound(round);

  grantReward(game, 18);

  assert.ok(gun.dead && round.dead && game.enemies.every((enemy) => enemy.dead));
  assert.deepEqual(game.actorLists.get(ActorList.transient).map(({ actor }) => actor), [
    game.pickups[1], game.pickups[0], game.effects[1], game.effects[0], round,
  ]);
  assert.deepEqual(game.pickups.map(({ kind }) => kind), ["credit", "reward"]);
  assert.equal(game.effects[0].large, true);
});

test("stage-one Z follows a pod reward that replaced its saved formation successor", () => {
  for (const [type, round, score] of [[1, 1, 400], [1, 64, 0], [7, 1, 200], [7, 128, 0]]) {
    const game = terrainWormScene(4300);
    game.eventStreamsClosed = true;
    game.campaignRound = round;
    game.spawn([0, 2, 1, 1, 0, 0, 3]);
    game.spawn([0, type, 1, 1, 0, 0, 3]);
    game.spawn([0, 0, 1, 1, 0, 0, 16]);
    const [trailing, recycled, pod] = game.enemies;
    const pool = game.run.actorPool;
    pool.free.length = 0;

    grantReward(game, 18);

    assert.ok(pod.dead && recycled.dead);
    assert.ok(!trailing.dead && trailing.formation.escaped);
    const [replacement] = game.actorLists.get(ActorList.transient);
    const [attachment] = recycled.children;
    assert.equal(replacement.address, recycled.actorAddress);
    assert.equal(game.score, score);
    if (!score) {
      assert.equal(replacement.actor, game.pickups[0]);
      assert.equal(replacement.actor.flashTick, game.tick);
      if (attachment) assert.ok(!attachment.dead && attachment.flashTick === game.tick);
    } else {
      assert.equal(replacement.actor.kind, "credit");
      assert.ok(replacement.actor.dead);
      if (attachment) assert.ok(attachment.dead);
    }
  }
});

test("stage-one Z dispatches the ground damage callback retained by a recycled pod reward", () => {
  for (const kind of ["wall", "patrol"]) {
    const game = terrainWormScene(4300);
    const pool = game.run.actorPool;
    const event = [4300, kind === "wall" ? 1 : 4, 0, 3, 72, 4340, 0];
    game.spawn([0, 2, 1, 1, 0, 0, 3]);
    const gun = kind === "wall" ? new GroundGun(event, game.assets.groundLogic)
      : new GroundPatrol(event, game.assets.groundLogic.get(4), game.camera, (frame) => game.sprite(frame));
    pool.allocate(game.actorLists, ActorList.main, kind === "wall" ? 0xec : 0xd0, gun);
    game.ground.push(gun);
    if (gun.patches) game.patchGround(gun, gun.patches);
    game.spawn([0, 0, 1, 1, 0, 0, 16]);
    const [trailing, pod] = game.enemies;
    pool.free.length = 0;

    grantReward(game, 18);

    const [slot] = game.actorLists.get(ActorList.transient);
    const [reward] = game.pickups;
    assert.equal(reward.actorAddress, gun.actorAddress);
    assert.equal(slot.address, gun.actorAddress);
    assert.equal(slot.actor, game.effects[0]);
    assert.ok(reward.dead && slot.actor.dead && gun.dead && pod.dead && !trailing.dead && trailing.formation.escaped);
    assert.equal(game.score, kind === "wall" ? 100 : 250);
    if (kind === "wall") {
      assert.deepEqual([slot.actor.x, slot.actor.y], [reward.x + 16, reward.y + 16 - game.camera]);
      assert.deepEqual([0, 1, 20, 21].map((offset) => game.map[gun.cell + offset]), [0x197c, 1, 0x1e4c, 1]);
    } else {
      assert.deepEqual([slot.actor.x, slot.actor.y], [reward.x + 1, reward.y]);
    }
    const renderer = Object.assign(Object.create(Renderer.prototype), {
      assets: game.assets, map: game.map, mapRevision: game.mapRevision,
      context: Object.fromEntries(["drawImage", "save", "beginPath", "rect", "clip", "restore", "fillRect", "fillText"]
        .map((name) => [name, () => {}])),
      drawSprite() {},
      drawPickup() { assert.fail("the recycled reward must not paint"); },
      drawEffect() { assert.fail("the marked blast must not paint"); },
    });
    renderer.draw(game);
  }
});

test("stage-one Z retires the terrain worm's path driver as well as its segments", () => {
  for (const full of [false, true]) {
    const game = terrainWormScene(3240);
    const pool = game.run.actorPool, worms = game.terrainWorms;
    worms.rotations[0] = 9 << 3;
    worms.present.fill(true, 1);
    worms.dispatch(game, game.camera);
    worms.update(game, 1);
    const { driver, parts } = worms.groups[0];
    if (full) pool.free.length = 0;

    grantReward(game, 18);

    assert.ok(driver.dead && parts.every((part) => part.dead));
    assert.equal(game.score, 750);
    const corpses = game.actorLists.get(ActorList.transient);
    assert.equal(corpses.length, full ? 1 : parts.length);
    assert.ok(corpses.every(({ actor }) => !actor.dead));
    worms.update(game, 0);
    assert.equal(driver.active, false);
    assert.ok(pool.free.includes(driver.actorAddress));
  }
});

test("coincident stage-two camera events defer new sprites and tiles even when they reclaim a painted slot", () => {
  const game = new Game(campaign);
  game.start(2);
  game.camera = 1001;
  game.endCamera = 1000;
  game.control.ceiling = 1016;
  game.player.x = 300;
  game.player.y = 24;
  game.shipTouchesTerrain = () => false;
  const path = Int16Array.of(10, 100, 60, 2, 36, 0, 0, 1000, 0);
  game.assets = { ...game.assets, events: [[1000, 1, 1, 1, 0, 0, 3]],
    paths: { bytes: new Uint8Array(path.buffer), offsets: [0] },
    background: [[1000, 1, 0, 0, 72, 1108, 0], [1000, 3, 3, 0, 248, 1108, 1], [1000, 4, 0, 0, 120, 1120, 0]],
  };
  game.explode(180, 45);
  const [effect] = game.effects;
  const pool = game.run.actorPool;
  pool.free.splice(0, pool.free.length - 3);
  const reserved = game.actorLists.get(ActorList.main).slice();
  const sprites = [], tiles = [];
  const renderer = Object.assign(Object.create(Renderer.prototype), {
    assets: game.assets, map: game.map, mapRevision: 0,
    world: { getContext: () => ({ drawImage: (...args) => tiles.push(args) }) },
    tileImages: game.assets.tiles.map((_, i) => i),
    context: Object.fromEntries(["drawImage", "save", "beginPath", "rect", "clip", "restore", "fillRect", "fillText"]
      .map((name) => [name, () => {}])),
    drawSprite() {},
    drawEffect(_, actor) { sprites.push(actor.actorAddress); },
    drawGroundSprite(_, actor) { sprites.push(actor.actorAddress); },
    drawForeground(_, actor) { sprites.push(actor.actorAddress); },
  });

  game.update();

  const [enemy] = game.enemies, [gun, patrol] = game.ground, [hatch] = game.scenery;
  assert.deepEqual(game.actorLists.get(ActorList.main).slice(3), reserved);
  assert.deepEqual([enemy.age, gun.phase, patrol.motion.y, hatch.phase], [0, 0, 100, 0]);
  assert.equal(gun.contactBox, undefined);
  assert.ok(effect.dead && hatch.actorAddress === effect.actorAddress);
  assert.equal(game.map[hatch.cell], hatch.patches[0]);
  renderer.draw(game);
  assert.deepEqual(sprites.splice(0), [effect.actorAddress]);
  assert.deepEqual(tiles, []);

  game.update();
  assert.deepEqual([enemy.age, patrol.motion.y, hatch.phase], [1, 99, 2]);
  assert.ok(gun.contactBox);
  renderer.draw(game);
  assert.deepEqual(sprites, [patrol.actorAddress, enemy.actorAddress]);
  assert.ok(tiles.some(([tile, x]) => tile === game.map[hatch.cell] >>> 6 && x === hatch.x));
});

test("stage-two Drone hits defer gun flashes, death tiles and blasts until the next paint pass", () => {
  const game = new Game(campaign);
  game.start(2);
  game.camera = game.endCamera = 1000;
  game.player.x = 300;
  game.player.y = 24;
  game.shipTouchesTerrain = () => false;
  game.assets = { ...game.assets, events: [], background: [[1000, 1, 0, 0, 72, 1108, 0]] };
  game.update();
  const [gun] = game.ground;
  const renderer = Object.create(Renderer.prototype);
  let flashes = 0;
  renderer.drawOverlay = () => { flashes++; };
  const drawGuns = () => renderer.drawStageTwoMain(game, game.actorPaint?.main ?? game.actorLists.get(ActorList.main));
  gun.health = 0x5442;
  game.addDroneVolley(64, 108, [[0, 0, 0, 0]]);
  game.update();
  assert.equal(gun.health, 1);
  assert.ok(!gun.dead);
  drawGuns();
  assert.equal(flashes, 0);
  game.update();
  drawGuns();
  assert.equal(flashes, 1);
  game.update();
  drawGuns();
  assert.equal(flashes, 1);

  game.addDroneVolley(64, 108, [[0, 0, 0, 0]]);
  game.update();

  assert.ok(gun.dead);
  assert.equal(game.score, 100);
  assert.equal(game.droneShots[0], null);
  assert.notEqual(game.map[gun.cell], gun.patches[0]);
  assert.equal(game.actorPaint.mapPatches.get(gun.cell), gun.patches[0]);
  assert.equal(game.effects.length, 1);
  assert.deepEqual(game.actorPaint.transient, []);

  game.update();
  assert.equal(game.actorPaint, undefined);
  assert.equal(game.effects[0].age, 1);
});

test("coincident stage-one camera events allocate after Drone damage and paint next tick", () => {
  const game = terrainWormScene(4300);
  const path = Int16Array.of(10, 100, 60, 4, 90, 0);
  game.assets.paths = { bytes: new Uint8Array(path.buffer), offsets: [0] };
  game.assets.events = [[4296, 1, 1, 1, 0, 0, 3], [4295, 2, 1, 1, 0, 0, 3]];
  game.assets.background = [[4296, 1, 0, 0, 72, 4340, 0], [4296, 4, 0, 3, 248, 4408, 1]];
  game.player.y = 24;
  for (let tick = 0; tick < 3; tick++) game.update();
  game.addDroneVolley(100, 50, [[0, 0, 0, 0]]);
  const sprites = [], tiles = [];
  const renderer = Object.assign(Object.create(Renderer.prototype), {
    assets: game.assets, map: game.map, mapRevision: 0,
    world: { getContext: () => ({ drawImage: (...args) => tiles.push(args) }) },
    tileImages: game.assets.tiles.map((_, i) => i),
    context: Object.fromEntries(["drawImage", "save", "beginPath", "rect", "clip", "restore", "fillRect", "fillText"]
      .map((name) => [name, () => {}])),
    drawSprite() {},
    drawGroundSprite(_, actor) { sprites.push(actor.actorAddress); },
    drawForeground(_, actor) { sprites.push(actor.actorAddress); },
  });

  game.update();

  const [enemy] = game.enemies, [gun, patrol] = game.ground;
  assert.deepEqual(game.actorLists.get(ActorList.main).map(({ actor }) => actor), [patrol, gun, enemy, game.boss]);
  assert.deepEqual([enemy.age, gun.phase, patrol.motion.y], [0, 0, patrol.worldY - game.camera]);
  assert.ok(game.droneShots[0]);
  assert.equal(game.score, 0);
  assert.equal(game.map[gun.cell], gun.patches[0]);
  renderer.draw(game);
  assert.deepEqual(sprites, []);
  assert.deepEqual(tiles, []);

  game.update();

  assert.equal(game.droneShots[0], null);
  assert.ok(enemy.dead && enemy.age === 1);
  assert.equal(game.score, 400);
  const [newborn] = game.enemies;
  assert.equal(newborn.formationId, enemy.formationId);
  assert.equal(newborn.age, 0);
  assert.deepEqual(game.pickups.map(({ value }) => value), [100]);
  renderer.draw(game);
  assert.deepEqual(sprites, [patrol.actorAddress, enemy.actorAddress]);
  assert.ok(tiles.some(([tile, x]) => tile === game.map[gun.cell] >>> 6 && x === gun.x));
});

for (const stage of [1, 2, 3, 4, 5]) {
  test(`scheduled stage-${stage} formations share credit counts by four-tick window and size`, () => {
    const game = stage === 1 ? terrainWormScene(4300) : new Game(campaign);
    if (stage !== 1) {
      game.start(stage);
      game.camera = 4300;
      game.player.x = 300;
      game.shipTouchesTerrain = () => false;
    }
    const [first, second, large, later] = [
      [9, 8, 1, 10], [5, 4, 1, 6], [5, 4, 3, 2], [3, 2, 1, 4], [4, 3, 1, 5],
    ][stage - 1];
    const path = Int16Array.of(10, 100, 60, 2, 36, 0, 0, 1000, 0);
    game.assets = {
      ...game.assets, background: [], paths: { bytes: new Uint8Array(path.buffer), offsets: [0] },
      events: [[2, first], [4, second], [5, first], [5, large], [8, later]]
        .map(([tick, type]) => [4300 - tick, type, 1, 1, 0, 0, 3]),
    };
    const advance = (tick) => { while (game.tick < tick) game.update(); };
    const kill = (type) => {
      const enemy = game.enemies.find((actor) => actor.type === type);
      game.hitWithWeapon(enemy.children.at(-1) ?? enemy, { damage: 127 });
    };

    advance(2);
    kill(first);
    assert.equal(game.pickups.length, 0);
    advance(5);
    kill(second);
    assert.equal(game.pickups.length, 0);
    kill(large);
    assert.deepEqual(game.pickups.map(({ value }) => value), [100]);
    advance(8);
    kill(later);
    kill(first);
    assert.deepEqual(game.pickups.map(({ value }) => value), [100, 50, 50]);
  });
}

test("stage-one Z and a path escape cancel other scheduled waves in the credit group", () => {
  for (const clear of [false, true]) {
    const game = terrainWormScene(4300);
    game.campaignRound = clear ? 256 : 1;
    const paths = Int16Array.of(10, 100, 60, 2, 36, 0, 0, 1000, 0, 10, 130, 60, 4, 5, 0);
    game.assets.paths = { bytes: new Uint8Array(paths.buffer), offsets: [0, 18] };
    game.assets.events = [[4296, 8, 1, 1, 0, 0, 3], [4295, 9, 1, clear ? 1 : 2, 0, 0, 3]];
    for (let tick = 0; tick < 7; tick++) game.update();
    const [survivor, second] = game.enemies;
    if (clear) {
      grantReward(game, 18);
      assert.equal(second.health, 129);
      game.hitWithWeapon(second, { damage: 129 });
    } else assert.equal(second, undefined);
    game.hitWithWeapon(survivor, { damage: 256 });
    assert.ok(survivor.dead);
    assert.equal(game.pickups.length, 0);
  }
});

test("a stage-one checkpoint clears old wave counts without restarting the current group window", () => {
  const game = terrainWormScene(4300);
  const path = Int16Array.of(10, 100, 60, 2, 36, 0, 0, 1000, 0);
  game.assets.paths = { bytes: new Uint8Array(path.buffer), offsets: [0] };
  game.assets.events = [[4296, 8, 1, 1, 0, 0, 3]];
  for (let tick = 0; tick < 4; tick++) game.update();
  const [{ formationId }] = game.enemies;
  game.saveCheckpoint([4296, 0, 0, 0, 160, 4472]);
  game.restoreCheckpoint();
  game.update();
  const [replay] = game.enemies;
  assert.equal(replay.formationId, formationId);
  game.hitWithWeapon(replay, { damage: 127 });
  assert.deepEqual(game.pickups.map(({ value }) => value), [50]);
});

test("the stage-one boss reserves its core before the arena and links arms ahead of it only on entry", () => {
  const game = terrainWormScene(449);
  game.endCamera = game.camera;
  game.eventStreamsClosed = true;
  game.shopVisited = true;
  const main = () => game.actorLists.get(ActorList.main);
  const [core] = main();
  assert.equal(core.type, 0x50);
  assert.equal(core.actor, game.boss);

  game.update();
  assert.deepEqual(main(), [core]);

  game.camera = game.endCamera = 448;
  game.update();
  const arms = main().slice(0, -1);
  assert.equal(arms.length, 8);
  assert.equal(main().at(-1), core);
  assert.deepEqual(arms.map(({ type }) => type), [0xfc, 0xfc, 0xfc, 0xfc, 0xfc, 0xfc, 0xfc, 0x100]);
  assert.ok(arms.every(({ actor }, index) => actor.parent === (arms[index - 1] ?? core).actor));
  assert.ok(arms.every(({ actor }) => actor.motion.y === -100), "newborn arm callbacks wait one tick");
  game.update();
  assert.equal(arms[0].actor.motion.y, 16 - 448 + 96);

  game.checkpoint.camera = 448;
  game.restoreCheckpoint();
  assert.deepEqual(main(), [...arms, core]);
});

test("the stage-one boss's next arm uses the speed of a round that recycled its parent", () => {
  const game = terrainWormScene(32);
  game.endCamera = game.camera;
  game.eventStreamsClosed = game.shopVisited = true;
  game.player.x = 300;
  game.player.y = 24;
  for (let tick = 0; tick < 12; tick++) game.update();
  const [first, second] = game.boss.arms;
  const originalY = second.motion.y;
  game.run.actorPool.free.length = 0;
  const round = { x: 130, y: 120, dx: 6, dy: 0, direction: 2, fixed: true,
    frame: game.assets.logic.foregroundShot.frame };
  game.addPooledHostileRound(round, 6);
  assert.equal(round.actorAddress, first.actorAddress);

  game.update();

  assert.ok(first.dead);
  assert.equal(game.actorLists.get(ActorList.main)[0].actor, second);
  assert.equal(second.speed, 6);
  assert.ok(Math.abs(second.motion.y - 120) <= 6);
  assert.notEqual(second.motion.y, originalY);
  assert.equal(round.x, 136);
});

test("a stage-one boss arm follows a replacement blast or a moving pod reward", () => {
  for (const kind of ["blast", "round-then-blast", "reward"]) {
    const game = terrainWormScene(32);
    game.endCamera = game.camera;
    game.eventStreamsClosed = game.shopVisited = true;
    game.player.x = 300;
    game.player.y = 24;
    for (let tick = 0; tick < 13; tick++) game.update();
    const [first, second] = game.boss.arms;
    game.run.actorPool.free.length = 0;
    if (kind === "round-then-blast") {
      game.addPooledHostileRound({ x: 130, y: 80, dx: 6, dy: 0, direction: 2, fixed: true,
        frame: game.assets.logic.foregroundShot.frame }, 6);
      game.update();
    }
    const record = kind === "reward"
      ? game.addPickup({ x: 130, y: 130, kind, reward: 16, age: 0, state: 7 })
      : game.explode(130, 130, true, true);
    assert.equal(record.address, first.actorAddress);

    game.update();

    assert.equal(second.speed, kind === "round-then-blast" ? 6 : first.speed);
    assert.ok(Math.abs(second.motion.y - 130) <= second.speed);
    const previousPosition = [second.xFixed, second.yFixed];
    if (kind === "reward") {
      game.update();
      assert.notDeepEqual([second.xFixed, second.yFixed], previousPosition);
    } else {
      for (let tick = 0; tick < record.actor.frames.length; tick++) game.update();
      assert.ok(game.run.actorPool.free.includes(record.address));
      assert.deepEqual([second.xFixed, second.yFixed], previousPosition);
    }
  }
});

test("a stage-one boss arm follows a formation credit through motion and retirement", () => {
  const game = terrainWormScene(32);
  game.endCamera = game.camera;
  game.eventStreamsClosed = game.shopVisited = true;
  Object.assign(game.player, { x: 300, y: 24 });
  const step = () => {
    if (game.boss.active) game.boss.arms.at(-1).fireCounter = 0;
    game.update();
  };
  for (let tick = 0; tick < 13; tick++) step();
  const [first, second] = game.boss.arms;
  game.run.actorPool.free.length = 0;
  const credit = { x: 130, y: 130, kind: "credit", value: 50, age: 0, state: 7, direction: game.randomWord() };
  game.addPickup(credit);
  assert.equal(credit.actorAddress, first.actorAddress);

  step();
  assert.deepEqual([second.xFixed, second.yFixed, second.speed], [9097216, 8615936, 11]);
  step();
  assert.deepEqual([second.xFixed, second.yFixed], [9228288, 8615936]);
  for (let tick = 0; !credit.dead && tick < 60; tick++) step();
  assert.equal(credit.dead, true);
  step();
  assert.ok(game.run.actorPool.free.includes(credit.actorAddress));
  assert.deepEqual([second.xFixed, second.yFixed], [10849280, 13667328]);
  step();
  assert.deepEqual([second.xFixed, second.yFixed], [10849280, 13667328]);
});

test("recycled boss arms use a straight round's signed horizontal velocity but a Cannon retains the heading", () => {
  for (const [weapon, dx, dy, xFixed, yFixed] of [
    ["forward", 0, -9, 9280512, 8651776],
    ["left", -9, 0, 9278464, 8592384],
    ["cannon", 0, -10, 8755200, 9273344],
  ]) {
    const game = terrainWormScene(32);
    game.endCamera = game.camera;
    game.eventStreamsClosed = game.shopVisited = true;
    Object.assign(game.player, { x: 300, y: 24 });
    for (let tick = 0; tick < 13; tick++) game.update();
    const [first, second] = game.boss.arms;
    game.run.actorPool.free.length = 0;
    const cannon = weapon === "cannon";
    const frames = game.assets.logic.cannon.shot;
    const shot = { x: 130, y: 130, dx, dy, point: !cannon, cannon, age: 0, damage: cannon ? 2 : 1,
      ...(cannon ? { frame: frames[0], frames } : { originalSprite: game.assets.playerShots[weapon][0] }) };
    game.addPlayerRound(shot, cannon ? 0x30 : 0x10);
    assert.equal(shot.actorAddress, first.actorAddress);

    game.update();

    assert.deepEqual([second.xFixed, second.yFixed, second.speed], [xFixed, yFixed, 11], weapon);
    assert.deepEqual([shot.x, shot.y], [130 + dx, 130 + dy], weapon);
  }
});

test("a stage-one eye hit paints only the boss tile flash until the next tick", () => {
  const game = terrainWormScene(32);
  game.endCamera = game.camera;
  game.eventStreamsClosed = game.shopVisited = true;
  game.update();
  const boss = game.boss;
  const modes = [];
  const renderer = {
    drawOverlay: (_region, mode) => modes.push(mode),
    drawSprite: () => modes.push("mouth"),
  };
  const draw = () => {
    modes.length = 0;
    Renderer.prototype.drawStageOneCore.call(renderer, game, boss);
    return modes.slice();
  };
  game.hitWithWeapon(boss, { x: 130, y: boss.weakY, point: true, damage: 1 });
  assert.deepEqual(draw(), [false, "mouth"]);
  game.hitWithWeapon(boss, { x: 160, y: boss.weakY, point: true, damage: 1 });
  assert.deepEqual(draw(), ["vga-hit"]);
  game.update();
  assert.deepEqual(draw(), [false, "mouth"]);
});

test("a lethal stage-one Drone hit keeps the already-painted formation and shows its drops next tick", () => {
  const game = terrainWormScene(4300);
  game.endCamera = game.camera;
  game.eventStreamsClosed = true;
  game.assets.paths = { bytes: new Uint8Array(Int16Array.of(10, 100, 60, 4, 90, 0).buffer), offsets: [0] };
  game.spawn([0, 7, 1, 1, 0, 0, 3]);
  const [enemy] = game.enemies;
  enemy.health = 0x5441 * 2;
  const painted = [];
  const renderer = Object.assign(Object.create(Renderer.prototype), {
    assets: game.assets, map: game.map, mapRevision: game.mapRevision,
    context: Object.fromEntries(["drawImage", "save", "beginPath", "rect", "clip", "restore", "fillRect", "fillText"]
      .map((name) => [name, () => {}])),
    drawSprite() {},
    drawForeground(_game, actor) {
      painted.push([actor.actorAddress, actor.droneFlashTick === game.tick]);
    },
    drawPickup() { painted.push("credit"); },
    drawEffect() { painted.push("blast"); },
  });
  const paint = () => {
    painted.length = 0;
    renderer.draw(game);
    return painted.slice();
  };
  const addresses = [enemy.actorAddress, enemy.children[0].actorAddress];
  for (const flash of [false, true]) {
    game.addDroneVolley(100, 60, [[0, 0, 0, 0]]);
    game.update();
    assert.equal(game.droneShots[0], null);
    assert.deepEqual(paint(), addresses.map((address) => [address, flash]));
  }
  assert.equal(enemy.dead, true);
  assert.equal(game.score, 200);
  game.update();
  assert.deepEqual(paint(), ["credit", "blast"]);
});

test("the stage-one Drone tests the boss eye with a point, not the Cannon's rectangle", () => {
  const game = terrainWormScene(32);
  game.endCamera = game.camera;
  game.eventStreamsClosed = true;
  game.update();
  const boss = game.boss;
  for (const [offset, dead] of [[15, false], [14, true]]) {
    game.addDroneVolley(160, boss.weakY + offset, [[0, 0, 0, 0]]);
    game.updateDroneRounds();
    assert.equal(game.droneShots[0], null);
    assert.equal(boss.dead, dead);
  }
});

test("a stage-one boss arm spends a Cannon round without taking damage or flashing", () => {
  const game = terrainWormScene(0);
  game.endCamera = game.camera;
  game.eventStreamsClosed = game.shopVisited = true;
  game.player.x = 300;
  game.update();
  game.update();
  const [arm] = game.boss.arms;
  const { x, y } = arm.motion;
  const frame = game.assets.logic.cannon.shot[0];
  const offset = game.bounds(game.sprite(frame), 0, 0);
  const round = { x: x - offset.x, y: y - offset.y + 10, dy: -10,
    cannon: true, damage: 2, age: 0, frame };
  game.addPlayerRound(round, 0x30);

  game.updatePlayerRound(round);

  assert.ok(round.dead);
  assert.ok(!arm.dead && arm.flashTick === undefined);
  assert.equal(game.boss.health, game.boss.definition.health);
  game.update();
  assert.ok(game.run.actorPool.free.includes(round.actorAddress));
});

test("stage-one boss tip rounds animate in place in the shared list and outlive the boss", () => {
  const game = terrainWormScene(32);
  game.endCamera = game.camera;
  game.eventStreamsClosed = true;
  game.shopVisited = true;
  game.player.x = 300;
  for (let tick = 0; tick < 11; tick++) game.update();
  assert.equal(game.boss.speed, 11);
  game.boss.arms.at(-1).fireCounter = 255;

  game.update();

  const [row] = game.actorLists.get(ActorList.transient) || [];
  const [bullet] = game.bullets;
  assert.equal(row?.actor, bullet);
  assert.equal(row.type, 0x14);
  assert.equal(bullet.frame, game.boss.definition.bullet[0]);
  game.update();
  assert.equal(bullet.frame, game.boss.definition.bullet[1]);

  game.destroy(game.boss);

  const records = game.actorLists.get(ActorList.transient);
  assert.equal(records[20], row, "death blasts prepend and counted rewards append around the live round");
  assert.deepEqual(records.slice(0, 20).map(({ type }) => type), Array(20).fill(0x0c));
  assert.deepEqual(records.slice(21).map(({ type }) => type),
    Array.from({ length: 18 }, (_, i) => i % 2 ? 0x18 : 0x60));
  const start = bullet.xFixed;
  game.update();
  assert.equal(bullet.xFixed, start + bullet.dx * 65536);
  assert.equal(game.countedCredits, 18);
});

test("a stage-one map gun death reuses the spent shot without advancing its explosion until next tick", () => {
  const game = terrainWormScene(4300);
  game.endCamera = game.camera;
  game.assets.background = [[4300, 1, 0, 0, 72, 4340, 0]];
  game.update();
  const [gun] = game.ground;
  const { x, y } = gun.bounds(game.camera);
  const shot = { x, y, dx: 0, dy: 0, point: true, damage: 2, age: 0 };
  game.addPlayerRound(shot);
  game.run.actorPool.free.length = 0;

  game.update();

  const [record] = game.actorLists.get(ActorList.transient);
  assert.equal(record.address, shot.actorAddress);
  assert.equal(record.type, 0x0c);
  assert.equal(record.actor.age, 0);
  assert.equal(gun.dead, true);
  assert.equal(game.score, 100);
  assert.equal(game.map[gun.cell], gun.definition.death[0][0]);

  game.update();

  assert.equal(record.actor.age, 1);
});

test("at capacity a map gun's self-reused explosion is marked and its raw animation words patch the terrain", () => {
  const game = terrainWormScene(4300);
  game.endCamera = game.camera;
  game.assets.background = [[4300, 1, 0, 0, 72, 4340, 0]];
  game.update();
  const [gun] = game.ground;
  const pool = game.run.actorPool;
  pool.free.length = 0;

  game.hitWithWeapon(gun, { damage: 2 });

  const [record] = game.actorLists.get(ActorList.transient) || [];
  assert.equal(record?.address, gun.actorAddress);
  assert.equal(record.actor.dead, true);
  assert.deepEqual([0, 1, 20, 21].map((offset) => game.map[gun.cell + offset]), [6524, 1, 7756, 1]);
  assert.equal(game.score, 100);
  game.update();
  assert.equal(record.actor.age, 0);
  assert.deepEqual(pool.free, [record.address]);
});

test("a stage-one patrol moves its slot after firing and is no longer a main-list target", () => {
  const game = terrainWormScene(4300);
  game.endCamera = game.camera;
  game.assets.background = [[4300, 4, 0, 3, 72, 4408, 0]];
  game.player.y = 24;
  game.update();
  const [patrol] = game.ground;
  const [record] = game.actorLists.get(ActorList.main) || [];
  assert.equal(record?.actor, patrol);
  assert.equal(record.type, 0xd0);
  game.player.y = 100;

  game.update();

  assert.deepEqual(game.actorLists.get(ActorList.main).map(({ actor }) => actor), [game.boss]);
  assert.deepEqual(game.actorLists.get(ActorList.transient).map(({ type }) => type), [0x14, 0x14, 0x14, 0xd0]);
  assert.equal(game.actorLists.get(ActorList.transient).at(-1), record);
  assert.equal(patrol.frameTicks, 1, "the transient pass advances the firing frame on the migration tick");
  assert.ok(!game.targets.includes(patrol));
  grantReward(game, 18);
  assert.equal(patrol.dead, false, "Z only dispatches damage to the main list");
});

test("a saturated right patrol's later rounds use the same slot's replacement coordinates and type", () => {
  const game = terrainWormScene(4300);
  game.endCamera = game.camera;
  game.assets.background = [[4300, 4, 0, 3, 248, 4408, 1]];
  game.player.y = 24;
  game.update();
  const [patrol] = game.ground;
  game.run.actorPool.free.length = 0;
  game.player.y = 100;

  game.update();

  const [record] = game.actorLists.get(ActorList.transient) || [];
  assert.equal(record?.address, patrol.actorAddress);
  assert.equal(record.type, 0x14);
  assert.equal(record.actor.direction, 1);
  assert.equal(record.actor.x, Math.floor(patrol.x + record.actor.dx));
  assert.equal(record.actor.y, Math.floor(patrol.motion.y + 21 + record.actor.dy));
  assert.deepEqual(game.bullets, [record.actor]);
});

test("a lethal hit on a stage-one patrol that reuses its own slot leaves a marked blast", () => {
  const game = terrainWormScene(4300);
  game.endCamera = game.camera;
  game.assets.background = [[4300, 4, 0, 3, 72, 4408, 0]];
  game.player.y = 24;
  game.update();
  const [patrol] = game.ground;
  const pool = game.run.actorPool;
  pool.free.length = 0;

  game.hitWithWeapon(patrol, { damage: patrol.health });

  const [record] = game.actorLists.get(ActorList.transient) || [];
  assert.equal(record?.address, patrol.actorAddress);
  assert.equal(record.type, 0x0c);
  assert.equal(record.actor.dead, true);
  assert.equal(game.score, 250);
  assert.equal(game.mapPatches.size, 0);
  game.update();
  assert.equal(record.actor.age, 0);
  assert.deepEqual(pool.free, [record.address]);
});

test("Z dispatches 127 damage rather than deleting high-health or exempt actors", () => {
  const game = new Game(campaign);
  game.start();
  game.spawn(game.assets.events.find((event) => event[1] === 8));
  const survivor = game.enemies[0];
  survivor.health = 200;
  const exempt = { parts: [{ id: 0x54 }], health: 20 };
  game.enemies.push(exempt);
  grantReward(game, 18);
  assert.equal(survivor.health, 73);
  assert.ok(!survivor.dead);
  assert.equal(exempt.health, 20);
  assert.equal(survivor.formation.escaped, true);
});

test("both sides of all three original map guns animate and shoot inwards at recovered speeds", () => {
  for (const type of [1, 2, 3]) for (const side of [0, 1]) {
    const gun = new GroundGun([4352, type, 0, 0, side ? 248 : 72, 4328, side],
      campaign.groundLogic);
    let seed = 0x5845;
    let shots = 0;
    const frames = new Set();
    for (let tick = 0; tick < 128; tick++) {
      const bullet = gun.update(4300 - tick, 4316 - tick,
        () => seed = (seed * 0x6255 + 0x3619) & 65535);
      frames.add(gun.patches.join(","));
      if (!bullet) continue;
      shots++;
      assert.equal(bullet.dx, side ? -6 : 6);
      assert.equal(bullet.dy, 0);
      assert.equal(bullet.damage, 4);
      assert.ok(campaign.lookup[bullet.frame.bank].has(bullet.frame.offset));
    }
    assert.ok(shots > 0);
    assert.ok(frames.size > 1);
  }
});

test("map gun hit boxes take two basic shots, replace destroyed tiles and stay destroyed on reversing", () => {
  const event = campaign.background.find((entry) => entry[1] === 1);
  const stage = { ...campaign.stages[0], background: [event], events: [] };
  const game = new Game({ ...campaign, stages: [stage] });
  game.start();
  game.camera = event[0] + 1;
  game.update();
  assert.equal(game.ground.length, 1);
  const gun = game.ground[0];
  assert.equal(gun.health, 2);
  for (let tick = 0; tick < 40; tick++) game.update();
  assert.ok(game.mapRevision > 0);
  assert.notEqual(game.map, stage.map);
  for (let hit = 0; hit < 2; hit++) {
    const bounds = gun.bounds(game.camera);
    game.shots.push({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 + 6 });
    game.update();
    assert.equal(gun.health, 1 - hit);
  }
  assert.equal(game.ground.length, 0);
  assert.equal(game.score, 100);
  for (const [i, tile] of gun.definition.death[gun.side].entries()) {
    const cell = gun.cell + (i % 2) + Math.floor(i / 2) * 20;
    assert.equal(game.map[cell], tile);
  }
  game.player.y = 176;
  for (let tick = 0; tick < 20; tick++) game.update({ down: true });
  assert.equal(game.ground.length, 0);
  assert.ok(game.backgroundEventLimit <= event[0]);
});

test("bottom-edge input reverses the camera within the original 16-pixel backtracking limit", () => {
  const p = { x: 160, y: 174, speed: 0 };
  const c = { camera: 4000, ceiling: 4016, bank: 0, reverseTicks: 0 };
  const step = (input) => {
    const { scroll, down } = movePlayer(p, input, c);
    scrollMap(c, scroll, down, 224);
  };
  step({ down: true });
  assert.equal(p.y, 177);
  assert.equal(c.camera, 3999);
  step({ down: true });
  assert.equal(p.y, 176);
  assert.equal(c.camera, 4000);
  assert.equal(c.delta, -1);
  for (let tick = 0; tick < 15; tick++) step({ down: true });
  assert.equal(c.camera, 4015);
  assert.equal(c.ceiling, 4015);
  step({ down: true });
  assert.equal(c.camera, 4014);
  assert.equal(c.ceiling, 4014);
  step({});
  assert.equal(c.camera, 4013);
  assert.equal(c.delta, 1);
});

test("reversing never respawns foreground events already crossed", () => {
  const event = campaign.events[0];
  const stage = { ...campaign.stages[0], events: [event], background: [] };
  const game = new Game({ ...campaign, stages: [stage] });
  game.start();
  game.camera = event[0] + 1;
  game.update();
  const waves = game.waves;
  game.player.y = 176;
  for (let tick = 0; tick < 30; tick++) game.update({ down: true });
  for (let tick = 0; tick < 30; tick++) game.update();
  assert.equal(game.waves, waves);
});

test("the early original pods grant speed, speed, power, then a rear gun, not a bomb launcher", () => {
  const game = new Game(campaign);
  game.start();
  game.resetDive();
  const pods = campaign.events.filter((event) => event[1] === 0)
    .sort((a, b) => b[0] - a[0]).slice(0, 4);
  for (const pod of pods) grantReward(game, pod[6]);
  assert.equal(game.player.speed, 2);
  assert.equal(game.player.power, 2);
  assert.equal(game.inventory[5].id, 8);
  assert.ok(game.inventory.every((weapon) => weapon?.id !== 21));
  fireWeapons(game);
  const rear = game.shots.find((shot) => shot.dy > 0);
  assert.ok(rear);
  assert.equal(rear.x, game.player.x);
  assert.equal(rear.y, game.player.y + 18);
  assert.equal(rear.dy, 9);
  assert.equal(rear.dx, 0);
  assert.equal(rear.bomb, undefined);
  assert.ok(rear.originalSprite.alpha.some((value) => value));
  const mount = weaponAttachment(game, 5, game.inventory[5]);
  assert.equal(game.sprite(mount.frames[0]), game.sprite(campaign.rewards[4].frames[0]));
});

test("straight weapon upgrades enlarge original masks instead of inventing extra projectiles", () => {
  const patterns = [
    [1, [[0, -6, 0, -9, "forward"]]],
    [8, [[0, 18, 0, 9, "rear"]]],
    [10, [[-2, -3, -9, 0, "left"], [2, -3, 9, 0, "right"]]],
    [14, [[-5, -12, 0, -9, "forward"], [6, -12, 0, -9, "forward"]]],
  ];
  for (const [id, pattern] of patterns) for (const power of [0, 1, 2]) {
    const game = new Game(campaign);
    game.start();
    game.resetDive();
    game.inventory = [{ id, power }, null, null, null, null, null, null];
    fireWeapons(game);
    assert.equal(game.shots.length, pattern.length);
    for (const [index, [x, y, dx, dy, mask]] of pattern.entries()) {
      const shot = game.shots[index];
      assert.deepEqual([shot.x, shot.y, shot.dx, shot.dy, shot.damage],
        [game.player.x + x, game.player.y + y, dx, dy, power + 1]);
      assert.equal(shot.originalSprite, game.assets.playerShots[mask][power]);
      assert.equal(shot.point, true);
    }
  }
});

test("rear attachment stays behind the ship while banking, firing and recovering from damage", () => {
  const game = new Game(campaign);
  game.start();
  game.resetDive();
  grantReward(game, 4);
  game.saveCheckpoint([game.camera, 0, 0, 0, 160, 0]);
  game.player.y = 90;
  game.assets = { ...game.assets, events: [], background: [] };
  const renderer = Object.create(Renderer.prototype);
  Object.assign(renderer, {
    assets: game.assets, map: game.map, mapRevision: game.mapRevision, world: {},
    context: Object.fromEntries(["fillRect", "drawImage", "save", "beginPath", "rect",
      "clip", "restore", "fillText"].map((name) => [name, () => {}])),
  });
  let drawn;
  renderer.drawSprite = (sprite, x, y) => {
    if (game.assets.logic.rearAttachment.some((frame) => game.sprite(frame) === sprite)) {
      drawn = { sprite, x, y };
    }
  };
  const frames = new Set();
  for (let tick = 0; tick < 30; tick++) {
    if (tick === 12) {
      game.invincible = 0;
      game.damage(39);
      for (let age = 0; age < 16; age++) game.update();
      assert.equal(game.continueRun(), true);
    }
    game.invincible = 999;
    game.player.y = 90;
    game.update({ fire: tick % 8 === 0, left: tick < 10, right: tick >= 20 });
    renderer.draw(game);
    assert.ok(drawn);
    if (!game.mountPosture) {
      assert.equal(drawn.x, game.player.x);
      assert.equal(drawn.y, game.player.y);
      assert.ok(drawn.y - drawn.sprite.originY >= game.player.y + 10);
    }
    frames.add(drawn.sprite);
    drawn = undefined;
  }
  assert.equal(frames.size, 5);
  assert.equal(game.player.lives, 2);
  assert.equal(game.inventory[5].id, 8);
  assert.ok(game.shots.some((shot) => shot.dy > 0));
});

test("the first shop opens at the original world-Y checkpoint and resumes the same stage once", () => {
  const game = new Game(campaign);
  game.start();
  game.shipTouchesTerrain = () => false;
  grantReward(game, 4);
  game.credits = 1234;
  game.player.health = 27;
  game.invincible = 999;
  const { worldY, camera } = game.assets.logic.shopCheckpoint;
  game.camera = worldY - game.player.y + 1;
  const map = game.map;
  const inventory = game.inventory;
  game.update();
  assert.equal(game.status, "playing");
  game.update();
  assert.equal(game.status, "shop");
  assert.equal(game.shopStage, 1);
  assert.equal(game.camera, camera);
  assert.equal(game.control.ceiling, camera);
  const snapshot = game.snapshot();
  const { foregroundEventLimit, backgroundEventLimit } = game;
  game.update({ fire: true, up: true });
  assert.deepEqual(game.snapshot(), snapshot);
  assert.equal(game.continueRun(), true);
  assert.equal(game.stage, 1);
  assert.equal(game.camera, camera);
  assert.equal(game.map, map);
  assert.equal(game.inventory, inventory);
  assert.equal(game.foregroundEventLimit, foregroundEventLimit);
  assert.equal(game.backgroundEventLimit, backgroundEventLimit);
  assert.equal(game.player.health, 27);
  assert.equal(game.credits, 1234);
  assert.equal(game.shopStage, undefined);
  game.camera = worldY - game.player.y + 4;
  for (let tick = 0; tick < 12; tick++) game.update();
  assert.equal(game.status, "playing");
  game.camera = 224;
  game.enemies = [];
  game.assets = { ...game.assets, events: [], background: [] };
  game.update();
  assert.equal(game.status, "playing");
  assert.equal(game.shopStage, undefined);
  assert.equal(game.boss.active, true);
});

test("autofire uses the original eight-unit counter including fractional three-unit cadence", () => {
  for (const [autofire, expected] of [
    [0, [1, 9, 17]], [1, [1, 5, 9, 13, 17]],
    [2, [1, 4, 7, 9, 12, 15, 17]], [3, [1, 3, 5, 7, 9, 11, 13, 15, 17]],
  ]) {
    const game = new Game(campaign);
    game.start();
    game.player.autofire = autofire;
    const ticks = [];
    for (let tick = 1; tick <= 17; tick++) {
      game.sounds.length = 0;
      game.update({ fire: true });
      if (game.sounds.includes("shot")) ticks.push(tick);
    }
    assert.deepEqual(ticks, expected);
    game.update({});
    game.sounds.length = 0;
    game.update({ fire: true });
    assert.ok(game.sounds.includes("shot"));
  }
});

test("later-stage foreground enemies survive the original number of basic hits", () => {
  for (const [number, type, hits] of [[3, 1, 2], [4, 2, 6], [5, 3, 12]]) {
    const game = new Game(campaign);
    game.start(number);
    game.assets = { ...game.assets, events: [], background: [] };
    game.spawn([4608, type, 1, 1, 0, 0, 0]);
    const enemy = game.enemies[0];
    enemy.speed = 0;
    enemy.motion.xFixed = 160 * 65536;
    enemy.motion.yFixed = 90 * 65536;
    for (let hit = 1; hit <= hits; hit++) {
      const bounds = game.targetBounds(enemy);
      game.shots.push({ x: bounds.x + 1, y: bounds.y + 1, dx: 0, dy: 0,
        damage: 1, point: true });
      game.update();
      assert.equal(Boolean(enemy.dead), hit === hits);
    }
    assert.equal(game.score, enemy.parts[0].score);
  }
});

test("background patrols traverse their original range, fire the correct fan and finish their firing animation", () => {
  for (const stage of [1, 2]) for (const side of [0, 1]) {
    const assets = campaign.stages[stage - 1];
    const definition = assets.groundLogic.get(stage === 1 ? 4 : 3);
    const event = [1120, stage === 1 ? 4 : 3, 1, 1, side ? 248 : 72, 1108, side];
    const patrol = new GroundPatrol(event, definition, 1000,
      (frame) => assets.lookup[frame.bank].get(frame.offset));
    const positions = new Set();
    for (let tick = 0; tick < 64; tick++) {
      patrol.update(1000, 1016, () => { throw new Error("Out-of-range patrol consumed RNG"); }, { y: 10 });
      assert.ok(patrol.worldY >= 1084 && patrol.worldY <= 1100);
      positions.add(patrol.worldY);
    }
    assert.equal(positions.size, 17);
    const shots = patrol.update(1000, 1016, () => 0, { y: patrol.motion.y });
    assert.equal(shots.length, stage === 1 ? 3 : 1);
    assert.ok(shots.every((shot) => side ? shot.dx < 0 : shot.dx > 0));
    if (stage === 1) assert.deepEqual(shots.map((shot) => Math.sign(shot.dy)),
      side ? [-1, 0, 1] : [1, 0, -1]);
    for (let tick = 0; tick < 6; tick++) patrol.update(1000, 1016,
      () => { throw new Error("Firing patrol consumed RNG"); }, { y: 100 });
    assert.equal(patrol.dead, stage === 1);
    if (stage === 2) {
      const frame = patrol.frame;
      for (let tick = 0; tick < 16; tick++) patrol.update(1000, 1016, () => 0, { y: 100 });
      assert.equal(patrol.frame, frame);
      assert.equal(patrol.frameTicks, 0);
    }
  }
});

test("sprite patrols spawn visibly, take damage and award their original score without altering map tiles", () => {
  for (const stage of [1, 2]) {
    const assets = campaign.stages[stage - 1];
    const event = assets.background.find((entry) => entry[1] === (stage === 1 ? 4 : 3));
    const game = new Game(campaign);
    game.start(stage);
    game.miniboss = undefined;
    game.endCamera = stage === 1 ? 0 : 0xe0;
    game.assets = { ...assets, events: [], background: [event] };
    game.shipTouchesTerrain = () => false;
    game.shopVisited = true;
    game.camera = event[0] + 1;
    game.player.y = 174;
    game.update();
    assert.equal(game.ground.length, 1);
    const enemy = game.ground[0];
    for (let tick = 0; tick < 256 && enemy.bounds().y < 16; tick++) {
      game.invincible = 2;
      game.update();
    }
    assert.ok(enemy.bounds().y >= 16);
    assert.ok(game.sprite(enemy.frame));
    const renderer = Object.create(Renderer.prototype);
    const drawn = [];
    Object.assign(renderer, {
      assets: game.assets, map: game.map, mapRevision: game.mapRevision, world: {},
      tileImages: assets.tiles.map(() => ({})),
      maskedTiles: assets.tiles.map(() => ({})),
      context: Object.fromEntries(["fillRect", "drawImage", "save", "beginPath", "rect",
        "clip", "restore", "fillText"].map((name) => [name, () => {}])),
      drawSprite: (sprite) => drawn.push(sprite),
    });
    renderer.draw(game);
    assert.ok(drawn.includes(game.sprite(enemy.frame)));
    const health = enemy.health;
    for (let hit = 0; hit < health; hit++) {
      const b = enemy.bounds();
      game.shots.push({ x: Math.floor(b.x + b.w / 2), y: Math.floor(b.y + b.h / 2),
        dx: 0, dy: 0, point: true, damage: 1 });
      game.update();
    }
    assert.equal(enemy.dead, true);
    assert.equal(game.ground.length, 0);
    assert.equal(game.score, stage === 1 ? 250 : 200);
    assert.equal(game.mapRevision, 0);
    assert.equal(game.pickups.length, 0);
    const sprite = game.sprite(enemy.frame);
    assert.deepEqual([game.effects[0].x, game.effects[0].y, game.effects[0].large],
      [enemy.x - sprite.originX + Math.floor(sprite.width / 2),
        enemy.motion.y - sprite.originY + Math.floor((sprite.height - 1) / 2), stage === 1]);
  }
});

test("later-stage map guns animate, fire, take their recovered health and replace only their own map cells", () => {
  for (const stage of [2, 3, 4, 5]) for (const side of [0, 1]) {
    const assets = campaign.stages[stage - 1];
    const type = { 2: 1, 3: 4, 4: 1, 5: 2 }[stage];
    const game = new Game(campaign);
    game.start(stage);
    game.miniboss = undefined;
    game.endCamera = 0xe0;
    game.assets = { ...assets, events: [], background: [[1100, type, 0, 0, 72, 1108, side]] };
    game.shipTouchesTerrain = () => false;
    game.camera = 1101;
    game.update();
    const gun = game.ground[0];
    assert.ok(gun);
    let shots = 0;
    const frames = new Set();
    for (let tick = 0; tick < 256; tick++) {
      const bullet = gun.update(1000, 1016, () => 0);
      frames.add(gun.patches.join(","));
      if (bullet) {
        shots++;
        assert.ok(game.sprite(bullet.frame));
        if (stage === 3) assert.equal(Math.sign(bullet.dy), side ? 1 : -1);
        else assert.equal(Math.sign(bullet.dx), side ? -1 : 1);
      }
    }
    assert.ok(frames.size > 1);
    assert.ok(shots > 0);
    game.camera = 1000;
    const health = gun.health;
    for (let hit = 0; hit < health; hit++) {
      const b = gun.bounds(game.camera);
      game.shots.push({ x: b.x + 2, y: b.y + 2, dx: 0, dy: 0, point: true, damage: 1 });
      game.update();
    }
    assert.equal(gun.dead, true);
    assert.equal(game.score, stage === 4 ? 400 : 100);
    for (const [i, tile] of gun.definition.death[side].entries()) {
      assert.equal(game.map[gun.cell + i % 2 + Math.floor(i / 2) * 20], tile);
    }
  }
});

test("native diagonal bullets retain fractional motion and expire at original screen boundaries", () => {
  const game = new Game(campaign);
  game.start(2);
  game.miniboss = undefined;
  game.endCamera = 0xe0;
  game.assets = { ...game.assets, events: [], background: [] };
  game.camera = 1000;
  const bullet = { x: 100, y: 50, dx: 11585 / 16384 * 8, dy: -11585 / 16384 * 8, fixed: true };
  game.bullets.push(bullet);
  for (let tick = 1; tick <= 4; tick++) {
    game.update();
    assert.equal(bullet.x, Math.floor(100 + tick * bullet.dx));
    assert.equal(bullet.y, Math.floor(50 + tick * (bullet.dy + 1)));
  }
  bullet.xFixed = 319 * 65536;
  game.update();
  assert.equal(bullet.dead, true);
  assert.equal(game.bullets.length, 0);
});

test("stage-one boss prevents premature completion, has an invulnerable body/arms and a damageable mouth", () => {
  const game = new Game(campaign);
  game.start();
  game.shopVisited = true;
  game.assets = { ...game.assets, events: [], background: [] };
  game.camera = 225;
  game.update();
  assert.equal(game.status, "playing");
  assert.equal(game.boss.active, true);
  assert.equal(game.boss.speed, 0);
  game.camera = 48;
  game.update();
  assert.equal(game.boss.phase, 2);
  for (let tick = 0; tick < 12; tick++) { game.invincible = 2; game.update(); }
  assert.equal(game.boss.speed, 11);
  assert.equal(game.boss.arms.length, 8);
  for (const arm of game.boss.arms) assert.ok(game.sprite(arm.frame));
  const health = game.boss.health;
  game.shots.push({ x: 130, y: game.boss.motion.y + 30, dx: 0, dy: 0, damage: 30, point: true });
  game.update();
  assert.equal(game.boss.health, health);
  assert.equal(game.shots.length, 0);
  const arm = game.boss.arms[0];
  assert.equal(arm.indestructible, true);
  const previous = game.boss;
  game.shots.push({ x: 160, y: game.boss.weakY + 7, dx: 0, dy: 0, damage: 30, point: true });
  game.update();
  assert.equal(previous.dead, true);
  assert.equal(game.countedCredits, 18);
  assert.equal(game.status, "playing");
  assert.equal(game.bullets.length, 0);
  assert.equal(game.score, 0);
  assert.equal(game.pickups.filter((pickup) => pickup.value === 100).length, 9);
  for (let tick = 0; tick < 256 && game.status === "playing"; tick++) {
    game.invincible = 2;
    game.update();
  }
  assert.equal(game.countedCredits, 0);
  assert.equal(game.status, "shop");
  assert.equal(game.shopStage, 2);
  assert.ok(game.credits >= 3400);
  assert.equal(game.continueRun(), true);
  assert.equal(game.stage, 2);
  assert.equal(game.boss.health, 75);
  assert.equal(game.countedCredits, 0);
});
