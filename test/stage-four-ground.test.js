import { test } from "node:test";
import assert from "node:assert/strict";
import { ActorList } from "../src/actor-pool.js";
import { Game } from "../src/game.js";
import { Renderer } from "../src/renderer.js";
import { grantReward } from "../src/shop.js";
import { StageFourCorridorPod } from "../src/stage-four-ground.js";
import { loadTestCampaign } from "./helpers.js";

const campaign = loadTestCampaign();

function corridor(camera, elapsed = 15) {
  const game = new Game(campaign);
  game.start(4);
  game.assets = { ...game.assets, events: [], background: [] };
  game.camera = game.control.camera = camera;
  game.control.ceiling = camera + 16;
  game.tick = game.run.formationClock.tick = elapsed;
  game.shipTouchesTerrain = () => false;
  return game;
}

test("the stage-four corridor clamps reversal and admits a timed ship at either inclusive boundary", () => {
  for (const [camera, elapsed, x, ceiling] of [[3665, 15, 32, 3680], [2785, 47, 288, 2800]]) {
    const game = corridor(camera, elapsed);
    game.update();
    const [ship] = game.ground;
    assert.deepEqual(ship.motion, { x, y: -27 });
    assert.ok(ship.bounds().w);
    assert.equal(game.stageWaves, 0);
    assert.equal(game.control.ceiling, ceiling);
  }
  for (const [camera, ceiling] of [[3666, 3681], [3569, 3568], [2784, 2799]]) {
    const game = corridor(camera, camera === 3569 ? 16 : 15);
    game.update();
    assert.equal(game.ground.length, 0);
    assert.equal(game.control.ceiling, ceiling);
  }
});

test("a corridor pod survives Z, releases one damageable drone and awards one small globe", () => {
  const game = corridor(2785);
  for (let i = 0; i < 8; i++) game.update();
  const pod = game.bullets.find((bullet) => bullet instanceof StageFourCorridorPod);
  assert.ok(pod);
  const { actorPool: pool } = game.run;
  const podSlot = pool.recordsByAddress.get(pod.actorAddress);
  grantReward(game, 18);
  assert.ok(game.bullets.includes(pod));
  assert.equal(game.score, 300);
  game.update();
  while (game.tick < 44 && !game.ground.length) game.update();
  const [drone] = game.ground;
  assert.equal(drone.motion.x, 42);
  assert.equal(drone.bounds().w, 0);
  game.update();
  assert.ok(drone.bounds().w);
  game.hitWithWeapon(drone, { damage: 2 });
  assert.equal(game.score, 400);
  assert.deepEqual(game.pickups.map(({ value, counted }) => [value, Boolean(counted)]), [[50, false]]);
  for (let i = 0; i < 10 && !pod.exploding; i++) game.update();
  assert.ok(pod.exploding);
  assert.equal(pool.recordsByAddress.get(pod.actorAddress), podSlot);
  assert.equal(podSlot.type, 0x0c);
  for (let i = 0; i < 25; i++) game.update();
  assert.equal(game.ground.length, 0);
  assert.ok(!game.bullets.includes(pod));
  assert.ok(!game.actorLists.get(ActorList.transient).includes(podSlot));
});

test("recycled corridor slots retain shot fractions and the launcher's second fire counter", () => {
  const game = corridor(3000, 960);
  game.endCamera = game.camera;
  game.seed = 0x5844;
  const pool = game.run.actorPool;
  const advance = (tick) => {
    while (game.tick < tick) {
      game.divePhase = 4;
      game.update();
    }
  };

  advance(1075);
  const shotAddress = pool.free.at(-1);
  const previous = pool.recordsByAddress.get(shotAddress);
  assert.equal(previous.type, 0x14);
  assert.ok(previous.actor.dead);
  advance(1076);
  const shot = pool.recordsByAddress.get(shotAddress).actor;
  assert.notEqual(shot, previous.actor);
  assert.deepEqual([shot.x, shot.y, shot.direction], [62, 97, 10]);

  advance(1247);
  const launcherAddress = pool.free.at(-1);
  advance(1248);
  const launcher = pool.recordsByAddress.get(launcherAddress).actor;
  assert.equal(launcher.definition.type, 0xcc);
  assert.equal(launcher.shotCounter, 254);
});

test("defeating either stage-four core clears the corridor but preserves linked pods", () => {
  for (const [kind, coreIndex] of [["miniboss", 4], ["boss", 0]]) {
    const game = corridor(2785);
    for (let i = 0; i < 8; i++) game.update();
    const [ship] = game.ground;
    const pod = game.bullets.find((actor) => actor instanceof StageFourCorridorPod);
    assert.ok(ship && pod);

    const encounter = game[kind];
    encounter.spawn(game);
    encounter.destroy(encounter.parts[coreIndex], game);

    assert.equal(game.ground.length, 0);
    const shipSlot = game.run.actorPool.recordsByAddress.get(ship.actorAddress);
    if (kind === "miniboss") {
      assert.equal(shipSlot.list, ActorList.main);
      assert.ok(ship.dead);
    } else assert.notEqual(shipSlot.list, ActorList.main);
    assert.ok(game.actorLists.get(ActorList.transient).some(({ actor }) => actor === pod));
  }
});

