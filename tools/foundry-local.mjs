import childProcess from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TICK_RATE } from "../src/game.js";
import { movePlayer } from "../src/controls.js";
import { compareProgress, DEFAULT_DECISION_TICKS, validateAction, validateShopAction } from "../src/headless.js";
import { createHeadlessRun } from "./headless.mjs";
import { createRecoveryNavigation, recoveryInstructions } from "./recovery-navigation.mjs";
import { createNavigationMemory, incidentInstructions } from "./navigation-memory.mjs";

export const RECENT_DECISION_LIMIT = 12;

export const flightRules = `You are playing Xenon 2: Megablast, a vertically scrolling spaceship shoot-em-up.
Use the supplied scene and rules as authoritative for this implementation.
Your overall goal is to progress through the level and defeat its boss, not merely remain alive.
While pursuing that goal, choose routes using these priorities, in strict order:
1. Preserve health and lives.
2. Safely open supply pods with gunfire and collect their released supplies and power-ups.
3. Safely collect credit bubbles.
4. Shoot enemies.
A lower-priority objective does not justify taking avoidable damage. Choose a safe power-up over a bubble or a shot when you cannot safely do both.
Safe supply acquisition is your main proactive task when not evading danger. It outranks recentering, maximizing empty clearance, or scrolling faster once a route is safe.
Seek gun kills, not collision kills. Ramming enemies or spending lives to collect drops is not a successful attack or collection strategy.
Energy is health; reaching zero costs a life. Lives and continues are finite, so do not sacrifice a ship recklessly for a minor reward.
Advance through the level and defeat its boss when safe, without reversing the priority order.
The benchmark rewards furthest game progress, NOT time alive. Surviving indefinitely in a blocked corridor is not success.
That is a long-term goal, not a reason to skip equipment: brief safe detours and aiming pauses to secure supplies help later progress.
The level normally scrolls automatically; terrain can interrupt it. Holding down at the bottom can backtrack.
You do NOT need to move up to advance. Keep maneuvering room, but move to aim at enemies and reach collectible supplies and bubbles.
Your forward gun fires upward, toward smaller Y. Aim from below enemies without flying into them.
When surfaced, keep firing equipped weapons while moving OR waiting: shooting does not prevent steering or pickup collection.
Prefer ordinary steering while firing over ceasing fire, hiding, or diving whenever normal movement can handle the danger.

Supply drops:
Sealed supply containers are hazardous enemies with kind "supply-pod", NOT collectible pickups.
Align horizontally and shoot from BELOW: keep the top of player.bounds below the pod's bottom edge (larger Y), leaving a gap.
Your forward gun cannot hit a pod below you. Move around it with clearance before getting below it; never cross through it to line up.
Do not fly into a sealed pod's row or wait in its path; a moving pod can ram a stationary ship.
Keep firing from a safe distance until the pod disappears and a released pickup appears in scene.pickups.
Contact can break a pod and immediately collect its reward, but that still costs energy and is NOT a successful safe collection.
When safe, aim at pods, open them with gunfire, then collect their released supplies before chasing bubbles or ordinary enemies.
Prefer an already released reachable supply over opening another pod. Keep pursuing the same safe supply rather than switching targets every decision.
Once safely lined up below a pod, maintain the firing line and adjust only as needed to track it; do not bob up and down unnecessarily.
Ordinary enemies do not each turn into an upgrade. Defeating an entire enemy formation can release credit bubbles/globes.
kind "credit" pickups are valuable bubbles: collect them to fund health and weapons in Colin's Shop, not just for score.
scene.pickups contains collectible drops, not hostile bullets. Fly into a pickup while surfaced to collect it; shooting it is not collection.
Reward drops can grant health, weapons, upgrades, speed, autofire, protection, dives or a screen clear.
A generic kind "reward" does NOT identify its particular effect in this observation; do not assume it is health.
Drops move and can expire. Collect reachable supplies first, then bubbles, while using normal dodging and firing on the way.
Skip a pickup when reaching it would predictably cost health; preserving health has higher priority than collecting it.

Choose controls for the next decisionTicks simulation ticks:
Avoid approaching enemies, bullets and terrain BEFORE they overlap player.bounds. Use bounds, not just centre points.
X increases right; Y increases down. Velocity is measured screen pixels per tick; null is unknown.
Predict where threats will move during the action. Terrain "1" marks a partly hazardous 16-pixel cell.
Check your own movement and banking throughout the action too: a clear destination is not safe if getting there crosses an enemy or pod.
Move to evade danger, line up shots or safely collect drops, not merely to be moving.
Keep a steady course toward the chosen supply or firing line while it remains safe. Reverse for a developing hazard or a missed intercept, not merely because another direction offers slightly more empty space.
Move conservatively: make the smallest necessary control change to maintain a safe firing line or collect the chosen supply. Use recentDecisions to notice needless back-and-forth, but change course promptly for a real hazard; do not wait or refuse a vertical dodge just to appear steady.
Stay still and fire when safe and well positioned. If recent controls lost energy or kept pushing a screen edge, reconsider them.
Banking causes horizontal inertia. Choose an escape with room to move; reversing blindly toward another threat is not evasion.
Terrain can rewind/push the ship back without costing energy. Repeating the same controls or waiting can leave you bouncing forever.
Terrain is NOT harmless: failed recovery or surfacing inside a wall can crush the ship regardless of remaining energy.
feedback.progress measures time without reaching a new furthest-forward camera position, not merely survival.
It also measures time without the ship advancing in world Y: camera motion plus equal downward pushback is NOT ship progress.
Only a new furthest-forward world position resets the ship-progress timer; moving up and down in the same pocket is not progress.
feedback.movementAttempts summarizes actual screen/world displacement; near-zero results mean the attempted route did not work.
If progress stalls in an ordinary corridor, try a different route toward visible open space instead of repeating failed movement.
feedback.navigation explicitly flags stalled map progress, stalled world-space ship movement and repeated-state cycles. Lateral movement and tiny new camera records do not necessarily mean useful forward progress.
When requiresRecovery is true, change the route that is failing. Prefer a safe connected route that restores forward scrolling over staying indefinitely in a safe-looking pocket. Do not endlessly alternate the same movements.
terrain.navigation is a hull-clearance map sampled every cellSize pixels: rows index ship CENTRES at (x + column*cellSize, y + row*cellSize). "0" means the native surfaced hull fits at that point; "1" means blocked. It is not the raw rock grid and does not include enemies.
Before entering a channel, trace connected clear samples around the next obstruction; a safe four-tick endpoint can still be a dead end. Samples do not guarantee that the path between them is clear. terrain.touching is the exact current hull/rock overlap; it takes precedence over nearby clear samples.
terrain.recovering means the native terrain rewind is active; it can undo steering. Repeated up/sideways attempts that return to the same position are not an escape.
If terrain.recovering or terrain.touching confirms a blocked hull, a brief straight retreat can create turning room. Once the hull is clear and native recovery has stopped, stop retreating and turn around the obstruction through open water.
DOWN at y=176 requests reverse map scrolling instead of further downward screen movement. To move sideways while allowing forward scrolling, omit DOWN. Do not choose a down-diagonal merely because its free-flight clearance matches the corresponding sideways action.
feedback.navigation.recentCameraAdvance measures actual net camera movement over its window; positive means forward, negative means backtracking. backtrackPixels is the current distance behind the furthest camera position.
Do not interrupt a safe forward-moving detour just because it has not yet beaten an old progress record. An old world-position stall alone is not proof the current hull is blocked.
Maintain a safe detour over several decisions, checking actual world displacement each time. Temporary backtracking is acceptable to reach a new forward route; endless retreat or alternating down/stay is not.
Boss fights can legitimately stop scrolling; do not abandon a visible boss merely because the camera is stationary.
feedback.damageEvents remembers recent energy losses and nearby threats; proximity is context, NOT proof of the damage cause.
Use damage history to avoid repeating damaging routes. Resume safe power-up collection, bubble collection and shooting in that order once clear.
Dive is a LAST RESORT: each use spends a limited charge and prevents firing and pickup collection while submerged.
First try ordinary steering while firing. Dive only for an imminent hit that normal movement cannot avoid, or an otherwise inescapable terrain trap.
Last resort does NOT mean never dive: use a remaining charge before an otherwise unavoidable lethal hit or fatal crush, rather than lose the ship with charges unused.
When terrain blocks normal escape, combine a charged dive with movement into open space; do not simply resurface inside the obstruction.
While diving, move clear of terrain and enemies before surfacing. Omit dive to stay protected while still in danger.
Once a safe surfacing route is clear, surface and resume shooting/collection rather than wasting the whole dive hiding.
Protection lasts until the dive timer expires unless you deliberately end it early; never surface inside an obstruction.
Do not press dive again while already diving unless you want to surface.`;

