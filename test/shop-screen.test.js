import { test } from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/game.js";
import { ShopScreen } from "../src/shop-screen.js";
import { loadTestCampaign } from "./helpers.js";

const assets = loadTestCampaign();
function shop(stage = 1, end = false, age = 76) {
  const game = new Game(assets);
  game.start(stage);
  if (end) game.camera = 0;
  game.credits = 10000;
  game.openShop(stage);
  const screen = new ShopScreen(game);
  for (let i = 0; i < age; i++) screen.update();
  return { game, screen };
}
function settle(screen) {
  for (let frame = 0; frame < 100 && screen.busy; frame++) screen.update();
  assert.equal(screen.busy, false);
}
function buying(screen) {
  settle(screen);
  screen.activate(20);
  settle(screen);
}

for (const destination of [1, 2]) {
  test(`shop exit freezes flight through the shutters and hold before stage ${destination}`, () => {
    const { game, screen } = shop();
    const camera = game.camera, tick = game.tick;
    game.shopStage = destination;
    buying(screen);
    assert.equal(screen.phase, "buy");
    screen.activate(20);
    let held;
    for (let frame = 1; frame <= 46; frame++) {
      screen.update();
      assert.equal(screen.busy, true);
      assert.equal(screen.activate(20), false);
      assert.deepEqual([game.status, game.tick, game.camera], ["shop", tick, camera]);
      if (frame === 36) held = [game.seed, screen.draw().slice()];
      else if (frame < 46 && held) assert.deepEqual([game.seed, screen.draw()], held);
    }
    screen.update();
    assert.equal(game.status, destination === 1 ? "playing" : "stage-loading");
    assert.equal(game.stage, destination);
    if (destination === 1) assert.deepEqual([game.tick, game.camera], [tick, camera]);
  });
}

test("graphical source stock uses visit cap and wallet, not the complete HTML item list", () => {
  const { game, screen } = shop();
  buying(screen);
  assert.equal(game.shopBudget, 600);
  assert.deepEqual(screen.slots.map((slot) => slot.id), [2, 3, 4, 5, 6, ...Array(15).fill(26)]);
  screen.activate(1);
  assert.match(screen.message, /SPEEDUP\r\rTHAT WILL COST 500/);
  assert.equal(game.player.speed, 0);
  assert.equal(screen.activate(21), false);
  settle(screen);
  screen.activate(21);
  assert.equal(game.player.speed, 0);
  assert.equal(game.credits, 10000);
  settle(screen);
  assert.equal(game.player.speed, 1);
  assert.equal(game.credits, 9500);
  game.credits = 100;
  screen.activate(4);
  settle(screen);
  assert.equal(screen.activate(21), false);
  settle(screen);
  assert.equal(game.player.nashwan, 0);
  assert.equal(game.credits, 100);
});

test("graphical sales use live mount-list order and keep the original mount after another sale", () => {
  const { game } = shop();
  game.replaceWeapon(1, { id: 18, power: 2 });
  game.replaceWeapon(5, { id: 8, power: 1 });
  const screen = new ShopScreen(game);
  screen.age = 32;
  assert.deepEqual(screen.slots.slice(0, 3).map((slot) => slot.id), [8, 18, 0]);
  screen.activate(0);
  settle(screen);
  screen.activate(21);
  assert.equal(game.inventory[5], null);
  assert.equal(screen.slots[0].id, 0);
  settle(screen);
  screen.activate(1);
  settle(screen);
  screen.activate(21);
  assert.equal(game.inventory[1], null);
  assert.equal(game.credits, 15500);
  screen.activate(21);
  assert.equal(game.credits, 15500);
});

test("reselecting a quoted slot confirms the transaction, even after visiting an empty slot", () => {
  const { game } = shop();
  game.replaceWeapon(5, { id: 8, power: 0 });
  const screen = new ShopScreen(game);
  screen.age = 80;
  assert.equal(screen.activate(0), false);
  settle(screen);
  assert.equal(screen.activate(1), false);
  assert.equal(screen.activate(0), true);
  assert.equal(game.inventory[5], null);
  assert.equal(screen.activate(20), false);
  assert.equal(screen.phase, "sell");
  buying(screen);
  assert.equal(screen.activate(1), false);
  settle(screen);
  assert.equal(screen.activate(1), true);
  assert.equal(game.player.speed, 0);
  settle(screen);
  assert.equal(game.player.speed, 1);
});