function scene(type, side, offset) {
  const game = new Game(campaign);
  game.start(4);
  const event = game.assets.background.find((e) => e[1] === type && e[6] === side).slice();
  const camera = event[5] - offset;
  event[0] = camera;
  game.assets = { ...game.assets, events: [], background: [event] };
  game.camera = game.control.camera = game.control.ceiling = camera;
  game.endCamera = 0;
  game.shipTouchesTerrain = () => false;
  return game;
}

test("stage-four camera events withhold wall actors, map patches and arena parts until the next draw", () => {
  for (const type of [2, 4]) {
    const game = new Game(campaign);
    game.start(4);
    const arena = game.assets.background.find((event) => event[1] === type);
    const camera = arena[0];
    game.camera = game.control.camera = camera + 1;
    game.control.ceiling = camera + 16;
    if (type === 4) game.endCamera = 0;
    game.player.x = 300;
    game.player.y = 24;
    game.shipTouchesTerrain = () => false;
    game.assets = { ...game.assets, events: [[camera, 3, 1, 23, 0, 0, 3]], background: [
      [camera, 1, 0, 0, 104, camera + 80, 0],
      [camera, 3, 0, 0, 56, camera + 68, 0],
      [camera, 5, 0, 0, 248, camera + 152, 1],
      arena,
    ] };
    const sprites = [], overlays = [], tiles = [];
    const renderer = Object.assign(Object.create(Renderer.prototype), {
      assets: game.assets, map: game.map, mapRevision: 0,
      world: { getContext: () => ({ drawImage: (...args) => tiles.push(args) }) },
      tileImages: game.assets.tiles.map((_, i) => i),
      context: Object.fromEntries(["drawImage", "save", "beginPath", "rect", "clip", "restore", "fillRect", "fillText"]
        .map((name) => [name, () => {}])),
      drawShip() {},
      drawSprite(sprite) { sprites.push(sprite); },
      drawOverlay(region) { if (region) overlays.push(region); },
    });

    game.update();

    const [gun, hunter] = game.ground, [ram] = game.scenery, [enemy] = game.enemies;
    const encounter = type === 2 ? game.miniboss : game.boss;
    assert.equal(encounter.parts.length, type === 2 ? 20 : 19);
    assert.deepEqual([enemy.age, gun.fireCounter, hunter.phase, ram.counter], [0, 0, 0, 0]);
    assert.equal(gun.bounds(game.camera).w, 0);
    if (type === 2) assert.equal(game.checkpoint.camera, encounter.definition.reverseLimit);
    else assert.equal(encounter.parts[1].bounds().w, 0);
    renderer.draw(game);
    assert.deepEqual([sprites, overlays, tiles], [[], [], []]);

    game.update();

    assert.equal(enemy.age, 1);
    assert.ok(gun.fireCounter);
    assert.ok(gun.bounds(game.camera).w);
    assert.ok(ram.counter);
    if (type === 4) assert.ok(encounter.parts[1].bounds().w);
    renderer.draw(game);
    assert.ok(sprites.includes(game.sprite(hunter.frame)));
    assert.ok(sprites.includes(game.sprite(ram.frame)));
    assert.ok(sprites.includes(game.sprite(game.enemyFrame(enemy))));
    assert.ok(tiles.some(([tile, x]) => tile === game.map[gun.cell] >>> 6 && x === gun.x));
    if (type === 2) assert.ok(encounter.parts.every((part) => sprites.includes(game.sprite(part.frame))));
    else assert.ok(overlays.some((region) => region.width === 6));
  }
});

test("stage-four linked formation paint precedes camera births and lethal Drone drops", () => {
  const game = corridor(3900);
  game.endCamera = game.camera;
  game.assets.events = [[3900, 1, 1, 1, 0, 0, 3]];
  game.assets.paths = { bytes: new Uint8Array(Int16Array.of(10, 100, 80, 4, 180, 0).buffer), offsets: [0] };
  const drawn = [];
  const renderer = Object.assign(Object.create(Renderer.prototype), {
    assets: game.assets, map: game.map, mapRevision: game.mapRevision,
    context: Object.fromEntries(["drawImage", "save", "beginPath", "rect", "clip", "restore", "fillRect", "fillText"]
      .map((name) => [name, () => {}])),
    drawSprite() {},
    drawForeground(_game, actor) { drawn.push(actor.actorAddress); },
    drawPickup() { drawn.push("credit"); },
    drawEffect() { drawn.push("blast"); },
  });
  const paint = () => {
    drawn.length = 0;
    renderer.draw(game);
    return drawn.slice();
  };

  game.update();
  const [enemy] = game.enemies;
  const [attachment] = enemy.children;
  const addresses = [enemy.actorAddress, attachment.actorAddress];
  assert.deepEqual(game.actorLists.get(ActorList.main).map(({ address }) => address), addresses);
  assert.deepEqual(paint(), []);

  enemy.health = 1;
  const { x, y, w, h } = game.targetBounds(attachment);
  game.addDroneVolley(x + (w >> 1), y + (h >> 1), [[0, 0, 0, 0]]);
  game.update();
  assert.ok(enemy.dead && attachment.dead);
  assert.deepEqual(paint(), addresses);

  game.update();
  assert.deepEqual(paint(), ["credit", "blast"]);
});

