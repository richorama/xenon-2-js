export const BACKTRACK_PIXELS = 16;

export function playerDirections(player, input) {
  const left = input.target ? input.target.x < player.x - 1 : input.left;
  const right = input.target ? input.target.x > player.x + 1 : input.right;
  const up = input.target ? input.target.y < player.y - 1 : input.up;
  const down = input.target ? input.target.y > player.y + 1 : input.down;
  return { up, down: Boolean(down), left, right };
}

// CS:44f3-45f3; CS:3e1a-3f00. Keyboard inputs use the original integer steps.
export function movePlayer(player, input, control) {
  const { up, down, left, right } = playerDirections(player, input);
  if (left) control.bank = Math.max(-6, Math.min(0, control.bank) - 1);
  else if (right) control.bank = Math.min(6, Math.max(0, control.bank) + 1);
  else control.bank -= Math.sign(control.bank);
  let scroll = control.scrollDirection ?? 1;
  const atTop = up && player.y <= 16;
  if (up) {
    if (player.y > 16) player.y -= 3 + player.speed;
    else { player.y = 16; scroll = 1; }
  }
  if (down && !atTop) {
    if (player.y < 176) player.y += 3 + player.speed;
    else if (control.camera !== control.ceiling) {
      scroll = -1;
      player.y = 176;
    }
  }
  let dx = control.bank;
  if (dx > 0 && right) dx = 6;
  if (dx < 0 && left) dx = -6;
  if (!player.speed) dx >>= 1;
  if (player.speed >= 2) dx += dx >> 1;
  player.x = Math.max(16, Math.min(302, player.x + dx));
  player.bank = Math.sign(control.bank);
  return { scroll, up, down, left, right };
}

export function scrollMap(control, scroll, down, floor) {
  if (scroll === (control.scrollDirection ?? 1)) control.reverseTicks = 0;
  else if (++control.reverseTicks >= 35) scroll *= 2;
  control.scroll = scroll;
  const previous = control.camera;
  control.camera = Math.max(floor, Math.min(control.ceiling, previous - scroll));
  control.delta = previous - control.camera;
  const candidate = control.camera + (previous === control.ceiling && down ? 0 : BACKTRACK_PIXELS);
  control.ceiling = Math.min(control.ceiling, candidate);
  return control.delta;
}
