import { frameAt } from "./motion.js";
import { ActorList } from "./actor-pool.js";

export function weaponAnchor(game, slot, weapon) {
  const { player } = game;
  const { id } = weapon;
  if (slot >= 1 && slot <= 4) {
    const [x, y] = game.assets.logic.auxiliaryMounts[slot - 1];
    return { x: player.x + x, y: player.y + y };
  }
  const position = id === 11 || id === 19 ? game.playerTrail[0] : player;
  return { x: position.x, y: position.y + ([9, 11, 13, 19].includes(id) ? 25 : 0) };
}

export function weaponAttachment(game, slot, weapon) {
  if (game.mountPosture === 16) return;
  const { id } = weapon;
  const { cannon, mountFrames, rearAttachment } = game.assets.logic;
  const age = game.weaponAges.get(weapon) || 0;
  const frames = id === 8 ? [rearAttachment[game.rearFrame]]
    : id === 15 ? [cannonFrame(game, weapon)]
    : id === 17 ? [mountFrames[17][Math.max(0, age - 1)]] : mountFrames[id];
  if (!frames) return;
  const position = game.electroBall?.weapon === weapon ? game.electroBall
    : game.mine?.weapon === weapon ? game.mine : weaponAnchor(game, slot, weapon);
  const { x, y } = position.posed ? position
    : mountPosition(game, frameAt(frames, age), position);
  const overlay = id === 15 && game.assets.logic.auxiliaryMounts[slot - 1]?.[0]
    ? cannon.overlay : null;
  const overlayPosition = overlay && mountPosition(game, frameAt(overlay, age), position);
  return { x, y, frames, age, overlay, overlayPosition };
}

// CS:47a9 uses sprite centers and a signed 16-bit multiply, not interpolation.
function mountPosition(game, frame, position) {
  const { mountPosture: posture, player } = game;
  if (!posture || posture === 16) return position;
  const ship = game.mountShipSprite || game.shipSprite(game.divePose);
  const sprite = game.sprite(frame);
  const center = (coordinate, origin, size) => (((coordinate - origin) * 2 + size) << 16) >> 17;
  const shipX = center(player.x, ship.originX, ship.width);
  const shipY = center(player.y, ship.originY, ship.height - 1);
  const mountX = center(position.x, sprite.originX, sprite.width);
  const mountY = center(position.y, sprite.originY, sprite.height - 1);
  return { x: ((shipX + posture * (mountX - shipX)) << 16) >> 16,
    y: ((shipY + posture * (mountY - shipY)) << 16) >> 16 };
}

function poseRemoteMount(game, mount) {
  mount.posed = Boolean(game.mountPosture);
  if (mount.posed) {
    const age = game.weaponAges.get(mount.weapon) || 0;
    Object.assign(mount, mountPosition(game, frameAt(game.assets.logic.mountFrames[mount.weapon.id], age), mount));
  }
}

export function cannonFrame(game, weapon) {
  return game.assets.logic.cannon.frames[(game.cannonPhases.get(weapon) ?? -1) + 1];
}

function weaponEntries(game, ...ids) {
  return [...game.inventory.entries()].filter(([, weapon]) => ids.includes(weapon?.id));
}

// CS:246d: the recoil animation launches a round one tick after the fire pulse.
export function updateCannons(game, firing) {
  for (const [slot, weapon] of weaponEntries(game, 15)) updateCannon(game, slot, weapon, firing);
}

function updateCannon(game, slot, weapon, firing) {
  const { cannon } = game.assets.logic;
  let phase = game.cannonPhases.get(weapon);
  if (phase !== undefined) {
    phase++;
    if (phase === 1 && !game.mountPosture) {
      const { x, y } = weaponAnchor(game, slot, weapon);
      game.addPlayerRound({ x, y: y - 11, dy: -10,
        damage: cannon.damage, frame: cannon.shot[0], frames: cannon.shot, age: 0,
        cannon: true, piercing: true }, 0x30);
    }
    if (phase === 4) phase = undefined;
  }
  if (phase === undefined && firing && !game.mountPosture) phase = 0;
  if (phase === undefined) game.cannonPhases.delete(weapon);
  else game.cannonPhases.set(weapon, phase);
}

