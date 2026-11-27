import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { validateAction, validateShopAction } from "../src/headless.js";
import { createDecisionClient, decisionOptions } from "../tools/foundry-decision.mjs";
import { parseDecision, playWithFoundry } from "../tools/foundry-local.mjs";

const apiKey = "test-secret-do-not-log";
const scene = (player = {}) => ({
  status: "playing", canStep: true, stage: 1, elapsedTicks: 0,
  player: { x: 160, y: 174, health: 39, lives: 3, dives: 3, diving: false, ...player },
  enemies: [], bullets: [], pickups: [],
});
const reply = (choice = "right_fire", extra = {}) => ({
  model: "microsoft-decision-1.1",
  answers: { action: { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 0.9, ...extra } },
  usage: { input_tokens: 123, output_tokens: 1 },
});

test("candidate controls cannot combine opposite directions and reflect dive availability and real shop stock", () => {
  for (const player of [{}, { dives: 0 }, { dives: 0, diving: true }]) {
    const options = Object.values(decisionOptions(scene(player)));
    assert.ok(options.some(({ control }) => control.input.left));
    assert.ok(options.some(({ control }) => control.input.right));
    for (const { control } of options) {
      validateAction(control.input, 4);
      if (player.diving) assert.ok(!control.input.fire);
      if (player.dives === 0 && !player.diving) assert.ok(!control.input.dive);
    }
    if (player.diving || player.dives !== 0) assert.ok(options.some(({ control }) => control.input.dive));
  }
  const legalActions = [{ action: "buy", id: 4 }, { action: "exit" }];
  const options = Object.values(decisionOptions({ status: "shop", shop: { legalActions } }));
  assert.deepEqual(options.map(({ control }) => control.shop), legalActions);
  for (const { control } of options) validateShopAction(control.shop);
  assert.throws(() => decisionOptions({ status: "shop", shop: { legalActions: [] } }));
  assert.throws(() => decisionOptions({ status: "shop", shop: { legalActions: [{ action: "buy", id: -1 }] } }));
  assert.throws(() => decisionOptions({ status: "dying" }));
});

test("lookahead describes each route and protection state without changing or filtering legal controls", () => {
  const forecast = {
    movements: {
      right: { firstContact: { kind: "supply-pod", tick: 2 }, actionEnd: { gap: 0 } },
      left: { firstContact: null, actionEnd: { gap: 17.5 } },
      stay: { firstContact: { kind: "terrain-worm", tick: 0 }, actionEnd: { gap: 0 } },
    },
  };
  const original = structuredClone(forecast);
  for (const player of [{}, { dives: 0 }, { dives: 0, diving: true }]) {
    const state = scene(player), before = structuredClone(state);
    const ordinary = decisionOptions(state), described = decisionOptions(state, forecast);
    const controls = (options) => Object.fromEntries(Object.entries(options).map(([label, option]) => [label, option.control]));
    assert.deepEqual(controls(described), controls(ordinary));
    for (const [label, option] of Object.entries(described)) {
      if (label.startsWith("right_")) {
        assert.match(option.description, /potential supply-pod contact at tick 2; action-end gap 0 pixels/);
      } else if (label.startsWith("left_")) {
        assert.match(option.description, /no geometric contact predicted; action-end gap 17.5 pixels/);
      } else if (label.startsWith("stay_")) {
        assert.match(option.description, /potential terrain-worm contact at tick 0/);
      } else {
        assert.doesNotMatch(option.description, /no geometric contact predicted/);
      }
    }
    if (player.diving) {
      assert.match(described.right_coast.description, /retain remaining dive protection without spending another charge/);
      assert.match(described.right_surface.description, /giving up remaining dive protection/);
      assert.equal(described.right_dive, undefined);
    } else {
      assert.match(described.right_fire.description, /does not add dive protection/);
      if (player.dives !== 0) {
        assert.match(described.right_dive.description, /temporary protection.*costs one charge/);
      }
    }
    assert.deepEqual(state, before);
    assert.deepEqual(forecast, original);
    assert.ok(Object.values(ordinary).every((option) => !option.description.includes("Geometric forecast:")));
  }
});