test("stage-four attachment hits follow a live, marked or freed round at the root address", () => {
  for (const state of ["live", "marked", "freed"]) {
    const released = state === "freed";
    const game = corridor(3900);
    game.endCamera = game.camera;
    game.spawn([3900, 1, 1, 1, 0, 0, 3], [256, 258]);
    const [root] = game.enemies;
    const [attachment] = root.children;
    const { actorPool: pool } = game.run;
    const free = pool.free.splice(0);
    const round = { x: 150, y: 80, dx: 0, dy: 0, direction: 2, fixed: true,
      frame: game.assets.logic.foregroundShot.frame };
    game.addPooledHostileRound(round, 0);
    pool.free.push(...free);
    assert.equal(round.actorAddress, root.actorAddress);
    game.update();
    assert.deepEqual([attachment.motion.x, attachment.motion.y], [150, 80]);

    if (state !== "live") round.dead = true;
    if (released) pool.release(game.actorLists, ActorList.transient, pool.recordsByAddress.get(round.actorAddress));
    const { x, y, w, h } = game.targetBounds(attachment);
    const impact = { x: x + (w >> 1), y: y + (h >> 1), w: 1, h: 1 };
    const shot = { x: impact.x, y: impact.y, point: true, dx: 0, dy: 0, damage: root.health - 1 };
    if (state === "live") {
      game.addPlayerRound(shot);
      game.update();
    } else game.hitPlayerRound(shot, impact);
    assert.ok(shot.dead);
    assert.equal(root.health, 1);
    assert.equal(attachment.flashTick, game.tick);
    const drawn = [];
    Renderer.prototype.drawTransient.call({
      drawEnemyRound: (_, actor) => drawn.push(actor),
    }, game, game.actorLists.get(ActorList.transient));
    assert.deepEqual(drawn, released ? [] : [round]);

    game.hitPlayerRound({ damage: 1 }, impact);
    assert.ok(attachment.dead);
    assert.equal(game.score, 400);
    assert.deepEqual(game.pickups.map(({ x, y, value }) => [x, y, value]), [[150, 80, 100]]);
    assert.equal(Boolean(game.effects[0].dead), released);
  }
});

test("stage-four hunters open, aim vertically once and return to their hatch with full health", () => {
  for (const side of [0, 1]) {
    const game = scene(3, side, -96);
    game.endCamera = game.camera;
    game.divePhase = 4;
    game.randomWord = () => 0;
    game.update();
    const [hunter] = game.ground;
    game.update();
    assert.equal(hunter.phase, 1);
    assert.equal(hunter.bounds().w, 0);
    game.update();
    assert.ok(hunter.bounds().w > 0);
    assert.equal(hunter.motion.x - hunter.baseX, side ? -6 : 6);
    for (let i = 0; i < 12; i++) game.update();
    assert.equal(hunter.phase, 2);
    const worldY = hunter.worldY;
    game.update();
    assert.equal(hunter.worldY, worldY + 6);
    hunter.health = 1;
    for (let i = 0; i < 90 && hunter.phase; i++) game.update();
    assert.equal(game.ground[0], hunter);
    assert.equal(hunter.phase, 0);
    assert.equal(hunter.worldY, hunter.baseY);
    assert.equal(hunter.health, 10);
  }
});

function contactScene(paths) {
  const game = corridor(3900);
  game.endCamera = game.camera;
  const words = paths.flatMap(([x, y]) => [10, x, y, 4, 90, 0]);
  game.assets.paths = { bytes: new Uint8Array(Int16Array.from(words).buffer), offsets: paths.map((_, i) => i * 12) };
  return game;
}

test("stage-four main contact uses the inclusive hull before steering, not the moved hull", () => {
  for (const [x, input, health] of [[181, { left: true }, 31], [183, { right: true }, 39]]) {
    const game = contactScene([[x, 174]]);
    game.spawn([3900, 3, 1, 1, 0, 0, 3]);
    const [wave] = game.enemies;
    game.update(input);
    assert.equal(game.player.health, health);
    assert.equal(game.shipHitFlash, health < 39);
    assert.equal(Boolean(wave.dead), health < 39);
    if (!wave.dead) {
      game.update(input);
      assert.equal(game.player.health, 39);
      game.update();
      assert.equal(game.player.health, 31);
      assert.ok(wave.dead);
    }
  }
});

test("stage-four first overlapping slot blocks lower entries even when marked or when Shades is active", () => {
  for (const [mode, health, leadKilled] of [
    ["ram", 23, true], ["protected", 31, true], ["invincible", 39, true], ["fatal", 0, false],
    ["marked", 23, false], ["shades", 39, true], ["shades-marked", 39, false],
  ]) {
    const game = contactScene([[160, 174]]);
    game.spawn([3900, 3, 1, 1, 0, 0, 3]);
    game.spawn([3900, 1, 1, 1, 0, 0, 3]);
    const [tail, lead] = game.enemies;
    if (mode.endsWith("marked")) lead.dead = true;
    if (mode === "fatal") game.player.health = 16;
    game.player.protection = mode === "protected";
    game.invincible = mode === "invincible" ? 9 : 0;
    game.player.shades = mode.startsWith("shades") ? 1 : 0;

    game.update();
    assert.equal(game.player.health, health, mode);
    assert.equal(game.shipHitFlash, health > 0 && health < 39, mode);
    assert.equal(game.kills, Number(leadKilled), mode);
    assert.equal(Boolean(tail.dead), false, mode);
  }
});

