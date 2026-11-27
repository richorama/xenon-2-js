import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { TICK_RATE } from "../src/game.js";
import { createFoundryClient, createGameplayFeedback, decisionPacket, forecastCollisions, navigationInstructions, parseDecision, playWithFoundry } from "../tools/foundry-local.mjs";

const completion = (content = '{"input":{"right":true,"fire":true}}') => ({
  model: "test-model", choices: [{ finish_reason: "stop", message: { content } }],
});

function scene(tick = 0) {
  return {
    elapsedTicks: tick, stage: 1, status: "playing", canStep: true,
    camera: 4608 - tick, score: 0, credits: 0, kills: 0,
    player: { x: 160, y: 174, health: 39, lives: 3 },
    enemies: [], bullets: [], pickups: [],
  };
}

function fakeRun() {
  const state = scene();
  const inputs = [];
  return {
    state, inputs, decisionTicks: 4,
    observe: () => ({ observation: structuredClone(state) }),
    step(input, ticks = this.decisionTicks) {
      inputs.push(input);
      state.elapsedTicks += ticks;
      state.camera -= ticks;
      if (input.right) state.player.x += ticks;
      return { ticksAdvanced: ticks, observation: structuredClone(state) };
    },
  };
}

test("model decisions accept only validated control JSON, including a sole JSON code block", () => {
  assert.deepEqual(parseDecision('{"input":{"fire":true}}'), { fire: true });
  assert.deepEqual(parseDecision('```json\n{"input":{"left":true}}\n```'), { left: true });
  for (const content of [null, "go right", "[]", "null", "{}", '{"input":null}',
    '{"input":{"fire":"yes"}}', '{"input":{"diving":true}}',
    '{"input":{"left":true,"right":true}}', '{"input":{},"ticks":120}',
    'Here you go: {"input":{"fire":true}}']) assert.throws(() => parseDecision(content));
});

test("shop decisions use a separate strict protocol and cannot issue flight or menu inputs", () => {
  for (const action of [{ action: "buy", id: 4 }, { action: "sell", slot: 5 }, { action: "more" }, { action: "exit" }]) {
    assert.deepEqual(parseDecision(JSON.stringify({ shop: action }), "shop"), action);
  }
  for (const content of ['{"input":{"fire":true}}', '{"shop":{"action":"buy","id":4,"ticks":1}}',
    '{"shop":{"action":"sell","slot":-1}}', '{"shop":{"action":"exit"},"input":{}}']) {
    assert.throws(() => parseDecision(content, "shop"));
  }
  for (const content of ['{"shop":{"action":"exit"}}', '{"input":{"activate":20}}', '{"input":{"confirm":true}}']) {
    assert.throws(() => parseDecision(content));
  }
});