export const realtimeRules = `The game keeps ticking while you decide. Your controls take effect on receipt, not at the observed tick,
and stay held until replaced. decisionTicks is the minimum observation interval, not a fixed action duration.
Allow for inference latency. realtime.heldInput shows the current buttons; realtime.previousLatencyMs is the last measured response time.
Dive is a single press, not a held button.`;

export const lookaheadRules = `Preserving health means anticipating collisions, not reacting only after energy is lost.
Before selecting controls, check the whole proposed path during decisionTicks and the room to escape afterwards.
collisionForecast gives advisory geometric predictions for each movement direction, shared by its fire/coast/dive/surface choices.
Avoid a predicted contact during the action before considering power-ups, bubbles or shots. Prefer routes that leave clearance afterwards.
If every ordinary route risks an imminent hit, consider a charged emergency dive rather than losing health with charges unused.
The forecast uses free-flight steering and linear observed threat/camera motion, not future game state.
When available, terrain warnings use the hull-clearance samples, not solid 16-pixel rock tiles. Their gaps measure ship-centre clearance to sampled blocked positions; enemy gaps include the four-pixel hull margin.
Unknown threat velocities are checked at their current bounds only. Coarse terrain cells can overstate hazards.
No predicted contact is NOT a guarantee of safety: new spawns, changing trajectories, terrain pushback and backtracking are not simulated.
Predictions describe geometry, not damage or dive immunity; submerged ship bounds can understate the size needed for safe surfacing.
The horizon is capped at 16 ticks; check actionCovered before trusting it for a longer action.
In real-time mode predictions start at the observed tick, not when controls arrive; allow for latency and held controls.
Use these estimates with the actual scene and movement/damage history. They do not override your choice.`;

export const flightDirections = [
  ["stay", {}, "Hold position"],
  ["left", { left: true }, "Move left"],
  ["right", { right: true }, "Move right"],
  ["up", { up: true }, "Move up"],
  ["down", { down: true }, "Move down"],
  ["up_left", { up: true, left: true }, "Move up and left"],
  ["up_right", { up: true, right: true }, "Move up and right"],
  ["down_left", { down: true, left: true }, "Move down and left"],
  ["down_right", { down: true, right: true }, "Move down and right"],
];

export function diveInstructions(scene) {
  const player = scene?.player;
  if (scene?.status !== "playing" || !Number.isSafeInteger(player?.dives) || player.dives < 0) return "";
  const status = `\nDIVE STATUS: charges=${player.dives}, diving=${Boolean(player.diving)}, diveTicks=${player.diveTicks ?? "unknown"}. `;
  if (player.diving) {
    return status + "Omit dive to continue the current dive; a surface action ends it, not starts another."
      + (player.dives === 0 ? " No further dive can be started after surfacing unless a new charge is actually collected." : "");
  }
  return status + (player.dives === 0
    ? "No dive action is available. Plan using surfaced movement and firing; do not approach danger assuming a future dive or refill will save the ship."
    : "A dive is available but spends one charge and prevents firing and collection while submerged. Save it for an imminent hit ordinary steering cannot avoid, not routine supply approach or speculative future danger.");
}

export function bossInstructions(scene) {
  if (scene?.status !== "playing" || scene.boss?.kind !== "stage-one-boss") return "";
  return `\nVISIBLE BOSS: scene.boss describes the currently drawn body, its active contactBounds and its currently targetable weakPoint.
The body can be visible before contactBounds and weakPoint activate. This is its entrance, NOT empty safe water: prepare a firing line below the visible body, leaving at least a full hull of extra space for its entering arms, while checking live hazards.
Use the lower firing lane with as much vertical separation as safely available; do not hover just below the mouth or beside the upper body. Newly unfolding arms can rapidly cross that small gap before their measured velocity is known. Prepare this separation during the entrance, not after the first hit.
Once weakPoint is present, aim sustained forward fire through it from below, while keeping the hull outside the body and dodging threats. You do not need to fly upward into the boss to hit it.
Forward shots travel straight upward along the ship's x coordinate. Parking above or beside the weak point misses it, however long you fire. When safe, first move below the body, then align horizontally with the weak point and hold that firing line; do not camp beside the boss merely because staying still looks locally clear.
Health still outranks firing alignment. Abandon the firing line BEFORE an arm reaches the hull. If no dive is available and every route warns of contact, do not freeze: an unavoidable first hit does not justify accepting repeated hits. Compare horizonEnd clearance and move out of the overlapping arm, then return to a firing line once clear.
The articulated arms are indestructible contact hazards, not useful shooting targets. Preserve a safe firing line rather than chasing an arm, a bubble or further upward movement.
Boss defeat, not extra camera scrolling or time alive, is the objective here. Keep firing whenever surfaced; all movement and dive choices remain yours.`;
}

