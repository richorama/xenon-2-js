import { PathMotion } from "./motion.js";
import { frameAt } from "./game.js";
import { ActorList } from "./actor-pool.js";

const disabledBox = () => ({ x: 1000, y: 0, w: 0, h: 0 });

// Stage-two eye controllers and segmented attacks, CS:7f32, 80f5-830b, 866d-89ad.
export class StageTwoMiniboss {
  constructor(definition, paths, sine, sprite) {
    this.definition = definition;
    this.paths = paths;
    this.sine = sine;
    this.sprite = sprite;
    this.remaining = 3;
    this.busy = 0;
    this.initial = 2;
    this.selectors = [0x45d2, 0xaa6a];
    this.lights = Array(8).fill(0);
    this.presence = [false, false];
    this.waves = [];
    this.corpses = [];
    this.dead = false;
    this.shopPending = false;
    this.eyes = definition.eyes.map((eye, i) => ({
      ...eye, index: 2 - i, cell: eye.worldY / 16 * 20 + eye.x / 16,
      miniboss: this, boss: true, ground: true, health: definition.health,
      phase: 0, hit: 0, dead: false, motion: { x: eye.x, y: -100 },
      box: disabledBox(), bounds() { return this.box; },
      acceptsHit: () => this.busy !== 3,
    }));
  }

  get targets() {
    return [...this.waves, ...this.eyes].filter((actor) => !actor.dead);
  }

  light(number) {
    if (!this.lights[number - 1]) this.lights[number - 1] = 24;
  }

  spawn(game, side, camera = game.camera, scroll = game.control.scroll) {
    const seed = this.selectors[side];
    const rotated = this.selectors[side] = ((seed >>> 5) | (seed << 11)) & 65535;
    const early = this.remaining === 1 || this.initial > 0;
    if (this.remaining !== 1 && this.initial > 0) this.initial--;
    const entry = this.definition.entries[(rotated & 6) + (early ? 0 : 8) + side];
    const [x, worldY, entrance, exit, path] = entry;
    this.light(entrance);
    for (const [i, part] of this.definition.parts.entries()) {
      const motion = new PathMotion(this.paths, 67 + path, this.sine,
        { delay: i * 10, randomWord: () => game.randomWord() });
      motion.xFixed = x * 65536;
      motion.yFixed = (worldY - scroll - camera) * 65536;
      const actor = {
        miniboss: this, ground: true, wave: true, side, exit, part: i === 0 ? 0 : i === 11 ? 2 : 1,
        health: this.definition.waveHealth, motion, frame: part.frame, type: part.id, hit: 0,
        drawMode: "hidden", dead: false,
        bounds: () => actor.box,
      };
      if (!game.addStageTwoBossActor(actor, part.id)) continue;
      // CS:8271 leaves the fractions and heading in place until the path starts.
      const pool = game.run.actorPool;
      const [xLow, yLow] = pool.subpixels.get(actor.actorAddress) || [0, 0];
      motion.xFixed += xLow;
      motion.yFixed += yLow;
      motion.heading = (pool.headings.get(actor.actorAddress) || 0) * 65536;
      this.updateBounds(actor);
      game.savePooledBounds(actor);
      this.waves.unshift(actor);
    }
    this.busy |= 1 << side;
  }

  updateBounds(actor) {
    const sprite = this.sprite(actor.frame);
    const [x, y, w, h] = sprite.box;
    actor.box = { x: actor.motion.x - sprite.originX + x,
      y: actor.motion.y - sprite.originY + y, w, h };
  }

  dispatch(game) {
    const { camera, control } = game;
    if (!this.dead && camera >= 0x9d0 && camera <= 0xb50) {
      for (let side = 0; side < 2; side++) {
        if (!this.presence[side]) this.spawn(game, side);
      }
    } else if (this.dead && camera > 0x9f0) {
      game.camera = control.camera = control.ceiling = 0x9f0;
    }
    this.presence.fill(false);
  }

