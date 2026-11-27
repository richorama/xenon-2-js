import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decodeAssets, DOS_ASSET_PATHS } from "../src/assets.js";
import { TICK_RATE } from "../src/game.js";
import { DEFAULT_DECISION_TICKS, HeadlessGame, MAX_ACTION_TICKS, performShopAction, validateAction, validateStep } from "../src/headless.js";
import { Renderer } from "../src/renderer.js";

const root = new URL("../", import.meta.url);

export async function createHeadlessRun({
  stage = 1, seed = 0x5845, output, capture = Boolean(output), decisionTicks = DEFAULT_DECISION_TICKS,
  tapFire = false,
} = {}) {
  validateAction({}, decisionTicks);
  if (typeof tapFire !== "boolean") throw new Error("tapFire must be a boolean.");
  const files = await Promise.all(DOS_ASSET_PATHS.map(async (path) =>
    new Uint8Array(await readFile(new URL(path, root)))));
  const assets = decodeAssets(files);
  const session = new HeadlessGame(assets, { stage, seed });
  let canvas, renderer;
  if (capture) {
    const { createCanvas } = await import("@napi-rs/canvas");
    canvas = createCanvas(320, 200);
    renderer = new Renderer(canvas, assets, createCanvas);
  }
  const directory = output ? resolve(output) : undefined;
  if (directory) {
    await mkdir(dirname(directory), { recursive: true });
    // A fresh directory prevents overwriting or mixing frames from different runs.
    await mkdir(directory);
  }
  let frameCount = 0;
  let frame;
  let closed = false;
  let fireDown = false;
  const log = (name, value) => {
    if (directory) appendFileSync(join(directory, name), JSON.stringify(value) + "\n");
  };
  const manifest = () => {
    if (directory) writeFileSync(join(directory, "manifest.json"), JSON.stringify({
      version: 2, stage, seed, decisionTicks, tickRate: TICK_RATE, width: 320, height: 200,
      framePattern: renderer ? "frame-%06d.png" : undefined, frameCount, initialFrame: Boolean(renderer),
      elapsedTicks: session.elapsedTicks, simulatedSeconds: session.elapsedTicks / TICK_RATE,
      status: session.game.status, closed, ...(tapFire ? { tapFire: true } : {}),
    }, null, 2) + "\n");
  };
  const render = () => {
    if (!renderer) return;
    if (session.shopScreen) renderer.drawShop(session.shopScreen);
    else renderer.draw(session.game);
    if (directory) {
      frame = `frame-${String(frameCount).padStart(6, "0")}.png`;
      writeFileSync(join(directory, frame), canvas.toBuffer("image/png"));
      log("frames.jsonl", {
        file: frame, tick: session.game.tick, elapsedTicks: session.elapsedTicks,
        time: session.elapsedTicks / TICK_RATE, status: session.game.status,
      });
      frameCount++;
    }
  };
  const observe = () => ({ observation: session.observe(), ...(frame ? { frame } : {}) });
  render();
  log("actions.jsonl", {
    type: "start", format: "xenon2-actions", version: 2, tickRate: TICK_RATE,
    stage, seed, decisionTicks, ...(tapFire ? { tapFire: true } : {}), ...observe(),
  });
  manifest();
  const recordStep = (input, ticks) => {
    const { ticksAdvanced, observation } = session.step(input, ticks, render);
    if (ticksAdvanced) fireDown = Boolean(input.fire && observation.status === "playing");
    const result = { ticksAdvanced, observation, ...(frame ? { frame } : {}) };
    log("actions.jsonl", { type: "step", input, ticksRequested: ticks, ...result });
    manifest();
    return result;
  };
  const run = {
    output: directory,
    decisionTicks,
    tapFire,
    observe,
    step(input = {}, ticks = decisionTicks) {
      if (closed) throw new Error("This run is closed.");
      validateStep(input, ticks);
      if (!tapFire || !input.fire || session.game.status !== "playing") return recordStep(input, ticks);
      const status = session.game.status;
      let advanced = 0, result;
      while (advanced < ticks) {
        const controls = { ...input, fire: !fireDown };
        if (advanced) delete controls.dive;
        result = recordStep(controls, 1);
        advanced += result.ticksAdvanced;
        if (!result.ticksAdvanced || result.observation.status !== status) break;
      }
      return { ...result, ticksAdvanced: advanced };
    },
    shop(action) {
      if (closed) throw new Error("This run is closed.");
      return performShopAction(run, action);
    },
    screenshot() {
      if (!canvas) throw new Error("Enable capture to take screenshots.");
      return canvas.toBuffer("image/png");
    },
    close() {
      if (closed) return;
      closed = true;
      manifest();
    },
  };
  return run;
}

