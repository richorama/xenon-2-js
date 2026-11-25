import { test } from "node:test";
import assert from "node:assert/strict";
import { Game, frameAt } from "../src/game.js";
import { ActorList } from "../src/actor-pool.js";
import { buy, sell, price, salePrice, grantReward } from "../src/shop.js";
import { cannonFrame, weaponAttachment } from "../src/weapons.js";
import { loadTestCampaign } from "./helpers.js";

const assets = loadTestCampaign();
function shop() {
  const game = new Game(assets);
  game.start();
  game.resetDive();
  game.status = "shop";
  game.shopStage = game.stage;
  game.credits = 100000;
  return game;
}

test("purchases are atomic, enforce caps and prevent incompatible mounts", () => {
  const game = shop();
  assert.equal(buy(game, 14).ok, true);
  assert.equal(game.credits, 97000);
  assert.equal(buy(game, 20).ok, false);
  assert.equal(buy(game, 14).ok, true);
  assert.equal(buy(game, 14).ok, true);
  const before = game.snapshot();
  assert.equal(buy(game, 14).ok, false);
  assert.deepEqual(game.snapshot(), before);
  assert.equal(game.player.power, 3);
  game.credits = 0;
  assert.equal(buy(game, 8).ok, false);
  assert.equal(buy(game, 999).ok, false);
  assert.equal(game.inventory[5], null);
  game.status = "playing";
  game.credits = 10000;
  assert.equal(buy(game, 8).ok, false);
});

test("four auxiliary mounts and rear/side mounts preserve their distinct compatibility rules", () => {
  const game = shop();
  for (let i = 0; i < 4; i++) assert.equal(buy(game, 18).ok, true);
  assert.equal(buy(game, 15).ok, false);
  assert.equal(buy(game, 8).ok, true);
  assert.equal(buy(game, 11).ok, false);
  assert.equal(buy(game, 23).ok, true);
  assert.equal(game.inventory[6].id, 23);
  assert.equal(buy(game, 10).ok, false);
});

test("the Homing Missile doesn't duplicate across two mounts, but its pod can replace an occupied side slot", () => {
  const game = shop();
  assert.equal(buy(game, 23).ok, true);
  assert.equal(buy(game, 23).ok, true); // The original shop charges if the other slot is free.
  assert.equal(game.inventory[5].id, 23);
  assert.equal(game.inventory[6], null);
  const other = shop();
  assert.equal(buy(other, 8).ok, true);
  assert.equal(buy(other, 21).ok, true);
  assert.equal(buy(other, 23).ok, false);
  grantReward(other, 13);
  assert.deepEqual(other.inventory.slice(5).map((weapon) => weapon.id), [8, 23]);
});

test("selling uses original base plus power formula, frees mounts, and cannot duplicate credit", () => {
  const game = shop();
  buy(game, 14);
  buy(game, 14);
  const balance = game.credits;
  const item = assets.shop.find((entry) => entry.id === 14);
  assert.equal(salePrice(item, game.inventory[0]), 2500);
  assert.equal(sell(game, 0).ok, true);
  assert.equal(game.credits, balance + 2500);
  assert.equal(game.inventory[0], null);
  assert.equal(sell(game, 0).ok, false);
  assert.equal(sell(game, -1).ok, false);
  assert.equal(game.credits, balance + 2500);
  game.loadStage(5);
  game.shopStage = 5;
  assert.equal(price(item, 5), 1500);
  assert.equal(buy(game, 14).ok, true);
  assert.equal(game.credits, balance + 1000);
});

test("a sold front gun stays empty until Cannon installation or leaving the shop", () => {
  for (const route of ["same stage", "next stage", "Cannon"]) {
    const game = shop();
    assert.ok(buy(game, 14).ok);
    assert.ok(buy(game, 21).ok);
    assert.ok(sell(game, 0).ok);
    assert.equal(game.inventory[0], null);
    assert.equal(buy(game, 12).ok, false);
    if (route === "next stage") game.shopStage++;
    if (route === "Cannon") assert.ok(buy(game, 15).ok);
    else assert.ok(game.continueRun());
    assert.deepEqual(game.inventory[0], { id: 1, power: 0 });
    assert.equal(game.actorLists.get(ActorList.mounts)
      .filter(({ actor }) => actor.slot === 0 && !actor.dead).length, 1);
    if (route !== "next stage") assert.equal(game.firePeriod, 8);
  }
});

