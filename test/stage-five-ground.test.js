import { test } from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/game.js";
import { Renderer } from "../src/renderer.js";
import { grantReward } from "../src/shop.js";
import { loadTestCampaign } from "./helpers.js";

const campaign = loadTestCampaign();

function scene(type, initialY, predicate = () => true) {
  const game = new Game(campaign);
  game.start(5);
  const event = game.assets.background.find((e) => e[1] === type && predicate(e)).slice();
  const camera = event[5] - 8 - initialY;
  event[0] = camera;
  game.assets = { ...game.assets, events: [], background: [event] };
  game.camera = game.control.camera = game.control.ceiling = camera;
  game.endCamera = 0;
  game.shipTouchesTerrain = () => false;
  game.invincible = 999;
  return { game, event };
}

function shoot(game, enemy, damage = 1) {
  const { x, y } = enemy.bounds(game.camera);
  game.shots.push({ x: x + 5, y: y + 5, dx: 0, dy: 0, damage, point: true });
  game.update();
}

test("either barrier post collapses the whole span, but the center absorbs shots without taking damage", () => {
  for (const index of [0, 2]) {
    const { game } = scene(1, 50, (e) => e[0] === 4112);
    game.update();
    const [left, middle, right] = game.ground;
    const outer = [left, middle, right][index];
    const initial = game.map.slice(left.cell, left.cell + 4);
    shoot(game, middle, 30);
    assert.equal(game.ground.length, 3);
    assert.equal(game.shots.length, 0);
    assert.notDeepEqual(game.map.slice(left.cell, left.cell + 4), initial);
    shoot(game, outer, 9);
    assert.deepEqual([left.health, right.health], index ? [10, 1] : [1, 10]);
    shoot(game, outer);
    assert.equal(game.ground.length, 0);
    assert.deepEqual([...game.map.slice(left.cell, left.cell + 4)], [0x3781, 0, 0, 0x3741]);
    assert.equal(game.score, 200);
    assert.equal(game.effects[0].x, outer.x + 8);
    game.update({ down: true });
    assert.equal(game.ground.length, 0);
  }
});

test("a swivel turret stays dormant until visible, spins once, then tracks and fires from its muzzle", () => {
  const { game } = scene(3, -18);
  game.update();
  const [turret] = game.ground;
  const direction = turret.direction;
  assert.equal(turret.phase, 0);
  for (let i = 1; i <= 8; i++) {
    game.update();
    assert.equal(turret.direction, (direction + i) & 7);
    assert.equal(game.bullets.length, 0);
  }
  game.player.x = turret.x + 100;
  game.player.y = turret.worldY - game.camera + 16;
  turret.fireCounter = 255;
  game.update();
  assert.equal(turret.direction, (direction + 7) & 7);
  assert.equal(game.bullets.length, 1);
  const bullet = game.bullets[0];
  assert.deepEqual([bullet.dx, bullet.dy], turret.definition.vectors[turret.direction].map((v) => v * 8));
  assert.ok(game.sprite(bullet.frame));
});

test("ring turrets launch eight animated shots; destroying one clears only its footprint and matching neighbors", () => {
  const { game, event } = scene(4, 55);
  const cell = ((event[5] - 8) / 16) * 20 + (event[4] - 8) / 16;
  game.map[cell - 1] = 0x2e41;
  game.map[cell + 2] = 0x1001;
  game.map[cell + 22] = 0x2001;
  game.update();
  const [turret] = game.ground;
  assert.equal(game.map[cell - 1], 0x05c0);
  assert.equal(game.map[cell + 19], 0x0ac0);
  turret.fireCounter = 255;
  game.update();
  assert.equal(game.bullets.length, 8);
  assert.equal(new Set(game.bullets.map((shot) => `${shot.dx},${shot.dy}`)).size, 8);
  const [shot] = game.bullets;
  const frame = shot.frame;
  game.update();
  assert.notEqual(shot.frame, frame);
  grantReward(game, 18);
  assert.equal(game.score, 500);
  assert.equal(game.bullets.length, 0);
  assert.deepEqual([cell, cell + 1, cell + 20, cell + 21].map((i) => game.map[i]), [0, 0, 0, 0]);
  assert.deepEqual([cell - 1, cell + 19, cell + 2, cell + 22].map((i) => game.map[i]),
    [0x2e41, 0x32c1, 0x1001, 0x2001]);
});

