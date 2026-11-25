import { ActorList } from "./actor-pool.js";
import { PathMotion, frameAt } from "./motion.js";

const definition = { kind: "terrain-worm" };
const rearGuardType = 0xbc, driverType = 0x10c, headType = 0x114, bodyType = 0x110, frontGuardType = 0xb8;

export class StageOneWorms {
  constructor(data, paths, sine) {
    this.data = data;
    this.paths = paths;
    this.sine = sine;
    this.rotations = data.rotations.slice();
    this.openTicks = data.openings.map(() => 0);
    this.clearActors();
  }

  clearActors() {
    this.groups = this.rotations.map(() => undefined);
    this.present = this.rotations.map(() => false);
    this.order = [];
  }

  get targets() {
    return this.order.flatMap((slot) => this.groups[slot].parts.slice().reverse());
  }

  findContact(lists, overlaps, matchesOther) {
    let groupOverlaps = false;
    for (const { type, actor } of lists.get(ActorList.main) || []) {
      if (type === frontGuardType && actor.wormSlot !== undefined) {
        groupOverlaps = Boolean(actor.contactBox && overlaps(actor.contactBox));
        if (actor.dead && groupOverlaps) return actor;
      } else if (type === rearGuardType && actor.wormSlot !== undefined) {
        groupOverlaps = false;
      } else if (groupOverlaps && actor.terrainWorm && overlaps(actor.contactBox)) {
        return actor;
      } else if (actor.wormSlot === undefined && matchesOther(actor)) {
        return actor;
      }
    }
  }

  dispatch(game, camera) {
    const { data } = this;
    const { actorPool: pool } = game.run;
    if (camera < data.firstCamera || camera > data.lastCamera) return;
    game.control.ceiling = Math.max(game.control.ceiling, data.lastCamera);
    for (let slot = 0; slot < this.groups.length; slot++) {
      if (this.present[slot]) continue;
      const allocate = (type, actor) => pool.allocate(game.actorLists, ActorList.main, type,
        Object.assign(actor, { wormSlot: slot }));
      const state = this.rotations[slot];
      this.rotations[slot] = ((state >>> 3) | (state << 13)) & 65535;
      const index = this.rotations[slot] & 15;
      const opening = data.openings[index];
      this.openTicks[index] ||= data.openTicks;

      const y = opening.y - camera - 1;
      const rear = {};
      if (!allocate(rearGuardType, rear)) continue;
      const driver = new PathMotion(this.paths, opening.path, this.sine, { offsetX: opening.x });
      allocate(driverType, driver);
      const [xFraction, yFraction] = pool.subpixels.get(driver.actorAddress) || [0, 0];
      driver.xFixed += xFraction;
      driver.yFixed = y * 65536 + yFraction;
      driver.heading = (pool.headings.get(driver.actorAddress) ?? 0) * 65536;
      const parts = [];
      for (const [i, part] of data.parts.entries()) {
        const segment = {
          terrainWorm: true, definition, ground: true, spriteActor: true, whiteFlash: true,
          motion: { x: opening.x, y }, frame: part.frame, remaining: -part.delay,
          hidden: true, health: 1, hit: 0, corpse: i === 0 ? 0 : 1, score: part.score,
          bounds() {
            return this.hidden ? { x: 0, y: 0, w: 0, h: 0 }
              : game.bounds(game.sprite(this.frame), this.motion.x, this.motion.y);
          },
        };
        if (!allocate(i === 0 ? headType : bodyType, segment)) break;
        segment.contactBox = game.bounds(game.sprite(segment.frame), opening.x, y);
        segment.heading = pool.headings.get(segment.actorAddress) ?? 0;
        parts.push(segment);
      }
      rear.frontGuard = allocate(frontGuardType, {})?.actor;
      this.groups[slot] = { index, retireIndex: opening.retireIndex, driver, parts };
      this.order = [slot, ...this.order.filter((activeSlot) => activeSlot !== slot)];
    }
    for (const [i, opening] of data.openings.entries()) {
      if (this.openTicks[i]) game.patchGround(opening, [opening.tiles[--this.openTicks[i] & 3]]);
    }
  }