test("shop departure saves purchases and sales before a Nashwan loan without saving the wallet", () => {
  const game = shop();
  grantReward(game, 4);
  game.checkpoint.credits = 123;
  game.saveCheckpointEquipment();
  assert.ok(sell(game, 5).ok);
  assert.ok(buy(game, 14).ok);
  assert.ok(buy(game, 14).ok);
  assert.ok(buy(game, 6).ok);
  assert.ok(game.continueRun());
  assert.deepEqual(game.inventory[0], { id: 14, power: 2 });
  assert.deepEqual(game.checkpoint.inventory, [{ id: 14, power: 1 }, null, null, null, null, null, null]);
  assert.equal(game.checkpoint.credits, 123);
  game.player.nashwan = 0;
  game.restoreCheckpoint();
  assert.deepEqual(game.inventory[0], { id: 14, power: 1 });
  assert.equal(game.inventory[5], null);
});

test("Cannon sales retire both records and checkpoint reconstruction fills auxiliary mount gaps", () => {
  const game = shop();
  game.eventStreamsClosed = true;
  assert.equal(buy(game, 15).ok, true);
  assert.equal(buy(game, 15).ok, true);
  const [survivor, sold] = game.actorLists.get(ActorList.mounts);
  const soldOverlay = sold.actor.overlay;
  assert.equal(sell(game, 1).ok, true);
  assert.ok(sold.actor.dead && soldOverlay.actor.dead);
  assert.ok(!game.run.actorPool.free.includes(soldOverlay.address));

  game.continueRun();
  game.update();
  assert.ok(game.run.actorPool.free.includes(sold.address));
  assert.ok(game.run.actorPool.free.includes(soldOverlay.address));
  game.saveCheckpointEquipment();
  game.restoreCheckpoint();
  const [restored] = game.actorLists.get(ActorList.mounts);
  assert.equal(restored.actor.slot, 1);
  assert.notEqual(restored.actor.weapon, survivor.actor.weapon);
  assert.deepEqual(restored.actor.weapon, { id: 15, power: 0 });
  assert.deepEqual(game.actorLists.get(ActorList.transient), [restored.actor.overlay]);
});

test("all consumable items apply recovered effects and reject purchases at capacity", () => {
  const game = shop();
  game.player.health = 1;
  buy(game, 4);
  assert.equal(game.player.health, 21);
  buy(game, 7);
  assert.equal(game.player.health, 39);
  assert.equal(buy(game, 4).ok, false);
  for (let i = 0; i < 2; i++) assert.equal(buy(game, 3).ok, true);
  assert.equal(buy(game, 3).ok, false);
  assert.equal(game.player.speed, 2);
  for (let i = 0; i < 3; i++) assert.equal(buy(game, 5).ok, true);
  assert.equal(buy(game, 5).ok, false);
  assert.equal(buy(game, 6).ok, true);
  assert.equal(game.player.nashwan, 170);
  assert.equal(buy(game, 6).ok, false);
  assert.equal(buy(game, 16).ok, false);
  game.player.dives = 0;
  buy(game, 16);
  assert.equal(game.player.dives, 3);
  buy(game, 24);
  assert.equal(game.player.protection, true);
  assert.equal(buy(game, 24).ok, false);
  buy(game, 25);
  assert.equal(game.player.shades, 220);
  assert.equal(buy(game, 25).ok, false);
  game.player.lives = 8;
  buy(game, 22);
  assert.equal(game.player.lives, 9);
  assert.equal(buy(game, 22).ok, false);
});

test("shop minimum credits help an empty wallet but do not alter a sufficient balance or RNG", () => {
  const game = new Game(assets);
  game.start();
  game.camera = 2496;
  game.openShop(1);
  assert.ok(game.credits >= 600 && game.credits <= 750);
  assert.equal(buy(game, 3).ok, true);
  game.credits = 600;
  const seed = game.seed;
  game.openShop(1);
  assert.equal(game.credits, 600);
  assert.equal(game.seed, seed);
  game.credits = 70000;
  game.camera = 224;
  game.openShop(2);
  assert.equal(game.credits, 70000);
  assert.equal(game.seed, seed);
});

