import { test } from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/game.js";
import { ShopScreen } from "../src/shop-screen.js";
import { loadTestCampaign } from "./helpers.js";

const assets = loadTestCampaign();

function finishShopVisit(game, purchase) {
  const screen = new ShopScreen(game);
  const advance = (until) => {
    for (let tick = 0; tick < 500 && !until(); tick++) screen.update();
    assert.ok(until(), `stage ${game.stage}, shop phase ${screen.phase}`);
  };
  advance(() => !screen.busy);
  screen.activate(20);
  advance(() => screen.phase === "buy" && !screen.busy);
  if (purchase) {
    const slot = screen.slots.findIndex(({ id }) => id === purchase);
    assert.ok(slot >= 0);
    const credits = game.credits;
    screen.activate(slot);
    advance(() => !screen.busy);
    assert.equal(screen.activate(21), true);
    advance(() => !screen.busy);
    assert.equal(game.credits, credits - screen.item(purchase).price);
  }
  screen.activate(20);
  advance(() => game.status !== "shop");
}

function cannonCheckpoint(game) {
  const { camera, credits } = game.checkpoint;
  game.update({ fire: true });
  const [formation] = game.enemies;
  assert.ok(formation);
  let cannonFired = false;
  for (let tick = 0; tick < 100 && !formation.dead; tick++) {
    game.invincible = 2;
    game.update({ fire: true });
    cannonFired ||= game.shots.some((shot) => shot.cannon);
  }
  assert.ok(cannonFired);
  assert.equal(formation.dead, true);
  const bounds = game.targetBounds(formation);
  assert.ok(bounds.x + bounds.w < game.player.x, "the formation dies left of the starter's firing line");
  assert.ok(game.camera < camera);

  // Place a credit and hostile shots at the hull; exercise the real contact paths.
  const { x, y, lives } = game.player;
  const collectedCredits = game.credits;
  game.addPickup({ x, y, kind: "credit", value: 100, age: 0 });
  game.update();
  assert.equal(game.credits, collectedCredits + 100);
  game.invincible = 0;
  for (let i = 0; i < 5; i++) {
    game.bullets.push({ x, y: y - 10, dx: 0, dy: 0, damage: 8 });
    game.update();
    assert.equal(game.player.health, Math.max(0, 39 - (i + 1) * 8));
  }
  assert.equal(game.status, "dying");
  assert.ok(game.sounds.includes("death"));
  for (let tick = 0; tick < 16; tick++) game.update();
  assert.equal(game.status, "turn-ready");
  assert.deepEqual([game.camera, game.credits, game.player.lives, game.player.health],
    [camera, credits, lives - 1, 39]);
  assert.deepEqual(game.inventory[1], { id: 15, power: 0 });
  assert.equal(game.shots.length, 0);
  assert.equal(game.continueRun(), true);
  return game.stageWaves;
}

test("all five stage dispatches resolve every foreground type and animation reference", () => {
  for (const stage of assets.stages) {
    for (const event of stage.events) assert.ok(stage.logic.templates.has(event[1]));
    for (const parts of stage.logic.templates.values()) {
      for (const part of parts) {
        assert.ok(part.frames.length);
        for (const frame of part.frames) {
          assert.ok(stage.lookup[frame.bank].has(frame.offset), `stage ${stage.number}`);
        }
      }
    }
  }
  assert.equal(assets.stages[2].logic.templates.get(3).length, 7);
});