test("a stage-four mount fires after the wall gun and can reclaim its birth-tick round", () => {
  for (const capacity of [2, 3]) {
    const game = contactScene([[160, 80]]);
    const pool = game.run.actorPool;
    pool.free.splice(0, pool.free.length - capacity);
    game.assets.background = [[3900, 1, 0, 0, 104, 3980, 0]];
    game.dispatchCameraEvents();
    const [gun] = game.ground;
    gun.phase = 3;
    const hostileAddress = pool.free.at(-1);

    game.update({ fire: true });

    const [forward] = game.shots;
    const transients = game.actorLists.get(ActorList.transient);
    assert.deepEqual(transients.map(({ type }) => type), capacity === 2 ? [0x10] : [0x10, 0x14]);
    assert.equal(transients[0].actor, forward);
    assert.equal(forward.actorAddress === hostileAddress, capacity === 2);
    assert.deepEqual([forward.x, forward.y, forward.age], [160, 159, 1]);
  }
});

test("stage-four straight kills free their slot for the drop, but Cannon rounds keep hitting", () => {
  for (const cannon of [false, true]) {
    const game = contactScene([[160, 80]]);
    const pool = game.run.actorPool;
    pool.free.splice(0, pool.free.length - 2);
    game.spawn([3900, 3, 1, 1, 0, 0, 3], [256, 258]);
    const [enemy] = game.enemies;
    const frames = game.assets.logic.cannon.shot;
    const round = cannon ? { x: 160, y: 99, dy: -10, age: 0, damage: 2, cannon, frames, frame: frames[0] }
      : { x: 160, y: 84, dx: 0, dy: -9, age: 0, damage: 6, point: true };
    game.addPlayerRound(round, cannon ? 0x30 : 0x10);
    game.update();
    if (cannon) {
      assert.equal(enemy.health, 4);
      game.update();
      assert.equal(enemy.health, 2);
      assert.equal(pool.recordsByAddress.get(round.actorAddress).actor, round);
      assert.deepEqual([round.x, round.y], [160, 79]);
    } else {
      assert.ok(round.dead && enemy.dead);
      const { actor: drop } = pool.recordsByAddress.get(round.actorAddress);
      assert.equal(drop, game.pickups[0]);
      assert.equal(drop.value, 50);
      assert.equal(game.effects.length, 0);
    }
  }
});

test("a stage-four Laser skips the linked attachment on a root hit but can revisit an attachment hit first", () => {
  for (const [x, health] of [[152, 5], [162, 0]]) {
    const game = contactScene([[160, 80]]);
    game.spawn([3900, 1, 1, 1, 0, 0, 3]);
    const [root] = game.enemies;
    game.addPlayerRound({ x, y: 64, damage: 3, age: 0,
      beam: { parent: { x, y: 64 }, inset: 0, width: 16, length: -32 } }, 0x24);
    game.update();
    assert.equal(Boolean(root.dead), health === 0);
    if (health) assert.equal(root.health, health);
    assert.equal(game.score, health ? 0 : 400);
  }
});

test("a stage-four Laser resumes at a recycled successor in the transient list, not the next enemy", () => {
  const game = contactScene([[160, 80]]);
  const pool = game.run.actorPool;
  pool.free.splice(0, pool.free.length - 5);
  for (const type of [3, 1]) game.spawn([3900, type, 1, 1, 0, 0, 3], [256, 258]);
  const [tail, root] = game.enemies;
  root.health = 3;
  const free = pool.free.splice(0);
  const round = { x: 160, y: 80, dx: 0, dy: 0, direction: 2, fixed: true,
    frame: game.assets.logic.foregroundShot.frame };
  game.addPooledHostileRound(round, 0);
  assert.equal(round.actorAddress, root.actorAddress);
  pool.free.push(...free);
  const spent = pool.allocate(game.actorLists, ActorList.transient, 0x10, { dead: true }, null);
  game.addPlayerRound({ x: 158, y: 64, damage: 3, age: 0,
    beam: { parent: { x: 158, y: 64 }, inset: 0, width: 16, length: -32 } }, 0x24);
  game.update();

  assert.equal(game.score, 400);
  assert.equal(tail.health, 6);
  assert.equal(game.pickups[0].actorAddress, spent.address);
  assert.equal(game.pickups[0].age, 0);
  assert.ok(pool.free.includes(round.actorAddress));
});