export function updateLinkedMounts(game, firing, held, directions, previousX, previousY) {
  const { player } = game;
  const dx = player.x - previousX, dy = player.y - previousY;
  const updated = new Set();
  if (game.inventory[5]?.id !== 11) game.electroBall = undefined;
  if (![9, 13].includes(game.inventory[5]?.id)) game.mine = undefined;
  let shot = false;
  const records = (game.actorLists.get(ActorList.mounts) || []).slice();
  for (const record of records) {
    const { slot, weapon, dead } = record.actor;
    // The new mount can fire before this pass visits the starter it replaced.
    if (dead) game.run.actorPool.release(game.actorLists, ActorList.mounts, record);
    else if (game.inventory[slot] === weapon) {
      updated.add(slot);
      updateWeaponMount(game, slot, weapon, firing, held);
      if (weapon.id === 11) updateElectroBall(game, held, dx, dy);
      else if (weapon.id === 9 || weapon.id === 13) updateMine(game, held, directions, previousX, previousY);
      else if (weapon.id === 15) updateCannon(game, slot, weapon, firing);
      else if (weapon.id === 18 || weapon.id === 19) updateLaserOrDrone(game, slot, weapon, firing, held);
      else if (firing && fireStraightWeapon(game, weapon)) shot = true;
    }
  }
  // Keep the legacy group order for inventory entries without a pool record.
  const untracked = [...game.inventory.entries()].filter(([slot, weapon]) => weapon && !updated.has(slot));
  for (const [slot, weapon] of untracked) updateWeaponMount(game, slot, weapon, firing, held);
  if (!updated.has(5)) {
    updateElectroBall(game, held, dx, dy);
    updateMine(game, held, directions, previousX, previousY);
  }
  if (firing) {
    for (const [, weapon] of untracked) if (fireStraightWeapon(game, weapon)) shot = true;
    if (!game.divePhase || shot) game.sounds.push("shot");
  }
  for (const [slot, weapon] of untracked) if (weapon.id === 15) updateCannon(game, slot, weapon, firing);
  for (const [slot, weapon] of untracked) {
    if (weapon.id === 18 || weapon.id === 19) updateLaserOrDrone(game, slot, weapon, firing, held);
  }
}

export function updateWeaponMounts(game, firing, held) {
  for (const [slot, weapon] of game.inventory.entries()) {
    if (weapon) updateWeaponMount(game, slot, weapon, firing, held);
  }
}

function updateWeaponMount(game, slot, weapon, firing, held) {
  let age = game.weaponAges.get(weapon) || 0;
  if (weapon.id === 17) {
    if (age === 1 && !game.mountPosture) {
      const { x, y } = weaponAnchor(game, slot, weapon);
      const { frames, damage } = game.assets.logic.missileShot;
      for (const offset of [-3, 5]) {
        game.addPlayerRound({ x: x + offset, y: y - 16, dx: 0, dy: -9, point: true,
          frames, frame: frames[0], age: 0, damage });
      }
    }
    if (age) age = age === game.assets.logic.mountFrames[17].length ? 0 : age + 1;
    if (!age && firing && !game.mountPosture) age = 1;
  } else if (weapon.id === 21) {
    if (!game.divePhase) {
      if (age) age--;
      if (!age && firing && !game.shots.some((shot) => shot.bomb && !shot.dead)) {
        const x = game.player.x, y = game.player.y - 12;
        const { frames, damage } = game.assets.logic.bomb;
        game.addPlayerRound({ x, y, age: 0, fuse: -((y >>> 4) + 4), frames, damage, bomb: true }, 0x28);
        age = 16;
      }
    }
  } else if (weapon.id === 23) {
    if (!game.divePhase) {
      if (age) age--;
      if (!age && firing && !game.shots.some((shot) => shot.homing && !shot.dead)) {
        for (const direction of [7, 5, 3, 1]) {
          game.addPlayerRound({ x: game.player.x, y: game.player.y, age: 0,
            direction, phase: 13, homing: true, launch: true }, 0x48);
        }
        age = 19;
      }
    }
  } else {
    age++;
    if (weapon.id === 20 && held && !game.mountPosture) fireFlamer(game, weapon);
  }
  game.weaponAges.set(weapon, age);
}