test("powerup chooses the lowest eligible weapon and advice uses the original stage text", () => {
  const game = shop();
  game.inventory[0].power = 2;
  buy(game, 18);
  buy(game, 12);
  assert.equal(game.inventory[1].power, 1);
  buy(game, 12);
  assert.equal(game.inventory[1].power, 2);
  assert.equal(buy(game, 12).ok, false);
  assert.equal(buy(game, 2).message, "YOU CAN'T TAKE IT WITH YOU");
  assert.equal(buy(game, 2).message, "YOU CAN'T TAKE IT WITH YOU");
  assert.match(buy(game, 2).message, /ENOUGH ADVICE/);
});

test("advice advances independently per seat and starts a second set on the return visit", () => {
  const first = new Game(assets);
  first.start(2, 2);
  first.continueRun();
  const readAdvice = (game) => Array.from({ length: 4 }, () => {
    const result = buy(game, 2);
    assert.ok(result.ok);
    return result.message;
  });
  first.credits = 100000;
  first.openShop(2);
  const opening = readAdvice(first);
  assert.notEqual(opening[0], opening[1]);
  assert.equal(opening[2], opening[3]);
  first.continueRun();
  first.openShop(3);
  const returning = readAdvice(first);
  assert.notEqual(returning[0], opening[0]);
  assert.notEqual(returning[1], opening[1]);
  assert.deepEqual(returning.slice(2), opening.slice(2));

  const second = first.partner;
  second.credits = 100000;
  second.openShop(2);
  assert.deepEqual(readAdvice(second), opening);
});

test("each recovered weapon produces functional projectiles with valid original artwork", () => {
  for (const item of assets.shop.filter((entry) => entry.mounts && ![1, 11].includes(entry.id))) {
    const game = shop();
    assert.equal(buy(game, item.id).ok, true, item.name);
    game.inventory[0] = item.mounts & 1 ? game.inventory[0] : null;
    game.status = "playing";
    game.player.y = 90;
    game.playerTrail = Array.from({ length: 3 }, () => ({ x: 160, y: 90 }));
    game.update({ fire: true });
    if ([15, 17].includes(item.id)) game.update();
    if ([9, 13].includes(item.id)) for (let i = 0; i < 12; i++) game.update({ fire: true });
    assert.ok(game.snapshot().shots, item.name);
    for (const shot of game.shots) {
      if (shot.sprite !== undefined) assert.ok(game.assets.weapons[shot.sprite], item.name);
      if (shot.frame) assert.ok(game.sprite(shot.frame), item.name);
    }
    game.invincible = 100;
    for (let i = 0; i < 150; i++) game.update();
    assert.equal(game.snapshot().shots, 0, `${item.name} projectiles expire or leave play`);
  }
});

test("after a checkpoint death the original eight-step posture suppresses mounted fire but not the basic gun", () => {
  const game = shop();
  for (const id of [8, 15, 17, 18]) assert.ok(buy(game, id).ok);
  game.continueRun();
  game.shipTouchesTerrain = () => false;
  game.saveCheckpoint([4000, 0, 0, 0, 160, 4176]);
  game.killPlayer();
  for (let tick = 0; tick < 16; tick++) game.update();
  assert.equal(game.continueRun(), true);
  assert.equal(game.status, "playing");
  assert.equal(game.player.lives, 2);
  game.player.y = 96;
  const mount = () => weaponAttachment(game, 1, game.inventory[1]);
  const [offsetX, offsetY] = game.assets.logic.auxiliaryMounts[0];
  for (let tick = 0; tick < 8; tick++) {
    game.update({ fire: true });
    assert.equal(game.mountPosture, 8 - tick);
    assert.ok(game.shots.some((shot) => shot.originalSprite === game.assets.playerShots.forward[0]));
    assert.ok(!game.shots.some((shot) => shot.cannon || shot.beam || shot.frames));
    if (!tick) {
      assert.notEqual(mount().x, game.player.x + offsetX);
      assert.notEqual(mount().overlayPosition.y, mount().y);
    }
  }
  game.update();
  game.update({ fire: true });
  assert.deepEqual([mount().x, mount().y], [game.player.x + offsetX, game.player.y + offsetY]);
  assert.ok(game.shots.some((shot) => shot.beam));
  assert.ok(game.shots.some((shot) => shot.originalSprite === game.assets.playerShots.rear[0]));
  game.update();
  assert.ok(game.shots.some((shot) => shot.cannon));
  assert.equal(game.shots.filter((shot) => shot.frames === game.assets.logic.missileShot.frames).length, 2);
});