  update(game, delta, aimOperand, updateOther) {
    const { actorLists: lists } = game;
    const { actorPool: pool } = game.run;
    const main = ActorList.main;
    this.present.fill(false);
    for (const [list, record] of pool.walk(lists, main, updateOther && ActorList.transient)) {
      const { actor, type, address } = record;
      const slot = actor.wormSlot;
      if (slot === undefined || list !== main) {
        if (updateOther) aimOperand = updateOther(list, record, aimOperand);
        continue;
      }
      if (actor.dead) {
        pool.release(lists, main, record);
      } else if (type === rearGuardType) {
        const records = lists.get(main);
        const rearIndex = records.indexOf(record);
        const front = actor.frontGuard;
        const frontIndex = records.findIndex(({ actor }) => actor === front);
        if (frontIndex === rearIndex - 1 && frontIndex >= 0) front.dead = actor.dead = true;
        else if (frontIndex >= 0) {
          // CS:25a8 builds the group gate from drawn segments, but CS:1c18 tests raw segment boxes.
          const boxes = records.slice(frontIndex + 1, rearIndex)
            .filter(({ actor }) => actor.terrainWorm && !actor.hidden && !actor.dead)
            .map(({ actor }) => actor.contactBox);
          if (!boxes.length) front.contactBox = undefined;
          else {
            const x = Math.min(...boxes.map((box) => box.x));
            const y = Math.min(...boxes.map((box) => box.y));
            aimOperand = y;
            front.contactBox = { x, y, w: Math.max(...boxes.map((box) => box.x + box.w)) - x,
              h: Math.max(...boxes.map((box) => box.y + box.h)) - y };
          }
        }
      } else if (type === driverType) {
        this.present[slot] = true;
        actor.yFixed += delta * 65536;
        // CS:6aac loads the worm's presence-byte index before advancing the path.
        aimOperand = actor.step(this.data.speed, slot);
        game.saveActorMotion(actor, actor);
        if (!actor.active) {
          actor.dead = true;
          pool.release(lists, main, record);
        }
      } else if (type !== frontGuardType) {
        this.present[slot] = true;
        // CS:6a0a reads the live successor before its callback runs this tick.
        const records = lists.get(main);
        const next = records[records.indexOf(record) + 1];
        if (next?.type === rearGuardType) {
          const { retireIndex } = this.groups[slot];
          aimOperand = retireIndex * 2;
          this.openTicks[retireIndex] ||= this.data.openTicks;
          actor.dead = true;
          pool.release(lists, main, record);
        } else if (next?.actor.wormSlot === slot) {
          const leader = next.actor;
          const { x, y } = leader.motion ?? leader;
          actor.motion.x = x;
          actor.motion.y = y + delta;
          actor.heading = next.type === driverType ? leader.heading >>> 16 : leader.heading;
          pool.headings.set(address, actor.heading);
          actor.remaining = leader.remaining;
          actor.hidden &&= actor.remaining < 0;
          const pose = ((actor.heading + 16) >>> 5) & 7;
          aimOperand = pose * 2;
          actor.frame = this.data.frames[actor.corpse][pose];
          actor.contactBox = game.bounds(game.sprite(actor.frame), actor.motion.x, actor.motion.y);
          actor.hit = 0;
        }
      }
    }
    for (const slot of this.order) {
      const group = this.groups[slot];
      if (group.driver.dead) group.driver.active = false;
      group.parts = group.parts.filter((part) => !part.dead);
    }
    return aimOperand;
  }

  destroy(game, part) {
    const { actorPool: pool } = game.run;
    const frames = this.data.corpses[part.corpse];
    const corpse = { kind: "terrain-worm-corpse", ...part.motion, frames, frame: frames[0], age: 0 };
    const record = pool.allocate(game.actorLists, ActorList.transient, part.corpse ? bodyType : headType, corpse);
    if (record) {
      corpse.heading = game.randomWord() & 255;
      pool.headings.set(record.address, corpse.heading);
      // CS:6708 marks the dying segment's address after constructing the corpse.
      if (record.address === part.actorAddress) corpse.dead = true;
    }
    part.dead = true;
    game.score += part.score;
    game.kills++;
  }

  updateCorpse(corpse) {
    corpse.frame = frameAt(corpse.frames, ++corpse.age);
    const y = corpse.y + (this.sine[corpse.heading] >> 2);
    if (y < 0 || y >= 192) { corpse.dead = true; return; }
    corpse.y = y;
    const x = corpse.x + (this.sine[(corpse.heading + 64) & 255] >> 2);
    if (x < 0 || x >= 320) { corpse.dead = true; return; }
    corpse.x = x;
  }
}
