import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { DEFAULT_DECISION_TICKS, validateAction, validateShopAction } from "../src/headless.js";
import { bossInstructions, diveInstructions, flightDirections, flightRules, lookaheadRules, navigationInstructions, playWithFoundry, realtimeRules, shopRules } from "./foundry-local.mjs";
import { createHeadlessRun } from "./headless.mjs";
import { recoveryInstructions } from "./recovery-navigation.mjs";
import { incidentInstructions } from "./navigation-memory.mjs";

const choiceLookaheadRules = `Each option includes its own geometric contact warning. Compare danger during the action before endpoint clearance, pickup collection or firing.
A forecast of contact applies to an exposed ship. Diving can retain or add temporary protection; surfacing gives it up.
Prefer an ordinary route without predicted contact during decisionTicks that also leaves room for the next escape. If none exists, use a charged emergency dive if available, or retain an existing dive.
A warning only beyond the current action does not by itself require a dive if a clear action preserves an escape.
Avoid prolonged edge camping: a screen edge removes escape directions and leaves little room for newly appearing threats. When comparably safe and not collecting, prefer interior open water with room to evade both sideways and vertically.
If at a clamped side edge with a clear inward route, gently steer back towards the interior while firing rather than remaining pinned there. This is a soft preference; never enter a known hazard just to leave the edge.
Among comparably safe routes, prioritize opening and collecting supplies over extra clearance or recentering. Keep a safe supply target and firing line across decisions; do not reverse steering just to improve the gap slightly.
Steering conservatively means no unnecessary changes, not refusing a needed dodge or supply intercept.
A newly seen enemy with null velocity is NOT stationary. It may travel a ship-width during one action. If space allows, keep at least a ship-width of separation and do not move closer until its motion is understood.
No predicted contact is not a safe-route certificate when an unknown-motion enemy is nearby. Combine the raw bounds and banking with the forecast, and favour a route that leaves multiple escape directions next turn.
Do NOT assume post-hit invulnerability. Enemy contact can damage the ship again on the very next game tick; flashing after a hit is not protection.
One decision lasts multiple ticks: an overlapping enemy can deal repeated hits and drain most or all of a health bar during a single action. Separate completely or activate emergency protection BEFORE contact, not after losing the first 8 energy.
An enemy labelled terrain-worm is a hostile creature, not a coarse terrain cell. Do not dismiss its contact warning as a conservative map-cell false positive.
When every ordinary route predicts immediate enemy contact, choose an available protective dive now; waiting for the health bar to fall can be too late to activate it.
Contact is checked before movement and before a new dive activates. If an enemy already overlaps the ship at the next observation, neither a steering command nor a new dive can undo that first hit.
Act while there is still a full decision of room: do not wait for a tick-zero contact warning. When ordinary routes have only a narrow closing gap, take an early clear escape or protective dive now, before the next observation can be too late.
A four-pixel safety margin is a buffer, not extra usable space. Avoid repeatedly choosing an action that leaves the same nearby hostile just outside that margin with no reliable next-turn escape.
For terrain recovery, consult terrain.navigation and the actual same-direction movement outcomes in the options. Do not treat free-flight endpoints as proof that a repeatedly rewound route works. Plan a connected detour and persist until clear, without entering known enemy contact.`;