test("full submersion hides the mount without freezing its sprite animation, and surfacing restores it", () => {
  const game = shop();
  assert.ok(buy(game, 19).ok);
  game.continueRun();
  game.shipTouchesTerrain = () => false;
  game.player.y = 96;
  const drone = game.inventory[5];
  const mount = () => weaponAttachment(game, 5, drone);
  game.update({ dive: true });
  game.update();
  assert.ok(game.divePose && mount());
  for (let i = 0; i < 17; i++) game.update({ fire: true });
  assert.equal(game.diveMasked, true);
  assert.equal(mount(), undefined);
  const hiddenAge = game.weaponAges.get(drone);
  game.update({ dive: true });
  assert.equal(mount(), undefined);
  assert.equal(game.weaponAges.get(drone), hiddenAge + 1);
  while (game.divePhase) game.update({ fire: true });
  for (let i = 0; i < 15; i++) game.update({ fire: true });
  assert.equal(game.mountPosture, 1);
  assert.ok(mount());
  assert.ok(!game.droneShots.some(Boolean));
  game.update({ fire: true });
  assert.equal(game.droneShots.filter(Boolean).length, 4);
});

test("the Mine lays spaced charges while held and detonates them in deployment order on release", () => {
  for (const [id, power] of [[9, 0], [13, 1]]) {
    const game = shop();
    assert.ok(buy(game, id).ok);
    game.openShop(game.stage);
    game.continueRun();
    game.inventory[0] = null;
    game.player.y = 96;
    game.invincible = 999;
    const target = { ground: true, spriteActor: true, health: 50,
      update() {}, bounds: () => ({ x: 124, y: 0, w: 105, h: 30 }) };
    game.ground = [target];
    for (let i = 0; i < 11; i++) game.update({ fire: true });
    assert.equal(game.shots.length, 0);
    for (let i = 0; i < 5; i++) game.update({ fire: true, right: true });
    const [second, first] = game.shots;
    assert.equal(game.shots.length, 2);
    assert.deepEqual([second.x - first.x, first.fuse, second.fuse], [32, -4, -8]);
    for (let i = 0; i < 3; i++) game.update();
    assert.equal(target.health, 50);
    game.update();
    assert.equal(target.health, 46 - 2 * power);
    assert.deepEqual(game.shots, [second]);
    assert.equal(game.effects.length, 4);
    game.update({ fire: true });
    assert.equal(second.fuse, -4);
    for (let i = 0; i < 4; i++) game.update();
    assert.equal(game.shots.length, 0);
    assert.equal(target.health, 42 - 4 * power);
    assert.ok(game.effects.every((effect) => game.sprite(effect.frames[0])));
  }
});

test("the Homing Missile launches one four-rocket volley, pauses, and tracks into point contact", () => {
  const game = shop();
  assert.ok(buy(game, 23).ok);
  game.openShop(game.stage);
  game.continueRun();
  game.inventory[0] = null;
  game.player.y = 96;
  game.invincible = 999;
  const target = { ground: true, spriteActor: true, health: 50,
    update() {}, bounds: () => ({ x: 116, y: 49, w: 14, h: 14 }) };
  game.eventStreamsClosed = true;
  game.ground = [target];
  game.update({ fire: true });
  assert.deepEqual(game.shots.map(({ x, y, direction }) => [x, y, direction]),
    [[164, 92, 1], [164, 100, 3], [156, 100, 5], [156, 92, 7]]);
  for (let i = 0; i < 4; i++) game.update({ fire: true });
  const upperLeft = game.shots.at(-1);
  assert.deepEqual([upperLeft.x, upperLeft.y], [140, 76]);
  for (let i = 0; i < 8; i++) game.update({ fire: true });
  assert.deepEqual([upperLeft.x, upperLeft.y, upperLeft.target], [140, 76, undefined]);
  game.update({ fire: true });
  assert.equal(upperLeft.target, target);
  assert.deepEqual([upperLeft.x, upperLeft.y], [136, 72]);
  for (let i = 0; i < 3; i++) game.update({ fire: true });
  assert.equal(upperLeft.dead, true);
  assert.equal(target.health, 49);
  assert.equal(game.shots.length, 3);
  for (let i = 0; i < 20; i++) game.update({ fire: true });
  assert.ok(game.shots.length <= 4);
});