test("Decision options expose actual failed movement beside the corresponding controls without inventing a prediction", () => {
  const state = scene(), feedback = { movementAttempts: [
    { input: { up: true, right: true, fire: true }, ticks: 24, endTick: 96,
      displacement: { x: 0, y: 0, worldY: 0, cameraAdvance: 0 } },
  ] };
  const original = decisionOptions(state), described = decisionOptions(state, undefined, feedback);
  for (const [label, option] of Object.entries(described)) {
    assert.deepEqual(option.control, original[label].control);
    if (label.startsWith("up_right_")) {
      assert.match(option.description, /actual dx 0, dy 0, worldY 0, camera advance 0 pixels/);
      assert.match(option.description, /history, not a prediction/);
    } else assert.doesNotMatch(option.description, /Last observed same-direction/);
  }
});

test("bottom-edge DOWN options explain backtracking without changing their controls or claiming free-flight guarantees", () => {
  const ordinary = decisionOptions(scene({ y: 170 })), bottom = decisionOptions(scene({ y: 176 }));
  for (const [label, option] of Object.entries(bottom)) {
    assert.deepEqual(option.control, ordinary[label].control);
    assert.equal(option.description.includes("DOWN requests map backtracking"), label.startsWith("down"));
    assert.doesNotMatch(ordinary[label].description, /DOWN requests map backtracking/);
  }
});

test("cycle warnings describe implicated directions without removing controls or changing the model's selection", async (t) => {
  const state = scene(), feedback = { navigation: {
    requiresRecovery: true, mapStalled: true, shipStalled: true,
    windowTicks: 32, newForwardPixels: 0, cycle: { directions: ["down_left", "right"] },
  } };
  const original = decisionOptions(state), described = decisionOptions(state, undefined, feedback);
  for (const [label, option] of Object.entries(described)) {
    assert.deepEqual(option.control, original[label].control);
    assert.equal(option.description.includes("detected no-progress cycle"), /^(down_left|right)_/.test(label));
  }
  let body;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify(reply("right_fire")));
  });
  const client = createDecisionClient({ endpoint: "https://example.test", model: "deployment", apiKey });
  const result = await client.complete({ scene: state, feedback });
  assert.match(body.questions.action.instructions, /NAVIGATION ALERT: mapStalled=true/);
  assert.match(body.questions.action.instructions, /down_left -> right/);
  assert.deepEqual(parseDecision(result.content), { right: true, fire: true });
  await client.complete({ scene: state, feedback: {
    navigation: { ...feedback.navigation, bossVisible: true },
  } });
  assert.doesNotMatch(body.questions.action.instructions, /NAVIGATION ALERT/);
  assert.doesNotMatch(body.questions.action.criteria.right_fire, /detected no-progress cycle/);
});

test("Decision HTTP uses typed choices and maps only supplied labels to strict flight and shop controls", async (t) => {
  let requestBody;
  let choice = "right_fire";
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/providers/microsoft/v1/systemone");
    assert.equal(request.method, "POST");
    assert.equal(request.headers["api-key"], apiKey);
    let text = "";
    for await (const chunk of request) text += chunk;
    requestBody = JSON.parse(text);
    assert.equal(requestBody.questions.action.type, "choice");
    assert.ok(Object.hasOwn(requestBody.questions.action.criteria, choice));
    response.end(JSON.stringify(reply(choice)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((accept) => server.close(accept));
  });
  const client = createDecisionClient({
    endpoint: `http://127.0.0.1:${server.address().port}`, model: "deployment-name", apiKey,
  });
  const packet = { decisionTicks: 4, scene: scene(), previousScenes: [], recentDecisions: [] };
  const result = await client.complete(packet);
  assert.deepEqual(requestBody.state, packet);
  assert.equal(requestBody.model, "deployment-name");
  assert.equal(requestBody.messages, undefined);
  assert.ok(!JSON.stringify(requestBody).includes(apiKey));
  assert.ok(!JSON.stringify(result).includes(apiKey));
  assert.deepEqual(parseDecision(result.content), { right: true, fire: true });
  assert.equal(result.decision.confidence, 0.9);
  assert.deepEqual(result.usage, { input_tokens: 123, output_tokens: 1 });
  assert.doesNotMatch(requestBody.questions.action.instructions, /collisionForecast gives/);
  assert.doesNotMatch(requestBody.questions.action.criteria.right_fire, /Geometric forecast:/);
  const forecast = { ...packet, collisionForecast: { movements: {
    right: { firstContact: { kind: "supply-pod", tick: 2 }, actionEnd: { gap: 0 } },
  } } };
  assert.deepEqual(parseDecision((await client.complete(forecast)).content), { right: true, fire: true });
  assert.deepEqual(requestBody.state, forecast);
  assert.match(requestBody.questions.action.instructions, /collisionForecast gives/);
  assert.match(requestBody.questions.action.criteria.right_fire, /potential supply-pod contact at tick 2; action-end gap 0 pixels/);
  const failed = { ...packet, feedback: { movementAttempts: [
    { input: { right: true, fire: true }, ticks: 12, endTick: 48,
      displacement: { x: 0, y: 0, worldY: 0, cameraAdvance: 0 } },
  ] } };
  await client.complete(failed);
  assert.deepEqual(requestBody.state, failed);
  assert.match(requestBody.questions.action.criteria.right_fire, /Last observed same-direction attempt/);
  assert.match(requestBody.questions.action.instructions, /benchmark rewards furthest game progress, NOT time alive/);
  await client.complete({ ...packet, realtime: { heldInput: { left: true }, previousLatencyMs: 200 } });
  assert.match(requestBody.questions.action.instructions, /game keeps ticking while you decide/);
  choice = "buy_4";
  const shopping = {
    scene: { status: "shop", shop: { legalActions: [{ action: "buy", id: 4 }, { action: "exit" }] } },
    collisionForecast: forecast.collisionForecast,
  };
  assert.deepEqual(parseDecision((await client.complete(shopping)).content, "shop"), { action: "buy", id: 4 });
  assert.doesNotMatch(requestBody.questions.action.instructions, /collisionForecast gives/);
  assert.deepEqual(requestBody.questions.action.criteria, { buy_4: '{"action":"buy","id":4}', exit: '{"action":"exit"}' });
});