export function navigationInstructions(packet) {
  const navigation = packet.feedback?.navigation;
  if (packet.scene?.status !== "playing" || !navigation?.requiresRecovery || navigation.bossVisible) return "";
  return `\nNAVIGATION ALERT: mapStalled=${navigation.mapStalled}, shipStalled=${navigation.shipStalled}, cycling=${Boolean(navigation.cycle)}.
New map progress: ${navigation.newForwardPixels} pixels over ${navigation.windowTicks} ticks.
${Number.isFinite(navigation.recentCameraAdvance) ? `Actual net camera advance over that window: ${navigation.recentCameraAdvance} pixels; now ${navigation.backtrackPixels} pixels behind the furthest camera position.` : ""}
${navigation.shipStalled ? "The ship has not reached a new furthest world position for at least 32 ticks, even if the camera is moving." : ""}
${navigation.cycle ? `Repeated no-progress movement cycle: ${navigation.cycle.directions.join(" -> ")}.` : ""}
${packet.scene.terrain?.recovering === false && packet.scene.terrain?.touching === false ? "The current hull is clear of rock and native terrain recovery is NOT active. Do not retreat just because a historical progress timer is high." : ""}
Your task is to progress through the level. Prefer safe controls that allow forward scrolling, not maximum empty space gained by scrolling backwards.
Safe pod opening and reachable supply collection still outrank faster scrolling; do not abandon a safe supply approach solely to chase a camera record.
At the bottom edge, DOWN (including down-diagonals) requests backtracking. Omit DOWN to let the level advance while steering or firing. Retreat only to clear an actual obstruction or avoid a hit, then stop retreating as soon as clear.
If a safe route is already advancing the camera, keep it while safe even before it exceeds the previous high-water mark. If actual movement is blocked, trace a connected detour through the clearance map rather than repeating failed controls.
Keep firing while steering. Still avoid known enemy contact; dive remains a limited last resort for an otherwise inescapable trap. These warnings do not override your control choice.`;
}

const instructions = `${flightRules}
Return only {"input":{...}}. The value of input MUST be an OBJECT, never true or false.
Its only allowed keys are left, right, up, down, fire, dive, with boolean values; omitted buttons are false.
Never combine opposite directions. Do not output ticks, target coordinates, explanations or other fields.`;

export const shopRules = `You are shopping for a spaceship between flights in Xenon 2: Megablast. Prioritize survival and useful equipment.
scene.shop describes Colin's actual visible stock, prices, visit budget, mount constraints and legalActions.
Sell phase: sell by mount slot, or exit to finish selling and enter buying. You cannot return to selling.
Buy phase: buy by item id, more to change equipment page when available, or exit to resume flight.
Use player health, lives, weapons and upgrades to avoid wasting credits. New weapons use the game's mount rules.
Choose exactly one object from scene.shop.legalActions. Do not invent stock or spend beyond the shown constraints.`;

const shopInstructions = `${shopRules}
Return ONLY {"shop":{"action":"exit"}} or the same wrapper around another listed legal action.
Examples: {"shop":{"action":"buy","id":4}} or {"shop":{"action":"sell","slot":5}}.
Do not output input, ticks, prose, code fences or other fields.`;

export function parseDecision(content, phase = "playing") {
  if (typeof content !== "string") throw new Error("Model did not return text control JSON.");
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(content.trim());
  let decision;
  try {
    decision = JSON.parse(fenced ? fenced[1] : content);
  } catch {
    throw new Error("Model did not return valid control JSON.");
  }
  const key = phase === "shop" ? "shop" : "input";
  if (!decision || Array.isArray(decision) || typeof decision !== "object"
    || Object.keys(decision).length !== 1 || !Object.hasOwn(decision, key)) {
    throw new Error(`Model must return only {"${key}":{...}}.`);
  }
  if (key === "shop") validateShopAction(decision.shop);
  else validateAction(decision.input, 1);
  return decision[key];
}

export function createFoundryClient({
  endpoint, model, transport = "http", timeoutMs = 120000, curlExecutable = "curl.exe",
  reasoning = false, maxTokens = reasoning ? 1024 : 128,
} = {}) {
  const base = new URL(endpoint);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password
    || base.search || base.hash || !["/", "/v1", "/v1/"].includes(base.pathname)) {
    throw new Error("Endpoint must be an HTTP(S) service URL, optionally ending in /v1, without credentials or a query.");
  }
  if (typeof model !== "string" || !model.trim()) throw new Error("A Foundry Local model ID is required.");
  if (!["http", "windows-curl"].includes(transport)) throw new Error("Transport must be http or windows-curl.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Timeout must be a positive integer in milliseconds.");
  if (typeof reasoning !== "boolean") throw new Error("Reasoning must be a boolean.");
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error("Max tokens must be a positive integer.");
  base.pathname = "/v1/chat/completions";
  return {
    async complete(packet, { signal } = {}) {
      const shopping = packet.scene?.status === "shop";
      const selectingRoute = Boolean(packet.recovery?.candidates);
      const prompt = shopping ? shopInstructions : (selectingRoute
        ? `${flightRules}\nReturn only {"input":{...},"waypoint":"offered plan id or manual"}. Input contains only boolean left, right, up, down, fire or dive buttons. Never combine opposite directions.`
        : instructions)
        + (packet.collisionForecast ? `\n${lookaheadRules}` : "")
        + (packet.realtime ? `\n${realtimeRules}` : "")
        + navigationInstructions(packet)
        + diveInstructions(packet.scene)
        + recoveryInstructions(packet)
        + incidentInstructions(packet)
        + bossInstructions(packet.scene);
      const question = shopping
        ? JSON.stringify(packet) + '\nChoose one scene.shop.legalActions object. Reply only with {"shop":{...chosen action...}}.'
        : `Read-only game state, NOT the response format:\n<game-state>\n${JSON.stringify(packet)}\n</game-state>\nChoose controls using this priority order: preserve health, collect power-ups, collect credit bubbles, shoot enemies. Do not trade health for a lower-priority objective. Do not copy the scene or repeat past controls blindly. ${selectingRoute
          ? 'Return exactly {"input":{...},"waypoint":"id"} using an offered recovery.candidates id or "manual".'
          : 'Your reply must have exactly one top-level key, "input", whose value is an object containing only boolean left, right, up, down, fire or dive buttons.'} Omitted buttons are false. Return only that control JSON, with no scene fields or other text.`;
      const body = JSON.stringify({
        model, stream: false, temperature: reasoning ? 0.6 : 0, max_tokens: maxTokens,
        messages: reasoning ? [{
          role: "user",
          content: `${prompt}\n\n${question}\n\nYou may first reason briefly inside one leading <think>...</think> block. After that block, your final answer must contain only the required control JSON.`,
        }] : [{ role: "system", content: prompt }, { role: "user", content: question }],
      });
      let text;
      if (transport === "windows-curl") {
        text = await new Promise((accept, reject) => {
          const child = childProcess.execFile(curlExecutable, [
            "--noproxy", "*", "--connect-timeout", "3", "--max-time", String(timeoutMs / 1000),
            "--fail-with-body", "--silent", "--show-error", "-H", "Content-Type: application/json",
            "--data-binary", "@-", base.href,
          ], { timeout: timeoutMs + 2000, maxBuffer: 1024 * 1024, windowsHide: true, signal }, (error, stdout, stderr) => {
            if (error) reject(new Error(`Windows Foundry HTTP request failed: ${(stderr || stdout || error.message).slice(0, 1000)}`));
            else accept(stdout);
          });
          child.stdin.on("error", () => {});
          child.stdin.end(body);
        });
      } else {
        const response = await fetch(base, {
          method: "POST", headers: { "Content-Type": "application/json" }, body,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
        if (!response.ok) throw new Error(`Foundry HTTP ${response.status}: ${text.slice(0, 1000)}`);
      }
      const response = JSON.parse(text);
      const choice = response.choices?.[0];
      const completion = {
        model: response.model ?? model, content: choice?.message?.content,
        finishReason: choice?.finish_reason, usage: response.usage,
      };
      if (reasoning) completion.rawContent = completion.content;
      if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string") {
        const error = new Error(`Foundry did not return a complete text decision (${choice?.finish_reason ?? "no choice"}).`);
        error.completion = completion;
        throw error;
      }
      if (reasoning) {
        const thought = /^\s*<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/.exec(completion.content);
        if (thought) completion.content = thought[2];
        completion.reasoning = [choice.message.reasoning_content, thought?.[1]]
          .filter((part) => typeof part === "string").join("\n");
        if (/<\/?think>/.test(completion.content) || (thought && /<\/?think>/.test(thought[1]))) {
          const error = new Error("Model returned an incomplete or misplaced reasoning block.");
          error.completion = completion;
          throw error;
        }
      }
      if (selectingRoute) {
        const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(completion.content.trim());
        const value = JSON.parse(fenced ? fenced[1] : completion.content);
        if (!value || Object.keys(value).length !== 2 || !Object.hasOwn(value, "input")
          || typeof value.waypoint !== "string"
          || value.waypoint !== "manual" && !packet.recovery.candidates.some(({ id }) => id === value.waypoint)) {
          throw new Error("Model must select an offered recovery waypoint or manual.");
        }
        parseDecision(JSON.stringify({ input: value.input }));
        completion.rawContent ??= completion.content;
        completion.content = JSON.stringify({ input: value.input });
        completion.navigationDecision = { choice: value.waypoint };
      }
      return completion;
    },
  };
}