test("the purchased Electro Ball steers from its last trailing position, clamps, and docks before relaunch", () => {
  const game = shop();
  assert.ok(buy(game, 11).ok);
  game.openShop(game.stage);
  game.continueRun();
  game.inventory[0] = null;
  game.player.y = 91;
  game.playerTrail = Array.from({ length: 3 }, () => ({ x: 160, y: 91 }));
  const pose = () => {
    const mount = weaponAttachment(game, 5, game.inventory[5]);
    return [mount.x, mount.y];
  };
  game.update();
  game.update({ fire: true, right: true, up: true });
  assert.deepEqual(pose(), [160, 116]);
  game.update({ fire: true, right: true, up: true });
  assert.deepEqual(pose(), [172, 104]);
  for (let i = 0; i < 30; i++) game.update({ fire: true, right: true, up: true });
  assert.deepEqual(pose(), [319, 0]);
  assert.equal(game.shots.length, 0);
  game.update();
  assert.deepEqual(pose(), [319, 0]);
  game.update({ fire: true, left: true });
  assert.deepEqual(pose(), [311, 8]);
  for (let i = 0; i < 10; i++) game.update();
  const docked = game.playerTrail[0];
  assert.deepEqual(pose(), [docked.x, docked.y + 25]);
  game.update({ fire: true, left: true });
  assert.deepEqual(pose(), [docked.x, docked.y + 25]);
});

test("the Electro Ball damages only the first target each held tick and cannot hit while returning", () => {
  const game = shop();
  assert.ok(buy(game, 11).ok);
  game.openShop(game.stage);
  game.continueRun();
  game.inventory[0] = null;
  game.player.y = 90;
  game.playerTrail = Array.from({ length: 3 }, () => ({ x: 160, y: 90 }));
  const target = () => ({ ground: true, spriteActor: true, health: 50,
    update() {}, bounds: () => ({ x: 140, y: 100, w: 40, h: 30 }) });
  const [first, second] = [target(), target()];
  game.ground.push(first, second);
  game.update();
  assert.equal(first.health, 50);
  game.update({ fire: true });
  game.update({ fire: true });
  assert.deepEqual([first.health, second.health], [42, 50]);
  game.update();
  game.update({ fire: true });
  assert.equal(first.health, 42);
  game.update({ dive: true });
  game.update({ fire: true });
  assert.deepEqual([first.health, second.health], [38, 50]);
  game.update({ fire: true });
  assert.deepEqual([first.health, second.health], [38, 50]);
});

test("the purchased Bomb rises, holds over its blast, and hits a square without clearing enemy fire", () => {
  const game = shop();
  assert.ok(buy(game, 21).ok);
  game.openShop(game.stage);
  game.continueRun();
  game.inventory[0] = null;
  game.player.y = 96;
  const target = (x, y) => ({ ground: true, spriteActor: true, health: 50,
    update() {}, bounds: () => ({ x, y, w: 1, h: 1 }) });
  const [near, corner, outside] = [target(160, 30), target(191, 61), target(192, 30)];
  game.ground.push(near, corner, outside);
  game.bullets.push({ x: 180, y: 30, dx: 0, dy: -1 });
  for (let i = 0; i < 9; i++) game.update({ fire: true });
  const [bomb] = game.shots;
  assert.equal(bomb.y, 30);
  assert.ok(game.sprite(bomb.frame));
  assert.deepEqual(game.ground.map((enemy) => enemy.health), [50, 50, 50]);
  for (let i = 0; i < 3; i++) {
    game.update({ fire: true, right: true });
    assert.deepEqual(game.shots, [bomb]);
    assert.deepEqual([bomb.x, bomb.y], [160, 30]);
  }
  game.update({ fire: true });
  assert.equal(game.shots.length, 0);
  assert.deepEqual(game.ground.map((enemy) => enemy.health), [42, 42, 50]);
  assert.equal(game.bullets.length, 1);
  assert.equal(game.effects.length, 4);
  assert.ok(game.effects.every(({ x, y, frames }) => x >= 140 && x < 180 && y >= 10 && y < 50
    && Boolean(game.sprite(frames[0]))));
  for (let i = 0; i < 5; i++) game.update();
  assert.equal(game.effects.length, 0);
});

