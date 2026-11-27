import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecoveryNavigation, recoveryRoutes } from "../tools/recovery-navigation.mjs";
import { createDecisionClient } from "../tools/foundry-decision.mjs";
import { createFoundryClient, parseDecision, playWithFoundry } from "../tools/foundry-local.mjs";

const feedback = { navigation: { requiresRecovery: true } };
const scene = (tick = 0) => ({
  status: "playing", canStep: true, stage: 1, life: 0, campaignRound: 1, elapsedTicks: tick, camera: 100,
  score: 0, credits: 0, kills: 0,
  player: { x: 8, y: 32, health: 39, lives: 3, dives: 0, diving: false },
  enemies: [], bullets: [], pickups: [],
  terrain: { navigation: { x: 0, y: 0, cellSize: 8, rows: [
    "0001000", "0101000", "0101000", "0001000", "0001000",
  ] } },
});

test("recovery routes connect visible clear samples without crossing rock or joining disconnected islands", () => {
  const state = scene(), original = structuredClone(state);
  const routes = recoveryRoutes(state).filter(({ kind }) => kind === "visible-corridor");
  assert.ok(routes.length > 0);
  for (const { waypoints } of routes) {
    let before = { x: state.player.x, worldY: state.camera + state.player.y };
    for (const point of waypoints) {
      assert.ok(point.x <= 16, "Do not propose the disconnected island to the right.");
      const dx = Math.sign(point.x - before.x) * 8, dy = Math.sign(point.worldY - before.worldY) * 8;
      assert.ok(!dx || !dy, "Do not cut diagonally across corners.");
      for (let x = before.x, y = before.worldY; x !== point.x || y !== point.worldY; x += dx, y += dy) {
        assert.equal(state.terrain.navigation.rows[(y - state.camera) / 8][x / 8], "0");
      }
      before = point;
    }
  }
  assert.deepEqual(state, original);
});

test("a model-selected retreat survives alert changes and needs real reverse scrolling, not one down/wait pair", () => {
  const navigation = createRecoveryNavigation(), state = scene();
  const recovery = navigation.snapshot(state, feedback);
  const route = recovery.candidates.find(({ kind }) => kind === "make-turning-room");
  navigation.select({ scene: state, recovery }, route.id);
  const moved = { ...scene(4), camera: 104 };
  const active = navigation.snapshot(moved, { navigation: { requiresRecovery: false } });
  assert.equal(active.plan.id, route.id);
  assert.equal(active.plan.waypoint.worldY, 144);
  assert.equal(active.plan.selectedAt, 0);
  const reached = navigation.snapshot({ ...scene(12), camera: 112 }, feedback);
  assert.equal(reached.plan, undefined);
  assert.equal(reached.lastOutcome.reason, "waypoints-reached");
});

test("no-progress plans expire and are remembered without banning ordinary controls", () => {
  const navigation = createRecoveryNavigation(), state = scene();
  const recovery = navigation.snapshot(state, feedback);
  const route = recovery.candidates.find(({ kind }) => kind === "make-turning-room");
  navigation.select({ scene: state, recovery }, route.id);
  assert.ok(navigation.snapshot(scene(28), feedback).plan);
  const expired = navigation.snapshot(scene(32), feedback);
  assert.equal(expired.plan, undefined);
  assert.equal(expired.lastOutcome.reason, "no-waypoint-progress");
  assert.ok(expired.failedPlans.some(({ id }) => id === route.id));
  assert.ok(expired.candidates.every(({ id }) => id !== route.id));
  assert.throws(() => navigation.select({ scene: state, recovery: expired }, "not-offered"), /unavailable/);
  navigation.select({ scene: state, recovery: expired }, "manual");
  assert.equal(navigation.snapshot({ ...scene(36), life: 1 }, feedback).failedPlans.length, 0);
  assert.equal(navigation.snapshot(scene(40), { navigation: { ...feedback.navigation, bossVisible: true } }), undefined);
  assert.equal(navigation.snapshot({ ...scene(44), status: "shop" }, feedback), undefined);
});

