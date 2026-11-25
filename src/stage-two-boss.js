import { shotDirection } from "./boss.js";

const disabledBox = () => ({ x: 1000, y: 0, w: 0, h: 0 });

function setFrames(actor, frames) {
  actor.frames = frames;
  actor.frameIndex = 0;
  actor.frame = frames[0];
  actor.frameTicks = actor.frame.duration;
}

function animate(actor) {
  if (actor.frameTicks > 0 && !--actor.frameTicks) {
    actor.frameIndex = (actor.frameIndex + 1) % actor.frames.length;
    actor.frame = actor.frames[actor.frameIndex];
    actor.frameTicks = actor.frame.duration;
  }
}

// CS:89ae-8c84; eggs/crawlers at 83bd-85cf; repairable arena walls at 8c85-8e00.
export class StageTwoBoss {
  constructor(definition, sprite) {
    this.definition = definition;
    this.sprite = sprite;
    this.health = definition.health;
    this.worldY = 96;
    this.wait = -1;
    this.moveTicks = this.dy = this.hatching = this.mouthPhase = this.fireCounter = 0;
    this.tiles = definition.tiles.slice();
    this.ground = this.boss = true;
    this.active = this.dead = false;
    this.hit = 0;
    this.motion = { x: 160, y: -100 };
    this.bodyBox = disabledBox();
    this.children = [];
    this.terrain = definition.terrain.map((group) => group.map((tile) => ({
      ...tile, cell: tile.worldY / 16 * 20 + tile.x / 16, intact: true,
    })));
  }

  bounds() { return this.dead ? disabledBox() : this.bodyBox; }

  get targets() {
    return [...this.children.filter((actor) => !actor.dead && actor.kind === "crawler"),
      ...(this.active && !this.dead ? [this] : [])];
  }

  bullet(x, y, direction, frames, speed = this.definition.bulletSpeed) {
    const [dx, dy] = this.definition.vectors[direction];
    return { x, y, direction, dx: dx * speed, dy: dy * speed, frame: frames[0],
      frames, fixed: true, damage: 4 };
  }

  patchAnimation(offset, tiles) {
    for (const [i, tile] of tiles.entries()) this.tiles[offset + i % 2 + Math.floor(i / 2) * 6] = tile;
  }

  spawnEgg(camera, randomWord, addActor) {
    const egg = { kind: "egg", motion: { x: 160, y: this.worldY - camera + 128 },
      state: 0, direction: randomWord() & 7, indestructible: true, dead: false };
    setFrames(egg, this.definition.egg.idle);
    if (!addActor || addActor(egg, 0x10c)) this.children.unshift(egg);
    return egg;
  }

  spawnCrawler(egg, addActor) {
    const actor = { kind: "crawler", ground: true, bossOwner: this,
      motion: { ...egg.motion }, direction: egg.direction, turnTarget: -1,
      health: this.definition.crawler.health, fireCounter: 0, hit: 0, dead: false,
      bounds() { return this.box; } };
    setFrames(actor, this.definition.crawler.frames[actor.direction]);
    this.updateBounds(actor);
    if (!addActor || addActor(actor, 0x110)) this.children.unshift(actor);
    return actor;
  }

  updateBounds(actor) {
    const sprite = this.sprite(actor.frame);
    const [x, y, w, h] = sprite.box;
    actor.box = { x: actor.motion.x - sprite.originX + x,
      y: actor.motion.y - sprite.originY + y, w, h };
  }

  updateEgg(egg, camera, delta, randomWord, addActor) {
    animate(egg);
    const p = egg.motion;
    p.y += delta;
    if (!egg.state) {
      const [dx, dy] = this.definition.egg.vectors[egg.direction];
      let x = p.x + dx, worldY = p.y + dy + camera;
      if (x <= 116) { x = 116; egg.state = 1; egg.direction = 4; }
      if (x >= 204) { x = 204; egg.state = 1; egg.direction = 0; }
      if (worldY <= 108) { worldY = 108; egg.state = 1; egg.direction = 6; }
      if (worldY >= 340) { worldY = 340; egg.state = 1; egg.direction = 2; }
      p.x = x;
      p.y = worldY - camera;
    } else if (egg.state === 1) {
      if (!(randomWord() & 7)) {
        egg.state = 2;
        setFrames(egg, this.definition.egg.hatch);
      }
    } else if (egg.frame.offset === (0x3c3b & ~1) - 8 && egg.frame.bank === 1) {
      const crawler = this.spawnCrawler(egg, addActor);
      // CS:84dd marks the egg's address even if the crawler just reused it.
      if (egg.actorAddress !== undefined && crawler.actorAddress === egg.actorAddress) crawler.dead = true;
      egg.dead = true;
    }
  }