test("Foundry HTTP transport sends the decision packet to chat completions and reports server failures", async (t) => {
  let mode = "ok";
  let requestBody;
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.method, "POST");
    let text = "";
    for await (const chunk of request) text += chunk;
    requestBody = JSON.parse(text);
    if (mode === "error") {
      response.writeHead(503);
      response.end("Model unavailable");
    } else if (mode === "incomplete") {
      const result = completion('{"input":');
      result.choices[0].finish_reason = "length";
      response.end(JSON.stringify(result));
    } else if (mode === "timeout") {
      await setTimeout(100);
      response.end(JSON.stringify(completion()));
    } else response.end(JSON.stringify(completion()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((accept) => server.close(accept));
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const client = createFoundryClient({ endpoint, model: "test-model" });
  const packet = { decisionTicks: 4, scene: scene() };
  assert.deepEqual(parseDecision((await client.complete(packet)).content), { right: true, fire: true });
  assert.equal(requestBody.model, "test-model");
  assert.equal(requestBody.stream, false);
  assert.equal(requestBody.temperature, 0);
  assert.equal(requestBody.max_tokens, 128);
  assert.equal(requestBody.messages[0].role, "system");
  assert.doesNotMatch(requestBody.messages[0].content, /NAVIGATION ALERT/);
  assert.doesNotMatch(requestBody.messages[0].content, /VISIBLE BOSS/);
  assert.ok(requestBody.messages[1].content.includes(JSON.stringify(packet)));
  assert.doesNotMatch(requestBody.messages[0].content, /collisionForecast gives/);
  const forecast = decisionPacket(scene(), [], 4, undefined, true);
  await client.complete(forecast);
  assert.ok(requestBody.messages[1].content.includes(JSON.stringify(forecast)));
  assert.match(requestBody.messages[0].content, /collisionForecast gives/);
  const exhausted = { ...packet, scene: { ...scene(), player: { ...scene().player, dives: 0, diving: false, diveTicks: 0 } } };
  await client.complete(exhausted);
  assert.match(requestBody.messages[0].content, /DIVE STATUS: charges=0, diving=false, diveTicks=0/);
  assert.match(requestBody.messages[0].content, /No dive action is available/);
  const submerged = { ...exhausted, scene: { ...exhausted.scene,
    player: { ...exhausted.scene.player, diving: true, diveTicks: 12 } } };
  await client.complete(submerged);
  assert.match(requestBody.messages[0].content, /DIVE STATUS: charges=0, diving=true, diveTicks=12/);
  assert.match(requestBody.messages[0].content, /No further dive can be started after surfacing/);
  assert.ok(requestBody.messages[1].content.includes(JSON.stringify(submerged)));
  await client.complete({ ...packet, realtime: { heldInput: { left: true }, previousLatencyMs: 200 } });
  assert.match(requestBody.messages[0].content, /game keeps ticking while you decide/);
  const navigation = { requiresRecovery: true, mapStalled: true, shipStalled: true,
    windowTicks: 32, newForwardPixels: 0, cycle: { directions: ["left", "right"] } };
  await client.complete({ ...packet, feedback: { navigation } });
  assert.match(requestBody.messages[0].content, /NAVIGATION ALERT: mapStalled=true/);
  assert.match(requestBody.messages[0].content, /left -> right/);
  await client.complete({ ...packet, feedback: { navigation: { ...navigation, bossVisible: true } } });
  assert.doesNotMatch(requestBody.messages[0].content, /NAVIGATION ALERT/);
  const enteringBoss = { ...packet, scene: { ...scene(), boss: {
    kind: "stage-one-boss", bounds: { x: 112, y: -84, w: 96, h: 96 },
    contactBounds: null, weakPoint: null,
  } } };
  await client.complete(enteringBoss);
  assert.match(requestBody.messages[0].content, /VISIBLE BOSS/);
  assert.match(requestBody.messages[0].content, /NOT empty safe water/);
  assert.ok(requestBody.messages[1].content.includes(JSON.stringify(enteringBoss)));
  await client.complete({ scene: { ...scene(), status: "shop", shop: { legalActions: [{ action: "exit" }] } } });
  assert.match(requestBody.messages[0].content, /Sell phase/);
  assert.doesNotMatch(requestBody.messages[0].content, /collisionForecast gives/);
  assert.match(requestBody.messages[1].content, /"shop":/);
  mode = "error";
  await assert.rejects(client.complete(packet), /HTTP 503.*Model unavailable/);
  mode = "incomplete";
  await assert.rejects(client.complete(packet), (error) =>
    error.message.includes("length") && error.completion.content === '{"input":');
  mode = "timeout";
  await assert.rejects(createFoundryClient({ endpoint, model: "test-model", timeoutMs: 10 }).complete(packet),
    (error) => error.name === "TimeoutError");
  const abort = new AbortController();
  const pending = client.complete(packet, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

test("reasoning mode uses one user prompt and separates thoughts from final flight and shop controls", async (t) => {
  let requestBody;
  const raw = '<think>Consider {"input":{"left":true}}, but reject it.</think>\n{"input":{"right":true,"fire":true}}';
  let result = completion(raw);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify(result));
  });
  const options = { endpoint: "http://localhost", model: "test-model", reasoning: true };
  const client = createFoundryClient(options);
  const packet = { decisionTicks: 4, scene: scene() };
  const reply = await client.complete(packet);
  assert.equal(requestBody.messages.length, 1);
  assert.equal(requestBody.messages[0].role, "user");
  assert.ok(requestBody.messages[0].content.includes(JSON.stringify(packet)));
  assert.equal(requestBody.temperature, 0.6);
  assert.equal(requestBody.max_tokens, 1024);
  assert.equal(reply.rawContent, raw);
  assert.equal(reply.reasoning, 'Consider {"input":{"left":true}}, but reject it.');
  assert.deepEqual(parseDecision(reply.content), { right: true, fire: true });
  assert.throws(() => parseDecision(raw));

  result = completion('{"shop":{"action":"exit"}}');
  result.choices[0].message.reasoning_content = "No useful purchase is affordable.";
  const shopping = { scene: { ...scene(), status: "shop", shop: { legalActions: [{ action: "exit" }] } } };
  const shop = await createFoundryClient({ ...options, maxTokens: 512 }).complete(shopping);
  assert.equal(requestBody.max_tokens, 512);
  assert.match(requestBody.messages[0].content, /Sell phase/);
  assert.equal(shop.reasoning, result.choices[0].message.reasoning_content);
  assert.deepEqual(parseDecision(shop.content, "shop"), { action: "exit" });
});

test("reasoning failures never apply a thought, truncated reply or invalid final controls", async (t) => {
  let result;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(result)));
  const client = createFoundryClient({ endpoint: "http://localhost", model: "test-model", reasoning: true });
  for (const [content, finishReason = "stop"] of [
    ['<think>{"input":{"fire":true}}'],
    ['{"input":{"fire":true}}</think>'],
    ['<think>First <think>nested</think> thought.</think>{"input":{"fire":true}}'],
    ['<think>{"input":{"fire":true}}</think>'],
    ['<think>Done.</think>Here is my answer: {"input":{"fire":true}}'],
    ['<think>Done.</think>{"input":{"left":true,"right":true}}'],
    ['<think>Done.</think>{"input":{"fire":true}}', "length"],
  ]) {
    result = completion(content);
    result.choices[0].finish_reason = finishReason;
    const run = fakeRun();
    await assert.rejects(playWithFoundry(run, client));
    assert.equal(run.state.elapsedTicks, 0);
    assert.deepEqual(run.inputs, []);
  }
});

test("Windows HTTP bridge passes JSON on stdin and uses an argument array, not a shell command", async (t) => {
  let executable, args, options, body;
  t.mock.method(childProcess, "execFile", (file, argv, opts, callback) => {
    executable = file;
    args = argv;
    options = opts;
    process.nextTick(() => callback(null, JSON.stringify(completion()), ""));
    return { stdin: { on() {}, end(text) { body = JSON.parse(text); } } };
  });
  const client = createFoundryClient({
    endpoint: "http://127.0.0.1:12345", model: "test-model", transport: "windows-curl",
  });
  assert.equal((await client.complete({ decisionTicks: 4 })).model, "test-model");
  assert.equal(executable, "curl.exe");
  assert.equal(args.at(-1), "http://127.0.0.1:12345/v1/chat/completions");
  assert.deepEqual(args.slice(args.indexOf("--data-binary"), -1), ["--data-binary", "@-"]);
  assert.equal(options.shell, undefined);
  assert.equal(body.model, "test-model");
  assert.ok(body.messages[1].content.includes('"decisionTicks":4'));
});

test("Foundry configuration rejects malformed endpoints, missing models and invalid transport limits", () => {
  for (const options of [{ endpoint: "not a URL" }, { endpoint: "file:///tmp/model" },
    { endpoint: "http://name:password@localhost" }, { endpoint: "http://localhost/?secret=value" },
    { endpoint: "http://localhost/other" }, { model: "" }, { transport: "shell" }, { timeoutMs: 0 },
    { reasoning: "yes" }, { maxTokens: 0 }, { maxTokens: 1.5 }, { maxTokens: NaN }]) {
    assert.throws(() => createFoundryClient({ endpoint: "http://localhost", model: "test-model", ...options }));
  }
});