test("scripted combat, animated shops and all 601 events lead through five stages into a harder campaign", () => {
  const game = new Game(assets);
  game.start();
  // Assist travel and boss hits, but drive shop, checkpoint and stage transitions normally.
  game.shipTouchesTerrain = () => false;
  let replayedWaves = 0;
  for (let stage = 1; stage <= 5; stage++) {
    assert.equal(game.stage, stage);
    if (stage === 3) replayedWaves = cannonCheckpoint(game);
    for (let tick = 0; tick < 8000 && game.status === "playing"; tick++) {
      game.invincible = 2;
      if (game.boss?.parts) {
        for (const actor of game.boss.targets) {
          if (actor.indestructible) continue;
          const box = actor.bounds();
          game.shots.push({ x: box.x + Math.floor(box.w / 2), y: box.y + Math.floor(box.h / 2),
            dx: 0, dy: 0, damage: 1, point: true });
        }
      } else if (game.boss?.phase || game.boss?.active) {
        game.shots.push({ x: 160, y: game.boss.weakY + 7, dx: 0, dy: 0, damage: 1, point: true });
      }
      if (game.miniboss && !game.miniboss.dead) {
        for (const actor of game.miniboss.targets) {
          if (actor.indestructible || (actor.wave && actor.part)) continue;
          const box = actor.bounds();
          if (box.x >= 320 || box.y < 0 || box.y >= 192) continue;
          game.shots.push({ x: box.x + Math.min(8, box.w >> 1), y: box.y + Math.min(8, box.h >> 1),
            dx: 0, dy: 0, damage: 1, point: true });
        }
      }
      const finalBoss = stage === 2 && game.miniboss.dead && game.camera < 352;
      const returnToCore = stage === 5 && game.boss.remaining === 0 && game.boss.parts.at(-1).motion.y > 160;
      game.update({ fire: true, left: tick % 300 < 150, right: tick % 300 >= 150,
        up: finalBoss && !game.boss.active, down: finalBoss && game.boss.active || returnToCore });
      for (const enemy of game.enemies) {
        assert.ok(Number.isFinite(enemy.motion.xFixed));
        for (let part = 0; part < enemy.parts.length; part++) {
          assert.ok(game.sprite(game.enemyFrame(enemy, part)));
        }
      }
      game.sounds.length = 0;
      if (game.status === "shop" && game.shopStage === stage) {
        const camera = game.camera;
        const waves = game.stageWaves;
        finishShopVisit(game);
        assert.equal(game.status, "playing");
        assert.equal(game.stage, stage);
        assert.equal(game.camera, camera);
        assert.equal(game.stageWaves, waves);
      }
    }
    assert.equal(game.stageWaves, assets.stages[stage - 1].events.length + (stage === 3 ? replayedWaves : 0),
      `stage ${stage}`);
    if (game.boss) assert.equal(game.boss.dead, true, `boss at stage ${stage}, camera ${game.camera}, guards ${game.boss.remaining}`);
    else assert.equal(game.progress, 1);
    assert.equal(game.status, stage === 5 ? "ending" : "shop");
    const snapshot = game.snapshot();
    game.update({ fire: true });
    assert.deepEqual(game.snapshot(), snapshot);
    if (stage < 5) {
      finishShopVisit(game, stage === 2 ? 15 : undefined);
      assert.equal(game.score, snapshot.score);
      assert.equal(game.credits, 0);
      assert.equal(game.checkpoint.credits, 0);
      assert.deepEqual(game.inventory[1], stage === 1 ? null : { id: 15, power: 0 });
      assert.equal(game.camera, 0x1200);
      assert.deepEqual([game.player.x, game.player.y], [snapshot.x, 176]);
      assert.equal(game.enemies.length, 0);
      assert.equal(game.shots.length, 0);
    } else {
      const ending = new ShopScreen(game);
      for (let tick = 0; tick < 500 && game.status === "ending"; tick++) ending.update();
      assert.equal(game.stage, 1);
      assert.equal(game.campaignRound, 2);
      assert.equal(game.continues, snapshot.continues + 1);
      assert.equal(game.score, snapshot.score);
      assert.equal(game.credits, 0);
      assert.deepEqual(game.inventory, [{ id: 1, power: 0 }, null, null, null, null, null, null]);
      assert.equal(game.waves, 601 + replayedWaves);
      game.spawn(assets.stages[0].events.find((event) => event[1] === 1));
      assert.equal(game.enemies[0].health, 4);
    }
    const loading = game.snapshot();
    assert.equal(loading.status, "stage-loading");
    assert.equal(game.continueRun(), false);
    game.update({ right: true, fire: true });
    assert.deepEqual(game.snapshot(), { ...loading, status: "turn-ready" });
    assert.equal(game.continueRun(), true);
    assert.deepEqual(game.snapshot(), { ...loading, status: "playing" });
  }
  assert.equal(game.continueRun(), false);
  game.start();
  assert.equal(game.stage, 1);
  assert.equal(game.campaignRound, 1);
  assert.equal(game.score, 0);
  assert.equal(game.shopStage, undefined);
  assert.equal(game.inventory[1], null);
});

test("practice stage selection initializes the requested assets, then continues normally", () => {
  const game = new Game(assets);
  game.start(4);
  assert.equal(game.assets, assets.stages[3]);
  assert.equal(game.stage, 4);
  assert.equal(game.waves, 0);
  assert.equal(game.continueRun(), false);
  assert.throws(() => game.start(6), /Missing stage/);
});

test("launching from the menu shows the stage-one loading frame before player one's ready screen", () => {
  for (const players of [1, 2]) {
    const game = new Game(assets);
    game.start(1, players, true);
    assert.equal(game.status, "stage-loading");
    const screen = game.runScreen;
    game.update({ fire: true });
    assert.equal(game.status, "turn-ready");
    assert.notEqual(game.runScreen, screen);
    assert.equal(game.playerNumber, 1);
    assert.equal(game.tick, 0);
    assert.equal(game.continueRun(), true);
    assert.equal(game.status, "playing");
    assert.equal(game.tick, 0);
  }
});

test("a stage-five winner sees the ending without a second reward if their partner is eliminated", () => {
  const first = new Game(assets);
  first.start(5, 2);
  assert.equal(first.continueRun(), true);
  const startingContinues = first.continues;
  first.beginVictory();
  assert.equal(first.status, "stage-wait");
  assert.equal(first.continues, startingContinues + 1);

  const second = first.activeGame;
  assert.notEqual(second, first);
  assert.equal(second.continueRun(), true);
  second.player.lives = 1;
  second.continues = 0;
  second.killPlayer();
  for (let tick = 0; tick < 16; tick++) second.update();
  assert.equal(second.status, "turn-over");
  for (let tick = 0; tick < 30; tick++) second.update();
  assert.equal(second.status, "eliminated");
  assert.equal(second.activeGame, first);
  assert.equal(first.status, "ending");

  const ending = new ShopScreen(first);
  for (let tick = 0; tick < 500 && first.status === "ending"; tick++) ending.update();
  assert.deepEqual([first.status, first.stage, first.campaignRound, first.continues],
    ["stage-loading", 1, 2, startingContinues + 1]);
  first.update();
  assert.equal(first.continueRun(), true);
  first.update({ fire: true });
  assert.equal(first.status, "playing");
});