// CS:213c spawns one damaging plume and one visual-only plume on every held tick.
function fireFlamer(game, weapon) {
  const { player } = game;
  const { frames, ttl, damage } = game.assets.logic.flamer;
  for (const damaging of [true, false]) {
    const y = player.y - (damaging ? 16 : 22) + (game.randomWord() & 3);
    const drift = (game.randomWord() << 24) >> 24;
    game.addPlayerRound({ x: player.x, y, xFixed: player.x * 65536 + 32768, dxFixed: drift * 1024,
      age: 0, frames, ttl, damage: damage + weapon.power, flame: true, damaging }, 0xb4);
  }
}

// CS:262d uses a signed counter for ascent and a separate stationary fuse.
export function stepBomb(shot) {
  if (shot.fuse < 0) {
    shot.y -= 6;
    shot.fuse++;
  } else if (shot.fuse === 0) shot.fuse = 3;
  else return --shot.fuse === 0;
  return false;
}

// CS:2697/275d: the mount rises, then lays charges as it is steered while firing.
export function updateMine(game, held, { up, down, left, right }, previousX, previousY) {
  const weapon = game.inventory[5];
  if (weapon?.id !== 9 && weapon?.id !== 13) {
    game.mine = undefined;
    return;
  }
  const { x, y } = weaponAnchor(game, 5, weapon);
  if (game.mine?.weapon !== weapon) {
    game.mine = { weapon, x: previousX, y: previousY + 25, phase: 0, lastX: -100, lastY: 0 };
  }
  const mine = game.mine;
  poseRemoteMount(game, mine);
  if (mine.posed) return;
  if (!mine.phase) {
    mine.x = x;
    mine.y = y;
    if (held) mine.phase = 1;
  } else if (mine.phase === 3) {
    mine.x += Math.max(-8, Math.min(8, x - mine.x));
    mine.y += Math.max(-8, Math.min(8, y - mine.y));
    if (mine.x === x && mine.y === y) mine.phase = 0;
  } else if (!held) mine.phase = 3;
  else if (mine.phase === 1) {
    if (mine.y > 16) mine.y -= 12;
    else mine.phase = 2;
  } else {
    if (left) mine.x = Math.max(0, mine.x - 8);
    if (right) mine.x = Math.min(319, mine.x + 8);
    if (up) mine.y = Math.max(0, mine.y - 8);
    if (down) mine.y = Math.min(191, mine.y + 8);
    // CS:2758 only decrements the global count on detonation, not when death clears charges.
    const pooled = game.stage === 2 || game.stage === 4;
    const count = pooled ? game.run.mineChargeCount
      : game.shots.filter((shot) => shot.mine && !shot.dead).length;
    if (count === 10 || (Math.abs(mine.x - mine.lastX) < 32 && Math.abs(mine.y - mine.lastY) < 32)) return;
    mine.lastX = mine.x;
    mine.lastY = mine.y;
    const frames = game.assets.logic.mountFrames[weapon.id];
    const age = game.weaponAges.get(weapon);
    const duration = frames[0].duration;
    game.addPlayerRound({ mine: true, x: mine.x, y: mine.y, age: age - age % duration,
      frames, fuse: -4 * (count + 1), power: weapon.power }, weapon.id === 9 ? 0x38 : 0x3c);
    if (pooled) game.run.mineChargeCount++;
  }
}

// CS:229b keeps one ball: fire steers it, then releasing starts a distinct return phase.
export function updateElectroBall(game, held, dx, dy) {
  const weapon = game.inventory[5];
  if (weapon?.id !== 11) {
    game.electroBall = undefined;
    return;
  }
  const { x, y } = weaponAnchor(game, 5, weapon);
  if (game.electroBall?.weapon !== weapon) {
    game.electroBall = { weapon, x: game.player.x - dx, y: game.player.y - dy + 25, phase: "idle" };
  }
  const ball = game.electroBall;
  poseRemoteMount(game, ball);
  if (ball.posed) return;
  if (ball.phase === "returning") {
    ball.x += Math.max(-8, Math.min(8, x - ball.x));
    ball.y += Math.max(-8, Math.min(8, y - ball.y));
    if (ball.x === x && ball.y === y) ball.phase = "idle";
    return;
  }
  if (!held) {
    if (ball.phase === "active") ball.phase = "returning";
    else {
      ball.x = x;
      ball.y = y;
    }
    return;
  }
  if (ball.phase === "idle") ball.phase = "active";
  else {
    ball.x = Math.max(0, Math.min(319, ball.x + dx * 4));
    ball.y = Math.max(0, Math.min(191, ball.y + dy * 4));
  }
  const frame = frameAt(game.assets.logic.mountFrames[11], game.weaponAges.get(weapon) || 0);
  const bounds = game.bounds(game.sprite(frame), ball.x, ball.y);
  const attack = { electroBall: true, damage: game.assets.logic.electroBallDamage };
  if (game.stage === 2 || game.stage === 4) game.hitPlayerRound(attack, bounds);
  else game.hitFirstInBox(attack, bounds);
}