test("decision packets derive measured motion and outcomes without fabricating newly-seen velocities", () => {
  const before = scene(4);
  before.enemies.push({ id: 1, bounds: { x: 10, y: 20, w: 8, h: 8 } });
  const current = scene(8);
  current.player.health = 31;
  current.score = 100;
  current.enemies.push({ id: 1, bounds: { x: 14, y: 28, w: 8, h: 8 } },
    { id: 2, bounds: { x: 100, y: 10, w: 8, h: 8 } });
  const history = [{ before, input: { right: true }, ticksRequested: 4, ticksAdvanced: 4, observation: current }];
  const packet = decisionPacket(current, history, 4);
  assert.equal(packet.motionInterval, 4);
  assert.equal(packet.cameraDelta, -4);
  assert.deepEqual(packet.scene.enemies[0].velocity, { x: 1, y: 2 });
  assert.equal(packet.scene.enemies[1].velocity, null);
  assert.equal(current.enemies[0].velocity, undefined);
  assert.equal(packet.recentDecisions[0].outcome.energyDelta, -8);
  assert.equal(packet.recentDecisions[0].outcome.scoreDelta, 100);
  assert.equal(packet.previousScenes[0].elapsedTicks, 4);
  assert.equal(decisionPacket(current, [], 4).scene.enemies[0].velocity, null);
  const respawn = { ...current, life: 1 };
  before.life = 0;
  const reset = decisionPacket(respawn, history, 4);
  assert.equal(reset.motionInterval, null);
  assert.equal(reset.scene.enemies[0].velocity, null);
  assert.deepEqual(reset.previousScenes, []);
  assert.equal(reset.recentDecisions.length, 1);
  const shopping = decisionPacket({ ...current, status: "shop", shop: { legalActions: [{ action: "exit" }] } }, history, 4);
  assert.equal(shopping.scene.enemies, undefined);
  assert.deepEqual(shopping.previousScenes, []);
});

test("compact feedback retains damage and failed movement after short scene history has forgotten them", () => {
  const feedback = createGameplayFeedback();
  let before = scene();
  before.enemies = [
    { id: 1, kind: "supply-pod", bounds: { x: 150, y: 160, w: 14, h: 14 } },
    { id: 2, kind: "enemy", bounds: { x: 0, y: 0, w: 14, h: 14 } },
  ];
  const initial = feedback.snapshot(before);
  const history = [];
  let first;
  for (let tick = 4; tick <= 80; tick += 4) {
    const after = scene(tick);
    after.camera = 4608;
    after.player.health = 31;
    const input = { up: true, fire: true };
    feedback.record(before, input, after);
    history.push({ before, input, ticksRequested: 4, ticksAdvanced: 4, observation: after });
    if (history.length > 12) history.shift();
    if (tick === 4) first = feedback.snapshot(after);
    before = after;
  }
  const packet = decisionPacket(before, history, 4, feedback.snapshot(before));
  assert.equal(packet.recentDecisions.length, 12);
  assert.ok(packet.recentDecisions.every(({ outcome }) => outcome.energyDelta === 0));
  assert.equal(packet.feedback.progress.ticksWithoutForwardProgress, 80);
  assert.equal(packet.feedback.progress.secondsWithoutForwardProgress, 80 / TICK_RATE);
  assert.deepEqual(packet.feedback.movementAttempts, [{
    input: { up: true, fire: true }, startTick: 0, endTick: 80, ticks: 80,
    displacement: { x: 0, y: 0, worldY: 0, cameraAdvance: 0 },
  }]);
  assert.deepEqual(packet.feedback.damageEvents, [{
    startTick: 0, endTick: 4, energyLost: 8, input: { up: true, fire: true },
    position: { x: 160, y: 174 },
    nearbyThreats: [{ id: 1, kind: "supply-pod", bounds: { x: 150, y: 160, w: 14, h: 14 } }],
  }]);
  assert.deepEqual(initial.movementAttempts, []);
  assert.equal(first.movementAttempts[0].ticks, 4);
  packet.feedback.damageEvents[0].energyLost = 999;
  assert.equal(feedback.snapshot(before).damageEvents[0].energyLost, 8);
});

test("twelve compact action outcomes do not expand scene snapshots or change measured motion", () => {
  const at = (tick) => ({ ...scene(tick), enemies: [
    { id: 1, kind: "enemy", bounds: { x: tick, y: 20, w: 8, h: 8 } },
  ] });
  const history = Array.from({ length: 16 }, (_, index) => ({
    before: at(index * 4), input: index % 2 ? { up: true, fire: true } : { down: true, fire: true },
    ticksRequested: 4, ticksAdvanced: 4, observation: at((index + 1) * 4),
  }));
  const packet = decisionPacket(at(64), history, 4);
  assert.equal(packet.recentDecisions.length, 12);
  assert.deepEqual(packet.recentDecisions.map(({ endTick }) => endTick),
    Array.from({ length: 12 }, (_, index) => 20 + index * 4));
  assert.ok(packet.recentDecisions.every((entry) => !entry.before && !entry.observation && !entry.scene));
  assert.deepEqual(packet.previousScenes.map(({ elapsedTicks }) => elapsedTicks), [56, 60]);
  assert.equal(packet.motionInterval, 4);
  assert.deepEqual(packet.scene.enemies[0].velocity, { x: 1, y: 0 });
});

function forecastScene() {
  const state = scene();
  Object.assign(state.player, {
    x: 100, y: 100, speedLevel: 0, banking: 0, bounds: { x: 98, y: 98, w: 4, h: 4 },
  });
  return state;
}

test("collision lookahead anticipates an incoming pod and distinguishes an escape from steering into it", () => {
  const state = forecastScene();
  state.enemies = [{ id: 1, kind: "supply-pod", bounds: { x: 118, y: 98, w: 4, h: 4 }, velocity: { x: -4, y: 0 } }];
  const forecast = forecastCollisions(state, 4);
  assert.equal(forecast.movements.stay.firstContact.tick, 3);
  assert.equal(forecast.movements.stay.firstContact.kind, "supply-pod");
  assert.ok(forecast.movements.right.firstContact.tick < 3);
  assert.equal(forecast.movements.left.firstContact, null);
  assert.ok(forecast.movements.left.horizonEnd.gap > forecast.movements.stay.minimumSampledGap);
});

test("swept collision forecasts catch a fast bullet passing entirely through the ship between sampled endpoints", () => {
  const state = forecastScene();
  state.bullets = [{ id: 2, kind: "bullet", bounds: { x: 130, y: 98, w: 2, h: 2 }, velocity: { x: -60, y: 0 } }];
  const { stay } = forecastCollisions(state, 1).movements;
  assert.equal(stay.firstContact.tick, 0.4);
  assert.equal(stay.minimumSampledGap, 0);
  assert.ok(stay.actionEnd.gap > 0);
});

test("finer decisions retain enough lookahead to see a threat beyond the next two ticks", () => {
  const state = forecastScene();
  state.enemies = [{ id: 1, kind: "enemy", bounds: { x: 118, y: 98, w: 4, h: 4 },
    velocity: { x: -4, y: 0 } }];
  for (const ticks of [1, 2]) {
    const forecast = forecastCollisions(state, ticks);
    assert.equal(forecast.movements.stay.firstContact.tick, 3);
    assert.equal(forecast.movements.stay.actionEnd.x, state.player.x);
    assert.ok(forecast.movements.stay.actionEnd.gap > 0);
    assert.ok(forecast.horizonTicks >= 8);
  }
});

