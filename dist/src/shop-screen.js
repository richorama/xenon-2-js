import { buy, sell, price, purchaseProblem, salePrice } from "./shop.js";
import { ActorList } from "./actor-pool.js";

const shutterHold = 9;
const entryShuttersOpen = 18;
const hatchOpening = 13;
const cabinetOpen = entryShuttersOpen + hatchOpening + 1;
const handFrames = 35;
const handRelease = 18;
const portraitBottom = 104;
const hatchesClosed = 19;
const hatchesOpened = hatchesClosed + hatchOpening;
const shuttersClosed = hatchesClosed + 17;
const exitResume = shuttersClosed + shutterHold + 2;
const saleRise = 8;
const salePoses = [0xf700, 0xf470, 0xf700, 0xf990, 0xf700, 0xf470, 0xf700, 0xf990, 0xf700];
const saleLower = saleRise + salePoses.length * 3;
const saleFrames = saleLower + 12;
const salePowerLabels = new Set([1, 8, 9, 10, 13, 14, 18, 19]);
const endingHolds = [30, 30, 17];
const endingFlash = 150;
const endingBlank = 80;
const wordsIn = (message) => message.match(/[^ \r\n]+ *|[\r\n]/g) || [];

export class ShopScreen {
  constructor(game) {
    this.game = game;
    this.art = game.campaign.shopArt;
    this.lookup = new Map([
      ...game.campaign.banks[0].map((s) => [s.offset + 8, s]),
      ...game.campaign.weapons.map((s) => [s.offset + 0x6bee, s]),
      ...game.campaign.shopSprites.map((s) => [s.offset + 0xabc4, s]),
    ]);
    this.pixels = new Uint8Array(320 * 200);
    this.slotNoise = new Uint8Array(20 * 28);
    this.phase = game.status === "ending" ? "ending" : "sell";
    this.page = 0;
    this.selection = 0;
    this.age = 0;
    this.entryHold = shutterHold;
    this.blink = true;
    this.mouth = 0;
    this.brow = false;
    this.endingLine = 0;
    if (this.phase === "ending") this.setMessage(this.art.ending[0]);
    else if (game.stage === 5) {
      this.greetingLine = 0;
      this.setMessage(this.art.stageFiveGreeting[0]);
    } else this.setMessage(this.art.prompts.sell);
    this.fillSlots();
    this.prepareSlots();
  }

  get busy() {
    return this.phase === "ending" || this.age < cabinetOpen || this.handFrame !== undefined
      || this.transition !== undefined || this.exitFrame !== undefined || this.greetingLine !== undefined
      || Boolean(this.buyDialogue || this.saleQuote);
  }

  item(id) { return this.game.campaign.shop.find((item) => item.id === id); }

  fillSlots() {
    const game = this.game;
    let slots;
    if (this.phase === "ending") {
      slots = Array.from({ length: 20 }, (_, i) => ({ id: i === 19 ? 0 : 26 }));
    } else if (this.phase === "sell") {
      slots = (game.actorLists.get(ActorList.mounts) || []).flatMap(({ actor: { weapon, slot, dead } }) =>
        !dead && weapon.id !== 1 ? [{ id: weapon.id, slot, power: weapon.power }] : []);
      while (slots.length < 20) slots.push({ id: 0 });
    } else {
      const affordable = (id) => {
        const cost = price(this.item(id), game.stage);
        return cost <= game.credits && cost <= game.shopBudget;
      };
      if (this.page && price(this.item(20), game.stage) > game.credits) this.page = 0;
      slots = Array.from({ length: 19 }, (_, i) => {
        const id = this.page + i + 2;
        return { id: id > 25 ? 0 : affordable(id) ? id : 26 };
      });
      slots.push({ id: this.page || affordable(21) ? 27 : 26 });
    }
    this.slots = slots.map((slot, i) => ({ ...slot, timer: this.slots?.[i].timer ?? 1, iconFrame: -1 }));
  }

  get hatchTimer() {
    if (this.exitFrame > 0) return Math.max(-9, -this.exitFrame);
    if (this.transition > 0) {
      if (this.transition <= hatchesClosed) return Math.max(-9, -this.transition);
      return this.transition < hatchesClosed + 9 ? this.transition - hatchesClosed - 9 : 1;
    }
    if (this.age < cabinetOpen) {
      if (this.age <= entryShuttersOpen) return -9;
      return this.age < cabinetOpen - 5 ? this.age - cabinetOpen + 5 : 1;
    }
  }