test("a sole legal shop action is explicitly forced without inventing model scores or making an API call", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("A single legal action needs no model."));
  const client = createDecisionClient({ endpoint: "https://example.test", model: "deployment", apiKey });
  const result = await client.complete({ scene: { status: "shop", shop: { legalActions: [{ action: "exit" }] } } });
  assert.deepEqual(parseDecision(result.content, "shop"), { action: "exit" });
  assert.deepEqual(result.decision, { type: "forced", choice: "exit" });
  assert.equal(result.model, undefined);
  assert.equal(result.usage, undefined);
});

test("transmitted dive reminders distinguish remaining charges, exhaustion and an active final dive", async (t) => {
  let body;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify(reply(body.state.scene.player.diving ? "stay_coast" : "stay_fire")));
  });
  const client = createDecisionClient({ endpoint: "https://example.test", model: "deployment", apiKey });
  for (const player of [{ dives: 2, diveTicks: 0 }, { dives: 0, diveTicks: 0 },
    { dives: 0, diving: true, diveTicks: 12 }]) {
    const state = scene(player), before = structuredClone(state);
    await client.complete({ scene: state });
    const { instructions, criteria } = body.questions.action;
    assert.match(instructions, new RegExp(`DIVE STATUS: charges=${player.dives}, diving=${Boolean(player.diving)}, diveTicks=${player.diveTicks}`));
    if (player.diving) {
      assert.match(instructions, /No further dive can be started after surfacing/);
      assert.ok(criteria.stay_coast);
      assert.ok(criteria.stay_surface);
      assert.equal(criteria.stay_fire, undefined);
      assert.equal(criteria.stay_dive, undefined);
    } else if (player.dives === 0) {
      assert.match(instructions, /No dive action is available/);
      assert.equal(criteria.stay_dive, undefined);
    } else {
      assert.match(instructions, /A dive is available but spends one charge/);
      assert.ok(criteria.stay_dive);
    }
    assert.deepEqual(state, before);
  }
});

test("visible boss geometry and targeting advice are transmitted without selecting movement", async (t) => {
  let body;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify(reply("stay_fire")));
  });
  const client = createDecisionClient({ endpoint: "https://example.test", model: "deployment", apiKey });
  const state = { ...scene(), boss: {
    kind: "stage-one-boss", bounds: { x: 112, y: -84, w: 96, h: 96 },
    contactBounds: null, weakPoint: null,
  } };
  const result = await client.complete({ scene: state });
  assert.deepEqual(body.state.scene.boss, state.boss);
  assert.match(body.questions.action.instructions, /VISIBLE BOSS/);
  assert.match(body.questions.action.instructions, /NOT empty safe water/);
  assert.deepEqual(parseDecision(result.content), { fire: true });
  await client.complete({ scene: scene() });
  assert.doesNotMatch(body.questions.action.instructions, /VISIBLE BOSS/);
});