test("lookahead retains banking drift and speed without changing the observation or claiming unknown motion is safe", () => {
  const state = forecastScene();
  Object.assign(state.player, { banking: 6, speedLevel: 2 });
  state.enemies = [{ id: 3, kind: "enemy", bounds: { x: 180, y: 100, w: 4, h: 4 }, velocity: null }];
  state.pickups = [{ id: 4, kind: "credit", bounds: { ...state.player.bounds } }];
  const before = structuredClone(state);
  const forecast = forecastCollisions(state, 1);
  assert.equal(forecast.movements.stay.actionEnd.x, 107);
  assert.equal(forecast.movements.right.actionEnd.x, 109);
  assert.equal(forecast.movements.left.actionEnd.x, 91);
  assert.equal(forecast.unknownMotionCount, 1);
  assert.equal(forecast.movements.stay.firstContact, null);
  assert.deepEqual(state, before);
  const longer = forecastCollisions(state, 120);
  assert.equal(longer.actionCovered, false);
  assert.equal(longer.movements.stay.actionEnd, null);
});

test("opt-in packet forecasts account for observed terrain scrolling and are omitted by default and in shops", () => {
  const before = forecastScene(), current = forecastScene();
  before.camera = 100;
  current.camera = 96;
  current.elapsedTicks = 4;
  current.terrain = { x: 96, y: 72, cellSize: 16, rows: ["1"] };
  const history = [{ before, observation: current, input: {}, ticksRequested: 4, ticksAdvanced: 4 }];
  assert.equal(decisionPacket(current, history, 4).collisionForecast, undefined);
  const packet = decisionPacket(current, history, 4, undefined, true);
  assert.equal(packet.collisionForecast.cameraVelocity, -1);
  assert.equal(packet.collisionForecast.movements.stay.firstContact.tick, 6);
  assert.equal(packet.collisionForecast.movements.stay.firstContact.kind, "terrain");
  assert.equal(packet.collisionForecast.movements.stay.actionEnd.gap, 2);
  assert.equal(forecastCollisions(current, 4, 0).movements.stay.firstContact, null);
  const shopping = decisionPacket({ ...current, status: "shop" }, history, 4, undefined, true);
  assert.equal(shopping.collisionForecast, undefined);
});

test("terrain forecasts use hull-clearance centres instead of expanding a partial tile around an already sized hull", () => {
  const state = forecastScene();
  state.terrain = { x: 96, y: 96, cellSize: 16, rows: ["1"] };
  assert.equal(forecastCollisions(state, 4, 0).movements.stay.firstContact.tick, 0);
  state.terrain.navigation = { x: 88, y: 100, cellSize: 8, rows: ["00010"] };
  const original = structuredClone(state), forecast = forecastCollisions(state, 4, 0);
  assert.equal(forecast.movements.stay.firstContact, null);
  assert.equal(forecast.movements.right.firstContact.kind, "terrain");
  assert.ok(forecast.movements.right.firstContact.tick > 2);
  state.terrain.touching = true;
  assert.equal(forecastCollisions(state, 4, 0).movements.stay.firstContact.tick, 0);
  delete state.terrain.touching;
  state.bullets.push({ id: 1, kind: "bullet", bounds: { x: 104, y: 100, w: 1, h: 1 }, velocity: { x: 0, y: 0 } });
  assert.equal(forecastCollisions(state, 4, 0).movements.stay.firstContact.tick, 0);
  assert.deepEqual({ ...state, bullets: [] }, original);
});

test("feedback bounds input segments and damage events while distinguishing screen movement from scrolling", () => {
  const feedback = createGameplayFeedback();
  let before = scene();
  for (let i = 1; i <= 10; i++) {
    const after = scene(i * 4);
    after.player.x += i % 2 ? 4 : 0;
    after.player.health -= i;
    feedback.record(before, { [i % 2 ? "right" : "left"]: true, fire: true }, after);
    before = after;
  }
  const { movementAttempts, damageEvents, progress } = feedback.snapshot(before);
  assert.equal(movementAttempts.length, 6);
  assert.equal(damageEvents.length, 4);
  assert.equal(damageEvents[0].startTick, 24);
  assert.deepEqual(movementAttempts.at(-1).displacement, { x: -4, y: 0, worldY: -4, cameraAdvance: 4 });
  assert.equal(progress.furthestCamera, 4568);
  assert.equal(progress.ticksWithoutForwardProgress, 0);
});

test("backtracking does not erase stalled progress, but a new forward position does", () => {
  const feedback = createGameplayFeedback();
  let before = scene();
  for (const [tick, camera] of [[4, 4604], [8, 4608], [12, 4606], [16, 4603]]) {
    const after = { ...scene(tick), camera };
    feedback.record(before, { fire: true }, after);
    if (tick === 12) {
      assert.equal(feedback.snapshot(after).progress.ticksWithoutForwardProgress, 8);
      assert.equal(feedback.snapshot(after).progress.furthestCamera, 4604);
    }
    before = after;
  }
  assert.equal(feedback.snapshot(before).progress.ticksWithoutForwardProgress, 0);
  assert.equal(feedback.snapshot(before).movementAttempts.length, 1);
});

test("terrain pushback remains visible even while the camera scrolls, and normal ship progress resets it", () => {
  const feedback = createGameplayFeedback();
  let before = scene();
  before.player.y = 120;
  for (let tick = 4; tick <= 40; tick += 4) {
    const after = scene(tick);
    after.player.y = 120 + tick;
    feedback.record(before, { fire: true }, after);
    before = after;
  }
  const blocked = feedback.snapshot(before);
  assert.equal(blocked.progress.ticksWithoutForwardProgress, 0);
  assert.equal(blocked.progress.ticksWithoutPlayerAdvance, 40);
  assert.equal(blocked.progress.secondsWithoutPlayerAdvance, 40 / TICK_RATE);
  assert.equal(blocked.movementAttempts[0].displacement.worldY, 0);
  assert.equal(blocked.navigation.mapStalled, false);
  assert.equal(blocked.navigation.shipStalled, true);
  assert.equal(blocked.navigation.requiresRecovery, true);
  const after = scene(44);
  after.player.y = before.player.y;
  feedback.record(before, { fire: true }, after);
  assert.equal(feedback.snapshot(after).progress.ticksWithoutPlayerAdvance, 0);
  assert.equal(feedback.snapshot(after).navigation.requiresRecovery, false);
});