  updateSlots() {
    if (this.hatchTimer === undefined) {
      // CS:5691 reloads expired occupied slots before any static draws consume RNG.
      for (const slot of this.slots) {
        if (!slot.id) slot.timer = 0;
        else if (--slot.timer <= 0) slot.timer = 20 + (this.game.randomWord() & 255);
      }
    }
    this.prepareSlots();
  }

  prepareSlots() {
    const hatch = this.hatchTimer;
    for (const [i, slot] of this.slots.entries()) {
      const timer = hatch ?? slot.timer;
      if (timer > 2 && slot.id) {
        slot.iconFrame = (slot.iconFrame + 1) % this.art.icons[slot.id].length;
      } else if (timer !== -8) {
        for (let row = 0; row < 28; row++) this.slotNoise[i * 28 + row] = this.game.randomWord() >>> 8;
      }
    }
  }

  setMessage(message) {
    this.message = message;
    this.textAge = 0;
  }

  updateBuyDialogue() {
    const dialogue = this.buyDialogue;
    if (dialogue.purchase === undefined) {
      if (dialogue.advice) this.refreshStock();
      if (dialogue.shopEntry) this.selection = 0;
      this.buyDialogue = undefined;
      return;
    }
    const id = dialogue.purchase;
    const result = buy(this.game, id);
    this.buyDialogue = {};
    if (!result.ok) {
      this.setMessage(this.art.prompts.room);
      return;
    }
    this.game.sounds.push("pickup");
    if (id === 2) {
      this.setMessage(result.message);
      this.buyDialogue = { advice: true, winkTicks: 12 };
    } else {
      this.refreshStock();
      this.message += this.art.prompts.bought;
    }
  }

  refreshStock() {
    for (const slot of this.slots) {
      if (slot.id >= 2 && slot.id < 26 && price(this.item(slot.id), this.game.stage) > this.game.credits) {
        slot.id = 26;
        slot.iconFrame = -1;
      }
    }
    if (this.slots[19].id === 27 && this.slots[18].id === 26) {
      this.slots[19].id = 26;
      this.slots[19].iconFrame = -1;
    }
  }

  updateHatches() {
    if (++this.transition > hatchesOpened) {
      for (const slot of this.slots) slot.timer = 1;
      this.transition = undefined;
      this.setMessage(this.art.prompts.buy);
      this.buyDialogue = { shopEntry: true };
      return false;
    }
    if (this.transition === hatchesClosed + 1) {
      this.phase = "buy";
      this.fillSlots();
    }
    this.prepareSlots();
    this.updatePortrait(false);
    return true;
  }

  updatePortrait(typing) {
    this.mouth = 0;
    if (typing) {
      const random = this.game.randomWord();
      while (this.mouth < 3 && !(random & (1 << this.mouth))) this.mouth++;
    }
    // CS:561c draws only the left eyelid during the timed advice wink.
    this.wink = this.buyDialogue?.winkTicks > 0;
    if (this.wink) this.buyDialogue.winkTicks--;
    const forcedBlink = this.age < cabinetOpen || this.handFrame < handRelease;
    this.blink = forcedBlink || !this.wink && !(this.game.randomWord() & 0x2654);
    this.brow = false;
    if (!forcedBlink && !this.saleQuote) {
      if (this.browTicks) { this.browTicks--; this.brow = true; }
      else if (!(this.game.randomWord() & 0x2654)) { this.browTicks = 8; this.brow = true; }
    }
  }

  updateExit() {
    const victory = this.phase === "ending";
    if (this.game.status !== (victory ? "ending" : "shop")) return;
    const frame = ++this.exitFrame;
    if (frame === hatchesClosed + 1) this.setMessage("");
    if (frame <= shuttersClosed || (frame > shuttersClosed + shutterHold && frame <= exitResume)) {
      this.age++;
      this.prepareSlots();
      this.updatePortrait(false);
    }
    if (!victory && frame === exitResume) this.game.continueRun();
    if (victory && frame === exitResume + endingFlash + endingBlank) this.game.finishVictory();
  }