test("the two tagged swivel turrets record their individual deaths and cannot be rebuilt from a triggered event", () => {
  const { game, event } = scene(9, 50);
  const second = game.campaign.stages[4].background.find((e) => e[1] === 9 && e[3] !== event[3]);
  game.assets.background.push([event[0], ...second.slice(1)]);
  game.update();
  assert.equal(game.ground.length, 2);
  const left = game.ground.find((turret) => turret.flag === event[3]);
  shoot(game, left, 20);
  assert.deepEqual([...game.stageFiveTurretFlags], [event[3]]);
  game.checkpoint.camera = event[0];
  game.restoreCheckpoint();
  game.update();
  assert.deepEqual(game.ground.map((turret) => turret.flag), [second[3]]);
  assert.equal(game.score, 400);
});

test("the stage-five formations stagger ten ships down distinct original paths", () => {
  const starts = [];
  for (const [index, path] of [0, 1, 2].entries()) {
    const { game, event } = scene(7, -24, (e) => e[3] === path);
    game.camera = game.control.camera = game.control.ceiling = event[0] = [2000, 1712, 1456][index];
    game.player.x = 300;
    game.update();
    assert.equal(game.ground.length, 10);
    const [leader, second] = game.ground;
    const tail = game.ground.at(-1);
    assert.equal(leader.motion.xFixed, tail.motion.xFixed);
    game.update();
    assert.notEqual(leader.motion.xFixed, tail.motion.xFixed);
    assert.equal(second.motion.xFixed, tail.motion.xFixed);
    starts.push(tail.motion.x);
    let volley = false;
    for (let tick = 0; tick < 40 && !volley; tick++) {
      game.bullets = [];
      game.update();
      volley = new Set(game.bullets.map(({ dx, dy }) => `${dx},${dy}`)).size === 8;
    }
    assert.ok(volley, `path ${path} should fire a visible eight-way volley`);
  }
  assert.deepEqual(starts, [112, 121, 104]);
});

test("both wall patrols release damageable homing actors inward without updating them on their birth tick", () => {
  for (const side of [0, 1]) {
    const { game } = scene(8, 60, (event) => event[6] === side);
    game.update();
    const [patrol] = game.ground;
    patrol.fireCounter = 255;
    game.update();
    const [child, parent] = game.ground;
    assert.equal(parent, patrol);
    assert.equal(child.motion.x, parent.motion.x + (side ? -32 : 32));
    assert.equal(child.motion.y, parent.motion.y);
    assert.ok(!child.bounds().w);
    child.age = 6;
    game.update();
    assert.equal(child.motion.x, parent.motion.x + (side ? -37 : 37));
    assert.ok(child.bounds().w > 0);
    const { x, y, w, h } = child.bounds();
    const [dx, dy] = child.definition.vectors[child.direction];
    game.shots.push({ x: x + Math.floor(w / 2) + dx, y: y + Math.floor(h / 2) + dy + 1,
      dx: 0, dy: 0, damage: 6, point: true });
    child.age = 9;
    game.update();
    assert.ok(!game.ground.includes(child));
    assert.ok(game.ground.includes(parent));
    assert.equal(game.score, 100);
  }
});

function encounter(type) {
  const game = new Game(campaign);
  game.start(5);
  const event = game.assets.background.find((e) => e[1] === type);
  game.assets = { ...game.assets, events: [], background: game.assets.background.filter((e) => e[0] === event[0]) };
  game.camera = game.control.camera = event[0] + 1;
  game.control.ceiling = game.camera + 16;
  game.shipTouchesTerrain = () => false;
  game.player.x = 20;
  game.invincible = 9999;
  return game;
}

function aimAt(game, actor, damage) {
  const { x, y, w, h } = actor.bounds();
  game.shots.push({ x: x + (w >> 1), y: y + (h >> 1), dx: 0, dy: 0, damage, point: true });
}

