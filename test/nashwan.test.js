import { test } from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/game.js";
import { buy } from "../src/shop.js";
import { weaponAnchor } from "../src/weapons.js";
import { ActorList } from "../src/actor-pool.js";
import { Renderer } from "../src/renderer.js";
import { loadTestCampaign } from "./helpers.js";

const assets = loadTestCampaign();
function equipped() {
  const game = new Game(assets);
  game.start();
  game.resetDive();
  game.inventory = [{ id: 21, power: 0 }, { id: 18, power: 1 }, null, null, null,
    { id: 8, power: 1 }, null];
  game.syncPower();
  game.credits = 10000;
  game.openShop(1);
  return game;
}

test("Super Nashwan buys a timed loan of seven original mounts, not a spread or permanent upgrades", () => {
  const game = equipped(), saved = game.inventory;
  const original = structuredClone(saved);
  assert.equal(buy(game, 6).ok, true);
  assert.equal(game.credits, 9400);
  assert.equal(game.inventory, saved);
  game.continueRun();
  assert.deepEqual(game.inventory, [14, 15, 15, 18, 18, 19, 10].map((id, i) =>
    ({ id, power: i === 1 || i === 2 ? 0 : 2 })));
  game.invincible = 999;
  for (let i = 0; i < 169; i++) game.update();
  assert.equal(game.player.nashwan, 1);
  assert.notEqual(game.inventory, saved);
  game.togglePause();
  game.update();
  assert.equal(game.player.nashwan, 1);
  game.togglePause();
  game.update();
  assert.equal(game.player.nashwan, 0);
  assert.equal(game.inventory, saved);
  assert.deepEqual(game.inventory, original);
  const expiry = game.nashwanExpiryFrame;
  assert.ok(expiry);
  game.togglePause();
  game.update();
  assert.equal(game.nashwanExpiryFrame, expiry);
  game.togglePause();
  game.update();
  assert.equal(game.nashwanExpiryFrame, undefined);
});

for (const stage of [2, 4]) test(`stage ${stage} dying Nashwan expiry paints loan overlays before the Drone`, () => {
  const game = new Game(assets);
  game.start(stage);
  const camera = stage === 2 ? 1000 : 3900;
  game.assets = { ...game.assets, events: [], background: [[camera, 3, 3, 0, 248, camera + 108, 1]] };
  game.camera = game.endCamera = camera;
  game.player.y = 120;
  const paid = game.inventory;
  game.credits = 10000;
  game.openShop(stage);
  assert.ok(buy(game, 6).ok);
  game.continueRun();
  game.resetDive();
  game.player.nashwan = 1;
  game.run.droneShots[0] = { x: 152, y: 160, dx: 0, dy: 0, age: 0 };
  game.killPlayer();
  game.update();

  assert.equal(game.inventory, paid);
  assert.equal(game.actorLists.get(ActorList.transient).length, 0);
  assert.equal(game.ground.length, 1);
  assert.ok(game.actorPaint);
  const overlays = game.assets.logic.cannon.overlay.map((frame) => game.sprite(frame));
  const empty = game.sprite(game.assets.logic.nashwan.meter[0]);
  const draws = [];
  const renderer = Object.assign(Object.create(Renderer.prototype), {
    assets: game.assets, map: game.map, mapRevision: game.mapRevision,
    world: { getContext: () => ({ drawImage() {} }) },
    tileImages: [], maskedTiles: [],
    context: {
      ...Object.fromEntries(["drawImage", "save", "beginPath", "rect", "clip", "restore",
        "fillText"].map((name) => [name, () => {}])),
      fillRect(x, y, w, h) { if (x === 152 && y === 160 && w === 2 && h === 2) draws.push("Drone"); },
    },
    drawSprite(sprite, x, y) {
      if (overlays.includes(sprite)) draws.push("overlay");
      if (sprite === empty && x === 152 && y === 160) draws.push("meter");
    },
  });
  renderer.draw(game);
  assert.deepEqual(draws, ["overlay", "overlay", "meter", "Drone"]);

  draws.length = 0;
  game.update();
  renderer.draw(game);
  assert.deepEqual(draws, ["Drone"]);
});