test("stage-four area damage dispatches a recycled wall gun only when its saved bounds overlap", () => {
  for (const mode of ["survives", "dies", "miss"]) {
    const game = corridor(16, 0);
    game.assets.background = [[16, 1, 0, 0, 232, 96, 1]];
    game.assets.paths = { bytes: new Uint8Array(Int16Array.from([10, 161, 80, 4, 90, 0]).buffer), offsets: [0] };
    const pool = game.run.actorPool;
    pool.free.splice(0, pool.free.length - 3);
    game.spawn([16, 3, 1, 1, 0, 0, 3], [256, 258]);
    const [later] = game.enemies;
    game.dispatchCameraEvents();
    const [gun] = game.ground;
    game.updateGroundActor(gun, 0);
    if (mode === "dies") gun.health = 3;
    game.spawn([16, 0, 1, 1, 0, 0, 16], [272, 274]);
    game.enemies.at(-1).health = 3;
    game.hitMainArea({ damage: 3 }, { x: 120, y: 62, w: mode === "miss" ? 56 : 140, h: 48 });

    assert.equal(later.health, 6);
    const slot = pool.recordsByAddress.get(gun.actorAddress), { actor } = slot;
    if (mode === "dies") {
      assert.deepEqual([game.score, slot.type, actor.dead, actor.x, actor.y], [400, 0x0c, true, 177, 80]);
      assert.deepEqual([0, 1, 20, 21].map((offset) => game.map[gun.cell + offset]), gun.definition.death[0]);
    } else {
      assert.equal(actor.kind, "reward");
      assert.equal(gun.health, mode === "miss" ? 16 : 13);
      const renders = [];
      const renderer = Object.assign(Object.create(Renderer.prototype), {
        drawOverlay: (...args) => renders.push(args),
        drawSprite: (_, x, y) => renders.push([x, y]),
      });
      renderer.drawTransient(game, [slot]);
      game.tick++;
      game.updateTransientActor(slot);
      renderer.drawTransient(game, [slot]);
      assert.notEqual(actor.y, 80);
      assert.deepEqual(renders, mode === "miss" ? [[161, 80], [actor.x, actor.y]]
        : [[{ x: 160, y: 64, width: 2, tiles: gun.definition.initial[0] }, "vga-hit"]]);
    }
  }
});

test("stage-four area damage flashes both the recycled formation root and its surviving attachment", () => {
  const game = contactScene([[160, 80]]);
  const pool = game.run.actorPool;
  pool.free.splice(0, pool.free.length - 4);
  for (const [type, group, reward] of [[3, 256, 3], [1, 264, 3], [0, 272, 16]]) {
    game.spawn([3900, type, 1, 1, 0, 0, reward], [group, group + 2]);
  }
  const [later, root, pod] = game.enemies;
  const [attachment] = root.children;
  pod.health = 3;

  game.hitMainArea({ damage: 3 }, { x: 120, y: 62, w: 70, h: 48 });

  const { actor } = pool.recordsByAddress.get(root.actorAddress);
  assert.equal(actor.kind, "reward");
  assert.equal(root.health, root.parts[0].health - 3);
  assert.equal(actor.flashTick, game.tick);
  assert.equal(attachment.flashTick, game.tick);
  assert.equal(later.health, 6);
  assert.equal(later.flashTick, undefined);
});

function supplyAreaScene(camera, y) {
  const game = corridor(camera, 0), pool = game.run.actorPool;
  const words = [10, 161, y, 4, 90, 0];
  game.assets.paths = { bytes: new Uint8Array(Int16Array.from(words).buffer), offsets: [0] };
  pool.free.splice(0, pool.free.length - 3);
  game.spawn([camera, 3, 1, 1, 0, 0, 3], [256, 258]);
  return game;
}

function hitSupplyArea(game, damage, reward) {
  game.spawn([game.camera, 0, 1, 1, 0, 0, reward], [272, 274]);
  game.enemies.at(-1).health = damage;
  game.hitMainArea({ damage }, { x: 16, y: 62, w: 264, h: 70 });
}

test("a surviving hunter's inherited paint uses the reward index and world-relative sprite position", () => {
  const game = supplyAreaScene(960, 96);
  game.assets.background = [[960, 3, 0, 0, 136, 1042, 0]];
  game.dispatchCameraEvents();
  const [hunter] = game.ground;
  hunter.box = game.bounds(game.sprite(hunter.frame), hunter.motion.x, hunter.motion.y);

  hitSupplyArea(game, 3, 0);

  const [slot] = game.actorLists.get(ActorList.transient), reward = slot.actor;
  assert.equal(hunter.health, 7);
  assert.equal(slot.address, hunter.actorAddress);
  const draws = [];
  const renderer = Object.assign(Object.create(Renderer.prototype), {
    drawOverlay: (region) => draws.push(region),
    drawSprite: (_, x, y, __, mask) => draws.push([x, y, mask]),
  });
  renderer.drawTransient(game, [slot]);
  assert.deepEqual(draws.splice(0), [[161, -864, "vga-hit"]]);
  game.tick++;
  game.updateTransientActor(slot);
  renderer.drawTransient(game, [slot]);
  assert.deepEqual(draws, [[reward.x, reward.y - 960, false],
    { x: 32, y: 48, width: 1, tiles: hunter.definition.hatch[1] }]);
});