function compactScene(scene) {
  return {
    elapsedTicks: scene.elapsedTicks, camera: scene.camera,
    player: { x: scene.player.x, y: scene.player.y },
    ...Object.fromEntries(["enemies", "bullets", "pickups"].map((kind) =>
      [kind, scene[kind].map(({ id, bounds }) => ({ id, bounds }))])),
  };
}

export function createGameplayFeedback({ navigationMemory = [], onMemoryChange } = {}) {
  const memory = createNavigationMemory(navigationMemory, onMemoryChange);
  let flight, furthestCamera, furthestWorldY, lastProgressTick, lastPlayerAdvanceTick;
  let movementAttempts = [], damageEvents = [], progressSamples = [];
  const sample = (scene, input) => ({
    tick: scene.elapsedTicks, camera: scene.camera, furthestCamera,
    position: [scene.player.x, scene.camera + scene.player.y, scene.camera]
      .map((value) => Math.round(value / 4)).concat(scene.player.banking ?? 0).join(","),
    direction: input ? [
      input.up ? "up" : input.down ? "down" : "",
      input.left ? "left" : input.right ? "right" : "",
    ].filter(Boolean).join("_") || "stay" : null,
  });
  const cycle = () => {
    const recent = progressSamples.filter(({ direction }) => direction !== null);
    for (let period = 1; period <= Math.min(8, Math.floor(recent.length / 3)); period++) {
      if (Array.from({ length: period * 2 }, (_, index) =>
        recent.at(-1 - index).position === recent.at(-1 - index - period).position).every(Boolean)) {
        return {
          periodTicks: recent.at(-1).tick - recent.at(-1 - period).tick,
          repetitionsAtLeast: 3, directions: recent.slice(-period).map(({ direction }) => direction),
        };
      }
    }
    return null;
  };
  const identity = (scene) => scene.status === "playing"
    ? JSON.stringify([scene.stage, scene.life, scene.campaignRound]) : undefined;
  const reset = (scene) => {
    flight = identity(scene);
    furthestCamera = scene.camera;
    furthestWorldY = scene.camera + scene.player.y;
    lastProgressTick = scene.elapsedTicks;
    lastPlayerAdvanceTick = scene.elapsedTicks;
    movementAttempts = [];
    damageEvents = [];
    progressSamples = [sample(scene)];
  };
  const ensure = (scene) => {
    if (!identity(scene) || flight !== identity(scene)) reset(scene);
  };
  return {
    memory: () => memory.entries(),
    record(before, input, after) {
      memory.record(before, after);
      ensure(before);
      if (!flight || flight !== identity(after) || after.elapsedTicks <= before.elapsedTicks) {
        reset(after);
        return;
      }
      if (after.camera < furthestCamera) {
        furthestCamera = after.camera;
        lastProgressTick = after.elapsedTicks;
      }
      if (after.camera + after.player.y < furthestWorldY) {
        furthestWorldY = after.camera + after.player.y;
        lastPlayerAdvanceTick = after.elapsedTicks;
      }
      progressSamples.push(sample(after, input));
      while (progressSamples.length > 1 && progressSamples[1].tick <= after.elapsedTicks - 64) progressSamples.shift();
      const buttons = Object.fromEntries(["left", "right", "up", "down", "fire", "dive"]
        .filter((key) => input[key]).map((key) => [key, true]));
      let attempt = movementAttempts.at(-1);
      if (!attempt || attempt.endTick !== before.elapsedTicks
        || JSON.stringify(attempt.input) !== JSON.stringify(buttons)) {
        attempt = {
          input: buttons, startTick: before.elapsedTicks, endTick: before.elapsedTicks,
          ticks: 0, displacement: { x: 0, y: 0, worldY: 0, cameraAdvance: 0 },
        };
        movementAttempts.push(attempt);
        if (movementAttempts.length > 6) movementAttempts.shift();
      }
      attempt.endTick = after.elapsedTicks;
      attempt.ticks += after.elapsedTicks - before.elapsedTicks;
      attempt.displacement.x += after.player.x - before.player.x;
      attempt.displacement.y += after.player.y - before.player.y;
      attempt.displacement.worldY += after.camera + after.player.y - before.camera - before.player.y;
      attempt.displacement.cameraAdvance += before.camera - after.camera;
      const energyLost = before.player.health - after.player.health;
      if (energyLost > 0) {
        const ship = before.player.bounds ?? { x: before.player.x, y: before.player.y, w: 0, h: 0 };
        const distance = ({ bounds: box }) => Math.hypot(
          Math.max(box.x - ship.x - ship.w, ship.x - box.x - box.w, 0),
          Math.max(box.y - ship.y - ship.h, ship.y - box.y - box.h, 0));
        const nearbyThreats = [...before.enemies, ...before.bullets]
          .filter((actor) => distance(actor) <= 32).sort((a, b) => distance(a) - distance(b)).slice(0, 2)
          .map(({ id, kind, bounds }) => ({ id, kind, bounds: { ...bounds } }));
        damageEvents.push({
          startTick: before.elapsedTicks, endTick: after.elapsedTicks, energyLost,
          input: buttons, position: { x: before.player.x, y: before.player.y }, nearbyThreats,
        });
        if (damageEvents.length > 4) damageEvents.shift();
      }
    },
    snapshot(scene) {
      ensure(scene);
      if (!flight) return undefined;
      const ticks = scene.elapsedTicks - lastProgressTick;
      const playerTicks = scene.elapsedTicks - lastPlayerAdvanceTick;
      const windowStart = progressSamples.findLast(({ tick }) => tick <= scene.elapsedTicks - 32) ?? progressSamples[0];
      const windowTicks = scene.elapsedTicks - windowStart.tick;
      const newForwardPixels = windowStart.furthestCamera - furthestCamera;
      const mapStalled = windowTicks >= 32 && newForwardPixels < 8;
      const shipStalled = playerTicks >= 32;
      const bossVisible = Boolean(scene.boss)
        || scene.enemies.some(({ kind }) => typeof kind === "string" && kind.includes("boss"));
      const navigation = {
        mapStalled, shipStalled, windowTicks, newForwardPixels,
        recentCameraAdvance: windowStart.camera - scene.camera,
        backtrackPixels: scene.camera - furthestCamera,
        cycle: mapStalled ? cycle() : null, bossVisible,
        requiresRecovery: !bossVisible && (mapStalled || shipStalled),
      };
      const nearbyIncidents = memory.nearby(scene, navigation);
      return structuredClone({
        progress: {
          furthestCamera, furthestWorldY, ticksWithoutForwardProgress: ticks,
          secondsWithoutForwardProgress: ticks / TICK_RATE,
          ticksWithoutPlayerAdvance: playerTicks,
          secondsWithoutPlayerAdvance: playerTicks / TICK_RATE,
        },
        navigation,
        ...(nearbyIncidents.length ? { nearbyIncidents } : {}),
        movementAttempts, damageEvents,
      });
    },
  };
}

