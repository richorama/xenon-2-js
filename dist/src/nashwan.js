import { ActorList } from "./actor-pool.js";

export const NASHWAN_TICKS = 0xaa;

// CS:2b22 saves the equipment list; CS:472d restores it, without buying weapons.
export function activateNashwan(game) {
  if (!game.player.nashwan || game.nashwan) return;
  game.nashwan = { inventory: game.inventory, mounts: game.actorLists.get(ActorList.mounts) };
  game.actorLists.set(ActorList.mounts, []);
  game.inventory = [14, 15, 15, 18, 18, 19, 10].map((id, slot) => ({
    id, power: slot === 1 || slot === 2 ? 0 : 2,
  }));
  const starter = game.addWeaponRecord(0, { id: 1, power: 0 });
  for (const slot of [1, 2, 3, 4, 5, 6, 0]) {
    if (slot === 0 && starter) starter.actor.dead = true;
    game.addWeaponRecord(slot, game.inventory[slot]);
  }
  game.firePeriod = 8;
  game.syncPower();
}

export function suspendNashwan(game) {
  if (!game.nashwan) return;
  game.releaseWeaponRecords();
  game.actorLists.set(ActorList.mounts, game.nashwan.mounts);
  game.inventory = game.nashwan.inventory;
  game.nashwan = undefined;
  game.syncPower();
}
