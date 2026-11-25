import { shotDirection } from "./boss.js";
import { spawnStageFiveHoming } from "./stage-five-ground.js";

export function stageFiveBeam(x, y, speed) {
  return { x, y, speed, beamLength: 0, damage: 6 };
}

export function stepStageFiveBeam(beam, delta) {
  if (beam.beamLength < 48) {
    beam.beamLength = Math.min(48, beam.beamLength + Math.abs(beam.speed));
    beam.y += delta + Math.min(0, beam.speed);
  } else {
    beam.y += beam.speed;
    if (beam.speed < 0 ? beam.y + 48 < 0 : beam.y >= 192) beam.dead = true;
  }
  return { x: beam.x, y: beam.y, w: 12, h: beam.beamLength + 1 };
}

const disabled = { x: 1000, y: 0, w: 0, h: 0 };

// CS:d963/db82: a scrolling body, four independent guns, and an exposed core.
export class StageFiveMiniboss {
  constructor(definition) {
    this.definition = definition;
    this.parts = [];
    this.move = 4;
    this.beamPhase = this.beamCounter = this.homingCounter = 0;
  }

  spawn(camera, event) {
    if (this.parts.length) return;
    this.y = event[5] - 8 - camera;
    this.parts = this.definition.parts.map((part, index) => {
      const actor = {
        index, definition: part, motion: { x: 112, y: this.y }, frame: part.frame,
        health: part.health, phase: 0, counter: 0, box: disabled, hit: 0,
        ground: true, boss: true, miniboss: this, bounds: () => actor.box,
      };
      return actor;
    });
  }

  get targets() {
    return this.dead ? [] : this.parts.slice(0, 5).filter((part) => !part.destroyed);
  }

  tileRegion() {
    const tiles = this.definition.tiles.slice();
    for (const [i, cell] of [8, 9, 14, 15, 20, 21].entries()) {
      tiles[cell] = this.definition.beamTiles[this.beamPhase][i];
    }
    return { x: 112, y: this.y, tiles, width: 6 };
  }

  update(game) {
    if (!this.parts.length || this.dead) return;
    const d = this.definition;
    const { camera, control, player } = game;
    control.ceiling = Math.max(d.reverseLimit, control.ceiling);
    this.y += control.delta;
    if (this.move) {
      this.y += Math.sign(this.move);
      this.move -= Math.sign(this.move);
    } else {
      const random = game.randomWord();
      if ((random & 255) < d.moveChance) {
        const down = random & 1;
        const worldY = this.y + camera;
        const span = down ? d.maxY - worldY : worldY - d.minY;
        if (span) this.move = (game.randomWord() % span + 1) * (down ? 1 : -1);
      }
    }
    if (!this.beamPhase) {
      this.beamCounter += d.beamRate;
      if (this.beamCounter >= 256) {
        this.beamCounter = game.randomWord() & 63;
        this.beamPhase = 1;
      }
    } else if (++this.beamPhase === 9) this.beamPhase = 0;
    if (this.beamPhase === 3) game.bullets.push(stageFiveBeam(150, this.y + 48, d.beamSpeed));

    this.homingCounter += d.homingRate;
    if (this.homingCounter >= 256) {
      this.homingCounter = game.randomWord() & 63;
      spawnStageFiveHoming(game, 110, this.y + 48, 6);
      spawnStageFiveHoming(game, 210, this.y + 48, 2);
    }
    for (const actor of this.parts) {
      const { index, motion, definition } = actor;
      motion.x = 112 + definition.x;
      motion.y = this.y + definition.y;
      actor.hit = 0;
      if (index >= 5) {
        actor.frame = d.panels[index >= 7 ? 1 : 0][(motion.y + camera) & 3];
        continue;
      }
      if (index === 4) {
        actor.phase = (actor.phase + 256 - actor.health) % 1536;
        actor.frame = d.coreFrames[actor.phase >>> 8];
      } else if (!actor.destroyed) {
        const direction = shotDirection(player.x - motion.x, player.y - motion.y);
        actor.frame = d.gunFrames[direction];
        actor.counter += d.gunRate;
        if (actor.counter >= 256) {
          actor.counter = game.randomWord() & 63;
          const [dx, dy] = d.vectors[direction];
          game.bullets.push({ x: motion.x + 8, y: motion.y + 8,
            dx: dx * d.gunSpeed, dy: dy * d.gunSpeed, frame: d.gunBullet, damage: 4, fixed: true });
        }
      } else {
        actor.frame = d.deadGun;
        continue;
      }
      actor.box = game.bounds(game.sprite(actor.frame), motion.x, motion.y);
    }
  }

  destroy(actor, game) {
    game.kills++;
    if (actor.index < 4) {
      actor.destroyed = true;
      actor.box = disabled;
      game.explode(actor.motion.x + 8, actor.motion.y + 8);
      game.score += 200;
      return;
    }
    this.dead = this.shopPending = true;
    for (const part of this.parts) part.dead = true;
    game.enemies = [];
    game.ground = [];
    for (let i = 0; i < 20; i++) game.explode(112 + game.randomWord() % 96,
      2256 - game.camera + game.randomWord() % 160, true);
    for (let pair = 0; pair < 5; pair++) for (const value of [50, 100]) {
      game.pickups.push({ kind: "credit", counted: true, value, age: 0, state: 7, direction: 0,
        x: game.randomWord() % 300 + 10, y: game.randomWord() % 180 + 6 });
      game.countedCredits++;
    }
    for (let row = 141; row < 151; row++) for (let column = 6; column < 14; column++) {
      game.patchGround({ cell: row * 20 + column }, [0]);
    }
    game.score += 1500;
  }
}
