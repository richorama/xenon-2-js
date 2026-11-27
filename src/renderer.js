import { DIVE_TICKS, INVULNERABILITY_TICKS, PLAY_HEIGHT, frameAt } from "./game.js";
import { ActorList } from "./actor-pool.js";
import { SHADES_TICKS } from "./shop.js";
import { NASHWAN_TICKS } from "./nashwan.js";
import { StageFourCorridorPod } from "./stage-four-ground.js";
import { weaponAttachment } from "./weapons.js";

const stageOneFlash = (game, actor) => actor.flashTick === game.tick || actor.droneFlashTick === game.tick;
const actorPaint = (game) => game.actorPaint?.tick === game.tick && game.actorPaint.map === game.map
  ? game.actorPaint : undefined;

function browserCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function bitmap(createCanvas, width, height, pixels, palette, alpha) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  for (let i = 0; i < pixels.length; i++) {
    image.data.set(palette[pixels[i]], i * 4);
    image.data[i * 4 + 3] = alpha ? alpha[i] : 255;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

export class Renderer {
  constructor(canvas, assets, createCanvas = browserCanvas) {
    this.canvas = canvas;
    this.createCanvas = createCanvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.context.imageSmoothingEnabled = false;
    this.setStage(assets);
  }

  drawShop(shop) {
    this.drawIndexed(shop.draw(), shop.art.palette);
  }

  drawIndexed(pixels, palette) {
    this.indexedImage ||= this.context.createImageData(320, 200);
    for (let i = 0; i < pixels.length; i++) {
      this.indexedImage.data.set(palette[pixels[i]], i * 4);
      this.indexedImage.data[i * 4 + 3] = 255;
    }
    this.context.putImageData(this.indexedImage, 0, 0);
  }

  setStage(assets) {
    this.assets = assets;
    this.images = new Map();
    this.whiteSprites = new Map();
    this.vgaFlashSprites = new Map();
    this.vgaFlashTiles = new Map();
    for (const bank of [...assets.banks, assets.weapons,
      Object.values(assets.playerShots || {}).flat()]) {
      for (const sprite of bank) {
        this.images.set(sprite, bitmap(this.createCanvas, sprite.width, sprite.height,
          sprite.pixels, assets.palette, sprite.alpha));
      }
    }
    const tiles = assets.tiles.map((pixels) => bitmap(this.createCanvas, 16, 16, pixels, assets.palette));
    this.tileImages = tiles;
    this.maskedTiles = assets.tiles.map((pixels) => bitmap(this.createCanvas, 16, 16, pixels, assets.palette,
      Uint8Array.from(pixels, (pixel) => pixel ? 255 : 0)));
    this.whiteTiles = assets.tiles.map((pixels) => bitmap(this.createCanvas, 16, 16, pixels,
      assets.palette.map(() => [255, 255, 255]),
      Uint8Array.from(pixels, (pixel) => pixel ? 255 : 0)));
    this.mapRevision = -1;
    this.world = this.createCanvas(320, 4800);
    const context = this.world.getContext("2d");
    for (let i = 0; i < assets.map.length; i++) {
      const tile = tiles[assets.map[i] >>> 6];
      if (!tile) throw new Error(`Map references missing tile ${assets.map[i] >>> 6}`);
      context.drawImage(tile, (i % 20) * 16, Math.floor(i / 20) * 16);
    }
  }

  drawSprite(sprite, x, y, alpha = 1, mask = false) {
    const vgaFlash = mask === "vga-hit";
    const images = vgaFlash ? this.vgaFlashSprites : mask ? this.whiteSprites : this.images;
    if (mask && !images.has(sprite)) {
      const color = vgaFlash ? this.assets.palette[7] : [255, 255, 255];
      images.set(sprite, bitmap(this.createCanvas, sprite.width, sprite.height, sprite.pixels,
        this.assets.palette.map(() => color), sprite.alpha));
    }
    this.context.globalAlpha = alpha;
    this.context.drawImage(images.get(sprite),
      Math.round(x - sprite.originX), Math.round(y - sprite.originY));
    this.context.globalAlpha = 1;
  }

  drawWave(game, actor) {
    if (actor.dead || actor.drawMode === "hidden") return;
    const sprite = game.sprite(actor.frame);
    this.drawSprite(sprite, actor.motion.x, actor.motion.y, actor.hit ? 0.55 : 1);
    if (actor.drawMode === "masked") this.drawTerrainCover(game, actor.motion.x - sprite.originX,
      actor.motion.y - sprite.originY);
  }

  drawGroundSprite(game, enemy) {
    const white = enemy.vgaFlash ? enemy.hit === 3 && "vga-hit" : enemy.whiteFlash ? enemy.hit === 3
      : ["arm", "skater", "wall-crawler", "wall-hunter"].includes(enemy.definition.kind) && enemy.hit;
    if (enemy.definition.kind !== "wall-hunter" || enemy.motion.y <= 220) {
      this.drawSprite(game.sprite(enemy.frame), enemy.motion.x, enemy.motion.y,
        enemy.hit && !white && !enemy.whiteFlash ? 0.55 : 1, white);
    }
    if (enemy.definition.kind === "wall-hunter") this.drawOverlay(enemy.drawHatch(actorPaint(game)?.camera ?? game.camera));
  }

  drawPickup(game, pickup) {
    if (pickup.wallGunFlash) {
      const { tick, tiles } = pickup.wallGunFlash;
      if (tick !== game.tick) return;
      const camera = actorPaint(game)?.camera ?? game.camera;
      this.drawOverlay({ x: (pickup.x & 0xfffe), y: pickup.y - camera, width: 2, tiles }, "vga-hit");
    } else if (pickup.wallHunterHatch) {
      const camera = actorPaint(game)?.camera ?? game.camera;
      const y = (pickup.y - camera) << 16 >> 16;
      if (y > 220) return;
      this.drawSprite(game.sprite(game.pickupFrame(pickup)), pickup.x, y, 1,
        stageOneFlash(game, pickup) && "vga-hit");
      if (pickup.state < 2) {
        const { x, worldY, width, tiles } = pickup.wallHunterHatch;
        this.drawOverlay({ x, y: (worldY - camera) << 16 >> 16, width, tiles });
      }
    } else if (pickup.state !== undefined || pickup.kind === "reward") {
      this.drawSprite(game.sprite(game.pickupFrame(pickup)), pickup.x, pickup.y, 1,
        stageOneFlash(game, pickup) && "vga-hit");
    } else {
      const base = pickup.kind === "health" ? 84 : pickup.kind === "power" ? 50
        : pickup.value === 50 ? 42 : 34;
      this.drawSprite(this.assets.banks[0][base + Math.floor(pickup.age / 4) % 3], pickup.x, pickup.y);
    }
  }

  drawPlayerRound(game, shot) {
    if (shot.beam) {
      const { caps, length, width } = shot.beam;
      if (length === 65) this.drawSprite(game.sprite(caps[1]), shot.x, shot.y + 1);
      this.drawSprite(game.sprite(caps[0]), shot.x, shot.y - length);
      const [r, g, b] = this.assets.palette[7];
      this.context.fillStyle = `rgb(${r},${g},${b})`;
      this.context.fillRect(shot.x, shot.y - length + 1, width, length);
      return;
    }
    const sprite = shot.originalSprite || (shot.frame ? game.sprite(shot.frame)
      : shot.sprite === undefined ? this.assets.banks[0][135]
      : this.assets.weapons[shot.sprite]);
    const flash = (game.stage === 1 || game.stage === 4) && stageOneFlash(game, shot);
    this.drawSprite(sprite, shot.x, shot.y, 1, flash && "vga-hit");
  }

  drawEnemyRound(game, bullet) {
    if (bullet.beamLength !== undefined) {
      const [top, bottom] = this.assets.logic.enemyBeamCaps;
      const { beamLength, speed, x, y } = bullet;
      if (speed < 0 || beamLength === 48) this.drawSprite(game.sprite(top), x, y);
      if (speed > 0 || beamLength === 48) this.drawSprite(game.sprite(bottom), x, y + beamLength - 1);
      const [r, g, b] = this.assets.palette[7];
      this.context.fillStyle = `rgb(${r},${g},${b})`;
      this.context.fillRect(x, y + 1, 12, beamLength - 1);
      return;
    }
    this.drawSprite(bullet.frame ? game.sprite(bullet.frame) : this.assets.banks[0][0], bullet.x, bullet.y,
      1, stageOneFlash(game, bullet) && "vga-hit");
  }

  drawEffect(game, effect) {
    if (effect.frames) {
      this.drawSprite(game.sprite(frameAt(effect.frames, effect.age)), effect.x, effect.y, 1,
        stageOneFlash(game, effect) && "vga-hit");
    } else {
      const index = effect.large ? 25 + Math.min(8, Math.floor(effect.age / 3))
        : Math.min(5, Math.floor(effect.age / 4));
      this.drawSprite(this.assets.banks[0][index], effect.x, effect.y);
    }
  }

  drawMountFrame(game, frame, x, y) {
    const sprite = game.sprite(frame);
    this.drawSprite(sprite, game.mountPosture ? ((x - sprite.originX) & ~1) + sprite.originX : x, y);
  }

  drawShip(game) {
    const { player } = game;
    if (game.status === "continue" || game.status === "gameover") return;
    const mask = game.shipHitFlash ? "vga-hit" : false;
    if (game.status === "dying") {
      this.drawSprite(game.sprite(frameAt(this.assets.logic.playerDeath, game.deathAge)), player.x, player.y, 1, mask);
    } else {
      const sprite = game.shipSprite(game.divePose);
      const x = game.divePose && !mask ? ((player.x - sprite.originX) & ~1) + sprite.originX : player.x;
      this.drawSprite(sprite, x, player.y, 1, mask);
      if (game.diveMasked && !mask) this.drawTerrainCover(game, player.x - sprite.originX, player.y - sprite.originY);
    }
    this.drawManeuverJets(game);
  }

  drawManeuverJets(game) {
    if (!game.maneuverJetBits) return;
    const bank = Math.abs(game.control.bank);
    const { x, y } = game.player;
    for (const [i, jet] of this.assets.logic.maneuverJets.entries()) {
      if (!(game.maneuverJetBits & (i < 2 ? 2 : 1))) continue;
      this.drawSprite(game.sprite(frameAt(jet.frames, game.tick)), x + jet.offsets[bank], y);
    }
  }

  drawMounts(game, records = [], inventory = game.inventory) {
    if (game.status === "continue" || game.status === "gameover") return;
    const tracked = new Set();
    const overlays = [];
    for (const { actor: { slot, weapon, dead } } of records) {
      if (inventory[slot] !== weapon) continue;
      tracked.add(slot);
      if (dead) continue;
      const mount = weaponAttachment(game, slot, weapon);
      if (mount) this.drawMountFrame(game, frameAt(mount.frames, mount.age), mount.x, mount.y);
    }
    for (const [slot, weapon] of inventory.entries()) {
      if (!weapon || tracked.has(slot)) continue;
      const mount = weaponAttachment(game, slot, weapon);
      if (!mount) continue;
      this.drawMountFrame(game, frameAt(mount.frames, mount.age), mount.x, mount.y);
      if (mount.overlay) overlays.push(mount);
    }
    for (const { overlay, overlayPosition: { x, y }, age } of overlays) {
      this.drawMountFrame(game, frameAt(overlay, age), x, y);
    }
  }

  drawStageTwoCore(game, boss) {
    if (game.camera >= 352) return;
    this.drawOverlay({ x: 112, y: boss.motion.y, tiles: boss.tiles, width: 6 }, boss.hit);
  }

  drawStageTwoEye(eye) {
    if (eye.dead || !eye.hit) return;
    const x = eye.x + (eye.index === 0 ? -32 : eye.index === 2 ? -16 : 0);
    const y = eye.motion.y - (eye.index === 2 ? 32 : 16);
    for (const [i, tile] of eye.flash.entries()) {
      if (tile >>> 1) this.context.drawImage(this.tileImages[tile >>> 6],
        x + i % 3 * 16, y + Math.floor(i / 3) * 16);
    }
  }

  drawForeground(game, actor, root = actor) {
    if (actor.dead || root.dead) return;
    const sprite = game.sprite(game.enemyFrame(actor));
    const { motion } = actor;
    if (game.stage === 1 || (game.stage === 4 && actor.actorAddress !== undefined)) {
      this.drawSprite(sprite, motion.x, motion.y, 1, stageOneFlash(game, actor) && "vga-hit");
    } else this.drawSprite(sprite, motion.x, motion.y, root.hit ? 0.55 : 1);
  }

  drawStageOneCore(game, boss) {
    if (game.camera >= 0x280) return;
    const d = boss.definition;
    const tiles = d.tiles.slice();
    const animation = d.tileAnimations[(game.tick & 12) >>> 2];
    for (const [i, offset] of [31, 33, 37, 39].entries()) {
      tiles[offset] = animation[i * 2];
      tiles[offset + 1] = animation[i * 2 + 1];
    }
    const flash = stageOneFlash(game, boss);
    this.drawOverlay({ x: 112, y: boss.motion.y, tiles, width: 6 }, flash && "vga-hit");
    if (!flash) this.drawSprite(game.sprite(d.mouth[(boss.mouthAge >>> 6) & 3]), 152, boss.motion.y + 66);
  }

  drawStageOneMain(game, records) {
    for (const { type, actor } of records) {
      if (actor.dead || actor.hidden) continue;
      if (type === 0x50) this.drawStageOneCore(game, actor);
      else if (actor.stageOneBoss) this.drawSprite(game.sprite(actor.frame), actor.motion.x, actor.motion.y);
      else if (actor.terrainWorm) {
        const sprite = game.sprite(actor.frame);
        this.drawSprite(sprite, ((actor.motion.x - sprite.originX) & ~1) + sprite.originX,
          actor.motion.y, 1, Boolean(actor.hit));
      } else if (actor.ground) this.drawGroundSprite(game, actor);
      else this.drawForeground(game, actor, actor.foregroundRoot?.dead ? actor : actor.foregroundRoot);
    }
  }

  drawStageTwoMain(game, records) {
    for (const { type, actor } of records) {
      if (actor.dead || actor.hidden) continue;
      if (type === 0x50) this.drawStageTwoCore(game, actor);
      else if (type === 0x54) this.drawStageTwoEye(actor);
      else if (actor.wave) this.drawWave(game, actor);
      else if (type === 0x10c || type === 0x110) {
        this.drawSprite(game.sprite(actor.frame), actor.motion.x, actor.motion.y, actor.hit ? 0.55 : 1);
      } else if (actor.ground) {
        if ((type === 0xe8 || type === 0xec) && (actor.hit === 3 || actor.droneFlashTick === game.tick)) {
          // CS:3bdf flashes the constructor's tile, not necessarily the current animation tile.
          this.drawOverlay({ x: actor.x & ~7, y: actor.worldY - game.camera, width: 1,
            tiles: actor.definition.initial[actor.side] }, "vga-hit");
        }
        if (actor.spriteActor) this.drawGroundSprite(game, actor);
      } else this.drawForeground(game, actor, actor.foregroundRoot);
    }
  }

  drawStageFourMain(game, records, camera) {
    for (const { actor } of records) {
      if (actor.dead || actor.hidden) continue;
      if (actor.finalBoss) {
        if (actor.index < 3) this.drawOverlay(actor.finalBoss.tileRegion(actor), stageOneFlash(game, actor) && "vga-hit");
        else if (actor.length && actor.frame) this.drawSprite(game.sprite(actor.frame), actor.motion.x, actor.motion.y);
      } else if (actor.miniboss) {
        this.drawSprite(game.sprite(actor.frame), actor.motion.x, actor.motion.y, 1, stageOneFlash(game, actor) && "vga-hit");
      } else if (actor.parts) this.drawForeground(game, actor);
      else if (actor.spriteActor) this.drawGroundSprite(game, actor);
      else if (actor.definition?.kind === "burst-gun" && stageOneFlash(game, actor)) {
        // CS:c746 masks with the original 2x2 pose even during the burst.
        this.drawOverlay({ x: actor.x & ~7, y: actor.worldY - camera, width: 2,
          tiles: actor.definition.initial[actor.side] }, "vga-hit");
      }
    }
  }

  drawTransient(game, records) {
    // CS:370b walks the saved links, including tail-appended credits and overlays.
    for (const { type, actor } of records) {
      if ((actor.dead && actor.markedFlashTick !== game.tick) || actor.hidden) continue;
      if (actor.kind === "reward") this.drawPickup(game, actor);
      else if (actor instanceof StageFourCorridorPod) this.drawEnemyRound(game, actor);
      else if (type === 0x0c) this.drawEffect(game, actor);
      else if (type === 0x14) this.drawEnemyRound(game, actor);
      else if (actor.kind === "invulnerability-ring") this.drawInvulnerabilityRing(game, actor);
      else if (type === 0x10 || type === 0x24 || type === 0x28 || type === 0x30
        || type === 0x38 || type === 0x3c || type === 0x48 || type === 0xb4) this.drawPlayerRound(game, actor);
      else if (type === 0x40) {
        const { slot, weapon, dead } = actor.mount;
        if (dead || game.status === "continue" || game.status === "gameover") continue;
        const mount = weaponAttachment(game, slot, weapon);
        if (!mount?.overlay) continue;
        const { x, y } = mount.overlayPosition;
        this.drawMountFrame(game, frameAt(mount.overlay, mount.age), x, y);
      } else if (actor.ground) this.drawGroundSprite(game, actor);
      else if (actor.kind === "terrain-worm-corpse") {
        const sprite = game.sprite(actor.frame);
        this.drawSprite(sprite, ((actor.x - sprite.originX) & ~1) + sprite.originX, actor.y);
      }
      else if (actor.miniboss) this.drawSprite(game.sprite(actor.frame), actor.x, actor.y);
      else this.drawPickup(game, actor);
    }
  }

  drawInvulnerabilityRing(game, { frame, x, y }) {
    const sprite = game.sprite(frame);
    this.drawSprite(sprite, ((x - sprite.originX) & ~1) + sprite.originX, y);
  }

  drawTerrainCover(game, left, top) {
    // The DOS terrain painters restore four map tiles over the sprite.
    const column = Math.floor(left / 16);
    const paint = actorPaint(game);
    const camera = paint?.camera ?? game.camera;
    const row = Math.floor((top + camera) / 16);
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const x = column + dx, y = row + dy;
      if (x < 0 || x >= 20 || y < 0 || y >= 300) continue;
      const cell = y * 20 + x;
      const tile = paint ? (paint.mapPatches.get(cell) ?? game.assets.map[cell]) : game.map[cell];
      if (!(tile >>> 1)) continue;
      this.context.drawImage((tile & 1 ? this.maskedTiles : this.tileImages)[tile >>> 6],
        x * 16, y * 16 - camera);
    }
  }

  drawOverlay(region, white = false) {
    if (!region) return;
    const vgaFlash = white === "vga-hit";
    for (const [i, tile] of region.tiles.entries()) {
      if (!(tile >>> 1)) continue;
      const x = region.x + i % region.width * 16, y = region.y + Math.floor(i / region.width) * 16;
      if (white && !(tile & 1)) {
        this.context.fillStyle = vgaFlash ? `rgb(${this.assets.palette[7].join(",")})` : "#fff";
        this.context.fillRect(x, y, 16, 16);
      } else {
        const index = tile >>> 6;
        if (vgaFlash && !this.vgaFlashTiles.has(index)) {
          const pixels = this.assets.tiles[index];
          this.vgaFlashTiles.set(index, bitmap(this.createCanvas, 16, 16, pixels,
            this.assets.palette.map(() => this.assets.palette[7]),
            Uint8Array.from(pixels, (pixel) => pixel ? 255 : 0)));
        }
        const image = vgaFlash ? this.vgaFlashTiles.get(index)
          : (white ? this.whiteTiles : tile & 1 ? this.maskedTiles : this.tileImages)[index];
        this.context.drawImage(image, x, y);
      }
    }
  }

  drawTimer(game, remaining, duration, x, y) {
    if (remaining === undefined) return;
    const meter = this.assets.logic.nashwan.meter;
    const level = Math.floor(Math.min(remaining, duration) * meter.length / (duration + 1));
    this.drawSprite(game.sprite(meter[level]), x, y);
  }

  draw(game) {
    if (game.runScreen) {
      this.drawIndexed(game.runScreen.pixels, game.runScreen.palette);
      return;
    }
    if (this.assets !== game.assets || this.map !== game.map) {
      this.setStage(game.assets);
      this.map = game.map;
    }
    const paint = actorPaint(game);
    const terrain = paint ?? game;
    const camera = terrain.camera;
    if (this.mapRevision !== terrain.mapRevision) {
      const context = this.world.getContext("2d");
      for (const [cell, tile] of terrain.mapPatches) {
        context.drawImage(this.tileImages[tile >>> 6], (cell % 20) * 16, Math.floor(cell / 20) * 16);
      }
      this.mapRevision = terrain.mapRevision;
    }
    const ctx = this.context;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 320, 200);
    ctx.drawImage(this.world, 0, camera, 320, PLAY_HEIGHT, 0, 0, 320, PLAY_HEIGHT);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, 320, PLAY_HEIGHT);
    ctx.clip();
    // CS:1fb4 paints the meter during transient updates, before any actor draw list.
    this.drawTimer(game, game.invulnerabilityMeterTime, INVULNERABILITY_TICKS, 4, 160);
    const stageOne = game.stage === 1;
    const stageTwo = game.stage === 2;
    const expiry = game.nashwanExpiryFrame;
    const mainRecords = paint?.main ?? game.actorLists.get(ActorList.main) ?? [];
    const stageFour = game.stage === 4;
    const main = stageTwo || stageFour ? mainRecords : stageOne ? mainRecords.filter(({ type, actor }) =>
      type === 0x50 || actor.stageOneBoss || actor.terrainWorm || actor.parts
      || type === 0xd0 || type === 0xd4) : [];
    const transientRecords = paint?.transient ?? expiry?.transient ?? game.actorLists.get(ActorList.transient) ?? [];
    const transient = stageTwo || stageFour ? transientRecords
      : stageOne ? transientRecords.filter(({ type, actor }) =>
      [0x0c, 0x10, 0x14, 0x18, 0x30, 0x40, 0x60, 0xd0, 0xd4].includes(type)
      || actor.kind === "reward" || actor.kind === "terrain-worm-corpse") : [];
    const pooled = new Set((paint?.main
      ? [...(game.actorLists.get(ActorList.main) || []), ...(game.actorLists.get(ActorList.transient) || [])]
      : [...main, ...transient]).map(({ actor }) => actor));
    const isPooled = (actor) => pooled.has(actor) || (stageFour && actor.actorAddress !== undefined);
    if (stageTwo) {
      this.drawShip(game);
      this.drawMounts(game, expiry?.mounts ?? game.actorLists.get(ActorList.mounts), expiry?.inventory);
      this.drawStageTwoMain(game, main);
    }
    for (const enemy of paint?.ground ?? game.ground) {
      if (enemy.dead || enemy.hidden || isPooled(enemy)) continue;
      if (enemy.hit === 3 && enemy.flashRegion) this.drawOverlay(enemy.flashRegion(camera), true);
      if (enemy.definition.kind === "terrain-turret" && enemy.hit) {
        const regions = enemy.core
          ? [{ tiles: enemy.definition.coreFrames[Math.floor(enemy.phase / 2)], x: 16, y: 0, width: 2 }]
          : [{ tiles: enemy.definition.flash, x: 0, y: 32, width: 4 },
            { tiles: enemy.definition.frames[Math.floor(enemy.phase / 2)], x: 16, y: 64, width: 2 }];
        for (const region of regions) for (const [i, tile] of region.tiles.entries()) {
          if (!(tile >>> 1)) continue;
          const x = enemy.x + region.x + i % region.width * 16;
          const y = enemy.motion.y + region.y + Math.floor(i / region.width) * 16;
          if (tile & 1) ctx.drawImage(this.whiteTiles[tile >>> 6], x, y);
          else { ctx.fillStyle = "#fff"; ctx.fillRect(x, y, 16, 16); }
        }
      }
      if (enemy.spriteActor) this.drawGroundSprite(game, enemy);
    }
    const boss = game.boss;
    const bossParts = paint?.bossParts ?? boss?.parts;
    if (boss && !boss.dead && !stageFour && !pooled.has(boss) && camera < 0x280 && (!boss.arenaRegion || bossParts.length)) {
      if (boss.arenaRegion) {
        if (boss.hit) this.drawOverlay(boss.arenaRegion(), true);
        for (const { frame, motion, hit, dead } of bossParts) {
          if (frame && !dead) this.drawSprite(game.sprite(frame), motion.x, motion.y, 1, hit);
        }
        if (!boss.hit) for (const { frame, x, y } of boss.hatchSprites()) {
          this.drawSprite(game.sprite(frame), x, y);
        }
      } else if (boss.parts) {
        for (const actor of [...boss.parts].reverse()) {
          if (!actor.dead) this.drawSprite(game.sprite(actor.frame), actor.motion.x, actor.motion.y, 1, boss.hit);
        }
        if (boss.present) for (const region of boss.definition.overlays) {
          for (const [i, tile] of region.tiles.entries()) {
            ctx.drawImage(this.maskedTiles[tile >>> 6],
              region.x + i % region.width * 16,
              region.worldY - game.camera + Math.floor(i / region.width) * 16);
          }
        }
      } else if (boss.tiles) {
        for (const child of boss.children) {
          if (!child.dead && !pooled.has(child)) this.drawSprite(game.sprite(child.frame), child.motion.x, child.motion.y,
            child.hit ? 0.55 : 1);
        }
        this.drawStageTwoCore(game, boss);
      } else this.drawStageOneCore(game, boss);
    }
    const minibossParts = paint?.minibossParts ?? game.miniboss?.parts;
    if (minibossParts && !stageFour) {
      if (game.miniboss.tileRegion && minibossParts.length && !game.miniboss.dead) {
        this.drawOverlay(game.miniboss.tileRegion(), minibossParts[4].hit);
      }
      for (const actor of minibossParts) {
        if (!actor.dead) this.drawSprite(game.sprite(actor.frame), actor.motion.x, actor.motion.y,
          1, game.miniboss.hit || actor.hit);
      }
    } else if (game.miniboss && !stageFour) {
      for (const actor of game.miniboss.waves) if (!pooled.has(actor)) this.drawWave(game, actor);
      for (const eye of game.miniboss.eyes) {
        if (!pooled.has(eye)) this.drawStageTwoEye(eye);
      }
      for (const corpse of game.miniboss.corpses) {
        if (!corpse.dead && !pooled.has(corpse)) this.drawSprite(game.sprite(corpse.frame), corpse.x, corpse.y);
      }
    }
    for (const pickup of game.pickups) {
      if (!pickup.dead && !isPooled(pickup)) this.drawPickup(game, pickup);
    }
    for (const shot of game.shots) {
      if (!isPooled(shot)) this.drawPlayerRound(game, shot);
    }
    const enemies = paint?.enemies ?? game.enemies;
    for (let index = enemies.length - 1; index >= 0; index--) {
      const enemy = enemies[index];
      if (enemy.dead || ((game.stage === 1 || stageFour) && isPooled(enemy))) continue;
      if (!isPooled(enemy)) this.drawForeground(game, enemy);
      for (const actor of enemy.children) if (!isPooled(actor)) this.drawForeground(game, actor, enemy);
    }
    for (const bullet of game.bullets) {
      if (!isPooled(bullet) && (game.stage !== 1 || bullet.actorAddress === undefined)) {
        this.drawEnemyRound(game, bullet);
      }
    }
    if (!stageTwo) {
      this.drawShip(game);
      this.drawMounts(game, stageOne || stageFour ? expiry?.mounts ?? game.actorLists.get(ActorList.mounts) : undefined,
        expiry?.inventory);
      if (stageFour) this.drawStageFourMain(game, main, camera);
      else if (main.length) this.drawStageOneMain(game, main);
    }
    for (const effect of game.effects) {
      if (!effect.dead && !isPooled(effect)) this.drawEffect(game, effect);
    }
    if (transient.length) this.drawTransient(game, transient);
    for (const actor of paint?.scenery ?? game.scenery) {
      if (actor.dead || actor.definition.kind !== "wall-ram") continue;
      this.drawOverlay(actor.extension);
      this.drawSprite(game.sprite(actor.frame), actor.tipX, actor.y + 8);
    }
    const ring = game.invulnerabilityRing;
    if (ring && ring.actorAddress === undefined) this.drawInvulnerabilityRing(game, ring);
    this.drawTimer(game, game.shadesMeterTime, SHADES_TICKS + 1, 294, 8);
    this.drawTimer(game, game.diveMeterTime, DIVE_TICKS, 152, 8);
    this.drawTimer(game, game.nashwanMeterTime, NASHWAN_TICKS, 152, 160);
    const [r, g, b] = this.assets.palette[7];
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    for (const shot of game.droneShots) {
      // The VGA mask clips the second pixel when it crosses a byte boundary.
      if (shot) ctx.fillRect(shot.x, shot.y, (shot.x & 7) === 7 ? 1 : 2, 2);
    }
    ctx.restore();
    ctx.fillStyle = "#111926";
    ctx.fillRect(0, 192, 320, 8);
    ctx.fillStyle = "#45576b";
    ctx.fillRect(3, 195, 74, 3);
    ctx.fillStyle = game.player.health > 12 ? "#74ddb5" : "#ff765f";
    ctx.fillRect(3, 195, Math.ceil(74 * game.player.health / 39), 3);
    ctx.font = "6px monospace";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#cad5e1";
    ctx.fillText(`${game.playerNumber}UP ${String(game.score).padStart(7, "0")}`, 87, 193);
    ctx.fillText(`LIVES ${game.player.lives}`, 188, 193);
    ctx.fillStyle = "#e9c57b";
    ctx.fillText(`P${game.player.power}  C${game.credits}`, 250, 193);
  }
}