test("a sale quote pauses at the item description while Colin gestures, then reveals the price", () => {
  const { game } = shop();
  game.replaceWeapon(1, { id: 18, power: 0 });
  const screen = new ShopScreen(game);
  screen.age = 80;
  const { tick, camera, credits } = game;
  const offer = screen.art.prompts.sale;
  screen.activate(0);
  assert.ok(screen.busy);
  assert.ok(screen.message.endsWith(screen.art.prompts.power + "1"));
  const gestures = [];
  for (let i = 0; i < 80 && !screen.message.includes(offer); i++) {
    assert.equal(screen.activate(21), false);
    screen.move(1, 0);
    assert.equal(screen.selection, 0);
    screen.update();
    const draws = [];
    const sprite = screen.sprite;
    try {
      screen.sprite = (pointer) => { draws.push(pointer); };
      screen.draw();
    } finally {
      screen.sprite = sprite;
    }
    assert.ok(draws.includes(0xeb44));
    assert.ok(!draws.includes(0xebea));
    if (screen.saleQuote?.frame < 47) gestures.push(screen.textAge);
  }
  assert.equal(gestures.length, 47);
  assert.equal(new Set(gestures).size, 1);
  assert.ok(screen.message.includes(offer));
  assert.deepEqual([game.tick, game.camera, game.credits], [tick, camera, credits]);
  assert.deepEqual(game.inventory[1], { id: 18, power: 0 });
  settle(screen);
  assert.equal(screen.activate(21), true);
  assert.equal(game.inventory[1], null);
});

test("original More icon pages later stock and stage-five discounts are applied before eligibility", () => {
  const { game, screen } = shop(5, true);
  buying(screen);
  assert.equal(screen.slots[19].id, 27);
  screen.activate(19);
  assert.deepEqual(screen.slots.slice(0, 5).map((slot) => slot.id), [21, 22, 23, 24, 25]);
  assert.equal(screen.slots[5].id, 0);
  screen.activate(1);
  assert.match(screen.message, /THAT WILL COST 3000/);
  settle(screen);
  screen.activate(21);
  settle(screen);
  assert.equal(game.player.lives, 4);
  assert.equal(game.credits, 7000);
  screen.activate(19);
  assert.equal(screen.slots[0].id, 2);
});

test("shop arrows wrap, bottom actions stay on two columns, and hatch transitions reject activation", () => {
  const { screen } = shop();
  screen.move(-1, 0);
  assert.equal(screen.selection, 4);
  screen.move(0, -1);
  assert.equal(screen.selection, 21);
  screen.move(1, 0);
  assert.equal(screen.selection, 20);
  screen.activate();
  assert.equal(screen.busy, true);
  screen.activate(21);
  assert.equal(screen.phase, "sell");
  const timers = [];
  const sellPrompt = screen.message;
  for (let i = 0; i < 32; i++) {
    screen.update();
    timers.push(screen.hatchTimer);
    assert.equal(screen.phase, i < 19 ? "sell" : "buy");
    assert.equal(screen.message, sellPrompt);
    assert.equal(screen.activate(20), false);
  }
  assert.deepEqual(timers, [
    -1, -2, -3, -4, -5, -6, -7, -8, ...Array(11).fill(-9),
    -8, -7, -6, -5, -4, -3, -2, -1, ...Array(5).fill(1),
  ]);
  screen.update();
  assert.equal(screen.phase, "buy");
  assert.equal(screen.message, screen.art.prompts.buy);
  assert.equal(screen.textAge, 1);
  assert.equal(screen.activate(0), false);
  assert.equal(screen.quote, undefined);
  settle(screen);
  assert.equal(screen.selection, 0);
});

test("the stage-five discount belongs to the current shop, not its destination stage", () => {
  const { game, screen } = shop(4, true);
  game.shopStage = 5;
  buying(screen);
  screen.activate(1);
  assert.match(screen.message, /COST 500/);
  settle(screen);
  screen.activate(21);
  settle(screen);
  assert.equal(game.credits, 9500);
});