test("up/down oscillation cannot repeatedly reset the ship-progress stall timer", () => {
  const feedback = createGameplayFeedback();
  let before = scene();
  before.player.y = 150;
  feedback.snapshot(before);
  for (let tick = 4; tick <= 32; tick += 4) {
    const after = scene(tick);
    after.camera = before.camera;
    after.player.y = tick % 8 ? 154 : 150;
    feedback.record(before, { [tick % 8 ? "down" : "up"]: true }, after);
    before = after;
  }
  assert.equal(feedback.snapshot(before).progress.ticksWithoutPlayerAdvance, 32);
  const advanced = structuredClone(before);
  advanced.elapsedTicks += 4;
  advanced.player.y = 146;
  feedback.record(before, { up: true }, advanced);
  assert.equal(feedback.snapshot(advanced).progress.ticksWithoutPlayerAdvance, 0);
});

test("map-stall flags detect negligible forward drift even when a tiny new camera record resets the old timer", () => {
  const feedback = createGameplayFeedback();
  let before = scene();
  feedback.snapshot(before);
  for (let tick = 4; tick <= 40; tick += 4) {
    const after = scene(tick);
    after.camera = 4608 - tick / 40;
    after.player.x += tick;
    feedback.record(before, { right: true, fire: true }, after);
    if (tick < 32) assert.equal(feedback.snapshot(after).navigation.mapStalled, false);
    before = after;
  }
  const stalled = feedback.snapshot(before);
  assert.equal(stalled.progress.ticksWithoutForwardProgress, 0);
  assert.equal(stalled.navigation.mapStalled, true);
  assert.equal(stalled.navigation.requiresRecovery, true);
  assert.equal(stalled.navigation.cycle, null);
  const advanced = scene(44);
  advanced.camera = before.camera - 32;
  feedback.record(before, { up: true, fire: true }, advanced);
  assert.equal(feedback.snapshot(advanced).navigation.requiresRecovery, false);
});

test("recovery feedback distinguishes a backtracking detour from resumed scrolling below an old high-water mark", () => {
  const feedback = createGameplayFeedback();
  let before = scene();
  before.camera = 4500;
  for (let tick = 4; tick <= 40; tick += 4) {
    const after = { ...scene(tick), camera: 4500 + tick };
    feedback.record(before, { down: true, fire: true }, after);
    before = after;
  }
  const retreat = feedback.snapshot(before);
  assert.equal(retreat.navigation.backtrackPixels, 40);
  assert.equal(retreat.navigation.recentCameraAdvance, -32);
  const after = { ...scene(72), camera: 4508, terrain: { recovering: false, touching: false } };
  feedback.record(before, { fire: true }, after);
  const resumed = feedback.snapshot(after);
  assert.equal(resumed.navigation.backtrackPixels, 8);
  assert.equal(resumed.navigation.recentCameraAdvance, 32);
  assert.equal(resumed.navigation.newForwardPixels, 0);
  assert.equal(resumed.navigation.requiresRecovery, true);
  const prompt = navigationInstructions({ scene: after, feedback: resumed });
  assert.match(prompt, /net camera advance over that window: 32 pixels; now 8 pixels behind/);
  assert.match(prompt, /current hull is clear of rock/);
  assert.match(prompt, /keep it while safe even before it exceeds the previous high-water mark/);
  after.terrain.recovering = true;
  assert.doesNotMatch(navigationInstructions({ scene: after, feedback: resumed }), /current hull is clear of rock/);
});

test("repeated world-position cycles are flagged with their movement sequence, but visible bosses suppress recovery alerts", () => {
  const feedback = createGameplayFeedback();
  let before = scene();
  before.camera = 2654;
  before.player.x = 129;
  before.player.y = 176;
  for (let tick = 4; tick <= 48; tick += 4) {
    const after = scene(tick), left = tick % 8 !== 0;
    after.camera = left ? 2658 : 2654;
    Object.assign(after.player, { x: left ? 93 : 129, y: 176, banking: left ? -4 : 4 });
    feedback.record(before, left ? { down: true, left: true, fire: true } : { right: true, fire: true }, after);
    before = after;
  }
  const navigation = feedback.snapshot(before).navigation;
  assert.equal(navigation.mapStalled, true);
  assert.equal(navigation.shipStalled, true);
  assert.equal(navigation.requiresRecovery, true);
  assert.deepEqual(navigation.cycle, {
    periodTicks: 8, repetitionsAtLeast: 3, directions: ["down_left", "right"],
  });
  before.boss = { kind: "stage-one-boss" };
  assert.equal(feedback.snapshot(before).navigation.requiresRecovery, false);
  delete before.boss;
  before.enemies.push({ kind: "stage-two-miniboss", bounds: { x: 100, y: 0, w: 40, h: 40 } });
  assert.equal(feedback.snapshot(before).navigation.mapStalled, true);
  assert.equal(feedback.snapshot(before).navigation.requiresRecovery, false);
});

test("feedback resets at life, shop, stage and campaign transitions instead of attributing respawn movement", () => {
  for (const change of [{ life: 1 }, { status: "shop" }, { stage: 2 }, { campaignRound: 2 }]) {
    const feedback = createGameplayFeedback();
    const before = { ...scene(), life: 0, campaignRound: 1 };
    let after = before;
    for (let tick = 4; tick <= 40; tick += 4) {
      const current = { ...scene(tick), camera: before.camera, life: 0, campaignRound: 1 };
      current.player.health = 31;
      feedback.record(after, { left: true }, current);
      after = current;
    }
    assert.equal(feedback.snapshot(after).damageEvents.length, 1);
    assert.equal(feedback.snapshot(after).navigation.requiresRecovery, true);
    assert.ok(feedback.snapshot(after).navigation.cycle);
    const next = { ...scene(100), life: 0, campaignRound: 1, ...change };
    feedback.record(after, {}, next);
    const snapshot = feedback.snapshot(next);
    if (change.status === "shop") assert.equal(snapshot, undefined);
    else {
      assert.deepEqual(snapshot.damageEvents, []);
      assert.deepEqual(snapshot.movementAttempts, []);
      assert.equal(snapshot.progress.ticksWithoutForwardProgress, 0);
      assert.equal(snapshot.navigation.mapStalled, false);
      assert.equal(snapshot.navigation.requiresRecovery, false);
      assert.equal(snapshot.navigation.cycle, null);
    }
  }
});