test("tapping fire cannot launch a second Bomb before the sixteen-tick reload", () => {
  const game = shop();
  assert.ok(buy(game, 21).ok);
  game.openShop(game.stage);
  game.continueRun();
  game.inventory[0] = null;
  game.player.y = 48;
  const launched = [];
  for (let tick = 0; tick <= 20; tick++) {
    game.update({ fire: tick % 2 === 0 });
    if (game.shots.some((shot) => shot.age === 1)) launched.push(tick);
  }
  assert.deepEqual(launched, [0, 16]);
});

test("the Flamer emits two animated plumes per held tick even between autofire pulses", () => {
  const game = shop();
  assert.ok(buy(game, 20).ok);
  game.openShop(game.stage);
  game.continueRun();
  game.player.y = 120;
  game.update({ fire: true });
  const [cosmetic, damaging] = game.shots;
  assert.equal(game.shots.length, 2);
  assert.deepEqual([cosmetic.damaging, damaging.damaging], [false, true]);
  assert.ok(cosmetic.y >= 86 && cosmetic.y <= 89);
  assert.ok(damaging.y >= 92 && damaging.y <= 95);
  const originalY = damaging.y, originalFrame = damaging.frame;
  game.update({ fire: true });
  assert.equal(game.shots.length, 4);
  assert.equal(damaging.y, originalY - 12);
  assert.notEqual(damaging.frame, originalFrame);
  assert.ok(game.sprite(damaging.frame));
  game.update();
  assert.equal(game.shots.length, 4);
  for (let i = 0; i < 6; i++) game.update();
  assert.equal(game.shots.length, 0);
});

test("only the damaging flame hits, and it stops at the first target for one to three damage", () => {
  for (const power of [0, 1, 2]) {
    const game = shop();
    assert.ok(buy(game, 20).ok);
    for (let i = 0; i < power; i++) assert.ok(buy(game, 12).ok);
    game.openShop(game.stage);
    game.continueRun();
    game.player.y = 120;
    const target = () => ({ ground: true, spriteActor: true, health: 50,
      update() {}, bounds: () => ({ x: 130, y: 80, w: 60, h: 20 }) });
    const [first, second] = [target(), target()];
    game.ground.push(first, second);
    game.update({ fire: true });
    assert.deepEqual([first.health, second.health], [49 - power, 50]);
    assert.deepEqual(game.shots.map((shot) => shot.damaging), [false]);
    game.update({ dive: true });
    game.update({ fire: true });
    assert.deepEqual([first.health, second.health], [48 - power * 2, 50]);
    game.update({ fire: true });
    assert.deepEqual([first.health, second.health], [48 - power * 2, 50]);
    assert.equal(game.shots.length, 2);
  }
});

test("purchased cannons track the four original mounts and launch a recoil-triggered round", () => {
  const game = shop();
  for (let i = 0; i < 4; i++) assert.equal(buy(game, 15).ok, true);
  const weapons = game.inventory.slice(1, 5);
  game.openShop(game.stage);
  game.continueRun();
  game.player.y = 90;
  assert.ok(weapons.every((weapon) => cannonFrame(game, weapon).offset === 0x861e));
  game.update({ fire: true });
  assert.ok(weapons.every((weapon) => cannonFrame(game, weapon).offset === 0x86ce));
  assert.equal(game.shots.filter((shot) => shot.cannon).length, 0);
  game.update({ right: true });
  assert.ok(weapons.every((weapon) => cannonFrame(game, weapon).offset === 0x877e));
  const rounds = game.shots.filter((shot) => shot.cannon);
  assert.deepEqual(rounds.map((shot) => [shot.x - game.player.x, shot.y - game.player.y]),
    [[44, 3], [-44, 3], [26, -5], [-26, -5]]);
  assert.ok(rounds.every((shot) => shot.damage === 2 && !shot.radius && shot.frame.offset === 0x849e));
  game.update();
  assert.ok(rounds.every((shot) => shot.frame.offset === 0x84fe));
});

test("missile launchers follow the auxiliary slots and fire from both barrels after opening", () => {
  const game = shop();
  buy(game, 18);
  buy(game, 17);
  game.openShop(game.stage);
  game.continueRun();
  game.player.y = 90;
  const mount = () => weaponAttachment(game, 2, game.inventory[2]);
  assert.deepEqual([mount().x, mount().y], [186, 106]);
  game.update({ fire: true });
  assert.equal(frameAt(mount().frames, mount().age).offset + 8, 0x96c0);
  game.update();
  assert.equal(frameAt(mount().frames, mount().age).offset + 8, 0x9770);
  assert.deepEqual(game.shots.filter((shot) => shot.frames).map((shot) => [shot.x, shot.y]),
    [[183, 81], [191, 81]]);
});