  update() {
    if (this.exitFrame !== undefined) {
      this.updateExit();
      return;
    }
    if (this.phase === "ending" && this.game.status !== "ending") return;
    if (this.age < cabinetOpen - 1) {
      if (this.age === 1 && this.entryHold > 0) {
        this.entryHold--;
        return;
      }
      if (++this.age === 2) this.entryCaps = true;
      this.prepareSlots();
      this.updatePortrait(false);
      return;
    }
    this.age++;
    if (this.transition !== undefined && this.updateHatches()) return;
    if (this.age === cabinetOpen) this.handFrame = 0;
    else if (this.handFrame !== undefined && ++this.handFrame === handFrames) this.handFrame = undefined;
    const showDialogue = this.age >= cabinetOpen && this.handFrame === undefined;
    let words = wordsIn(this.message);
    if (this.phase === "ending" && this.endingLine < endingHolds.length - 1
      && this.textAge >= words.length + endingHolds[this.endingLine]) {
      this.endingPrefix = this.endingLine === 0 ? this.message : "";
      this.setMessage(this.art.ending[++this.endingLine]);
      words = wordsIn(this.message);
    }
    if (this.greetingLine !== undefined) {
      const greeting = this.art.stageFiveGreeting;
      const hold = this.greetingLine < greeting.length - 1 ? 17 : 0;
      if (this.textAge >= words.length + hold) {
        const next = greeting[++this.greetingLine];
        if (next === undefined) this.greetingLine = undefined;
        else {
          this.setMessage(next);
          words = wordsIn(next);
        }
      }
    } else if (this.buyDialogue && this.textAge >= words.length) {
      this.updateBuyDialogue();
      words = wordsIn(this.message);
    }
    if (this.saleQuote && this.textAge >= words.length) {
      const sale = this.saleQuote;
      if (sale.frame === saleFrames) this.saleQuote = undefined;
      else {
        sale.frame = (sale.frame ?? -1) + 1;
        if (sale.frame === saleFrames) {
          this.message += this.art.prompts.sale + sale.amount;
          words = wordsIn(this.message);
        }
      }
    }
    const saleFrame = this.saleQuote?.frame;
    const saleHand = saleFrame >= 0 && saleFrame < saleFrames;
    const typing = showDialogue && !saleHand && this.textAge < words.length;
    const slotsFirst = this.handFrame !== undefined
      || this.greetingLine !== undefined || typing || saleFrame >= saleRise && saleFrame < saleLower;
    if (slotsFirst) this.updateSlots();
    if (showDialogue && !saleHand) this.textAge++;
    this.updatePortrait(typing);
    // CS:579a retries its unused voice draw after the portrait. Prices use the separate number writer.
    if (typing && !/^\d+ *$/.test(words[this.textAge - 1])) {
      while (!(this.game.randomWord() & 3)) {}
    }
    if (this.phase === "ending" && this.endingLine === endingHolds.length - 1
      && this.textAge >= words.length + endingHolds[this.endingLine]) this.exitFrame = 0;
    if (!slotsFirst) this.updateSlots();
  }

  move(dx, dy) {
    if (this.busy) return;
    let x = this.selection % 5, y = Math.floor(this.selection / 5);
    if (dx) x = y === 4 ? x ? 0 : 1 : (x + dx + 5) % 5;
    if (dy) y = (y + dy + 5) % 5;
    if (y === 4) x = Math.min(x, 1);
    this.selection = y * 5 + x;
  }

  activate(index = this.selection) {
    if (this.busy || !Number.isInteger(index) || index < 0 || index > 21) return false;
    this.selection = index;
    if (index === 20) {
      this.quote = undefined;
      if (this.phase === "buy") this.exitFrame = 0;
      else this.transition = 0;
      return false;
    }
    // CS:4eb3/518f treat a second press on the quoted slot like Buy or Sell.
    if (index === 21 || index === this.quote?.index) {
      if (!this.quote) return false;
      const quote = this.quote;
      this.quote = undefined;
      if (this.phase === "buy") {
        const allowed = !purchaseProblem(this.game, this.item(quote.id));
        this.setMessage(this.art.prompts[allowed ? "cash" : "room"]);
        this.buyDialogue = allowed ? { purchase: quote.id } : {};
        return allowed;
      }
      const result = sell(this.game, quote.slot);
      this.setMessage(this.art.prompts[result.ok ? "sold" : "room"]);
      this.buyDialogue = {};
      if (result.ok) {
        this.slots[quote.index] = { id: 0, timer: 0, iconFrame: -1 };
        this.game.sounds.push("pickup");
      }
      return result.ok;
    }
    const slot = this.slots[index];
    if (!slot.id) return false;
    this.quote = undefined;
    if (slot.id === 27) {
      this.page = this.page ? 0 : 19;
      this.fillSlots();
      return false;
    }
    if (slot.id === 26) {
      this.setMessage(this.art.prompts.unavailable);
      this.buyDialogue = {};
      return false;
    }
    const item = this.item(slot.id);
    this.quote = { ...slot, index };
    const label = this.art.labels[slot.id];
    if (this.phase === "sell") {
      this.saleQuote = { amount: salePrice(item, slot) };
      this.browTicks = 0;
      this.setMessage(label + (salePowerLabels.has(slot.id) ? this.art.prompts.power + (slot.power + 1) : ""));
    } else {
      this.setMessage(label + this.art.prompts.cost + price(item, this.game.stage));
      this.buyDialogue = {};
    }
    return false;
  }