test("AI control waits for inference, keeps bounded history, and applies the configured tick interval", async () => {
  const run = fakeRun();
  run.decisionTicks = 7;
  const client = { async complete(packet) {
    assert.equal(packet.decisionTicks, 7);
    const snapshot = run.observe();
    await setTimeout(5);
    assert.deepEqual(run.observe(), snapshot);
    assert.ok(packet.previousScenes.length <= 2);
    assert.equal(packet.recentDecisions.length, Math.min(packet.scene.elapsedTicks / 7, 12));
    assert.equal(packet.feedback.progress.ticksWithoutForwardProgress, 0);
    assert.equal(packet.feedback.navigation.requiresRecovery, false);
    if (packet.scene.elapsedTicks) assert.equal(packet.feedback.movementAttempts[0].displacement.x, packet.scene.elapsedTicks);
    return { content: '{"input":{"right":true,"fire":true}}' };
  } };
  const result = await playWithFoundry(run, client, { maxDecisions: 16 });
  assert.equal(result.decisions, 16);
  assert.equal(result.observation.elapsedTicks, 112);
  assert.equal(result.observation.player.x, 272);
  assert.equal(run.inputs.length, 16);
});

test("real-time requests retain twelve compact applied-action outcomes and only two scene snapshots", async () => {
  const run = fakeRun();
  run.decisionTicks = 1;
  let requests = 0;
  const result = await playWithFoundry(run, { async complete(packet) {
    assert.equal(packet.recentDecisions.length, Math.min(requests++, 12));
    assert.ok(packet.previousScenes.length <= 2);
    return { content: '{"input":{"fire":true}}' };
  } }, { realtime: true, maxDecisions: 16 });
  assert.equal(requests, 16);
  assert.equal(result.decisions, 16);
});

test("tap-fire experiments reject real-time inference before requesting controls or advancing ticks", async () => {
  const run = fakeRun();
  run.tapFire = true;
  await assert.rejects(playWithFoundry(run, { complete() { assert.fail("No model request is allowed."); } },
    { realtime: true }), /require paused inference/);
  assert.deepEqual(run.inputs, []);
});

test("observation stop conditions end paused and real-time runs without changing the native scene or requesting controls", async () => {
  for (const realtime of [false, true]) {
    const run = fakeRun();
    Object.assign(run.state, { status: "shop", shop: { nextStage: 2, busy: true } });
    const expected = structuredClone(run.state);
    const result = await playWithFoundry(run, {
      complete() { assert.fail("A completed stage needs no further model request."); },
    }, { realtime, stopWhen: (state) => state.status === "shop" && state.shop.nextStage === 2 });
    assert.equal(result.decisions, 0);
    assert.deepEqual(result.observation, expected);
    assert.deepEqual(run.inputs, []);
  }
});

test("a stage-clear stop condition observes the applied action and stops before shop animation or another decision", async () => {
  const run = fakeRun(), step = run.step.bind(run);
  run.step = (input, ticks) => {
    const result = step(input, ticks);
    Object.assign(run.state, { status: "shop", shop: { nextStage: 2, busy: true } });
    return { ...result, observation: structuredClone(run.state) };
  };
  let requests = 0;
  const result = await playWithFoundry(run, { async complete() {
    requests++;
    return { content: '{"input":{"fire":true}}' };
  } }, { stopOnDeath: true, stopWhen: (state) => state.shop?.nextStage === 2 });
  assert.equal(requests, 1);
  assert.deepEqual(run.inputs, [{ fire: true }]);
  assert.equal(result.observation.elapsedTicks, 4);
  assert.equal(result.observation.canStep, true);
  assert.equal(result.benchmark.died, false);
  assert.equal(result.benchmark.elapsedTicks, 4);
});

test("invalid AI responses do not advance the game and terminal menus do not call the model", async () => {
  const run = fakeRun();
  await assert.rejects(playWithFoundry(run, { complete: async () => ({ content: '{"input":{"fire":1}}' }) }));
  assert.equal(run.state.elapsedTicks, 0);
  run.state.canStep = false;
  run.state.status = "gameover";
  const result = await playWithFoundry(run, { complete() { assert.fail("Game over must not call the model."); } });
  assert.equal(result.decisions, 0);
});

test("death animation and Get Ready use recorded controls without inference, then flight resumes", async () => {
  const run = fakeRun();
  const step = run.step.bind(run);
  let calls = 0;
  run.step = (input, ticks) => {
    if (run.state.status === "dying") assert.deepEqual(input, {});
    if (run.state.status === "turn-ready") assert.deepEqual(input, { confirm: true });
    run.state.status = ["dying", "dying", "turn-ready", "playing", "gameover"][run.inputs.length];
    run.state.canStep = run.state.status !== "gameover";
    return step(input, ticks);
  };
  const result = await playWithFoundry(run, { async complete() {
    calls++;
    return { content: '{"input":{"fire":true}}' };
  } });
  assert.equal(result.decisions, 2);
  assert.equal(calls, 2);
  assert.deepEqual(run.inputs, [{ fire: true }, {}, {}, { confirm: true }, { fire: true }]);
  assert.equal(result.observation.status, "gameover");
});

test("no-continue stops before spending a continue or calling the model", async () => {
  const run = fakeRun();
  run.state.status = "continue";
  const result = await playWithFoundry(run, { complete() { assert.fail("No decision is needed."); } }, { autoContinue: false });
  assert.equal(result.observation.status, "continue");
  assert.deepEqual(run.inputs, []);
});

test("first-death mode stops on the fatal tick and separates survived turns from the fatal flight decision", async () => {
  const run = fakeRun(), step = run.step.bind(run);
  let calls = 0;
  run.step = (input, ticks) => {
    const fatal = run.inputs.length === 1;
    const result = step(input, fatal ? 1 : ticks);
    if (fatal) {
      run.state.status = "dying";
      run.state.player.health = 0;
    }
    return { ...result, observation: structuredClone(run.state) };
  };
  const result = await playWithFoundry(run, { async complete() {
    assert.ok(++calls <= 2, "Do not request controls after death.");
    return { content: '{"input":{"fire":true}}' };
  } }, { stopOnDeath: true });
  assert.equal(result.decisions, 2);
  assert.equal(result.observation.status, "dying");
  assert.equal(result.observation.player.lives, 3);
  assert.equal(result.benchmark.survivedTurns, 1);
  assert.equal(result.benchmark.fatalTurn, 2);
  assert.equal(result.benchmark.died, true);
  assert.equal(result.benchmark.elapsedTicks, 5);
  assert.equal(result.benchmark.simulatedSeconds, 5 / TICK_RATE);
  assert.equal(run.inputs.length, 2);
});