  updateWave(actor, game) {
    const motion = actor.motion;
    motion.yFixed += game.control.delta * 65536;
    this.presence[actor.side] = true;
    motion.step(this.definition.waveSpeed);
    game.saveActorMotion(actor, motion);
    actor.hit = Math.max(0, actor.hit - 1);
    if (!motion.active) {
      actor.dead = true;
      this.light(actor.exit);
      return;
    }
    if (actor.drawMode === "hidden") {
      if (motion.remaining >= 0) actor.drawMode = "masked";
    } else if (actor.drawMode === "masked") {
      if (motion.word(motion.cursor) && motion.cursor - 10 !== motion.base) actor.drawMode = "normal";
    } else if (!motion.word(motion.cursor)) actor.drawMode = "masked";
    actor.frame = this.definition.directions[actor.part][((motion.heading >>> 16) + 16 >>> 5) & 7];
    this.updateBounds(actor);
    game.savePooledBounds(actor);
  }

  updateEye(eye, game) {
    const { control, player, tick } = game;
    eye.hit = 0;
    if (control.scrollDirection < 0 && control.ceiling <= 0xb40) control.ceiling = 0xb40;
    eye.motion.y = eye.worldY - game.camera;
    const eligible = eye.index === 2 ? this.remaining === 1
      : (eye.index === 1 ? player.x < 160 : player.x >= 160) && this.busy !== 3;
    eye.box = eligible ? { x: eye.x, y: eye.motion.y, w: 16, h: 16 } : disabledBox();
    game.savePooledBounds(eye);
    if ((!eligible || eye.phase !== 4 || this.busy === 3) && !(tick & 1)) {
      eye.phase = (eye.phase + 1) & 7;
    }
    const phase = eye.phase > 4 ? 8 - eye.phase : eye.phase;
    game.patchGround(eye, [this.definition.eyeTiles[phase]]);
    if (eye.index === 2) {
      for (const [i, light] of this.definition.lights.entries()) {
        if (this.lights[i]) game.patchGround(light, light.tiles[(--this.lights[i] & 2) ? 1 : 0]);
      }
    }
  }

  updateCorpse(corpse) {
    corpse.age++;
    corpse.frame = frameAt(this.definition.corpses[corpse.part], corpse.age);
    const y = corpse.y + (this.sine[corpse.angle] >> 2);
    if (y < 0 || y >= 192) { corpse.dead = true; return; }
    corpse.y = y;
    const x = corpse.x + (this.sine[(corpse.angle + 64) & 255] >> 2);
    if (x < 0 || x >= 320) { corpse.dead = true; return; }
    corpse.x = x;
  }

  destroy(actor, game) {
    if (actor.wave) {
      if (!actor.part) this.busy &= ~(1 << actor.side);
      const corpse = { miniboss: this, part: actor.part, x: actor.motion.x, y: actor.motion.y,
        age: 0, frame: this.definition.corpses[actor.part][0] };
      if (game.addStageTwoBossActor(corpse, actor.type, ActorList.transient)) {
        corpse.angle = game.randomWord() & 255;
        game.run.actorPool.headings.set(corpse.actorAddress, corpse.angle);
        // CS:8187 marks the wave's address after constructing the corpse.
        if (corpse.actorAddress === actor.actorAddress) corpse.dead = true;
        this.corpses.unshift(corpse);
      }
      actor.dead = true;
      return;
    }
    this.busy = 3;
    game.patchGround(actor, [0x62c1]);
    game.explode(actor.box.x + 8, actor.box.y + 8);
    actor.dead = true;
    if (--this.remaining === 1) {
      game.control.scrollDirection = -1;
      this.selectors = [0xd251, 0x894d];
    }
    if (this.remaining) return;
    game.control.scrollDirection = 1;
    for (let cell = 0x1950 / 2; cell < 0x1950 / 2 + 0x1cc; cell++) {
      game.patchGround({ cell }, [0]);
    }
    for (const target of game.mainTargets) {
      if (target.dead || target.indestructible || target.boss || target.foregroundRoot) continue;
      target.hit = 3;
      target.health -= 127;
      if (target.health <= 0) game.destroy(target);
    }
    for (const enemy of game.enemies) if (enemy.formation) enemy.formation.escaped = true;
    this.presence.fill(false);
    for (let i = 0; i <= 0x27; i++) game.explode(game.randomWord() % 320,
      game.randomWord() % 192, true);
    for (let pair = 0; pair <= 4; pair++) {
      for (const value of [50, 100]) {
        game.addPickup({ kind: "credit", counted: true, value, age: 0, state: 7,
          x: game.randomWord() % 300 + 10, y: game.randomWord() % 180 + 6 });
      }
    }
    game.endCamera = game.boss ? 0 : 0xe0;
    this.dead = this.shopPending = true;
  }
}