test("Nashwan restores real sale equipment at a shop and re-applies the remaining loan on departure", () => {
  const game = equipped(), saved = game.inventory;
  buy(game, 6);
  game.continueRun();
  game.update();
  game.openShop(1);
  assert.equal(game.inventory, saved);
  assert.equal(game.player.nashwan, 169);
  assert.equal(buy(game, 6).ok, false);
  assert.equal(buy(game, 8).ok, true);
  game.continueRun();
  assert.equal(game.inventory[5].id, 19);
  game.invincible = 999;
  for (let i = 0; i < 169; i++) game.update();
  assert.deepEqual(game.inventory[5], { id: 8, power: 2 });
  game.start();
  assert.equal(game.nashwan, undefined);
  assert.equal(game.player.nashwan, 0);
});

test("Nashwan fires animated cannons, pulsed lasers and twelve-way drone volleys without the invented fan", () => {
  const game = equipped();
  buy(game, 6);
  game.continueRun();
  game.invincible = 999;
  game.player.y = 90;
  game.playerTrail = Array.from({ length: 3 }, () => ({ x: 160, y: 90 }));
  game.update({ fire: true });
  assert.equal(game.droneShots.filter(Boolean).length, 12);
  assert.equal(game.shots.filter((s) => s.beam).length, 2);
  assert.equal(game.shots.filter((s) => s.originalSprite).length, 4);
  assert.ok(game.shots.every((s) => s.sprite !== 63));
  assert.equal(game.shots.filter((s) => s.frames).length, 0);
  game.update({ fire: true });
  const cannonShots = game.shots.filter((s) => s.frames);
  assert.equal(cannonShots.length, 2);
  assert.deepEqual(cannonShots.map((s) => [s.x, s.dy, s.damage]), [[186, -10, 2], [134, -10, 2]]);
  const laser = game.shots.find((s) => s.beam);
  assert.equal(laser.beam.length, 32);
  game.update();
  assert.equal(laser.beam.length, 64);
  game.update();
  assert.equal(laser.beam.length, 65);
});

test("checkpoint markers during Nashwan update position and credits without saving the loan", () => {
  const game = equipped();
  game.continueRun();
  game.update();
  const paid = structuredClone(game.inventory);
  game.openShop(1);
  buy(game, 6);
  game.continueRun();
  game.camera = 4033;
  game.update();
  assert.equal(game.checkpoint.camera, 4032);
  const credits = game.credits;
  assert.equal(game.checkpoint.credits, credits);
  game.credits += 125;
  game.invincible = 0;
  game.player.health = 8;
  game.damage(8);
  for (let i = 0; i < 16; i++) game.update();
  assert.equal(game.player.lives, 2);
  assert.equal(game.credits, credits);
  assert.equal(game.inventory[0].id, 14);
  assert.deepEqual(game.nashwan.inventory, paid);
  assert.equal(game.continueRun(), true);
  game.invincible = 999;
  for (let tick = 0; tick < 170 && game.player.nashwan; tick++) game.update();
  assert.deepEqual(game.inventory, paid);
});

test("the stage-two Nashwan volleys don't reuse the temporary starter until its visit", () => {
  const game = new Game(assets);
  game.start(2);
  game.assets = { ...game.assets, events: [], background: [] };
  game.credits = 10000;
  game.openShop(2);
  assert.ok(buy(game, 6).ok);
  game.continueRun();
  const mounts = game.actorLists.get(ActorList.mounts);
  const starter = mounts.find(({ actor }) => actor.dead && actor.weapon.id === 1);
  assert.ok(starter);
  game.invincible = 999;
  game.posture = 0;
  game.update({ fire: true });

  const transient = game.actorLists.get(ActorList.transient);
  assert.deepEqual(transient.map(({ type }) => type), [0x24, 0x24, 0x10, 0x10, 0x10, 0x10, 0x40, 0x40]);
  assert.ok(transient.every(({ address }) => address !== starter.address));
  assert.equal(game.run.actorPool.free.at(-1), starter.address);
  game.posture = 0;
  game.update({ fire: true });
  assert.deepEqual(transient.slice(0, 2).map(({ type }) => type), [0x30, 0x30]);
  assert.equal(transient[1].address, starter.address);
});

test("the Nashwan drone trails the ship by the original three saved positions", () => {
  const game = equipped();
  buy(game, 6);
  game.continueRun();
  game.invincible = 999;
  const positions = [];
  for (let tick = 0; tick < 7; tick++) {
    game.update({ right: true });
    positions.push({ x: game.player.x, y: game.player.y });
    const { x, y } = tick < 3 ? { x: 160, y: 174 } : positions[tick - 3];
    assert.deepEqual(weaponAnchor(game, 5, game.inventory[5]), { x, y: y + 25 });
  }
});