test("a recycled grouped drone flashes the reward or marks a lethal credit at that address", () => {
  for (const fatal of [false, true]) {
    const game = supplyAreaScene(3400, 80);
    const paths = game.assets.paths;
    game.assets.paths = campaign.stages[3].paths;
    const launch = new StageFourCorridorPod(game.assets.logic.corridor.pods[0], 92);
    Object.assign(launch, { frameIndex: 4, frameTicks: 1 });
    launch.step(game, {});
    game.assets.paths = paths;
    const [drone] = game.ground;
    drone.updateBounds(game);
    if (fatal) drone.health = 1;
    const health = drone.health;

    hitSupplyArea(game, 1, 16);

    const [slot] = game.actorLists.get(ActorList.transient), { actor } = slot;
    assert.equal(slot.address, drone.actorAddress);
    assert.equal(drone.health, health - 1);
    assert.equal(game.formationCredits.has(drone.formationId), !fatal);
    if (fatal) {
      assert.deepEqual([game.score, slot.type, actor.value, actor.dead], [100, 0x60, 50, true]);
      assert.deepEqual([actor.x, actor.y], [game.effects[0].x, game.effects[0].y]);
    } else {
      assert.equal(actor.kind, "reward");
      assert.equal(actor.flashTick, game.tick);
      assert.equal(game.score, 0);
    }
  }
});

test("stage-four Flamer plumes enter the linked list in paint order and are marked on ship death", () => {
  const game = contactScene([[160, 80]]);
  game.replaceWeapon(0, { id: 20, power: 0 });
  game.posture = 0;
  game.update({ fire: true });

  const plumes = game.actorLists.get(ActorList.transient);
  assert.deepEqual(plumes.map(({ type, actor }) => [type, actor.damaging, actor.age]),
    [[0xb4, false, 1], [0xb4, true, 1]]);

  game.killPlayer();
  game.update({ fire: true });
  assert.deepEqual(plumes.map(({ actor }) => [actor.dead, actor.age]), [[true, 1], [true, 1]]);
  game.update();
  assert.equal(plumes.length, 0);
});

test("a stage-four Bomb marks its replacement blast and uses that slot's position at capacity", () => {
  for (const full of [false, true]) {
    const game = contactScene([[160, 80]]);
    game.replaceWeapon(6, { id: 21, power: 0 });
    const pool = game.run.actorPool;
    if (full) pool.free.splice(0, pool.free.length - 2);
    game.assets.background = [[3900, 1, 0, 0, 136, 3981, 0]];
    game.dispatchCameraEvents();
    const [gun] = game.ground;
    gun.phase = 4;
    game.player.x = 104;
    game.player.y = 126;
    const { frames, damage } = game.assets.logic.bomb;
    const bomb = { x: 104, y: 48, age: 0, fuse: 1, frames, damage, bomb: true };
    game.addPlayerRound(bomb, 0x28);
    game.update();

    assert.ok(bomb.dead);
    if (full) {
      const { type, actor } = pool.recordsByAddress.get(bomb.actorAddress);
      assert.deepEqual([type, actor.dead, actor.x, actor.y], [0x0c, true, 104, 33]);
      assert.equal(game.effects.length, 0);
      assert.equal(gun.health, 16);
    } else {
      assert.equal(game.effects.length, 4);
      assert.ok(game.effects.every(({ age }) => age === 0));
      assert.equal(gun.health, 8);
    }
  }
});

test("a stage-four Mine marks the second occupant of its slot after a full-pool wall-gun kill", () => {
  const game = contactScene([[160, 80]]);
  const pool = game.run.actorPool;
  pool.free.splice(0, pool.free.length - 2);
  game.assets.background = [[3900, 1, 0, 0, 120, 3973, 0]];
  game.dispatchCameraEvents();
  const [gun] = game.ground;
  gun.phase = 4;
  gun.health = 4;
  const charge = { mine: true, x: 104, y: 48, age: 0, fuse: -1, power: 0,
    frames: game.assets.logic.mountFrames[9] };
  game.addPlayerRound(charge, 0x38);
  game.run.mineChargeCount = 1;
  game.update();

  assert.equal(game.score, 400);
  assert.equal(game.run.mineChargeCount, 0);
  const { type, actor } = pool.recordsByAddress.get(charge.actorAddress);
  assert.deepEqual([type, actor.dead, actor.large], [0x0c, true, true]);
  assert.equal(game.effects.length, 0);
});

test("a stage-four Homing Missile uses the pre-corridor count and keeps its live lock without RNG", () => {
  const game = corridor(3600);
  game.endCamera = game.camera;
  game.seed = 0x5844;
  game.assets.background = [104, 216].map((x) => [3600, 1, 0, 0, x, 3680, 0]);
  game.dispatchCameraEvents();
  const [firstGun] = game.ground;
  const missile = { x: 160, y: 150, direction: 0, phase: 0, age: 0, launch: true, homing: true };
  game.addPlayerRound(missile, 0x48);
  game.update();

  assert.equal(game.ground.length, 3);
  assert.equal(missile.targetAddress, firstGun.actorAddress);
  const seed = game.seed;
  game.update();
  assert.equal(missile.targetAddress, firstGun.actorAddress);
  assert.equal(game.seed, seed);
});