test("the final arena installs its room and checkpoint without changing the already painted camera", () => {
  const game = encounter(6);
  const before = game.map.slice(0, 0x30c);
  const tiles = [], cameras = [], sprites = [];
  const world = { getContext: () => ({ drawImage: (...args) => tiles.push(args) }) };
  const renderer = Object.assign(Object.create(Renderer.prototype), {
    assets: game.assets, map: game.map, mapRevision: 0, world,
    tileImages: game.assets.tiles.map((_, i) => i),
    context: {
      ...Object.fromEntries(["save", "beginPath", "rect", "clip", "restore", "fillRect", "fillText"]
        .map((name) => [name, () => {}])),
      drawImage(source, _, camera) { if (source === world) cameras.push(camera); },
    },
    drawShip() {},
    drawInvulnerabilityRing() {},
    drawSprite(sprite) { sprites.push(sprite); },
  });

  game.update();

  assert.equal(game.camera, 416);
  assert.equal(game.checkpoint.camera, 416);
  assert.ok(game.eventStreamsClosed);
  assert.notDeepEqual(game.map.slice(0, 0x30c), before);
  assert.equal(game.boss.hatchCounter, 0);
  assert.ok(game.boss.parts.every((part) => !part.bounds().w));
  renderer.draw(game);
  assert.deepEqual(cameras, [0]);
  assert.deepEqual([tiles, sprites], [[], []]);

  game.update();

  assert.ok(game.boss.hatchCounter);
  assert.ok(game.boss.parts.some((part) => part.bounds().w));
  renderer.draw(game);
  assert.deepEqual(cameras, [0, 415]);
  assert.ok(tiles.length);
  assert.ok(sprites.length);
});

test("the miniboss fires its beam and opens the same-stage shop after the ten drops resolve", () => {
  const game = encounter(5);
  game.update();
  const boss = game.miniboss;
  const [gun, , , , core] = boss.parts;
  let beam, sawAdds = false;
  for (let i = 0; i < 260 && (!beam || !sawAdds || core.motion.y < 48); i++) {
    game.update();
    beam ||= game.bullets.find((bullet) => bullet.beamLength === 48 && bullet.y > 0);
    sawAdds ||= game.ground.some((actor) => actor.definition.kind === "patrol-homing");
  }
  assert.ok(beam && sawAdds);
  assert.equal(game.control.ceiling, 2336);
  aimAt(game, gun, 40);
  game.update();
  assert.equal(gun.destroyed, true);
  const untouched = game.map[141 * 20 + 5];
  const score = game.score;
  aimAt(game, core, 200);
  game.update();
  assert.equal(boss.dead, true);
  assert.equal(game.score - score, 1500);
  assert.equal(game.countedCredits, 10);
  assert.equal(game.status, "playing");
  assert.ok(game.map.slice(141 * 20 + 6, 141 * 20 + 14).every((tile) => tile === 0));
  assert.equal(game.map[141 * 20 + 5], untouched);
  assert.equal(game.stageFiveTurretFlags.size, 0);
  for (let i = 0; i < 500 && game.status === "playing"; i++) game.update();
  assert.equal(game.countedCredits, 0);
  assert.equal(game.status, "shop");
  assert.equal(game.shopStage, 5);
  assert.ok(game.continueRun());
  assert.equal(game.stage, 5);
});

test("the final arena cannot finish without exposing the core and resolving its twenty drops", () => {
  const game = encounter(6);
  game.update();
  const { boss } = game;
  const core = boss.parts.at(-1), initialBox = core.bounds();
  assert.equal(game.camera, 416);
  assert.equal(boss.remaining, 18);
  assert.ok(core.indestructible && !initialBox.w);
  assert.ok(game.map.slice(120, 480).some(Boolean));
  assert.deepEqual(boss.hatchSprites(), []);
  let sawSeeker = false, sawBeam = false, sawHatchOpen = false;
  for (let i = 0; i < 960 && !boss.dead; i++) {
    const reverse = !boss.remaining && core.motion.y > 160;
    for (const actor of boss.targets) {
      if (actor.indestructible) continue;
      const { x, y, w, h } = actor.bounds();
      if (w && x < 320 && y + (h >> 1) > 20 && y + (h >> 1) < 169
        && (actor !== core || i > 100)) aimAt(game, actor, 40);
    }
    game.update({ down: reverse });
    if (Math.abs(boss.hatch) === 2) {
      const [hatch] = boss.hatchSprites();
      assert.equal(hatch.y, boss.y + (boss.hatch < 0 ? 229 : 85));
      assert.ok(game.sprite(hatch.frame));
      sawHatchOpen = true;
    }
    sawSeeker ||= game.ground.some((actor) => actor.definition.kind === "arena-seeker");
    sawBeam ||= game.bullets.some((bullet) => bullet.beamLength > 0);
  }
  assert.ok(sawSeeker && sawBeam && sawHatchOpen);
  assert.equal(boss.dead, true);
  assert.equal(boss.remaining, 0);
  assert.equal(game.countedCredits, 20);
  assert.equal(game.status, "playing");
  assert.ok(game.map.slice(0, 0x30c).every((tile) => tile === 0));
  for (let i = 0; i < 500 && game.status === "playing"; i++) game.update();
  assert.equal(game.countedCredits, 0);
  assert.equal(game.status, "ending");
  assert.equal(game.continueRun(), false);
});