export function forecastCollisions(scene, decisionTicks, cameraVelocity = null) {
  const horizonTicks = Math.min(16, Math.max(8, decisionTicks * 2));
  const margin = 4;
  const hazards = [...scene.enemies, ...scene.bullets].map((actor) => ({
    id: actor.id, kind: actor.kind, bounds: actor.bounds,
    velocity: actor.velocity, unknownMotion: !actor.velocity,
  }));
  const unknownMotionCount = hazards.filter((actor) => actor.unknownMotion).length;
  const terrain = scene.terrain;
  const navigation = terrain?.navigation;
  const grid = navigation ?? terrain;
  for (const [row, cells] of (grid?.rows ?? []).entries()) {
    for (let column = 0; column < cells.length; column++) {
      if (cells[column] === "1") hazards.push({
        kind: "terrain",
        bounds: {
          x: grid.x + (column - (navigation ? 0.5 : 0)) * grid.cellSize,
          y: grid.y + (row - (navigation ? 0.5 : 0)) * grid.cellSize,
          w: grid.cellSize, h: grid.cellSize,
        },
        shipCentre: Boolean(navigation),
        velocity: { x: 0, y: -(cameraVelocity ?? 0) },
        unknownMotion: cameraVelocity === null,
      });
    }
  }
  const gap = (a, b) => Math.hypot(
    Math.max(b.x - a.x - a.w, a.x - b.x - b.w, 0),
    Math.max(b.y - a.y - a.h, a.y - b.y - b.h, 0));
  const contactTime = (a, b, dx, dy) => {
    let enter = 0, leave = 1;
    for (const [position, size, delta] of [["x", "w", dx], ["y", "h", dy]]) {
      if (!delta) {
        if (a[position] + a[size] < b[position] || b[position] + b[size] < a[position]) return null;
      } else {
        const first = (b[position] - a[position] - a[size]) / delta;
        const last = (b[position] + b[size] - a[position]) / delta;
        enter = Math.max(enter, Math.min(first, last));
        leave = Math.min(leave, Math.max(first, last));
      }
    }
    return enter <= leave ? enter : null;
  };
  const rounded = (value) => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
  const bounds = scene.player.bounds ?? { x: scene.player.x - 10, y: scene.player.y - 10, w: 22, h: 21 };
  const boxAt = (player) => ({
    x: bounds.x + player.x - scene.player.x - margin, y: bounds.y + player.y - scene.player.y - margin,
    w: bounds.w + 2 * margin, h: bounds.h + 2 * margin,
  });
  const movements = Object.fromEntries(flightDirections.map(([direction, input]) => {
    const player = { x: scene.player.x, y: scene.player.y, speed: scene.player.speedLevel ?? 0 };
    const control = { bank: scene.player.banking ?? 0 };
    let minimumGap = Infinity, firstContact = null, actionEnd = null, horizonEnd;
    for (let tick = 1; tick <= horizonTicks; tick++) {
      const centreBefore = { x: player.x, y: player.y, w: 0, h: 0 };
      const before = boxAt(player);
      movePlayer(player, input, control);
      const after = boxAt(player);
      let endGap = Infinity;
      for (const hazard of hazards) {
        const from = hazard.shipCentre ? centreBefore : before;
        const to = hazard.shipCentre ? { x: player.x, y: player.y, w: 0, h: 0 } : after;
        const velocity = hazard.velocity ?? { x: 0, y: 0 };
        const start = {
          ...hazard.bounds,
          x: hazard.bounds.x + velocity.x * (tick - 1), y: hazard.bounds.y + velocity.y * (tick - 1),
        };
        const end = { ...start, x: start.x + velocity.x, y: start.y + velocity.y };
        const hit = contactTime(from, start, to.x - from.x - velocity.x, to.y - from.y - velocity.y);
        const clearance = gap(to, end);
        minimumGap = Math.min(minimumGap, gap(from, start), clearance, hit === null ? Infinity : 0);
        endGap = Math.min(endGap, clearance);
        const atTick = hit === null ? null : tick - 1 + hit;
        if (atTick !== null && (!firstContact || atTick < firstContact.tick)) {
          firstContact = {
            tick: atTick, kind: hazard.kind,
            ...(hazard.id === undefined ? {} : { id: hazard.id }),
            uncertainMotion: hazard.unknownMotion,
          };
        }
      }
      const endpoint = { x: player.x, y: player.y, gap: rounded(endGap) };
      if (tick === decisionTicks) actionEnd = endpoint;
      horizonEnd = endpoint;
    }
    if (terrain?.touching) {
      minimumGap = 0;
      if (!firstContact || firstContact.tick > 0) firstContact = { tick: 0, kind: "terrain", uncertainMotion: false };
    }
    if (firstContact) firstContact.tick = rounded(firstContact.tick);
    return [direction, { firstContact, minimumSampledGap: rounded(minimumGap), actionEnd, horizonEnd }];
  }));
  return {
    horizonTicks, actionCovered: decisionTicks <= horizonTicks, marginPixels: margin,
    cameraVelocity, unknownMotionCount, movements,
  };
}