test("purchased lasers widen with power, damage only their current width, and detach from the ship", () => {
  for (const [power, width, damage] of [[0, 8, 3], [1, 12, 6], [2, 16, 9]]) {
    const game = shop();
    assert.ok(buy(game, 18).ok);
    game.inventory[0].power = 2;
    for (let i = 0; i < power; i++) assert.ok(buy(game, 12).ok);
    game.openShop(game.stage);
    game.continueRun();
    game.inventory[0] = null;
    game.player.y = 100;
    const target = (x) => ({ ground: true, spriteActor: true, health: 50,
      update() {}, bounds: () => ({ x, y: 92, w: 1, h: 1 }) });
    const [inside, outside] = [target(134 + width / 2), target(135 + width / 2)];
    game.ground.push(inside, outside);
    game.update({ fire: true });
    const [shot] = game.shots;
    assert.deepEqual([shot.x, shot.y, shot.beam.width], [135 - width / 2, 92, width]);
    assert.ok(shot.beam.caps.every((frame) => game.sprite(frame)));
    assert.equal(inside.health, 50 - damage);
    assert.equal(outside.health, 50);
    game.update({ right: true });
    assert.equal(shot.x, 138 - width / 2);
    assert.equal(shot.beam.length, 32);
    game.update({ right: true });
    game.update({ right: true });
    const detachedX = shot.x;
    assert.deepEqual([shot.y, shot.beam.length], [60, 65]);
    game.update({ right: true });
    assert.deepEqual([shot.x, shot.y], [detachedX, 28]);
    game.update();
    assert.equal(game.shots.includes(shot), false);
  }
});

test("purchased drones fire four, eight or twelve shots on held fire, independently of Laser pulses", () => {
  for (const [power, count] of [[0, 4], [1, 8], [2, 12]]) {
    const game = shop();
    assert.ok(buy(game, 19).ok);
    game.inventory[0].power = 2;
    for (let i = 0; i < power; i++) assert.ok(buy(game, 12).ok);
    assert.ok(buy(game, 18).ok);
    game.openShop(game.stage);
    game.continueRun();
    game.inventory[0] = null;
    game.player.y = 100;
    game.playerTrail = Array.from({ length: 3 }, () => ({ x: 160, y: 100 }));
    const lasers = [], volleys = [];
    for (let tick = 0; tick <= 16; tick++) {
      game.update({ fire: true, right: true });
      const fresh = game.shots.filter((shot) => shot.age === 1);
      if (fresh.some((shot) => shot.beam)) lasers.push(tick);
      const bolts = game.droneShots.filter((shot) => shot?.age === 1);
      if (bolts.length) {
        if (tick === 0) {
          const diagonal = power === 2 ? [172, 131, 7, 4] : [170, 135, 6, 6];
          assert.ok(bolts.some((shot) => [shot.x, shot.y, shot.dx, shot.dy]
            .every((value, i) => value === diagonal[i])));
        }
        volleys.push([tick, bolts.length]);
      }
    }
    assert.deepEqual(lasers, [0, 8, 16]);
    assert.deepEqual(volleys, [[0, count], [6, count], [12, count]]);
  }
});

test("the drone and electro ball trail the ship, and Side Shot and Bomb have no separate artwork", () => {
  for (const id of [11, 19]) {
    const game = shop();
    buy(game, id);
    game.openShop(game.stage);
    game.continueRun();
    game.player.y = 100;
    for (let i = 0; i < 5; i++) game.update({ up: true, right: true });
    const mount = weaponAttachment(game, 5, game.inventory[5]);
    assert.deepEqual([mount.x, mount.y], [166, 119]);
    assert.notEqual(mount.x, game.player.x);
  }
  for (const id of [10, 21, 23]) {
    const game = shop();
    assert.equal(buy(game, id).ok, true);
    const slot = game.inventory.findIndex((weapon) => weapon?.id === id);
    assert.equal(weaponAttachment(game, slot, game.inventory[slot]), undefined);
  }
});