  label(index) {
    if (index === 20) return this.phase === "sell" ? "Finish selling; buy equipment" : "Exit shop; continue flight";
    if (index === 21) return `${this.phase === "sell" ? "Sell" : "Buy"} selected item`;
    const slot = this.slots[index];
    return slot.id === 27 ? "More equipment" : slot.id === 26 ? "Out of stock"
      : slot.id ? `${this.item(slot.id).name}${this.phase === "sell" ? `, power ${slot.power + 1}` : ""}`
        : "Empty equipment slot";
  }

  blit(image, x, y, top = 0, rows = image.height - top) {
    x = Math.floor(x); y = Math.floor(y);
    for (let sy = top; sy < top + rows; sy++) {
      const dy = y + sy - top;
      if (dy < 0 || dy >= 200) continue;
      for (let sx = 0; sx < image.width; sx++) {
        const dx = x + sx, source = sy * image.width + sx;
        if (dx < 0 || dx >= 320 || image.alpha && !image.alpha[source]) continue;
        this.pixels[dy * 320 + dx] = image.pixels[source];
      }
    }
  }

  sprite(pointer, x, y, minY = 0, maxY = 200) {
    const sprite = this.lookup.get(pointer);
    if (!sprite) throw new Error(`Missing shop sprite ${pointer.toString(16)}`);
    y -= sprite.originY;
    const top = Math.max(0, minY - y);
    this.blit(sprite, x - sprite.originX, y + top, top, Math.min(sprite.height, maxY - y) - top);
  }

  drawHand() {
    const frame = this.handFrame;
    const saleFrame = this.saleQuote?.frame;
    let pointer, x, y;
    if (frame !== undefined) {
      // CS:5510 approaches diagonally and holds each pose for six updates.
      const step = frame < 12 ? frame : frame < 24 ? 11 : handFrames - frame;
      pointer = frame >= 12 && frame < handRelease ? 0xf990 : 0xf700;
      x = 262 + step * 2;
      y = 136 - step * 2;
    } else if (saleFrame >= 0 && saleFrame < saleFrames) {
      // CS:5240 raises the hand vertically and holds each sale pose for three updates.
      pointer = salePoses[Math.floor((saleFrame - saleRise) / 3)] ?? 0xf700;
      x = 247;
      y = portraitBottom + (saleFrame < saleRise ? (saleRise - saleFrame) * 2 : Math.max(0, saleFrame - saleLower) * 2);
    } else return;
    const hand = this.lookup.get(pointer);
    x -= hand.originX;
    y -= hand.originY;
    if (y < portraitBottom) this.blit(hand, x, y, 0, portraitBottom - y + 1);
  }

  drawSlots() {
    const hatch = this.hatchTimer;
    for (const [index, slot] of this.slots.entries()) {
      const x = 4 + index % 5 * 41, y = 4 + Math.floor(index / 5) * 41;
      const timer = hatch ?? slot.timer;
      if (timer <= 2 || !slot.id) {
        for (let row = 0; row < 28; row++) {
          const noise = this.slotNoise[index * 28 + row];
          for (let column = 0; column < 32; column++) {
            this.pixels[(y + row) * 320 + x + column] = noise & (0x80 >>> (column & 7)) ? 7 : 0;
          }
        }
        // The -8 frame skips the static repaint, leaving the previous hatch beneath it.
        if (timer === -8) {
          const opening = this.transition > hatchesClosed || this.age < cabinetOpen;
          this.sprite(this.art.hatches[opening ? 0 : 2], x, y);
        }
        if (timer < 0) this.sprite(this.art.hatches[timer + 9], x, y);
      } else {
        this.sprite(0xb2ec, x, y);
        const sprite = this.lookup.get(this.art.icons[slot.id][Math.max(0, slot.iconFrame)]);
        this.blit(sprite, x + 16 - Math.floor(sprite.width / 2), y + 14 - Math.floor(sprite.height / 2));
      }
    }
  }

  text(message) {
    let column = 0, row = 0;
    const newline = () => { column = 0; row++; };
    for (const word of message.toUpperCase().split(/( |\r|\n)/)) {
      if (word === "\r" || word === "\n") { newline(); continue; }
      if (word !== " " && word.length + column > 20) newline();
      for (const char of word) {
        if (row > 8) return;
        const glyph = char === " " ? undefined : this.art.font[char.charCodeAt(0) - 32];
        if (glyph) this.blit(glyph, 220 + column * 4, 118 + row * 7);
        column++;
      }
    }
  }