test("Decision requests select a persistent waypoint alongside unchanged model-selected buttons", async (t) => {
  const state = scene(), recovery = createRecoveryNavigation().snapshot(state, feedback);
  const route = recovery.candidates[0];
  let body, invalid = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({
      answers: {
        action: { type: "choice", choice: "left_fire", probabilities: { left_fire: 1 } },
        route: { type: "choice", choice: invalid ? "missing" : route.id, probabilities: { [route.id]: 1 } },
      },
    }));
  });
  const client = createDecisionClient({ endpoint: "https://example.test", model: "test", apiKey: "test-only" });
  const result = await client.complete({ scene: state, recovery });
  assert.equal(body.questions.route.type, "choice");
  assert.ok(body.questions.route.criteria[route.id]);
  assert.ok(body.questions.route.criteria.manual);
  assert.match(body.questions.action.instructions, /RECOVERY WAYPOINTS/);
  assert.deepEqual(parseDecision(result.content), { left: true, fire: true });
  assert.equal(result.navigationDecision.choice, route.id);
  invalid = true;
  await assert.rejects(client.complete({ scene: state, recovery }), /valid supplied recovery waypoint/);
});

test("local clients validate the waypoint wrapper and preserve the original model control response", async (t) => {
  const state = scene(), recovery = createRecoveryNavigation().snapshot(state, feedback);
  const route = recovery.candidates[0];
  let content = JSON.stringify({ input: { right: true, fire: true }, waypoint: route.id });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content } }],
  })));
  const client = createFoundryClient({ endpoint: "http://localhost", model: "test" });
  const result = await client.complete({ scene: state, recovery });
  assert.equal(result.rawContent, content);
  assert.equal(result.navigationDecision.choice, route.id);
  assert.deepEqual(parseDecision(result.content), { right: true, fire: true });
  content = '{"input":{"fire":true},"waypoint":"not-offered"}';
  await assert.rejects(client.complete({ scene: state, recovery }), /offered recovery waypoint/);
});

test("the paused controller carries a model-selected goal across decisions without substituting steering", async () => {
  let state = scene(), selected, applied = [], planned = [];
  const run = {
    decisionTicks: 4, observe: () => ({ observation: structuredClone(state) }),
    step(input, ticks = 4) {
      applied.push(input);
      state.elapsedTicks += ticks;
      return { ticksAdvanced: ticks, observation: structuredClone(state) };
    },
  };
  await playWithFoundry(run, {
    async complete(packet) {
      if (packet.recovery?.candidates && !selected) {
        selected = packet.recovery.candidates[0].id;
        return { content: '{"input":{"left":true,"fire":true}}', navigationDecision: { choice: selected } };
      }
      if (selected) planned.push(packet.recovery?.plan?.id);
      return { content: '{"input":{"fire":true}}' };
    },
  }, { maxDecisions: 12 });
  assert.ok(selected);
  assert.ok(planned.length > 0 && planned.every((id) => id === selected));
  assert.equal(applied.filter(({ left }) => left).length, 1);
  assert.ok(applied.every(({ right, up, down, dive }) => !right && !up && !down && !dive));
});

test("real-time decisions retain a selected waypoint without replacing held controls", async () => {
  let state = scene(), selected, plans = [];
  const applied = [];
  const run = {
    decisionTicks: 1, observe: () => ({ observation: structuredClone(state) }),
    step(input, ticks = 1) {
      state.elapsedTicks += ticks;
      applied.push(input);
      return { ticksAdvanced: ticks, observation: structuredClone(state) };
    },
  };
  const navigationMemory = [{
    kind: "terrain-stall", stage: 1, campaignRound: 1, x: 8, worldY: 100,
    startTick: 0, endTick: 32, energyLost: 0,
  }];
  await playWithFoundry(run, {
    async complete(packet) {
      if (!selected) {
        selected = packet.recovery.candidates[0].id;
        return { content: '{"input":{"fire":true}}', navigationDecision: { choice: selected } };
      }
      plans.push(packet.recovery.plan.id);
      return { content: '{"input":{"fire":true}}' };
    },
  }, { realtime: true, navigationMemory, maxDecisions: 3 });
  assert.equal(plans.length, 2);
  assert.ok(plans.every((id) => id === selected));
  assert.ok(applied.every(({ left, right, up, down, dive }) => !left && !right && !up && !down && !dive));
});