export function decisionPacket(observation, history, decisionTicks, feedback, collisionLookahead = false) {
  const scene = structuredClone(observation);
  delete scene.energyLost;
  const previous = history.at(-1)?.before;
  const sameFlight = (before) => before?.status === "playing" && before.stage === scene.stage
    && before.life === scene.life && before.campaignRound === scene.campaignRound;
  const interval = scene.status === "playing" && sameFlight(previous)
    && history.at(-1).observation.elapsedTicks === scene.elapsedTicks ? scene.elapsedTicks - previous.elapsedTicks : 0;
  const lastBreak = history.findLastIndex(({ before, observation: after }) =>
    !sameFlight(before) || after.status !== "playing" || after.life !== scene.life || after.stage !== scene.stage);
  for (const kind of ["enemies", "bullets", "pickups"]) {
    if (scene.status === "shop") {
      delete scene[kind];
      continue;
    }
    const old = new Map((previous?.[kind] ?? []).map((actor) => [actor.id, actor]));
    for (const actor of scene[kind]) {
      const prior = old.get(actor.id);
      actor.velocity = interval > 0 && prior
        ? { x: (actor.bounds.x - prior.bounds.x) / interval, y: (actor.bounds.y - prior.bounds.y) / interval }
        : null;
    }
  }
  if (scene.status === "shop") delete scene.terrain;
  return {
    decisionTicks, motionInterval: interval || null,
    cameraDelta: interval > 0 ? scene.camera - previous.camera : null,
    scene,
    ...(collisionLookahead && scene.status === "playing"
      ? { collisionForecast: forecastCollisions(scene, decisionTicks, interval > 0 ? (scene.camera - previous.camera) / interval : null) }
      : {}),
    ...(feedback ? { feedback: structuredClone(feedback) } : {}),
    previousScenes: scene.status === "playing"
      ? history.slice(lastBreak + 1).slice(-2).map(({ before }) => compactScene(before)) : [],
    recentDecisions: history.slice(-RECENT_DECISION_LIMIT).map(({ before, input, shop, appliedInputs, ticksRequested, ticksAdvanced, observation: after }) => ({
      ...(appliedInputs ? { appliedInputs } : input ? { input } : { shop }),
      ticksRequested, ticksAdvanced, endTick: after.elapsedTicks,
      outcome: {
        energyDelta: after.player.health - before.player.health,
        livesDelta: after.player.lives - before.player.lives,
        creditsDelta: after.credits - before.credits,
        scoreDelta: after.score - before.score,
        killsDelta: after.kills - before.kills,
        continuesDelta: Number.isInteger(before.continues) && Number.isInteger(after.continues)
          ? after.continues - before.continues : null,
        position: { x: after.player.x, y: after.player.y }, status: after.status,
      },
    })),
  };
}

function runBenchmark(run, flightTurns, startTick, realtime, progress) {
  const { observation } = run.observe();
  const died = observation.status === "dying";
  const benchmark = {
    objective: "furthest-game-progress",
    progress: {
      start: progress.start, furthest: progress.furthest, final: progress.position(observation),
      ticksWithoutProgress: observation.elapsedTicks - progress.furthest.elapsedTicks,
      maxStallSeconds: progress.maxStallTicks / TICK_RATE,
    },
    healthRemaining: observation.player.health,
    survivedTurns: Math.max(0, flightTurns - Number(died)),
    fatalTurn: died && flightTurns ? flightTurns : null, died, flightTurns,
    decisionTicks: run.decisionTicks, realtime,
    ...(run.tapFire ? { tapFire: true } : {}),
    elapsedTicks: observation.elapsedTicks - startTick,
    simulatedSeconds: (observation.elapsedTicks - startTick) / TICK_RATE,
  };
  if (run.output) writeFileSync(join(run.output, "benchmark.json"), JSON.stringify(benchmark, null, 2) + "\n");
  return benchmark;
}

function createProgressTracker(initial) {
  const position = (scene) => ({
    campaignRound: scene.campaignRound ?? 1, stage: scene.stage,
    progress: scene.levelProgress ?? scene.progress ?? 0, elapsedTicks: scene.elapsedTicks,
  });
  const tracker = {
    position, start: position(initial), furthest: position(initial), maxStallTicks: 0,
    record(scene) {
      const current = position(scene), peak = scene.furthestProgress ?? current;
      if (compareProgress(peak, this.furthest) > 0) {
        this.furthest = { ...peak };
      }
      this.maxStallTicks = Math.max(this.maxStallTicks, scene.maxProgressStallTicks ?? 0,
        scene.elapsedTicks - this.furthest.elapsedTicks);
    },
  };
  return tracker;
}