  draw() {
    const art = this.art;
    this.pixels.fill(0);
    if (this.phase === "ending" && this.exitFrame >= exitResume) {
      // 0f29:19eb draws a small fixed palette-7 cross, followed by a blank hold.
      if (this.exitFrame < exitResume + endingFlash) {
        for (const [row, left, width] of [[100, 165, 2], [101, 164, 4], [102, 165, 2]]) {
          this.pixels.fill(7, row * 320 + left, row * 320 + left + width);
        }
      }
      return this.pixels;
    }
    for (const image of art.backdrop) this.blit(image, image.x, image.y);
    for (let y = 0; y < 164; y += 41) for (let x = 0; x < 205; x += 41) {
      this.sprite(0xec90, x, y);
      this.sprite(0xefc0, x, y);
    }
    this.blit(art, 208, 9);
    const words = wordsIn(this.message);
    this.blit(art.mouths[this.mouth || 0], 208, 61);
    for (const decoration of art.decorations) {
      const sprite = decoration.frames[this.age % decoration.frames.length];
      this.blit(sprite, decoration.x + 208 - sprite.originX, decoration.y - sprite.originY);
    }
    if (this.blink) this.sprite(0xea9e, 263, 41);
    if (this.blink || this.wink) this.sprite(0xe9f8, 247, 41);
    if (this.brow && !this.saleQuote) this.sprite(0xebea, 263, 35);
    if (this.brow || this.saleQuote) this.sprite(0xeb44, 245, 35);
    const exitDoor = this.exitFrame > hatchesClosed ? (this.exitFrame - hatchesClosed) * 4 : 0;
    const opening = Math.max(0, this.age - 1) * 4;
    const portraitDoor = exitDoor ? Math.min(48, exitDoor) : Math.max(0, 48 - opening);
    if (portraitDoor > 8) {
      this.blit(art.portraitDoor[0], 208, 9, 48 - portraitDoor, portraitDoor - 8);
      this.blit(art.portraitDoor[1], 208, 113 - portraitDoor, 0, portraitDoor - 8);
    }
    if (portraitDoor) {
      // The VGA painter restores the cabinet trim over the first shutter step.
      const trim = portraitDoor < 8;
      for (const [i, pointer] of [0xabe4, 0xace4, 0xad94, 0xae94, 0xaf94, 0xb044].entries()) {
        this.sprite(pointer, 215 + i % 3 * 32, i < 3 ? portraitDoor + 1 : 112 - portraitDoor,
          trim ? 9 : 0, trim ? 105 : 200);
      }
    }
    const door = exitDoor ? Math.min(68, exitDoor) : Math.max(0, 68 - opening);
    // At height zero the opening draw leaves the last strip until CS:0c71 clears it.
    const doorImage = this.entryCaps && this.age === entryShuttersOpen ? 4 : door;
    if (this.entryCaps) {
      for (let y = 114; y < 182 - doorImage; y++) this.pixels.fill(0, y * 320 + 215, y * 320 + 312);
    }
    if (this.age >= cabinetOpen) this.text((this.endingPrefix || "") + words.slice(0, this.textAge).join(""));
    if (doorImage) this.blit(art.dialogueDoor, 208, 182 - doorImage, 0, doorImage);
    if (exitDoor || this.entryCaps) {
      for (const x of [226, 258, 290]) {
        this.sprite(portraitDoor & 4 ? 0xb1ae : 0xb144, x, 4);
        this.sprite(door & 4 ? 0xb1ae : 0xb144, x, 109);
      }
    }
    this.drawHand();
    this.drawSlots();
    const leaving = this.selection === 20 && this.transition === undefined && this.exitFrame === undefined
      && !this.buyDialogue?.shopEntry;
    this.sprite(leaving ? 0xdde0 : 0xe3ec, 4, 168);
    this.sprite(this.phase === "buy" ? this.selection === 21 ? 0xdfe4 : 0xe5f0
      : this.selection === 21 ? 0xe1e8 : 0xe7f4, 45, 168);
    if (this.selection < 20 && (!this.busy || this.saleQuote || this.buyDialogue)) {
      this.sprite(0xb282, 14 + this.selection % 5 * 41, 35 + Math.floor(this.selection / 5) * 41);
    }
    for (const [i, char] of String(Math.min(9999999, this.game.credits)).padStart(7, "0").split("").entries()) {
      this.blit(art.digits[Number(char)], 136 + i * 8, 172);
    }
    return this.pixels;
  }
}