const usage = `Usage: node tools/headless.mjs [options]
  --ticks N       Run up to N gameplay ticks holding fire (default: 182).
  --interactive   Read JSON commands from stdin; write JSON responses to stdout.
  --decision-ticks N  Ticks per decision when omitted from a command (default: ${DEFAULT_DECISION_TICKS}).
  --tap-fire      Alternate native fire press/release ticks while fire is requested.
  --output PATH   Save one PNG per tick, including the initial frame, and JSON logs.
  --no-frames     With --output, save action logs only (no Canvas dependency).
  --stage N       Start at stage 1-5 (default: 1).
  --seed N        RNG seed, 0-65535; decimal or 0x-prefixed (default: 0x5845).
  --help          Show this help.

Interactive commands:
  {"input":{"right":true,"fire":true},"ticks":4}
  {"command":"shop","action":"buy","id":3}
  {"input":{"confirm":true},"ticks":1}
  {"command":"observe"}
  {"command":"close"}
Actions advance 1-${MAX_ACTION_TICKS} ticks, stopping early on status changes.
Shop actions are buy/id, sell/slot, more and exit (finish selling, then leave buying).
Neutral inputs advance animations; confirm resumes Get Ready/continue or accepts a high-score initial.
The non-interactive hold-fire baseline still stops at the first menu or shop.`;

async function main(args) {
  const { values } = parseArgs({
    args,
    options: {
      ticks: { type: "string" }, interactive: { type: "boolean" },
      output: { type: "string" }, stage: { type: "string" },
      seed: { type: "string" }, help: { type: "boolean" }, "no-frames": { type: "boolean" },
      "decision-ticks": { type: "string" },
      "tap-fire": { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const ticks = Number(values.ticks ?? 182);
  if (!Number.isSafeInteger(ticks) || ticks < 1) throw new Error("--ticks must be a positive safe integer.");
  if (values.interactive && values.ticks !== undefined) {
    throw new Error("--interactive and --ticks cannot be used together.");
  }
  if (values["no-frames"] && !values.output) throw new Error("--no-frames requires --output.");
  const run = await createHeadlessRun({
    stage: Number(values.stage ?? 1), seed: Number(values.seed ?? 0x5845), output: values.output,
    capture: Boolean(values.output) && !values["no-frames"],
    decisionTicks: Number(values["decision-ticks"] ?? DEFAULT_DECISION_TICKS),
    tapFire: Boolean(values["tap-fire"]),
  });
  try {
    if (values.interactive) {
      console.log(JSON.stringify({
        type: "ready", output: run.output, decisionTicks: run.decisionTicks,
        ...(run.tapFire ? { tapFire: true } : {}), ...run.observe(),
      }));
      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          try {
            const command = JSON.parse(line);
            if (!command || typeof command !== "object" || Array.isArray(command)) {
              throw new Error("Commands must be JSON objects.");
            }
            const fields = command.command === undefined ? ["input", "ticks"]
              : command.command === "shop" ? ["command", "action", "id", "slot"] : ["command"];
            if (Object.keys(command).some((key) => !fields.includes(key))) {
              throw new Error(`Allowed command fields: ${fields.join(", ")}.`);
            }
            if (command.command === "close") {
              console.log(JSON.stringify({ type: "closed", ...run.observe() }));
              break;
            }
            if (command.command === "observe") {
              console.log(JSON.stringify(run.observe()));
            } else if (command.command === "shop") {
              const { command: name, ...action } = command;
              console.log(JSON.stringify(run.shop(action)));
            } else if (command.command !== undefined) {
              throw new Error(`Unknown command: ${command.command}`);
            } else {
              console.log(JSON.stringify(run.step(
                command.input === undefined ? {} : command.input,
                command.ticks === undefined ? run.decisionTicks : command.ticks,
              )));
            }
          } catch (error) {
            console.log(JSON.stringify({ error: error.message }));
          }
        }
      } finally {
        lines.close();
      }
    } else {
      let advanced = 0;
      while (advanced < ticks && ["playing", "dying"].includes(run.observe().observation.status)) {
        advanced += run.step({ fire: true }, Math.min(run.decisionTicks, ticks - advanced)).ticksAdvanced;
      }
      console.log(JSON.stringify({
        output: run.output, ticksAdvanced: advanced, ...run.observe(),
      }));
    }
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