test("survival benchmarks exclude shopping decisions and distinguish a live decision-limit exit", async () => {
  const run = fakeRun();
  run.state.status = "shop";
  run.state.shop = { busy: false };
  run.shop = () => {
    run.state.status = "playing";
    return run.step({}, 1);
  };
  const result = await playWithFoundry(run, { async complete(packet) {
    return { content: packet.scene.status === "shop" ? '{"shop":{"action":"exit"}}' : '{"input":{"fire":true}}' };
  } }, { maxDecisions: 2, stopOnDeath: true });
  assert.equal(result.decisions, 2);
  assert.equal(result.benchmark.flightTurns, 1);
  assert.equal(result.benchmark.survivedTurns, 1);
  assert.equal(result.benchmark.fatalTurn, null);
  assert.equal(result.benchmark.died, false);
});

test("progress benchmarks do not reward extra idle survival or erase progress after backtracking", async () => {
  const results = [];
  for (const maxDecisions of [3, 7]) {
    const run = fakeRun(), step = run.step.bind(run);
    run.state.progress = 0.1;
    run.step = (input, ticks) => {
      step(input, ticks);
      run.state.progress = run.inputs.length === 1 ? 0.4 : 0.35;
      return { ticksAdvanced: 4, ...run.observe() };
    };
    results.push((await playWithFoundry(run, { complete: async () => ({ content: '{"input":{"fire":true}}' }) },
      { maxDecisions, stopOnDeath: true })).benchmark);
  }
  assert.equal(results[0].objective, "furthest-game-progress");
  assert.equal(results[0].progress.start.progress, 0.1);
  assert.equal(results[0].progress.furthest.progress, 0.4);
  assert.equal(results[0].progress.final.progress, 0.35);
  assert.deepEqual(results[0].progress.furthest, results[1].progress.furthest);
  assert.ok(results[1].survivedTurns > results[0].survivedTurns);
  assert.ok(results[1].progress.maxStallSeconds > results[0].progress.maxStallSeconds);
});

test("progress benchmarks rank stages and campaign rounds before level fractions and retain between-decision peaks", async () => {
  const run = fakeRun(), step = run.step.bind(run);
  run.state.campaignRound = 1;
  run.state.levelProgress = 0.8;
  const positions = [[1, 1, 0.9], [1, 2, 0.05], [1, 2, 0.01], [2, 1, 0.02], [2, 1, 0.01]];
  run.step = (input, ticks) => {
    step(input, ticks);
    const [campaignRound, stage, levelProgress] = positions[run.inputs.length - 1];
    Object.assign(run.state, { campaignRound, stage, levelProgress });
    if (run.inputs.length === 4) {
      run.state.furthestProgress = { campaignRound, stage, progress: 0.03, elapsedTicks: run.state.elapsedTicks - 2 };
    }
    if (run.inputs.length === 5) run.state.status = "dying";
    return { ticksAdvanced: 4, ...run.observe() };
  };
  const result = await playWithFoundry(run, { complete: async () => ({ content: '{"input":{"fire":true}}' }) },
    { stopOnDeath: true });
  assert.deepEqual(result.benchmark.progress.furthest, { campaignRound: 2, stage: 1, progress: 0.03, elapsedTicks: 14 });
  assert.equal(result.benchmark.progress.final.progress, 0.01);
  assert.equal(result.benchmark.progress.ticksWithoutProgress, 6);
  assert.equal(result.benchmark.fatalTurn, 5);
});

test("collision forecasts are advisory and do not replace a model action even when it predicts contact", async () => {
  const run = fakeRun();
  run.state.enemies = [{ id: 1, kind: "supply-pod", bounds: { x: 150, y: 164, w: 22, h: 21 } }];
  await playWithFoundry(run, { async complete(packet) {
    assert.equal(packet.collisionForecast.movements.stay.firstContact.tick, 0);
    return { content: '{"input":{"right":true,"fire":true}}' };
  } }, { maxDecisions: 1, collisionLookahead: true });
  assert.deepEqual(run.inputs, [{ right: true, fire: true }]);
});

test("real-time first-death mode cancels pending inference without animating or respawning", async () => {
  const run = fakeRun(), step = run.step.bind(run);
  let cancelled = false;
  run.step = (input, ticks) => {
    assert.ok(run.state.elapsedTicks < 2, "Death must stop further ticks.");
    const result = step(input, ticks);
    if (run.state.elapsedTicks === 2) {
      run.state.status = "dying";
      run.state.player.health = 0;
    }
    return { ...result, observation: structuredClone(run.state) };
  };
  const result = await playWithFoundry(run, { complete: (packet, { signal }) => new Promise((accept, reject) => {
    signal.addEventListener("abort", () => { cancelled = true; reject(new Error("Cancelled")); }, { once: true });
  }) }, { realtime: true, stopOnDeath: true });
  assert.equal(cancelled, true);
  assert.equal(result.requests, 1);
  assert.equal(result.decisions, 0);
  assert.equal(result.observation.status, "dying");
  assert.equal(result.observation.elapsedTicks, 2);
  assert.equal(result.benchmark.survivedTurns, 0);
  assert.equal(result.benchmark.fatalTurn, null);
});

test("real-time control ticks during inference, holds buttons and pulses dive without overlapping requests", async () => {
  const run = fakeRun();
  const step = run.step.bind(run);
  const packets = [], delivered = [];
  let release, active = 0;
  const client = { complete(packet) {
    assert.equal(++active, 1);
    packets.push(packet);
    return new Promise((accept) => {
      release = () => {
        active--;
        accept({ content: JSON.stringify({ input: packets.length === 1
          ? { right: true, fire: true, dive: true } : { left: true, fire: true } }) });
      };
    });
  } };
  run.step = (input, ticks) => {
    assert.equal(ticks, 1);
    const result = step(input, ticks);
    if ([3, 7].includes(run.state.elapsedTicks)) release();
    return result;
  };
  const result = await playWithFoundry(run, client, {
    realtime: true, maxDecisions: 2, onDecision: (entry) => delivered.push(entry),
  });
  assert.equal(result.decisions, 2);
  assert.equal(result.requests, 2);
  assert.equal(result.observation.elapsedTicks, 11);
  assert.deepEqual(run.inputs.slice(0, 3), [{}, {}, {}]);
  assert.deepEqual(run.inputs[3], { right: true, fire: true, dive: true });
  assert.ok(run.inputs.slice(4, 7).every((input) => input.right && input.fire && !input.dive));
  assert.ok(run.inputs.slice(7).every((input) => input.left && input.fire && !input.dive));
  assert.deepEqual(delivered.map(({ requestedAtTick, receivedAtTick, appliedAtTick }) =>
    [requestedAtTick, receivedAtTick, appliedAtTick]), [[0, 3, 4], [4, 7, 8]]);
  assert.equal(packets[1].motionInterval, 4);
  assert.equal(packets[1].feedback.movementAttempts.reduce((ticks, attempt) => ticks + attempt.ticks, 0), 4);
  assert.equal(packets[1].feedback.movementAttempts.at(-1).displacement.x, 1);
  assert.deepEqual(packets[0].feedback.movementAttempts, []);
  assert.deepEqual(packets[1].realtime.heldInput, { right: true, fire: true });
  assert.ok(packets[1].recentDecisions[0].appliedInputs.some(({ atTick, input }) => atTick === 3 && input.dive));
  assert.ok(result.wallSeconds >= result.simulatedSeconds * 0.9);
});