  updateCrawler(actor, camera, control, randomWord, player, tick, patchGround) {
    animate(actor);
    actor.hit = Math.max(0, actor.hit - 1);
    const p = actor.motion, d = this.definition.crawler;
    p.y += control.delta;
    if (actor.turnTarget >= 0) {
      if (tick & 1) {
        const difference = (actor.turnTarget - actor.direction + 8) & 7;
        if (!difference) actor.turnTarget = -1;
        else {
          actor.direction = (actor.direction + (difference > 4 ? -1 : 1)) & 7;
          setFrames(actor, d.frames[actor.direction]);
        }
      }
      if (actor.turnTarget >= 0) { this.updateBounds(actor); return []; }
    }
    const bullets = [];
    if (p.y >= 0 && p.y < 192) {
      const sum = actor.fireCounter + d.fireRate;
      actor.fireCounter = sum & 255;
      if (sum > 255) {
        actor.fireCounter = randomWord() & 63;
        const direction = shotDirection(player.x - p.x, player.y - p.y);
        bullets.push(this.bullet(p.x, p.y, direction, [d.bullet], d.bulletSpeed));
      }
    }
    const [dx, dy] = d.vectors[actor.direction];
    p.x += dx;
    p.y += dy;
    const node = d.nodes.find(([x, y]) => p.x === x && p.y + camera === y);
    if (node) {
      let selection;
      do { selection = randomWord() & 3; } while (!selection);
      actor.turnTarget = node[selection + 1];
    }
    this.updateBounds(actor);
    if (!node) this.repairTerrain(actor.box, camera, patchGround);
    return bullets;
  }

  update(camera, control, randomWord, player, tick, population = 0, patchGround = () => {}) {
    const bullets = [];
    for (const child of [...this.children]) {
      if (child.dead) continue;
      if (child.kind === "egg") this.updateEgg(child, camera, control.delta, randomWord);
      else bullets.push(...this.updateCrawler(child, camera, control, randomWord, player, tick, patchGround));
    }
    this.children = this.children.filter((actor) => !actor.dead);
    this.updateCore(camera, control, randomWord, player, tick, population, (round) => bullets.push(round));
    return bullets;
  }

  updateCore(camera, control, randomWord, player, tick, population, emitRound, addActor) {
    this.hit = 0;
    this.motion.y = this.worldY - camera;
    if (this.dead) return;
    if (control.ceiling <= 288) control.ceiling = 288;
    if (!this.moveTicks) {
      if (this.wait < 0) {
        this.bodyBox = disabledBox();
        if (player.y + camera <= 176 && player.x >= 0 && player.x <= 319) {
          this.active = true;
          this.moveTicks = 1000;
          this.dy = 3;
          this.wait = 340;
        }
        return;
      }
      if (--this.wait < 0) {
        this.hatching = 0;
        this.moveTicks = 1000;
        this.dy = -3;
      }
    }
    this.active = true;
    const sum = this.fireCounter + this.definition.fireRate;
    this.fireCounter = sum & 255;
    if (sum > 255) {
      this.fireCounter = randomWord() & 63;
      const ring = !(randomWord() & 3);
      for (const direction of ring ? Array.from({ length: 16 }, (_, i) => 15 - i) : [4]) {
        emitRound(this.bullet(160, this.worldY - camera + 112, direction,
          this.definition.bullets[ring ? 1 : 0]));
      }
    }
    this.weakY = this.worldY - camera + 112;
    this.bodyBox = { x: 152, y: this.weakY, w: 16, h: 11 };
    if (camera >= 352) return;
    if (this.hatching) {
      this.mouthPhase = (this.mouthPhase + 1) & 3;
      this.patchAnimation(38, this.definition.mouth[this.mouthPhase]);
      if (!--this.hatching) this.spawnEgg(camera, randomWord, addActor);
    } else if (this.moveTicks) {
      this.moveTicks--;
      const y = this.worldY + this.dy;
      this.worldY = Math.max(96, Math.min(192, y));
      if (y < 96 || y > 192) this.moveTicks = 0;
      this.patchAnimation(42, this.definition.fins[0][tick & 1]);
      this.patchAnimation(46, this.definition.fins[1][tick & 1]);
    } else {
      const selection = population < 16 ? randomWord() : this.weakY + 10;
      if (population < 16 && !(selection & 0x2000)) this.hatching = (selection & 7) + 2;
      else {
        this.dy = selection & 0x4000 ? -3 : 3;
        this.moveTicks = (selection & 7) + 8;
      }
    }
    this.motion.y = this.worldY - camera;
  }

  terrainGroup(box, camera) {
    return this.terrain[(box.y + camera <= 128 ? 1 : 0) | (box.x <= 128 ? 2 : 0)];
  }

  terrainTarget(box, camera) {
    if (box.y + camera >= 432) return;
    return this.terrainGroup(box, camera).find((tile) => tile.intact
      && tile.x <= box.x + box.w - 1 && tile.x + 15 >= box.x
      && tile.worldY <= box.y + camera + box.h - 1 && tile.worldY + 15 >= box.y + camera);
  }

  destroyTerrain(tile, game) {
    tile.intact = false;
    game.patchGround(tile, [0]);
    game.explode(tile.x + 8, tile.worldY - game.camera + 8);
  }

  repairTerrain(box, camera, patchGround) {
    const tile = this.terrainGroup(box, camera).find((tile) => !tile.intact
      && tile.x <= box.x + box.w - 1 && tile.x + 15 >= box.x
      && tile.worldY <= box.y + camera + box.h - 1 && tile.worldY + 15 >= box.y + camera);
    if (tile) {
      tile.intact = true;
      patchGround(tile.cell, tile.tile);
    }
  }
}