test("a stage-four Homing Missile can lock a linked arena part excluded from the population count", () => {
  const game = corridor(16, 0);
  game.endCamera = game.camera;
  game.assets.background = [campaign.stages[3].background.find((event) => event[1] === 4)];
  game.dispatchCameraEvents();
  const missile = { x: 160, y: 150, direction: 0, phase: 0, age: 0, launch: true, homing: true };
  game.addPlayerRound(missile, 0x48);
  game.update();

  assert.equal(game.shots[0], missile);
  assert.equal(missile.targetAddress, game.boss.parts[1].actorAddress);
  assert.ok(missile.y < 150);
  assert.equal(game.effects.length, 0);
});

test("a stage-four Electro Ball hits the wall gun ahead of an overlapping foreground slot", () => {
  const game = contactScene([[160, 120]]);
  game.spawn([3900, 3, 1, 1, 0, 0, 3], [256, 258]);
  game.assets.background = [[3900, 1, 0, 0, 160, 4018, 0]];
  game.dispatchCameraEvents();
  game.replaceWeapon(0, null);
  game.replaceWeapon(5, { id: 11, power: 0 });
  game.posture = 0;
  game.player.y = 90;
  game.playerTrail.fill({ x: 160, y: 90 });
  game.update({ fire: true });

  assert.equal(game.ground[0].health, 12);
  assert.equal(game.ground[0].flashTick, game.tick);
  assert.equal(game.enemies[0].health, 6);
});

test("stage-four wall guns flash their initial tile mask once, a frame later for Drone damage", () => {
  for (const drone of [false, true]) {
    const game = contactScene([[160, 80]]);
    game.assets.background = [[3900, 1, 0, 0, 104, 3980, 0]];
    game.dispatchCameraEvents();
    const [gun] = game.ground;
    gun.phase = 1;
    const shot = { x: 110, y: 80, dx: 0, dy: 0, age: 0, damage: 1, point: true };
    if (drone) game.droneShots[0] = shot;
    else game.addPlayerRound(shot);
    const overlays = () => {
      const drawn = [];
      Renderer.prototype.drawStageFourMain.call({ drawOverlay: (...args) => drawn.push(args) },
        game, game.actorPaint?.main ?? game.actorLists.get(ActorList.main), game.camera);
      return drawn;
    };

    game.update();
    const mask = [[{ x: 96, y: 72, width: 2, tiles: gun.definition.initial[0] }, "vga-hit"]];
    assert.notDeepEqual(gun.patches, gun.definition.initial[0]);
    assert.equal(gun.health, 15);
    assert.deepEqual(overlays(), drone ? [] : mask);
    game.update();
    assert.deepEqual(overlays(), drone ? mask : []);
    game.update();
    assert.deepEqual(overlays(), []);
  }
});

test("Z defeats a wall hunter without removing its hatch and releases a non-gating 100-credit globe", () => {
  const game = scene(3, 0, 68);
  game.randomWord = () => 255;
  game.update();
  const [hunter] = game.ground;
  grantReward(game, 18);
  assert.equal(game.score, 200);
  assert.equal(game.countedCredits, 0);
  assert.equal(game.effects.length, 1);
  const [credit] = game.pickups;
  assert.equal(credit.value, 100);
  const slots = game.actorLists.get(ActorList.transient);
  assert.deepEqual(slots.map(({ type }) => type), [0x18, 0x0c]);
  assert.equal(slots[0].actor, credit);
  const before = [credit.x, credit.y];
  game.update();
  assert.notDeepEqual([credit.x, credit.y], before);
  assert.equal(game.ground[0], hunter);
  assert.equal(hunter.health, 10);
});

test("stage-four Z follows the supply drop's reused slot and writes the gun's fallback tiles", () => {
  const game = contactScene([[160, 80]]);
  const pool = game.run.actorPool;
  pool.free.splice(0, pool.free.length - 3);
  game.spawn([3900, 3, 1, 1, 0, 0, 3], [256, 258]);
  const [later] = game.enemies;
  game.assets.background = [[3900, 1, 0, 0, 232, 3980, 1]];
  game.dispatchCameraEvents();
  const [gun] = game.ground;
  game.spawn([3900, 0, 1, 1, 0, 0, 16], [272, 274]);

  game.clearScreen();

  assert.equal(game.score, 400);
  assert.equal(later.health, 6);
  const { type, actor } = pool.recordsByAddress.get(gun.actorAddress);
  assert.deepEqual([type, actor.dead, actor.x, actor.y], [0x0c, true, 176, -3804]);
  assert.deepEqual([0, 1, 20, 21].map((offset) => game.map[gun.cell + offset]), gun.definition.death[0]);
});