export function decisionOptions(scene, collisionForecast, feedback) {
  if (scene?.status === "shop") {
    if (!Array.isArray(scene.shop?.legalActions) || !scene.shop.legalActions.length) {
      throw new Error("The shop has no legal actions.");
    }
    return Object.fromEntries(scene.shop.legalActions.map((action) => {
      validateShopAction(action);
      const label = [action.action, action.id ?? action.slot].filter((part) => part !== undefined).join("_");
      return [label, { control: { shop: { ...action } }, description: JSON.stringify(action) }];
    }));
  }
  if (scene?.status !== "playing") throw new Error("Decisions require active flight or a ready shop.");
  const protectionEffects = {
    fire: "stay surfaced and fire equipped weapons; this does not add dive protection; can collect pickups",
    coast: scene.player.diving
      ? "do not request early surfacing; retain remaining dive protection without spending another charge; no firing or collecting"
      : "stay surfaced without firing; this does not add dive protection",
    dive: "activate an emergency dive for temporary protection from enemy, bullet and terrain contact; costs one charge and prevents firing and collecting",
    surface: "request early surfacing, giving up remaining dive protection to resume firing and collecting once exposed",
  };
  const modes = [["coast", {}, scene.player.diving
    ? "remain in the current dive without firing or collecting" : "stop firing without diving"]];
  if (!scene.player.diving) modes.push(["fire", { fire: true }, "fire equipped weapons while remaining surfaced"]);
  if (scene.player.diving || scene.player.dives > 0) {
    modes.push(scene.player.diving
      ? ["surface", { dive: true }, "end the dive once clear so firing and collection can resume"]
      : ["dive", { dive: true }, "evade an otherwise unavoidable hit or escape a terrain trap with an emergency dive; costs one limited charge and prevents firing and collection"]);
  }
  return Object.fromEntries(flightDirections.flatMap(([direction, movement, description]) =>
    modes.map(([mode, buttons, effect]) => {
      const input = { ...movement, ...buttons };
      validateAction(input, 1);
      let text = `${description}; ${collisionForecast ? protectionEffects[mode] : effect}.`;
      if (movement.down && scene.player.y >= 176) {
        text += " At the lower screen limit, DOWN requests map backtracking rather than more downward screen movement, subject to native recovery and scroll limits. Omit DOWN to steer sideways without requesting reverse scrolling.";
      }
      const prediction = collisionForecast?.movements?.[direction];
      if (prediction) {
        const warning = prediction.firstContact
          ? `potential ${prediction.firstContact.kind} contact at tick ${prediction.firstContact.tick}`
          : "no geometric contact predicted";
        text += ` Geometric forecast: ${warning}; action-end gap ${prediction.actionEnd?.gap ?? "unknown"} pixels.`;
      }
      const target = scene.boss?.weakPoint, end = prediction?.actionEnd;
      if (mode === "fire" && target && end && scene.player.weapons?.some(({ id }) => id === 1)) {
        const aligned = end.x >= target.x && end.x < target.x + target.w;
        const below = end.y - 6 > target.y + target.h;
        text += ` Forward-shot aim relative to the CURRENT boss weak point: action-end ship column ${aligned ? "aligned" : "NOT aligned"}, firing origin ${below ? "below" : "NOT below"} target; horizontal error from target centre ${end.x - (target.x + target.w / 2)} pixels. Both alignment and firing from below are needed. This uses a free-flight endpoint, not a guaranteed hit or safe path.`;
      }
      const attempt = feedback?.movementAttempts?.findLast(({ input: previous }) =>
        ["left", "right", "up", "down"].every((key) => Boolean(previous[key]) === Boolean(movement[key])));
      if (attempt) {
        const { x, y, worldY, cameraAdvance } = attempt.displacement;
        text += ` Last observed same-direction attempt (${attempt.ticks} ticks, ending tick ${attempt.endTick}): actual dx ${x}, dy ${y}, worldY ${worldY}, camera advance ${cameraAdvance} pixels. This is history, not a prediction.`;
      }
      if (feedback?.navigation?.requiresRecovery && !feedback.navigation.bossVisible
        && feedback.navigation.cycle?.directions.includes(direction)) {
        text += " This direction participates in the detected no-progress cycle; prefer a different route unless immediate safety requires it.";
      }
      return [`${direction}_${mode}`, { control: { input }, description: text }];
    })));
}