test("bought protection halves consecutive hits and expires on the next shop visit", () => {
  const game = shop();
  assert.ok(buy(game, 24).ok);
  assert.ok(game.continueRun());
  game.damage(9);
  assert.equal(game.player.health, 35);
  game.damage(4);
  assert.equal(game.player.health, 33);
  assert.equal(game.player.protection, true);
  game.openShop(game.stage);
  assert.equal(game.player.protection, false);
});

test("dives consume charges and temporary buffs freeze when paused", () => {
  const game = shop();
  game.continueRun();
  game.player.dives = 1;
  game.update({ dive: true });
  assert.equal(game.player.dives, 0);
  assert.equal(game.diveTime, 136);
  game.player.nashwan = 10;
  game.player.shades = 10;
  game.togglePause();
  game.update();
  assert.equal(game.player.nashwan, 10);
  assert.equal(game.player.shades, 10);
  assert.equal(game.diveTime, 136);
});

test("the invulnerability reward extends one ring and only counts down at full exposure", () => {
  const game = shop();
  game.continueRun();
  game.map.fill(0);
  game.eventStreamsClosed = true;
  grantReward(game, 16);
  game.update();
  assert.equal(game.invincible, 169);
  const firstFrame = game.invulnerabilityRing.frame;
  grantReward(game, 16);
  game.update({ dive: true });
  assert.equal(game.invincible, 338);
  assert.notEqual(game.invulnerabilityRing.frame, firstFrame);
  game.update();
  assert.equal(game.invincible, 337);
  assert.equal(game.invulnerabilityRing.x, game.player.x);
  for (let i = 0; i < 16; i++) game.update();
  assert.equal(game.invincible, 337);
  assert.equal(game.invulnerabilityRing, undefined);
  game.update({ dive: true });
  for (let i = 0; i < 20; i++) game.update();
  assert.equal(game.divePhase, 0);
  assert.equal(game.invincible, 337, "the ring does not count down during the return ramp");
  game.update();
  assert.equal(game.invincible, 336);
  assert.equal(game.invulnerabilityRing.x, game.player.x);
  for (let i = 0; i < 336; i++) game.update();
  assert.equal(game.invincible, 0);
  assert.equal(game.invulnerabilityRing, undefined);
  game.damage();
  assert.equal(game.player.health, 31);
});

test("Shades apply 127 damage to the first target in range, not while diving or after expiration", () => {
  const game = shop();
  assert.ok(buy(game, 25).ok);
  game.continueRun();
  game.eventStreamsClosed = true;
  game.map.fill(0);
  game.player.y = 90;
  const target = (x) => ({ ground: true, spriteActor: true, health: 1000, update() {},
    bounds: () => ({ x, y: 90, w: 1, h: 1 }) });
  const outside = target(225), edge = target(224), closer = target(161);
  game.ground.push(outside, edge, closer);
  game.update({ dive: true });
  assert.deepEqual(game.ground.map((enemy) => enemy.health), [1000, 873, 1000]);
  game.update();
  assert.equal(game.player.shades, 218);
  assert.equal(edge.health, 873);
  game.divePhase = game.diveStep = game.diveTime = 0;
  game.player.shades = 1;
  game.update();
  assert.equal(edge.health, 746, "the last timer tick still damages the first target");
  game.update();
  assert.equal(edge.health, 746);
  assert.equal(closer.health, 1000);
});

test("supply pods preserve recovered reward IDs, frames and effects instead of always powering up", () => {
  const game = shop();
  for (const reward of assets.rewards) {
    assert.ok(reward.frames.length);
    for (const frame of reward.frames) assert.ok(assets.lookup[frame.bank].has(frame.offset));
  }
  game.player.health = 1;
  grantReward(game, 2);
  assert.equal(game.player.health, 21);
  grantReward(game, 3);
  assert.equal(game.player.health, 39);
  grantReward(game, 0);
  assert.equal(game.player.speed, 1);
  assert.equal(game.player.power, 1);
  grantReward(game, 4);
  assert.equal(game.inventory[5].id, 8);
  grantReward(game, 5);
  assert.equal(game.inventory[6].id, 10);
  assert.equal(game.inventory[5], null);
  game.spawn(assets.events.find((event) => event[1] !== 0));
  game.bullets.push({ x: 10, y: 10 });
  grantReward(game, 18);
  assert.ok(game.enemies.every((enemy) => enemy.dead));
  assert.equal(game.bullets.length, 0);
});