test("Colin's opening hand gesture delays dialogue and input on ordinary and victory visits", () => {
  for (const ending of [false, true]) {
    const { game } = shop(ending ? 5 : 1, ending, 0);
    if (ending) game.status = "ending";
    const screen = new ShopScreen(game);
    game.randomWord = () => 5;
    const message = ending ? assets.shopArt.ending[0] : assets.shopArt.prompts.sell;
    assert.equal(screen.blink, true);
    screen.update();
    const closed = screen.draw().slice();
    const seed = game.seed;
    for (let frame = 0; frame < 9; frame++) {
      screen.update();
      assert.equal(screen.busy, true);
      assert.equal(game.seed, seed);
      assert.deepEqual(screen.draw(), closed);
    }
    const hatches = [];
    for (let frame = 0; frame < 30; frame++) {
      screen.update();
      assert.equal(screen.handFrame, undefined);
      assert.equal(screen.blink, true);
      hatches.push(screen.hatchTimer);
    }
    assert.deepEqual(hatches, [...Array(17).fill(-9), -8, -7, -6, -5, -4, -3, -2, -1, ...Array(5).fill(1)]);
    for (let frame = 0; frame < 35; frame++) {
      screen.update();
      assert.equal(screen.message, message);
      assert.equal(screen.textAge, 0);
      assert.equal(screen.blink, frame < 18);
      assert.equal(screen.brow, false);
      assert.equal(screen.activate(20), false);
      screen.move(1, 0);
      assert.equal(screen.selection, 0);
      if (frame === 12) {
        const pixels = screen.draw().slice();
        const paint = screen.drawHand;
        try {
          screen.drawHand = () => {};
          const backdrop = screen.draw();
          assert.notDeepEqual(pixels.subarray(83 * 320, 105 * 320), backdrop.subarray(83 * 320, 105 * 320));
          assert.deepEqual(pixels.subarray(105 * 320), backdrop.subarray(105 * 320));
        } finally {
          screen.drawHand = paint;
        }
      }
    }
    screen.update();
    assert.equal(screen.textAge, 1);
    assert.equal(screen.message, message);
    assert.equal(screen.busy, ending);
  }
});

test("the stage-five visit holds two greetings before its sell prompt and blocks shop input", () => {
  const { game, screen } = shop(5);
  const { tick, camera, credits } = game;
  const lines = [];
  for (let frame = 0; frame < 100 && screen.busy; frame++) {
    if (lines.at(-1)?.message !== screen.message) lines.push({ message: screen.message, hold: 0 });
    const wordCount = screen.message.split(" ").filter(Boolean).length;
    if (screen.textAge > wordCount) lines.at(-1).hold++;
    screen.move(1, 0);
    assert.equal(screen.selection, 0);
    assert.equal(screen.activate(20), false);
    screen.update();
  }
  assert.deepEqual(lines.map(({ message }) => message), assets.shopArt.stageFiveGreeting);
  assert.deepEqual(lines.map(({ hold }) => hold), [17, 17, 0]);
  assert.equal(screen.busy, false);
  assert.equal(game.status, "shop");
  assert.deepEqual([game.tick, game.camera, game.credits], [tick, camera, credits]);
  buying(screen);
  assert.equal(screen.phase, "buy");

  const { screen: earlier } = shop(4, true);
  assert.equal(earlier.message, earlier.art.prompts.sell);
  assert.equal(earlier.busy, false);
});

test("all graphical shop pages, original icon pointers, doors and dialogue compose without canvas or missing assets", () => {
  const { screen } = shop(5, true);
  for (const phase of ["sell", "buy"]) for (const page of [0, 19]) {
    screen.phase = phase;
    screen.page = page;
    screen.fillSlots();
    for (let age = 0; age < 130; age++) {
      screen.age = age;
      screen.textAge = age;
      const pixels = screen.draw();
      assert.equal(pixels.length, 64000);
      assert.ok(pixels.every((p) => p < 16));
    }
  }
});

test("shop slots flicker independently, pause their icons in static, and consume no RNG on redraw", () => {
  const { game } = shop(1, false, 0);
  game.replaceWeapon(5, { id: 8, power: 0 });
  game.replaceWeapon(1, { id: 18, power: 0 });
  const screen = new ShopScreen(game);
  screen.age = 80;
  screen.setMessage("");
  const [first, second] = screen.slots;
  first.timer = 4;
  second.timer = 6;

  screen.update();
  assert.deepEqual([first.iconFrame, second.iconFrame], [0, 0]);
  screen.update();
  assert.deepEqual([first.timer, second.timer], [2, 4]);
  assert.deepEqual([first.iconFrame, second.iconFrame], [0, 1]);
  const seed = game.seed;
  const pixels = screen.draw().slice();
  assert.deepEqual(screen.draw(), pixels);
  assert.equal(game.seed, seed);
  for (let y = 4; y < 32; y++) {
    assert.ok(pixels.subarray(y * 320 + 4, y * 320 + 36).every((p) => p === 0 || p === 7));
  }

  screen.update();
  assert.deepEqual([first.timer, first.iconFrame], [1, 0]);
  screen.update();
  assert.ok(first.timer >= 20 && first.timer <= 275);
  assert.deepEqual([first.iconFrame, second.timer, second.iconFrame], [1, 2, 2]);
});