test("invalid or failed real-time replies stop without applying them, but do not undo elapsed ticks", async () => {
  for (const fail of [false, true]) {
    const run = fakeRun();
    const step = run.step.bind(run);
    let release;
    run.step = (input, ticks) => {
      const result = step(input, ticks);
      if (run.state.elapsedTicks === 2) release();
      return result;
    };
    const client = { complete: () => new Promise((accept, reject) => {
      release = () => fail ? reject(new Error("Service unavailable")) : accept({ content: '{"input":{"fire":1}}' });
    }) };
    await assert.rejects(playWithFoundry(run, client, { realtime: true, maxDecisions: 1 }),
      fail ? /Service unavailable/ : /boolean/);
    assert.equal(run.state.elapsedTicks, 2);
    assert.deepEqual(run.inputs, [{}, {}]);
  }
});

test("real-time replies from a previous life are discarded while death and confirmation continue ticking", async () => {
  const run = fakeRun();
  run.state.life = 0;
  const step = run.step.bind(run);
  let release, calls = 0;
  run.step = (input, ticks) => {
    const result = step(input, ticks);
    if (run.state.elapsedTicks === 1) run.state.status = "dying";
    if (run.state.elapsedTicks === 2) run.state.status = "turn-ready";
    if (run.state.elapsedTicks === 3) {
      run.state.status = "playing";
      run.state.life = 1;
    }
    if (run.state.elapsedTicks === 4) release();
    return { ...result, observation: structuredClone(run.state) };
  };
  const result = await playWithFoundry(run, { complete() {
    if (++calls === 1) return new Promise((accept) => {
      release = () => accept({ content: '{"input":{"right":true}}' });
    });
    return Promise.resolve({ content: '{"input":{"fire":true}}' });
  } }, { realtime: true, maxDecisions: 2 });
  assert.equal(result.requests, 2);
  assert.equal(result.decisions, 1);
  assert.equal(result.observation.elapsedTicks, 8);
  assert.deepEqual(run.inputs[2], { confirm: true });
  assert.ok(run.inputs.every((input) => !input.right));
  assert.ok(run.inputs.slice(4).every((input) => input.fire));
});

test("an expired real-time surface choice is discarded instead of starting another dive", async () => {
  const run = fakeRun();
  run.state.player.diving = true;
  const step = run.step.bind(run);
  let release;
  run.step = (input, ticks) => {
    run.state.player.diving = false;
    const result = step(input, ticks);
    if (run.state.elapsedTicks === 2) release();
    return result;
  };
  const result = await playWithFoundry(run, { complete: () => new Promise((accept) => {
    release = () => accept({ content: '{"input":{"dive":true}}' });
  }) }, { realtime: true, maxDecisions: 1 });
  assert.equal(result.requests, 1);
  assert.equal(result.decisions, 0);
  assert.equal(run.state.elapsedTicks, 2);
  assert.ok(run.inputs.every((input) => !input.dive));
});

test("real-time shopping ticks while deciding and between selection, quote and confirmation", async () => {
  const run = fakeRun();
  run.state.status = "shop";
  run.state.shop = {
    phase: "buy", page: 0, busy: false, quotedIndex: null,
    offers: [{ id: 3, index: 2 }], legalActions: [{ action: "buy", id: 3 }],
  };
  const step = run.step.bind(run);
  let release, busyTicks = 0, purchases = 0;
  run.step = (input, ticks) => {
    if (input.activate !== undefined) {
      assert.equal(run.state.shop.busy, false);
      if (input.activate === 2) run.state.shop.quotedIndex = 2;
      else {
        assert.equal(input.activate, 21);
        assert.equal(run.state.shop.quotedIndex, 2);
        purchases++;
      }
      busyTicks = 2;
    } else if (busyTicks) busyTicks--;
    run.state.shop.busy = busyTicks > 0;
    const result = step(input, ticks);
    if (run.state.elapsedTicks === 2) release();
    return result;
  };
  const result = await playWithFoundry(run, { complete: () => new Promise((accept) => {
    release = () => accept({ content: '{"shop":{"action":"buy","id":3}}' });
  }) }, { realtime: true, maxDecisions: 1 });
  assert.equal(result.decisions, 1);
  assert.equal(purchases, 1);
  assert.equal(result.observation.shop.busy, false);
  assert.deepEqual(run.inputs, [{}, {}, { activate: 2 }, {}, {}, { activate: 21 }, {}, {}]);
});

test("real-time terminal states cancel pending inference and no-continue spends no ticks", async () => {
  const run = fakeRun();
  const step = run.step.bind(run);
  let cancelled = false;
  run.step = (input, ticks) => {
    run.state.status = "gameover";
    run.state.canStep = false;
    return step(input, ticks);
  };
  const result = await playWithFoundry(run, { complete: (packet, { signal }) => new Promise((accept, reject) => {
    signal.addEventListener("abort", () => { cancelled = true; reject(new Error("Cancelled")); }, { once: true });
  }) }, { realtime: true });
  assert.equal(result.decisions, 0);
  assert.equal(result.observation.elapsedTicks, 1);
  assert.equal(cancelled, true);
  run.state.canStep = true;
  run.state.status = "continue";
  await playWithFoundry(run, { complete() { assert.fail("Continue must not call the model."); } },
    { realtime: true, autoContinue: false });
  assert.equal(run.state.elapsedTicks, 1);
});