async function playRealtime(run, client, { maxDecisions, autoContinue, stopOnDeath, collisionLookahead, onDecision, stopWhen, navigationMemory }) {
  const started = performance.now();
  const startTick = run.observe().observation.elapsedTicks;
  const progress = createProgressTracker(run.observe().observation);
  const tickMs = 1000 / TICK_RATE;
  const abort = new AbortController();
  const history = [];
  const feedback = createGameplayFeedback({ navigationMemory, onMemoryChange: (entries) => {
    if (run.output) writeFileSync(join(run.output, "navigation-memory.json"), JSON.stringify(entries, null, 2) + "\n");
  } });
  const recovery = createRecoveryNavigation();
  const context = (scene) => JSON.stringify([
    scene.status, scene.stage, scene.life, scene.campaignRound, scene.shop?.phase, scene.shop?.page,
  ]);
  const log = (entry) => {
    if (run.output) appendFileSync(join(run.output, "decisions.jsonl"), JSON.stringify(entry) + "\n");
  };
  let decisions = 0, requests = 0, automaticTicks = 0, epoch = 0, flightTurns = 0;
  let input = {}, shopInputs = [], pending, interval, wake;
  let nextTickAt = started + tickMs, nextRequestTick = startTick;
  let finishAtTick, finishingShop = false, previousLatencyMs = null;
  const hold = (buttons) => {
    input = { ...buttons };
    interval?.appliedInputs.push({ atTick: run.observe().observation.elapsedTicks, input: { ...input } });
  };
  try {
    while (true) {
      const before = run.observe().observation;
      if (!before.canStep || stopWhen(before) || stopOnDeath && before.status === "dying"
        || before.status === "continue" && !autoContinue) break;
      if (pending?.result) {
        const request = pending;
        const { completion, error, latencyMs } = request.result;
        pending = undefined;
        previousLatencyMs = latencyMs;
        if (requests === maxDecisions) finishAtTick = before.elapsedTicks;
        const entry = {
          packet: request.packet, completion: completion ?? error?.completion, latencyMs,
          requestedAtTick: request.packet.scene.elapsedTicks, receivedAtTick: before.elapsedTicks,
        };
        try {
          if (error) throw error;
          if (request.epoch !== epoch) {
            log({ ...entry, discarded: "Game context changed during inference." });
          } else {
            const action = parseDecision(completion.content, before.status);
            if (action.dive && request.packet.scene.player.diving !== before.player.diving) {
              log({ ...entry, discarded: "Dive state changed during inference." });
            } else {
              if (before.status === "shop") {
                if (!before.shop.legalActions.some((legal) =>
                  Object.keys(legal).every((key) => legal[key] === action[key]))) {
                  throw new Error("Shop action is not currently available.");
                }
                if (action.action === "exit" || action.action === "more") {
                  shopInputs = [action.action === "exit" ? 20 : 19];
                } else {
                  const offer = before.shop.offers.find((item) =>
                    action.action === "buy" ? item.id === action.id : item.slot === action.slot);
                  shopInputs = before.shop.quotedIndex === offer.index ? [21] : [offer.index, 21];
                }
              } else {
                recovery.select(request.packet, completion.navigationDecision?.choice);
                hold(action);
                flightTurns++;
              }
              decisions++;
              if (requests === maxDecisions) {
                finishingShop = before.status === "shop";
                finishAtTick = before.elapsedTicks + run.decisionTicks;
              }
              const applied = {
                ...entry, decision: decisions, appliedAtTick: before.elapsedTicks + 1,
                ...(before.status === "shop" ? { shop: action } : { input: action }),
                ...run.observe(),
              };
              log(applied);
              onDecision(applied);
            }
          }
        } catch (failure) {
          log({ ...entry, error: failure.message });
          throw failure;
        }
      }
      if (requests === maxDecisions && !pending && (finishingShop
        ? !shopInputs.length && !before.shop?.busy
        : before.elapsedTicks >= finishAtTick)) break;
      const ready = before.status === "playing" || before.status === "shop" && !before.shop.busy;
      if (!pending && requests < maxDecisions && !shopInputs.length && ready
        && before.elapsedTicks >= nextRequestTick) {
        if (interval) {
          const ticks = before.elapsedTicks - interval.before.elapsedTicks;
          history.push({ ...interval, ticksRequested: ticks, ticksAdvanced: ticks, observation: before });
          if (history.length > RECENT_DECISION_LIMIT) history.shift();
        }
        const packet = decisionPacket(before, history, run.decisionTicks, feedback.snapshot(before), collisionLookahead);
        const navigation = recovery.snapshot(before, packet.feedback);
        if (navigation) packet.recovery = navigation;
        packet.realtime = { heldInput: { ...input }, previousLatencyMs };
        interval = { before, appliedInputs: [{ atTick: before.elapsedTicks, input: { ...input } }] };
        const request = { packet, epoch };
        pending = request;
        requests++;
        nextRequestTick = before.elapsedTicks + run.decisionTicks;
        const sentAt = performance.now();
        Promise.resolve().then(() => client.complete(packet, { signal: abort.signal })).then(
          (completion) => { request.result = { completion, latencyMs: performance.now() - sentAt }; wake?.(); },
          (error) => { request.result = { error, latencyMs: performance.now() - sentAt }; wake?.(); },
        );
      }
      if (performance.now() >= nextTickAt) {
        let controls = {};
        if (before.status === "playing") controls = input;
        else if (before.status === "shop" && !before.shop.busy && shopInputs.length) {
          controls = { activate: shopInputs.shift() };
        } else if (["turn-ready", "continue", "score-entry"].includes(before.status)) controls = { confirm: true };
        const result = run.step(controls, 1);
        progress.record(result.observation);
        feedback.record(before, controls, result.observation);
        if (!result.ticksAdvanced) break;
        nextTickAt += tickMs;
        if (context(before) !== context(result.observation)) {
          epoch++;
          hold({});
          shopInputs = [];
        } else if (input.dive) {
          const held = { ...input };
          delete held.dive;
          hold(held);
        }
        if (ready) automaticTicks = 0;
        else if (++automaticTicks > 2000) throw new Error("Automatic lifecycle transition did not finish.");
        if (performance.now() >= nextTickAt) await new Promise((accept) => setTimeout(accept, 0));
        continue;
      }
      await new Promise((accept) => {
        const timer = setTimeout(accept, Math.max(0, nextTickAt - performance.now()));
        wake = () => { clearTimeout(timer); accept(); };
        if (pending?.result) wake();
      });
      wake = undefined;
    }
    return {
      decisions, requests, ...run.observe(), realtime: true,
      navigationMemory: feedback.memory(),
      ...(stopOnDeath ? { benchmark: runBenchmark(run, flightTurns, startTick, true, progress) } : {}),
      wallSeconds: (performance.now() - started) / 1000,
      simulatedSeconds: (run.observe().observation.elapsedTicks - startTick) / TICK_RATE,
    };
  } finally {
    abort.abort();
    if (pending) log({
      packet: pending.packet, completion: pending.result?.completion,
      requestedAtTick: pending.packet.scene.elapsedTicks,
      receivedAtTick: run.observe().observation.elapsedTicks,
      discarded: "Run ended before the decision could be applied.",
    });
  }
}

