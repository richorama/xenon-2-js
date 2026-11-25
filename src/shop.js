import { NASHWAN_TICKS } from "./nashwan.js";

// Actor power caps recovered from CS:2bce-32ca; powers are zero-based.
const caps = { 1: 2, 8: 2, 9: 1, 10: 2, 11: 0, 13: 1, 14: 2, 15: 0,
  17: 0, 18: 2, 19: 2, 20: 2, 21: 0, 23: 0 };
export const SHADES_TICKS = 0xdc;

export function applyWeaponFirePeriod(game, id) {
  const period = { 1: 8, 10: 8, 14: 8, 20: 8, 21: 12, 23: 30 }[id];
  if (period) game.firePeriod = period;
}

export function newInventory() {
  return [{ id: 1, power: 0 }, null, null, null, null, null, null];
}

export function upgradeTarget(inventory) {
  let target;
  for (const weapon of inventory) {
    if (weapon && weapon.power < caps[weapon.id] && (!target || weapon.power < target.power)) target = weapon;
  }
  return target;
}

export function price(item, stage) {
  return stage === 5 ? item.price >>> 1 : item.price;
}

export function salePrice(item, weapon) {
  return (item.price + 2000 * weapon.power) >>> 1;
}

function slotFor(game, item) {
  const slots = item.mounts & 1 ? [0] : item.mounts & 2 ? [1, 2, 3, 4]
    : item.mounts & 4 ? [5] : item.mounts & 8 ? [6] : [5, 6];
  if (!(item.mounts & (2 | 16))) {
    const same = game.inventory[slots[0]];
    if (same?.id === item.id && same.power < caps[item.id]) return slots[0];
  }
  return slots.find((index) => !game.inventory[index]
    || (index === 0 && game.inventory[index].id === 1 && item.id !== 1));
}

export function purchaseProblem(game, item) {
  if (game.status !== "shop") return "The shop is closed.";
  if (!item || item.id === 1) return "Not for sale.";
  if (game.credits < price(item, game.stage)) return "Not enough credits.";
  if (item.mounts) return slotFor(game, item) === undefined ? "Mount occupied or power at maximum." : "";
  const p = game.player;
  const unavailable = {
    3: p.speed >= 2, 4: p.health >= 39, 5: p.autofire >= 3, 6: p.nashwan > 0,
    7: p.health >= 39, 12: !upgradeTarget(game.inventory), 16: p.dives > 0,
    22: p.lives >= 9, 24: p.protection, 25: p.shades > 0,
  };
  return unavailable[item.id] ? "Already at maximum or not needed." : "";
}

export function buy(game, id) {
  const item = game.campaign.shop?.find((entry) => entry.id === id);
  const problem = purchaseProblem(game, item);
  if (problem) return { ok: false, message: problem };
  if (item.mounts) {
    const slot = slotFor(game, item);
    const current = game.inventory[slot];
    // CS:2d86 checks both slots for an existing Homing Missile before installing one.
    if (id !== 23 || !game.inventory.some((weapon) => weapon?.id === 23)) {
      if (current?.id === id) current.power++;
      else {
        game.replaceWeapon(slot, { id, power: id === 13 ? 1 : 0 });
        if (id === 15) game.ensureStarterMount();
      }
      applyWeaponFirePeriod(game, id);
    }
  } else {
    const p = game.player;
    switch (id) {
      case 2: {
        const messages = game.campaign.advice?.[game.stage - 1] || [];
        const index = game.adviceIndex;
        if (index % 3 !== 2) game.adviceIndex++;
        const text = messages[index] || "YOU CAN'T TAKE IT WITH YOU";
        game.credits -= price(item, game.stage);
        return { ok: true, message: text };
      }
      case 3: p.speed++; break;
      case 4: p.health = Math.min(39, p.health + 20); break;
      case 5: p.autofire++; break;
      case 6: p.nashwan = NASHWAN_TICKS; break;
      case 7: p.health = Math.min(39, p.health + 40); break;
      case 12: upgradeTarget(game.inventory).power++; break;
      case 16: p.dives += 3; break;
      case 22: p.lives++; break;
      case 24: p.protection = true; break;
      case 25: p.shades = SHADES_TICKS; break;
      default: return { ok: false, message: "Unsupported item." };
    }
  }
  game.credits -= price(item, game.stage);
  game.syncPower();
  return { ok: true, message: `${item.name} installed.` };
}

export function sell(game, slot) {
  const weapon = game.inventory[slot];
  const item = game.campaign.shop?.find((entry) => entry.id === weapon?.id);
  if (game.status !== "shop" || !item || weapon.id === 1) {
    return { ok: false, message: "That item cannot be sold." };
  }

  const amount = salePrice(item, weapon);
  game.replaceWeapon(slot, null);
  game.credits += amount;
  game.syncPower();
  return { ok: true, message: `Sold ${item.name} for ${amount}.` };
}

// DS:31d8 dispatches pod reward IDs; these are not shop item IDs.
export function grantReward(game, reward) {
  const p = game.player;
  const weapons = { 4: 8, 5: 10, 7: 15, 8: 19, 9: 18, 10: 11,
    11: 9, 12: 17, 13: 23, 14: 20, 15: 21 };
  if (weapons[reward]) {
    const id = weapons[reward];
    const item = game.campaign.shop?.find((entry) => entry.id === id);
    if (!item) return;
    if (id === 23 && game.inventory.some((weapon) => weapon?.id === 23)) return;
    let slot = slotFor(game, item);
    if (id === 23 && slot === undefined) slot = 6;
    if (slot === undefined && !(item.mounts & (2 | 16))) {
      slot = item.mounts & 1 ? 0 : item.mounts & 4 ? 5 : 6;
    }
    if (slot === undefined) return;
    const current = game.inventory[slot];
    if (current?.id === id || (id === 9 && current?.id === 13)) {
      current.power = Math.min(caps[id], current.power + 1);
    }
    else {
      if (id === 8 && game.inventory[6]?.id === 10) game.replaceWeapon(6, null);
      if (id === 10 && game.inventory[5]?.id === 8) game.replaceWeapon(5, null);
      game.replaceWeapon(slot, { id, power: 0 });
      if (id === 15) game.ensureStarterMount();
    }
    applyWeaponFirePeriod(game, id);
  } else {
    switch (reward) {
      case 0: p.speed = Math.min(2, p.speed + 1); break;
      case 1: p.autofire = Math.min(3, p.autofire + 1); break;
      case 2: p.health = Math.min(39, p.health + 20); break;
      case 3: p.health = Math.min(39, p.health + 40); break;
      case 6: {
        const target = upgradeTarget(game.inventory);
        if (target) target.power++;
        break;
      }
      case 16: game.grantInvulnerability(); break;
      case 17: p.dives += 3; break;
      case 18: game.clearScreen(); break;
    }
  }
  game.syncPower();
}