test("Colin's longest talking branch uses portrait artwork rather than reading the following end-screen graphic", () => {
  const { game, screen } = shop();
  for (const slot of screen.slots) Object.assign(slot, { id: 26, timer: 200 });
  let first = true;
  game.randomWord = () => {
    if (!first) return 5;
    first = false;
    return 0;
  };
  screen.setMessage("WHAT DO YOU WANT TO BUY ?");
  screen.update();
  assert.equal(screen.mouth, screen.art.mouths.length - 1);
  assert.doesNotThrow(() => screen.draw());
});

test("the shop word writer retries an unused zero RNG draw after painting Colin's face", () => {
  const { game, screen } = shop(5);
  for (const slot of screen.slots) Object.assign(slot, { id: 26, timer: 200 });
  screen.browTicks = 0;
  const results = [4, 5, 5, 0, 9];
  game.randomWord = () => {
    assert.ok(results.length, "unexpected RNG draw");
    return results.shift();
  };
  screen.update();
  assert.equal(screen.mouth, 2);
  assert.equal(screen.blink, false);
  assert.equal(screen.brow, false);
  assert.deepEqual(results, []);
});

test("Colin takes payment and then winks with one eye while delivering advice", () => {
  const { game, screen } = shop();
  buying(screen);
  // Select advice twice first so the final reply lasts longer than the wink.
  for (let visit = 0; visit < 2; visit++) {
    screen.activate(0);
    settle(screen);
    assert.ok(screen.activate(21));
    for (let frame = 0; frame < 60 && screen.busy; frame++) screen.update();
  }
  const before = game.credits;
  game.randomWord = () => 5;
  screen.activate(0);
  settle(screen);
  assert.ok(screen.activate(21));
  assert.equal(screen.message, screen.art.prompts.cash);
  assert.ok(screen.busy);
  assert.equal(screen.activate(20), false);
  const draws = [];
  const drawSprite = screen.sprite.bind(screen);
  screen.sprite = (pointer, ...position) => {
    draws.push(pointer);
    drawSprite(pointer, ...position);
  };
  let winks = 0;
  for (let frame = 0; frame < 60 && screen.busy; frame++) {
    screen.update();
    draws.length = 0;
    screen.draw();
    assert.ok(!draws.includes(0xea9e));
    if (draws.includes(0xe9f8)) winks++;
  }
  assert.equal(winks, 12);
  assert.equal(screen.message, assets.advice[0][2]);
  assert.equal(game.credits, before - assets.shop.find(({ id }) => id === 2).price);
  assert.equal(screen.busy, false);
});

test("the cash panel finishes before purchase and the receipt holds shop input afterward", () => {
  const { game, screen } = shop();
  buying(screen);
  const credits = game.credits;
  const { cash, bought } = screen.art.prompts;
  screen.activate(4);
  settle(screen);
  assert.ok(screen.activate(21));
  assert.equal(screen.message, cash);
  for (let i = 0; i < 30 && screen.message === cash; i++) {
    assert.equal(game.credits, credits);
    assert.equal(game.player.nashwan, 0);
    assert.equal(screen.activate(21), false);
    screen.update();
  }
  assert.equal(screen.message, cash + bought);
  assert.equal(game.credits, credits - 600);
  assert.ok(game.player.nashwan > 0);
  assert.equal(screen.activate(20), false);
  settle(screen);
  assert.equal(game.credits, credits - 600);
  screen.activate(20);
  for (let i = 0; i < 47; i++) screen.update();
  assert.equal(game.status, "playing");
});

test("the victory visit plays three noninteractive lines, then the original cross and blank hold", () => {
  const { game } = shop(5, true);
  game.status = "ending";
  const screen = new ShopScreen(game);
  const lines = new Set([screen.message]);
  let cabinet = 0, cross = 0, blank = 0;
  for (let i = 0; i < 500 && game.status === "ending"; i++) {
    assert.equal(screen.activate(21), false);
    const pixels = screen.draw();
    if (pixels[101 * 320 + 165] === 7 && pixels.filter(Boolean).length === 8) cross++;
    else if (!pixels.some(Boolean)) blank++;
    else if (screen.exitFrame > 0) cabinet++;
    screen.update();
    if (screen.message) lines.add(screen.message);
  }
  assert.equal(lines.size, 3);
  assert.equal(cabinet, 46);
  assert.equal(cross, 150);
  assert.equal(blank, 80);
  assert.equal(game.status, "stage-loading");
  assert.equal(game.stage, 1);
  assert.equal(game.credits, 0);
  const after = game.snapshot();
  screen.update();
  assert.deepEqual(game.snapshot(), after);
});
