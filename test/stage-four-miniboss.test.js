import { test } from "node:test";
import assert from "node:assert/strict";
import { ActorList } from "../src/actor-pool.js";
import { Game } from "../src/game.js";
import { grantReward } from "../src/shop.js";
import { loadTestCampaign } from "./helpers.js";

const campaign = loadTestCampaign();

function arena(camera = 2350) {
  const game = new Game(campaign);
  game.start(4);
  game.assets = { ...game.assets, events: [], background: game.assets.background.filter((e) => e[1] === 2) };
  game.camera = game.control.camera = game.control.ceiling = camera;
  game.invincible = 999;
  game.shipTouchesTerrain = () => false;
  return game;
}

function shoot(game, actor) {
  const { x, y, w, h } = actor.bounds();
  game.shots.push({ x: x + Math.floor(w / 2), y: y + Math.floor(h / 2),
    dx: 0, dy: 0, damage: 127, point: true });
}

test("the stage-four miniboss assembles twenty parts and holds progression at its arena floor", () => {
  const game = arena(2673);
  game.update();
  assert.equal(game.miniboss.parts.length, 20);
  assert.equal(game.boss.parts.length, 0);
  for (let i = 0; i < 600; i++) game.update();
  assert.equal(game.camera, 2176);
  assert.equal(game.control.ceiling, 2480);
  assert.equal(game.status, "playing");
  assert.equal(game.miniboss.parts[4].health, 175);
});

test("the four fixed guns reject edge hits while Z spares the entire encounter", () => {
  const game = arena();
  game.update();
  game.update({ down: true });
  const gun = game.miniboss.parts[16];
  assert.ok(gun.box.y >= 0);
  grantReward(game, 18);
  assert.equal(gun.health, 20);
  game.control.scrollDirection = -1;
  const y = gun.box.y;
  const { x, w } = gun.box;
  game.shots.push({ x: x + Math.floor(w / 2), y: y - 1, dx: 0, dy: 0, damage: 127, point: true });
  game.update();
  assert.equal(gun.health, 20);
  assert.equal(game.shots.length, 0);
  shoot(game, gun);
  game.update();
  assert.equal(gun.dead, true);
  assert.equal(game.miniboss.remaining, 4);
  assert.equal(game.score, 300);
});

test("destroying the swept tail forces reverse; defeating all guards gates the same-stage shop", () => {
  const game = arena(2177);
  game.update();
  const { parts } = game.miniboss;
  game.destroy(parts[15]);
  assert.ok(parts.slice(6, 16).every((part) => part.dead));
  assert.equal(game.control.scrollDirection, -1);
  assert.equal(game.score, 1000);
  const camera = game.camera;
  for (let i = 0; i < 100; i++) game.update();
  assert.ok(game.camera > camera);
  for (const gun of parts.slice(16)) game.destroy(gun);
  game.update();
  assert.equal(parts[4].indestructible, false);
  assert.equal(parts[5].indestructible, false);
  game.hitWithWeapon(parts[5], { damage: 14 });
  assert.equal(parts[4].health, 161);
  assert.equal(parts[4].flashTick, game.tick);
  assert.equal(parts[5].flashTick, game.tick);
  game.hitWithWeapon(parts[4], { damage: 161 });
  assert.ok(game.actorLists.get(ActorList.main).length > 0);
  assert.ok(game.actorLists.get(ActorList.main).every(({ actor }) => actor.dead));
  assert.equal(game.endCamera, 0);
  assert.equal(game.camera, 2208);
  assert.equal(game.control.scrollDirection, 1);
  assert.equal(game.countedCredits, 10);
  assert.equal(game.score, 4200);
  assert.equal(game.status, "playing");
  for (const credit of game.pickups) Object.assign(credit, { y: 199, state: 0 });
  game.update();
  assert.equal(game.actorLists.get(ActorList.main).length, 0);
  assert.equal(game.status, "shop");
  assert.equal(game.shopStage, 4);
  assert.ok(game.continueRun());
  assert.equal(game.stage, 4);
});

test("a stage-four core gun hit damages its current predecessor after the core slot is reused", () => {
  const game = arena(2390);
  const miniboss = game.miniboss, pool = game.run.actorPool;
  miniboss.spawn(game);
  const [, , , limb, core, gun] = miniboss.parts;
  miniboss.remaining = 0;
  limb.health = 20;
  pool.release(game.actorLists, ActorList.main, pool.recordsByAddress.get(core.actorAddress));
  const blast = game.explode(212, 30, true, true);
  assert.equal(blast.address, core.actorAddress);

  game.hitWithWeapon(gun, { damage: 14 });

  assert.equal(limb.health, 6);
  assert.equal(core.health, 175);
  assert.equal(limb.flashTick, game.tick);
  assert.equal(gun.flashTick, game.tick);
  assert.equal(blast.actor.flashTick, undefined);
  game.hitWithWeapon(gun, { damage: 6 });
  assert.ok(miniboss.dead);
  assert.equal(game.countedCredits, 10);
  assert.equal(game.score, 2000);
});

test("the swept tail destroys the live linked chain after a limb's slot becomes an explosion", () => {
  const game = arena(2390);
  const miniboss = game.miniboss, pool = game.run.actorPool;
  miniboss.spawn(game);
  const { parts } = miniboss, gap = parts[11];
  pool.release(game.actorLists, ActorList.main, pool.recordsByAddress.get(gap.actorAddress));
  const blast = game.explode(212, 30, true, true);
  assert.equal(blast.address, gap.actorAddress);

  game.hitWithWeapon(parts[15], { damage: 127 });

  const main = game.actorLists.get(ActorList.main);
  assert.deepEqual(main.filter(({ actor }) => actor.dead).map(({ actor }) => actor.index),
    [5, 6, 7, 8, 9, 10, 12, 13, 14, 15]);
  assert.ok(!blast.actor.dead);
  assert.equal(miniboss.remaining, 4);
  assert.equal(game.control.scrollDirection, -1);
  assert.equal(game.score, 1000);
});
