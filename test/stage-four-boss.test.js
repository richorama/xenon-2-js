import { test } from "node:test";
import assert from "node:assert/strict";
import { ActorList } from "../src/actor-pool.js";
import { Game } from "../src/game.js";
import { grantReward } from "../src/shop.js";
import { loadTestCampaign } from "./helpers.js";

const campaign = loadTestCampaign();

function arena(camera) {
  const game = new Game(campaign);
  game.start(4);
  game.assets = { ...game.assets, events: [], background: game.assets.background.filter((e) => e[1] === 4) };
  game.camera = game.control.camera = game.control.ceiling = camera;
  game.endCamera = 0;
  game.invincible = 999;
  game.shipTouchesTerrain = () => false;
  game.randomWord = () => 0;
  return game;
}

function shoot(game, actor, damage) {
  const { x, y, w, h } = actor.bounds();
  game.shots.push({ x: x + Math.floor(w / 2), y: y + Math.floor(h / 2), dx: 0, dy: 0, damage, point: true });
}

test("the stage-four final encounter is scheduled once at camera 144 instead of ending at the wave floor", () => {
  const game = arena(225);
  for (let i = 0; i < 80; i++) game.update();
  assert.equal(game.camera, 145);
  assert.equal(game.boss.parts.length, 0);
  assert.equal(game.status, "playing");
  game.update();
  assert.equal(game.boss.parts.length, 19);
  assert.equal(game.boss.targets[0].bounds().w, 0);
  const parts = game.boss.parts;
  for (let i = 0; i < 160; i++) game.update();
  assert.equal(game.boss.parts, parts);
  assert.equal(game.camera, 0);
  assert.equal(game.control.ceiling, 16);
  assert.equal(game.status, "playing");
});

test("stage-four boss turrets guard the core, survive Z and expose it only after both are destroyed", () => {
  const game = arena(0);
  game.update();
  const [core, left, right] = game.boss.parts;
  game.update();
  grantReward(game, 18);
  assert.equal(left.health, 50);
  assert.equal(core.health, 100);
  shoot(game, left, 1);
  game.update();
  assert.equal(left.health, 49);
  assert.ok(left.hit);
  shoot(game, left, 49);
  game.update();
  assert.equal(left.indestructible, true);
  assert.equal(game.boss.turrets, 1);
  assert.equal(core.bounds().w, 0);
  shoot(game, right, 50);
  game.update();
  assert.equal(game.boss.turrets, 0);
  game.update();
  assert.equal(core.bounds().w, 25);
});

test("the sweep extends, curves, retracts and fires separately from the animated turret rounds", () => {
  const game = arena(0);
  let rounds = false, extent = 0;
  for (let i = 0; i < 160; i++) {
    game.update();
    rounds ||= game.bullets.some((round) => round.frames?.length > 1);
    if (game.boss.parts[3].length) {
      const { x, y } = game.boss.parts.at(-1).motion;
      extent = Math.max(extent, Math.hypot(x - 160, y - game.boss.parts[3].motion.y));
    }
  }
  assert.ok(rounds);
  assert.ok(extent > 100);
  assert.equal(game.boss.parts[3].length, 0);
  assert.equal(game.boss.parts.at(-1).bounds().w, 0);
});

test("the linked final arena survives a checkpoint and its sweep consumes Cannon rounds", () => {
  const game = arena(0);
  game.update();
  const main = () => game.actorLists.get(ActorList.main);
  const slots = main().slice();
  assert.equal(slots.length, 19);
  game.update();
  game.hitWithWeapon(game.boss.parts[1], { damage: 50 });
  game.setCheckpointPosition(game.camera);
  game.restoreCheckpoint();
  assert.deepEqual(main(), slots);
  assert.equal(game.boss.parts[1].indestructible, true);

  const head = game.boss.parts[3];
  game.boss.parts[0].phase = 8;
  game.update();
  const { x, y } = head.box;
  const cannon = { cannon: true, damage: 2, x, y };
  game.addPlayerRound(cannon, 0x30);
  game.hitPlayerRound(cannon, { x, y, w: 1, h: 1 });
  assert.equal(cannon.dead, true);
});

test("after its head slot is reused, the sweep follows the disabled turret's signed heading", () => {
  const game = arena(0);
  game.update();
  const { actorPool: pool } = game.run;
  const [turret, head, limb] = game.boss.parts.slice(2, 5);
  pool.release(game.actorLists, ActorList.main, pool.recordsByAddress.get(head.actorAddress));
  game.destroy(turret);

  assert.equal(game.effects[0].actorAddress, head.actorAddress);
  const carry = game.updateStageFourMainActor(pool.recordsByAddress.get(limb.actorAddress), 0x5a5a);
  assert.deepEqual(limb.motion, { x: 179, y: 31 });
  assert.equal(limb.length, 3);
  assert.equal(carry, 255);
});

test("a self-reused final turret blast keeps its first frame and moves with the arena", () => {
  const game = arena(0);
  const { actorPool: pool } = game.run;
  pool.free.splice(0, pool.free.length - 19);
  game.boss.spawn(game);
  const slots = game.actorLists.get(ActorList.main);
  const [turretSlot] = slots.splice(1, 1);
  slots.unshift(turretSlot);
  game.hitWithWeapon(turretSlot.actor, { damage: 50 });

  const blastSlot = pool.recordsByAddress.get(turretSlot.address);
  const blast = blastSlot.actor, { x, y } = blast;
  assert.equal(blastSlot.type, 0x0c);
  assert.equal(blastSlot.list, ActorList.transient);
  assert.equal(pool.headings.get(blastSlot.address), 0xffff);
  for (let i = 0; i < blast.frames.length + 2; i++) {
    game.boss.scrollY = 2;
    game.updateTransientActor(blastSlot);
  }

  assert.ok(!blast.dead);
  assert.equal(blast.age, 0);
  assert.equal(blast.y, y + 2 * (blast.frames.length + 2));
  assert.deepEqual(blast.box, { x: x + 6, y: blast.y + 6, w: 21, h: 21 });
});

test("core death preserves map-only machinery and projectiles and gates stage five on twenty credits", () => {
  const game = arena(0);
  game.update();
  const [core, left, right] = game.boss.parts;
  game.destroy(left);
  game.destroy(right);
  game.update();
  const bullet = { x: 8, y: 120, dx: 0, dy: 0 };
  game.bullets.push(bullet);
  const mapActor = { dead: false, definition: {}, update: () => [] };
  game.scenery.push(mapActor);
  shoot(game, core, 100);
  game.update();
  assert.equal(game.boss.dead, true);
  assert.equal(game.countedCredits, 20);
  assert.equal(game.effects.length, 22);
  assert.ok(game.scenery.includes(mapActor));
  assert.ok(game.bullets.includes(bullet));
  assert.equal(game.status, "playing");
  for (const credit of game.pickups) Object.assign(credit, { y: 199, state: 0 });
  game.update();
  assert.equal(game.status, "shop");
  assert.equal(game.shopStage, 5);
  delete game.randomWord;
  assert.ok(game.continueRun());
  assert.equal(game.stage, 5);
});