export function createDecisionClient({ endpoint, model, apiKey, timeoutMs = 30000 } = {}) {
  const url = new URL(endpoint);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const path = "/providers/microsoft/v1/systemone";
  if (!(url.protocol === "https:" || url.protocol === "http:" && loopback)
    || url.username || url.password || url.search || url.hash
    || !["/", path, path + "/"].includes(url.pathname)) {
    throw new Error("Decision endpoint must be HTTPS, without credentials or a query, optionally ending in /providers/microsoft/v1/systemone.");
  }
  if (typeof model !== "string" || !model.trim()) throw new Error("A Decision deployment name is required.");
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
    throw new Error("Set AZURE_DECISION_API_KEY to the Foundry resource API key.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Timeout must be a positive integer in milliseconds.");
  url.pathname = path;
  return {
    async complete(packet, { signal } = {}) {
      const options = decisionOptions(packet.scene, packet.collisionForecast, packet.feedback);
      const labels = Object.keys(options);
      if (labels.length === 1) {
        return {
          content: JSON.stringify(options[labels[0]].control), finishReason: "stop",
          decision: { type: "forced", choice: labels[0] },
        };
      }
      const shopping = packet.scene.status === "shop";
      const body = {
        model, state: packet,
        questions: {
          action: {
            type: "choice",
            instructions: (shopping ? shopRules : flightRules)
              + (!shopping && packet.collisionForecast ? `\n${lookaheadRules}` : "")
              + (!shopping && packet.realtime ? `\n${realtimeRules}` : "")
              + (shopping
                ? "\nSelect the most useful legal shopping action for the stated budget and equipment."
                : "\nFollow this priority order: preserve health, collect power-ups, collect credit bubbles, shoot enemies. Do not trade health for a lower-priority objective. Prefer firing while steering safely; dive is a last resort.")
              + "\nEach option describes the controls that will actually be applied."
              + (!shopping && packet.collisionForecast ? `\n${choiceLookaheadRules}` : "")
              + navigationInstructions(packet)
              + diveInstructions(packet.scene)
              + recoveryInstructions(packet)
              + incidentInstructions(packet)
              + bossInstructions(packet.scene),
            criteria: Object.fromEntries(Object.entries(options).map(([label, option]) => [label, option.description])),
          },
        },
      };
      if (packet.recovery?.candidates) {
        body.questions.route = {
          type: "choice",
          instructions: "Choose a recovery waypoint plan to persist across subsequent movement decisions, avoiding recorded terrain-stall pockets ahead. Prefer an untried connected corridor over repeating failed controls. Choose manual when none is suitable or immediate safety requires it, not merely to remain in a known no-progress loop. The action question still selects the actual buttons; coordinate that action with your chosen plan.",
          criteria: {
            ...Object.fromEntries(packet.recovery.candidates.map((route) => [route.id,
              `${route.kind}: waypoints ${JSON.stringify(route.waypoints)}. WorldY is camera+screenY; smaller is forward. ${route.kind === "make-turning-room"
                ? "Brief reverse scrolling to create turning room; not a certified clear route. Do not wait between retreat actions unless safety requires it."
                : "Connected clear samples in the visible map; avoid enemies and recheck actual movement."}`])),
            manual: "None of these sampled routes is suitable; choose safe controls directly without committing to a waypoint.",
          },
        };
      }
      let response;
      try {
        response = await fetch(url, {
          method: "POST", redirect: "error",
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
          headers: { "Content-Type": "application/json", "api-key": apiKey },
          body: JSON.stringify(body),
        });
      } catch (error) {
        throw new Error(error.name === "TimeoutError" ? "Decision request timed out." : "Decision request failed.");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Decision HTTP ${response.status}.`);
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Decision API returned invalid JSON.");
      }
      const answer = payload?.answers?.action;
      if (answer?.type !== "choice" || typeof answer.choice !== "string" || !Object.hasOwn(options, answer.choice)) {
        throw new Error("Decision API did not select a supplied legal action.");
      }
      const probabilities = answer.probabilities;
      if (!probabilities || Array.isArray(probabilities) || typeof probabilities !== "object"
        || !Object.hasOwn(probabilities, answer.choice)
        || Object.entries(probabilities).some(([label, probability]) => !Object.hasOwn(options, label)
          || !Number.isFinite(probability) || probability < 0 || probability > 1)
        || Math.abs(Object.values(probabilities).reduce((sum, probability) => sum + probability, 0) - 1) > 0.001
        || probabilities[answer.choice] === 0
        || (answer.confidence !== undefined && (!Number.isFinite(answer.confidence)
          || answer.confidence < 0 || answer.confidence > 1))) {
        throw new Error("Decision API returned invalid action probabilities.");
      }
      const usage = Object.fromEntries(["input_tokens", "output_tokens"].flatMap((key) =>
        Number.isSafeInteger(payload.usage?.[key]) && payload.usage[key] >= 0 ? [[key, payload.usage[key]]] : []));
      const route = payload?.answers?.route;
      if (body.questions.route && (route?.type !== "choice"
        || !Object.hasOwn(body.questions.route.criteria, route.choice)
        || !route.probabilities || Array.isArray(route.probabilities)
        || !Object.hasOwn(route.probabilities, route.choice)
        || Object.entries(route.probabilities).some(([label, probability]) =>
          !Object.hasOwn(body.questions.route.criteria, label) || !Number.isFinite(probability) || probability < 0 || probability > 1)
        || Math.abs(Object.values(route.probabilities).reduce((sum, probability) => sum + probability, 0) - 1) > 0.001
        || !route.probabilities[route.choice]
        || route.confidence !== undefined && (!Number.isFinite(route.confidence) || route.confidence < 0 || route.confidence > 1))) {
        throw new Error("Decision API did not select a valid supplied recovery waypoint.");
      }
      return {
        model: typeof payload.model === "string" ? payload.model.replaceAll(apiKey, "[redacted]") : model,
        content: JSON.stringify(options[answer.choice].control), finishReason: "stop", usage,
        decision: {
          type: "choice", choice: answer.choice, probabilities,
          ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
        },
        ...(body.questions.route ? { navigationDecision: {
          choice: route.choice, probabilities: route.probabilities,
          ...(route.confidence === undefined ? {} : { confidence: route.confidence }),
        } } : {}),
      };
    },
  };
}

const usage = `Usage: node tools/foundry-decision.mjs --endpoint URL --model DEPLOYMENT --output PATH [options]
Set AZURE_DECISION_API_KEY in the environment; never put the key in command arguments or recordings.
  --decision-ticks N  Gameplay ticks per decision (default: 4).
  --realtime          Keep ticking during inference; hold controls until the next reply.
  --stop-on-death     Benchmark one life; stop before death animation or respawn.
  --collision-lookahead  Add advisory visible-state collision forecasts without overriding controls.
  --navigation-memory PATH  Load prior observed incidents from navigation-memory.json.
  --tap-fire          Tap fire on alternate ticks instead of holding it (paused mode only).
  --decisions N       Maximum flight/shop decisions (default: 50).
  --timeout-ms N      Per-request timeout (default: 30000).
  --frames            Capture per-tick PNGs as well as action logs.
  --no-continue       Stop before spending an in-game continue.
  --stage N           Starting stage (default: 1).
  --seed N            RNG seed (default: 0x5845).
  --help              Show this help.
Uses the existing Foundry systemone endpoint; no deployment or local model is started.
Scores, confidence, token usage, controls and lifecycle events are recorded, without credentials.
A sole legal shop action is forced locally and marked as such, without a model request.`;

async function main(args) {
  const { values } = parseArgs({
    args, options: {
      endpoint: { type: "string" }, model: { type: "string" }, output: { type: "string" },
      "decision-ticks": { type: "string" }, decisions: { type: "string", default: "50" },
      "timeout-ms": { type: "string", default: "30000" },
      realtime: { type: "boolean" }, "stop-on-death": { type: "boolean" }, "collision-lookahead": { type: "boolean" },
      "tap-fire": { type: "boolean" },
      "navigation-memory": { type: "string" },
      frames: { type: "boolean" }, "no-continue": { type: "boolean" },
      stage: { type: "string" }, seed: { type: "string" }, help: { type: "boolean" },
    },
  });
  if (values.help) return console.log(usage);
  if (values.realtime && values["tap-fire"]) throw new Error("--tap-fire cannot yet be combined with --realtime.");
  if (!values.endpoint || !values.model || !values.output) throw new Error(usage);
  const client = createDecisionClient({
    endpoint: values.endpoint, model: values.model, apiKey: process.env.AZURE_DECISION_API_KEY,
    timeoutMs: Number(values["timeout-ms"]),
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