test("boss aim descriptions distinguish firing beside or above the weak point without changing controls", () => {
  const state = { ...scene(), boss: { kind: "stage-one-boss",
    weakPoint: { x: 152, y: 84, w: 16, h: 14 } } };
  state.player.weapons = [{ id: 1 }];
  const forecast = { movements: Object.fromEntries([
    ["stay", { x: 100, y: 56 }], ["down", { x: 100, y: 160 }],
    ["right", { x: 160, y: 56 }], ["down_right", { x: 160, y: 160 }],
  ].map(([direction, actionEnd]) => [direction, { actionEnd }])) };
  const options = decisionOptions(state, forecast);
  assert.match(options.stay_fire.description, /column NOT aligned, firing origin NOT below/);
  assert.match(options.down_fire.description, /column NOT aligned, firing origin below/);
  assert.match(options.right_fire.description, /column aligned, firing origin NOT below/);
  assert.match(options.down_right_fire.description, /column aligned, firing origin below/);
  const plain = decisionOptions(scene(), forecast);
  for (const key of Object.keys(plain)) assert.deepEqual(options[key].control, plain[key].control);
});

test("unknown choices and malformed probabilities never advance the game", async (t) => {
  let payload;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload)));
  const client = createDecisionClient({ endpoint: "https://example.test", model: "deployment", apiKey });
  for (const invalid of [
    {}, { answers: { action: { type: "noul", noul: 1 } } }, reply("invented"),
    reply("right_fire", { choice: { left: true, right: true } }),
    reply("right_fire", { probabilities: null }),
    reply("right_fire", { probabilities: {} }),
    reply("right_fire", { probabilities: { right_fire: 0.5, invented: 0.5 } }),
    reply("right_fire", { probabilities: { right_fire: "1" } }),
    reply("right_fire", { probabilities: { right_fire: -1 } }),
    reply("right_fire", { probabilities: { right_fire: 0.2 } }),
    reply("right_fire", { probabilities: { right_fire: 0, stay_fire: 1 } }),
    reply("right_fire", { confidence: 2 }),
  ]) {
    payload = invalid;
    const state = scene();
    const run = {
      decisionTicks: 4, observe: () => ({ observation: state }),
      step() { assert.fail("An invalid decision must not tick."); },
    };
    await assert.rejects(playWithFoundry(run, client, { maxDecisions: 1 }));
    assert.equal(state.elapsedTicks, 0);
  }
});

test("HTTP failures, invalid JSON, redirects and timeouts cannot leak the key or apply controls", async (t) => {
  let mode = "error";
  const server = createServer(async (request, response) => {
    if (request.url === "/redirected") assert.fail("Credential-bearing redirects must not be followed.");
    if (mode === "redirect") {
      response.writeHead(307, { Location: "/redirected" });
      response.end();
    } else if (mode === "timeout") {
      await setTimeout(100);
      response.end(JSON.stringify(reply()));
    } else {
      response.writeHead(mode === "error" ? 401 : 200);
      response.end(apiKey);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((accept) => server.close(accept));
  });
  const options = { endpoint: `http://127.0.0.1:${server.address().port}`, model: "deployment", apiKey };
  for (const [failure, message] of [["error", /HTTP 401/], ["json", /invalid JSON/],
    ["redirect", /request failed/], ["timeout", /timed out/]]) {
    mode = failure;
    const client = createDecisionClient({ ...options, timeoutMs: mode === "timeout" ? 10 : 1000 });
    await assert.rejects(client.complete({ scene: scene() }), (error) => {
      assert.match(error.message, message);
      assert.ok(!error.message.includes(apiKey));
      return true;
    });
  }
  const abort = new AbortController();
  const pending = createDecisionClient(options).complete({ scene: scene() }, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, /request failed/);
});

test("Decision configuration rejects insecure endpoints and missing credentials", () => {
  for (const options of [{ endpoint: "not a URL" }, { endpoint: "http://example.test" },
    { endpoint: "https://user:password@example.test" }, { endpoint: "https://example.test/?key=secret" },
    { endpoint: "https://example.test/other" }, { apiKey: "" }, { apiKey: "bad\nheader" },
    { model: "" }, { timeoutMs: 0 }]) {
    assert.throws(() => createDecisionClient({ endpoint: "https://example.test", model: "deployment", apiKey, ...options }));
  }
});