export async function playWithFoundry(run, client, {
  maxDecisions = 50, autoContinue = true, realtime = false, stopOnDeath = false,
  collisionLookahead = false, onDecision = () => {}, stopWhen = () => false, navigationMemory = [],
} = {}) {
  if (!Number.isSafeInteger(maxDecisions) || maxDecisions < 1) throw new Error("Decision limit must be a positive integer.");
  if (typeof autoContinue !== "boolean") throw new Error("autoContinue must be a boolean.");
  if (typeof realtime !== "boolean") throw new Error("realtime must be a boolean.");
  if (typeof stopOnDeath !== "boolean") throw new Error("stopOnDeath must be a boolean.");
  if (typeof collisionLookahead !== "boolean") throw new Error("collisionLookahead must be a boolean.");
  if (typeof stopWhen !== "function") throw new Error("stopWhen must be a function.");
  if (realtime && run.tapFire) throw new Error("Tap-fire experiments currently require paused inference.");
  if (realtime) return playRealtime(run, client, { maxDecisions, autoContinue, stopOnDeath, collisionLookahead, onDecision, stopWhen, navigationMemory });
  const history = [];
  const feedback = createGameplayFeedback({ navigationMemory, onMemoryChange: (entries) => {
    if (run.output) writeFileSync(join(run.output, "navigation-memory.json"), JSON.stringify(entries, null, 2) + "\n");
  } });
  const recovery = createRecoveryNavigation();
  const startTick = run.observe().observation.elapsedTicks;
  const progress = createProgressTracker(run.observe().observation);
  let decisions = 0, flightTurns = 0;
  let automaticTicks = 0;
  const log = (entry) => {
    if (run.output) appendFileSync(join(run.output, "decisions.jsonl"), JSON.stringify(entry) + "\n");
  };
  while (decisions < maxDecisions) {
    const { observation: before } = run.observe();
    if (!before.canStep || stopWhen(before) || stopOnDeath && before.status === "dying") break;
    if (before.status !== "playing" && !(before.status === "shop" && !before.shop.busy)) {
      if (before.status === "continue" && !autoContinue) break;
      const confirm = ["turn-ready", "continue", "score-entry"].includes(before.status);
      const result = run.step(confirm ? { confirm: true } : {}, confirm ? 1 : run.decisionTicks);
      progress.record(result.observation);
      feedback.record(before, {}, result.observation);
      automaticTicks += result.ticksAdvanced;
      if (!result.ticksAdvanced || automaticTicks > 2000) throw new Error("Automatic lifecycle transition did not finish.");
      continue;
    }
    const packet = decisionPacket(before, history, run.decisionTicks, feedback.snapshot(before), collisionLookahead);
    const navigation = recovery.snapshot(before, packet.feedback);
    if (navigation) packet.recovery = navigation;
    const started = performance.now();
    let completion;
    try {
      completion = await client.complete(packet);
      const action = parseDecision(completion.content, before.status);
      recovery.select(packet, completion.navigationDecision?.choice);
      const controls = before.status === "shop" ? { shop: action } : { input: action };
      const latencyMs = performance.now() - started;
      const result = controls.shop ? run.shop(action) : run.step(action);
      progress.record(result.observation);
      feedback.record(before, controls.input ?? {}, result.observation);
      decisions++;
      if (controls.input) flightTurns++;
      automaticTicks = 0;
      log({ decision: decisions, packet, completion, ...controls, latencyMs, ...result });
      onDecision({ decision: decisions, ...controls, latencyMs, ...result });
      history.push({ before, ...controls, ticksRequested: controls.shop ? result.ticksAdvanced : run.decisionTicks, ...result });
      if (history.length > RECENT_DECISION_LIMIT) history.shift();
    } catch (error) {
      log({ packet, completion: completion ?? error.completion, error: error.message, latencyMs: performance.now() - started });
      throw error;
    }
  }
  return {
    decisions, ...run.observe(), navigationMemory: feedback.memory(),
    ...(stopOnDeath ? { benchmark: runBenchmark(run, flightTurns, startTick, false, progress) } : {}),
  };
}

const usage = `Usage: node tools/foundry-local.mjs --endpoint URL --model ID --output PATH [options]
  --transport http|windows-curl  Use Windows curl.exe from WSL for Windows-loopback services.
  --decision-ticks N             Gameplay ticks per model decision (default: 4).
  --realtime                     Keep ticking during inference; hold controls until the next reply.
  --stop-on-death                Benchmark one life; stop at death before animation or respawn.
  --collision-lookahead          Add advisory visible-state collision forecasts; never override controls.
  --navigation-memory PATH       Load prior observed incidents from navigation-memory.json.
  --tap-fire                     Tap fire on alternate ticks instead of holding it (paused mode only).
  --decisions N                  Maximum model decisions (default: 50).
  --timeout-ms N                 Per-request timeout (default: 120000).
  --reasoning                    Use a single user prompt, temperature 0.6 and separate <think> reasoning.
  --max-tokens N                 Output budget (default: 128; 1024 with --reasoning).
  --frames                       Also capture per-tick PNGs; requires npm ci.
  --no-continue                  Stop at the continue prompt instead of spending an in-game continue.
  --stage N                      Starting stage (default: 1).
  --seed N                       RNG seed (default: 0x5845).
  --help                         Show this help.
Actions and model requests/responses are recorded. Invalid responses stop without applying an action.
The model buys/sells in Colin's Shop. By default, death, Get Ready, loading and high-score confirmation are automatic.
Available in-game continues are used unless --no-continue is set. Game over stops the run, without restarting.
All shop clicks, animation ticks and lifecycle confirmations are recorded for real-time replay.`;

async function main(args) {
  const { values } = parseArgs({
    args, options: {
      endpoint: { type: "string" }, model: { type: "string" }, output: { type: "string" },
      transport: { type: "string", default: "http" }, "decision-ticks": { type: "string" },
      decisions: { type: "string", default: "50" }, "timeout-ms": { type: "string", default: "120000" },
      realtime: { type: "boolean" }, "stop-on-death": { type: "boolean" }, "collision-lookahead": { type: "boolean" },
      "tap-fire": { type: "boolean" },
      "navigation-memory": { type: "string" },
      reasoning: { type: "boolean" }, "max-tokens": { type: "string" },
      frames: { type: "boolean" }, "no-continue": { type: "boolean" },
      stage: { type: "string" }, seed: { type: "string" }, help: { type: "boolean" },
    },
  });
  if (values.help) return console.log(usage);
  if (values.realtime && values["tap-fire"]) throw new Error("--tap-fire cannot yet be combined with --realtime.");
  if (!values.endpoint || !values.model || !values.output) throw new Error(usage);
  const client = createFoundryClient({
    endpoint: values.endpoint, model: values.model, transport: values.transport, timeoutMs: Number(values["timeout-ms"]),
    reasoning: Boolean(values.reasoning),
    maxTokens: values["max-tokens"] === undefined ? undefined : Number(values["max-tokens"]),
  });
  const maxDecisions = Number(values.decisions);
  if (!Number.isSafeInteger(maxDecisions) || maxDecisions < 1) throw new Error("--decisions must be a positive integer.");
  const run = await createHeadlessRun({
    output: values.output, capture: Boolean(values.frames),
    decisionTicks: Number(values["decision-ticks"] ?? DEFAULT_DECISION_TICKS),
    stage: Number(values.stage ?? 1), seed: Number(values.seed ?? 0x5845),
    tapFire: Boolean(values["tap-fire"]),
  });
  try {
    const result = await playWithFoundry(run, client, {
      maxDecisions, autoContinue: !values["no-continue"], realtime: Boolean(values.realtime),
      stopOnDeath: Boolean(values["stop-on-death"]), collisionLookahead: Boolean(values["collision-lookahead"]),
      navigationMemory: values["navigation-memory"] ? JSON.parse(readFileSync(values["navigation-memory"], "utf8")) : [],
      onDecision: ({ decision, input, shop, latencyMs, observation }) => console.error(JSON.stringify({
        decision, tick: observation.elapsedTicks, input, shop, status: observation.status, latencyMs: Math.round(latencyMs),
      })),
    });
    console.log(JSON.stringify({ output: run.output, ...result }));
  } finally {
    run.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
