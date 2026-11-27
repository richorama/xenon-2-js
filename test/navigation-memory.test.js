import assert from "node:assert/strict";
import { test } from "node:test";
import { createNavigationMemory, incidentInstructions } from "../tools/navigation-memory.mjs";
import { createGameplayFeedback } from "../tools/foundry-local.mjs";
import { createRecoveryNavigation } from "../tools/recovery-navigation.mjs";

const scene = (changes = {}) => ({
  status: "playing", stage: 1, campaignRound: 1, life: 0, elapsedTicks: 100, camera: 1000,
  player: { x: 80, y: 160, health: 39 }, ...changes,
});
const stall = { mapStalled: true, shipStalled: true, windowTicks: 32, cycle: { directions: ["left", "right"] } };

test("incident memory uses world coordinates and warns before an observed trap on a later attempt", () => {
  const memory = createNavigationMemory();
  const trapped = scene({ terrain: { recovering: true } });
  memory.nearby(trapped, stall);
  const saved = memory.entries();
  assert.equal(saved[0].worldY, 1160);
  assert.equal(saved[0].kind, "terrain-stall");
  assert.equal(saved[0].startTick, 68);
  const loaded = createNavigationMemory(saved);
  const approaching = scene({ elapsedTicks: 20, camera: 1100, player: { x: 100, y: 160, health: 39 } });
  const warnings = loaded.nearby(approaching);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].aheadPixels, 100);
  assert.equal(warnings[0].horizontalOffset, -20);
  assert.equal(warnings[0].previousAttempt, true);
  assert.equal(loaded.nearby({ ...approaching, stage: 2 }).length, 0);
  assert.equal(loaded.nearby({ ...approaching, campaignRound: 2 }).length, 0);
  assert.equal(loaded.nearby({ ...approaching, camera: 1400 }).length, 0);
  assert.equal(loaded.nearby({ ...approaching, camera: 900 }).length, 0);
  assert.equal(loaded.nearby({ ...approaching, status: "shop" }).length, 0);
  assert.equal(saved[0].previousAttempt, false, "Loading must not mutate the source journal.");
});

test("health-loss memory survives compact feedback and includes a fatal hit without inventing its cause", () => {
  const feedback = createGameplayFeedback();
  const before = { ...scene(), enemies: [], bullets: [] };
  const after = { ...before, elapsedTicks: 104, status: "dying", player: { ...before.player, health: 0 } };
  feedback.record(before, { fire: true }, after);
  const incidents = feedback.memory();
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].energyLost, 39);
  assert.equal(incidents[0].startTick, 100);
  assert.equal(incidents[0].endTick, 104);
  assert.equal(incidents[0].cause, undefined);
  const nextLife = { ...before, life: 1, elapsedTicks: 500, player: { ...before.player, health: 39 } };
  assert.equal(feedback.snapshot(nextLife).nearbyIncidents.length, 1);
});

test("repeated terrain loops cluster into one bounded incident and bosses do not create terrain warnings", () => {
  const memory = createNavigationMemory();
  memory.nearby(scene(), { ...stall, bossVisible: true });
  assert.equal(memory.entries().length, 0);
  for (let tick = 100; tick < 200; tick += 4) memory.nearby(scene({ elapsedTicks: tick }), stall);
  assert.equal(memory.entries().length, 1);
  assert.equal(memory.entries()[0].endTick, 196);
  for (let index = 0; index < 40; index++) memory.nearby(scene({
    elapsedTicks: 200 + index * 4, camera: 1200 + index * 32,
  }), stall);
  assert.equal(memory.entries().length, 32);
  assert.throws(() => createNavigationMemory([{}]), /Invalid navigation incident/);
  assert.throws(() => createNavigationMemory(Array(33).fill({})), /at most 32/);
});

test("a nearby remembered pocket offers pre-emptive waypoint choices before a fresh stall occurs", () => {
  const current = scene({ terrain: { navigation: { x: 16, y: 16, cellSize: 8, rows: Array(21).fill("0".repeat(37)) } } });
  const feedback = { navigation: { requiresRecovery: false }, nearbyIncidents: [
    { kind: "terrain-stall", aheadPixels: 100 },
  ] };
  const recovery = createRecoveryNavigation().snapshot(current, feedback);
  assert.ok(recovery.candidates.some(({ kind }) => kind === "visible-corridor"));
  const instructions = incidentInstructions({ feedback });
  assert.match(instructions, /BEFORE reaching/);
  assert.match(instructions, /NOT predictions or proof of a damage cause/);
});

test("only a confirmed uncollected visible supply creates an opportunity memory, not disappearance or collection", () => {
  const memory = createNavigationMemory();
  const before = { ...scene(), pickups: [
    { id: 1, kind: "reward", bounds: { x: 72, y: 112, w: 16, h: 16 } },
    { id: 2, kind: "reward", bounds: { x: 92, y: 112, w: 16, h: 16 } },
    { id: 3, kind: "credit", bounds: { x: 112, y: 112, w: 16, h: 16 } },
  ] };
  memory.record(before, { ...before, elapsedTicks: 104, pickups: [] });
  assert.equal(memory.entries().length, 0, "Disappearance alone is not a confirmed miss.");
  const outcomes = [
    { id: 1, kind: "reward", collected: true, stage: 1, campaignRound: 1, life: 0, elapsedTicks: 110 },
    { id: 2, kind: "reward", collected: false, stage: 1, campaignRound: 1, life: 0, elapsedTicks: 112 },
    { id: 3, kind: "credit", collected: false, stage: 1, campaignRound: 1, life: 0, elapsedTicks: 112 },
  ];
  memory.record({ ...before, elapsedTicks: 108, pickups: [] }, { ...before, elapsedTicks: 112, pickupOutcomes: outcomes });
  memory.record({ ...before, elapsedTicks: 112, pickups: [] }, { ...before, elapsedTicks: 116, pickupOutcomes: outcomes });
  const incidents = memory.entries();
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].kind, "missed-supply");
  assert.equal(incidents[0].x, 100);
  assert.equal(incidents[0].worldY, 1120);
  assert.equal(incidents[0].startTick, 100);
  assert.equal(incidents[0].endTick, 112);
});

test("replaying an already remembered prefix does not duplicate incidents or double-count health loss", () => {
  const first = createNavigationMemory(), before = scene(), after = {
    ...before, elapsedTicks: 104, player: { ...before.player, health: 31 },
  };
  first.record(before, after);
  const second = createNavigationMemory(first.entries());
  second.record(before, after);
  assert.equal(second.entries().length, 1);
  assert.equal(second.entries()[0].energyLost, 8);
});

test("native damage is remembered even if a health pickup restores it in the same decision", () => {
  const memory = createNavigationMemory(), before = { ...scene(), energyLost: 0 };
  memory.record(before, { ...before, elapsedTicks: 104, energyLost: 8 });
  assert.equal(memory.entries()[0].energyLost, 8);
});