test("stage-four Z resets a hunter's recycled credit to its hatch before the credit expires", () => {
  const game = contactScene([[160, 80]]);
  const pool = game.run.actorPool;
  pool.free.splice(0, pool.free.length - 3);
  game.spawn([3900, 3, 1, 1, 0, 0, 3], [256, 258]);
  const [later] = game.enemies;
  game.assets.background = [[3900, 3, 0, 0, 80, 3980, 0]];
  game.dispatchCameraEvents();
  const [hunter] = game.ground;
  game.spawn([3900, 0, 1, 1, 0, 0, 16], [272, 274]);

  game.clearScreen();

  const slot = pool.recordsByAddress.get(hunter.actorAddress);
  const credit = slot.actor;
  assert.deepEqual([slot.type, credit.x, credit.y, credit.state], [0x18, 88, 4000, 0]);
  assert.equal(credit.direction, game.seed);
  assert.equal(game.pickupFrame(credit), hunter.definition.frames[1][0]);
  assert.equal(later.health, 6);
  game.update();
  assert.equal(credit.y, 4008);
  assert.ok(credit.dead);
  assert.equal(slot.list, ActorList.transient);
  game.update();
  assert.equal(slot.list, undefined);
  assert.equal(pool.free.at(-1), slot.address);
});

test("stage-four Z marks the grouped drone's credit when it takes the source slot", () => {
  const game = corridor(3400, 0);
  const pool = game.run.actorPool;
  pool.free.splice(0, pool.free.length - 1);
  const pod = new StageFourCorridorPod(game.assets.logic.corridor.pods[0], 52);
  pod.frameIndex = 4;
  pod.frameTicks = 1;
  pod.step(game, {});
  const [drone] = game.ground;

  game.clearScreen();

  const slot = pool.recordsByAddress.get(drone.actorAddress);
  const credit = slot.actor;
  assert.deepEqual([slot.type, credit.value, credit.dead], [0x60, 50, true]);
  assert.deepEqual([credit.x, credit.y], [game.effects[0].x, game.effects[0].y]);
  assert.ok(game.effects[0].dead);
  assert.equal(game.score, 100);
  game.update();
  assert.equal(slot.list, undefined);
  assert.equal(game.countedCredits, 0);
});

test("a stage-four Z pickup prevents damage only from hostile rounds it is visited before", () => {
  for (const pickupFirst of [true, false]) {
    const game = contactScene([[160, 80]]);
    const round = { x: 160, y: 170, direction: 2, dx: 0, dy: 0, fixed: true, damage: 4,
      frame: game.assets.logic.foregroundShot.frame };
    const pickup = { kind: "reward", reward: 18, x: 0, y: 0, state: -2, direction: 0, age: 0 };
    const box = game.bounds(game.sprite(game.pickupFrame(pickup)), 0, 0);
    pickup.x = 160 - box.x - Math.floor(box.w / 2);
    pickup.y = 172 - box.y - Math.floor(box.h / 2);
    if (!pickupFirst) game.addPickup(pickup, true);
    game.addPooledHostileRound(round, 0);
    if (pickupFirst) game.addPickup(pickup, true);
    game.update();

    assert.ok(pickup.dead && round.dead);
    assert.equal(game.player.health, pickupFirst ? 39 : 35);
  }
});

test("a stage-four wall gun can reclaim a scenery ram's slot for a shot in the same tick", () => {
  const game = corridor(3900);
  const pool = game.run.actorPool;
  pool.free.splice(0, pool.free.length - 2);
  game.endCamera = game.camera;
  game.assets.background = [[3900, 1, 0, 0, 104, 3980, 0], [3900, 5, 0, 0, 248, 4020, 1]];
  game.update();
  const [gun] = game.ground, [ram] = game.scenery;
  assert.equal(pool.free.length, 0);

  gun.fireCounter = 255;
  for (let i = 0; i < 4; i++) game.update();

  const [shot] = game.bullets;
  assert.equal(shot.actorAddress, ram.actorAddress);
  assert.deepEqual([shot.x, shot.y, shot.direction], [gun.x + 18 + shot.dx, 86, 2]);
  assert.equal(game.scenery.length, 0);
  assert.equal(game.actorLists.get(ActorList.scenery).length, 0);
});

test("wall rams extend on both sides, survive Z and deal six energy without becoming shot targets", () => {
  for (const side of [0, 1]) {
    const game = scene(5, side, 151);
    game.randomWord = () => 0;
    game.update();
    const [ram] = game.scenery;
    ram.counter = 254;
    const origin = ram.tipX;
    game.invincible = 999;
    for (let i = 0; i < 6; i++) game.update();
    assert.equal(ram.length, 6);
    assert.equal(ram.tipX - origin, side ? -96 : 96);
    assert.equal(ram.extension.tiles.length, 12);
    assert.equal(game.targets.includes(ram), false);
    grantReward(game, 18);
    assert.equal(ram.length, 6);
    game.invincible = 0;
    game.player.x = side ? ram.x - 56 : ram.x + 56;
    game.player.y = ram.y + 24;
    game.update();
    assert.equal(game.player.health, 33);
    for (let i = 0; i < 5; i++) game.update();
    assert.equal(ram.length, 0);
    assert.equal(game.mapPatches.size, 0);
  }
});

test("wall ram contact uses the cached hull and flashes even on a lethal hit", () => {
  const game = corridor(3900);
  game.endCamera = game.camera;
  game.assets.background = [[3900, 5, 0, 0, 142, 4064, 0]];
  game.dispatchCameraEvents();
  game.player.health = 6;

  game.update({ right: true });

  assert.equal(game.player.x, 163);
  assert.equal(game.status, "dying");
  assert.equal(game.shipHitFlash, true);
});