export function updateLaserAndDrone(game, pulse, held) {
  for (const [slot, weapon] of weaponEntries(game, 18, 19)) {
    updateLaserOrDrone(game, slot, weapon, pulse, held);
  }
}

function updateLaserOrDrone(game, slot, weapon, pulse, held) {
  const laser = weapon.id === 18;
  let mount = game.weaponFire.get(weapon);
  if (!mount) {
    mount = { cooldown: 0 };
    game.weaponFire.set(weapon, mount);
  }
  const anchor = weaponAnchor(game, slot, weapon);
  const frames = game.assets.logic.mountFrames[weapon.id];
  const { x, y } = laser ? mountPosition(game, frameAt(frames, game.weaponAges.get(weapon) || 0), anchor) : anchor;
  const { power } = weapon;
  if (laser) {
    mount.x = x - 7;
    mount.y = y - 24;
  }
  if (game.mountPosture) return;
  if (mount.cooldown) mount.cooldown--;
  if (mount.cooldown || !(laser ? pulse : held)) return;
  if (laser) {
    mount.cooldown = 7;
    const inset = 4 - power * 2;
    game.addPlayerRound({ x: mount.x + inset, y: mount.y, damage: (power + 1) * 3, age: 0, piercing: true,
      beam: { parent: mount, length: -32, width: 8 + power * 4, inset, caps: game.assets.logic.laserCaps[power] } }, 0x24);
  } else {
    mount.cooldown = 6;
    game.addDroneVolley(x, y, game.assets.logic.droneVolleys[power]);
  }
}

export function moveLaserBeam(shot) {
  const { beam } = shot;
  if (beam.length !== 65) {
    shot.x = beam.parent.x + beam.inset;
    shot.y = beam.parent.y;
    beam.length += 32;
    if (beam.length === 96) beam.length = 65;
  }
  if (beam.length === 65) shot.y -= 32;
  shot.dead = shot.y < 0;
  shot.hits = new Set();
  const top = shot.y - beam.length;
  const y = Math.max(0, top);
  return { x: shot.x, y, w: beam.width, h: Math.max(0, top + 33 - y) };
}

export function fireWeapons(game) {
  let shot = false;
  for (const weapon of game.inventory) if (weapon && fireStraightWeapon(game, weapon)) shot = true;
  if (!game.divePhase || shot) game.sounds.push("shot");
}

function fireStraightWeapon(game, weapon) {
  const { player: p } = game;
  const initialShots = game.shots.length;
  const originalShot = (kind, dx, dy, x, y) => {
    game.addPlayerRound({ x: p.x + x, y: p.y + y, dx, dy, damage: weapon.power + 1,
      originalSprite: game.assets.playerShots[kind][weapon.power], point: true, age: 0 });
  };
  switch (weapon.id) {
    case 1:
      if (game.divePhase) return false;
      originalShot("forward", 0, -9, 0, -6);
      break;
    case 8:
      if (game.mountPosture) return false;
      originalShot("rear", 0, 9, 0, 18);
      game.rearFiring = true;
      break;
    case 10:
      if (game.divePhase) return false;
      originalShot("left", -9, 0, -2, -3);
      originalShot("right", 9, 0, 2, -3);
      break;
    case 14:
      if (game.mountPosture) return false;
      originalShot("forward", 0, -9, -5, -12);
      originalShot("forward", 0, -9, 6, -12);
      break;
    default: return false;
  }
  return game.shots.length > initialShots;
}
