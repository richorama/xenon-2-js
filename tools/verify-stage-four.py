"""Compare stage four with DOS, correcting foreground aiming in memory."""

import base64
import json
from pathlib import Path
import struct
import subprocess

from unicorn import Uc, UC_ARCH_X86, UC_MODE_16, UC_HOOK_CODE, UC_HOOK_INSN, UC_HOOK_INTR, UC_HOOK_MEM_WRITE
from unicorn.x86_const import (
    UC_X86_INS_OUT,
    UC_X86_REG_AX, UC_X86_REG_BP, UC_X86_REG_BX, UC_X86_REG_CS, UC_X86_REG_CX, UC_X86_REG_DI,
    UC_X86_REG_DS, UC_X86_REG_DX, UC_X86_REG_ES, UC_X86_REG_IP, UC_X86_REG_SI,
    UC_X86_REG_SP, UC_X86_REG_SS,
)

ROOT = Path(__file__).resolve().parent.parent
LOAD = 0x1000
DS = (LOAD + 0x1853) * 16
STOP = 0x1FF00
exe = (ROOT / "XENON2.EXE").read_bytes()
image = bytearray(exe[0x800:])
for index in range(struct.unpack_from("<H", exe, 6)[0]):
    offset, segment = struct.unpack_from("<HH", exe, 0x22 + index * 4)
    position = segment * 16 + offset
    value = struct.unpack_from("<H", image, position)[0]
    struct.pack_into("<H", image, position, (value + LOAD) & 65535)

# Correct the documented aiming bug in memory, never in the supplied executable.
assert image[0x4848:0x484F] == bytes.fromhex("8b 16 16 9f 2b 54 16")
image[0x4848:0x484F] = bytes.fromhex("8b 1e 16 9f 2b 5c 16")


def word(cpu, offset, value=None, signed=False):
    if value is not None:
        cpu.mem_write(DS + offset, struct.pack("<H", value & 65535))
    return struct.unpack("<h" if signed else "<H", cpu.mem_read(DS + offset, 2))[0]


def call(cpu, address):
    cpu.reg_write(UC_X86_REG_SP, 0xFFFC)
    cpu.mem_write(0x9FFFC, b"\x00\xff")
    cpu.emu_start(LOAD * 16 + address, STOP, count=100000)
    assert cpu.reg_read(UC_X86_REG_IP) == 0xFF00, "Original routine did not return"


def pop_return(cpu):
    sp = cpu.reg_read(UC_X86_REG_SP)
    ip = struct.unpack("<H", cpu.mem_read(0x90000 + sp, 2))[0]
    cpu.reg_write(UC_X86_REG_SP, sp + 2)
    cpu.reg_write(UC_X86_REG_IP, ip)


def machine(event, camera, seed, slots=range(0xA000, 0xB800, 0x4C)):
    cpu = Uc(UC_ARCH_X86, UC_MODE_16)
    cpu.mem_map(0, 0x100000)
    cpu.mem_write(LOAD * 16, bytes(image))
    cpu.mem_write((LOAD + 0x4489) * 16, (ROOT / "S4/SPRITES.VGA").read_bytes())
    for register, value in [(UC_X86_REG_CS, LOAD), (UC_X86_REG_DS, LOAD + 0x1853),
                            (UC_X86_REG_ES, LOAD + 0x1853), (UC_X86_REG_SS, 0x9000)]:
        cpu.reg_write(register, value)
    for actor in slots:
        cpu.mem_write(DS + actor, bytes(0x4C))
        word(cpu, actor + 8, 0 if actor == slots[-1] else actor + 0x4C)
    for sentinel in [0x8FB2, 0x8FFE, 0x904A, 0x9096, 0x90E2]:
        word(cpu, sentinel, 0)
        word(cpu, sentinel + 8, sentinel)
        word(cpu, sentinel + 0xA, sentinel)
    word(cpu, 0x8E7C, slots[0])
    word(cpu, 0x9190, camera)
    word(cpu, 0x304A, seed)
    word(cpu, 0x8E80, 0)
    word(cpu, 0x9188, 0)
    word(cpu, 0x9152, 0)
    word(cpu, 0x9154, 0)
    word(cpu, 0x9164, 0)
    word(cpu, 0x918C, 1)
    if event is None:
        return cpu, None
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
    cpu.reg_write(UC_X86_REG_DI, 0xF000)
    if event[1] in (2, 4):
        call(cpu, 0xC79F)
        call(cpu, 0xC12C if event[1] == 2 else 0xBC00)
    else:
        call(cpu, 0xC368 if event[1] == 3 else 0xC1F3)
    return cpu, cpu.reg_read(UC_X86_REG_SI)


cases = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {GroundWallHunter, GroundWallRam} from './src/stage-four-ground.js';
import {loadTestCampaign} from './test/helpers.js';
const assets=loadTestCampaign().stages[3], sprite=f=>assets.lookup[f.bank].get(f.offset);
const bounds=b=>[b.x,b.y,b.x+b.w-1,b.y+b.h-1];
const frame=f=>(f.offset+8)|f.bank;
const cases=[];
for(const event of assets.background.filter(e=>e[1]===3||e[1]===5)){
  const hunter=event[1]===3;
  for(const mode of ['movement','expire']){
    const initial=event[5]-100, initialSeed=0x5845+event[4];
    let camera=initial, seed=initialSeed;
    const rng=()=>seed=(Math.imul(seed,0x6255)+0x3619)&65535;
    const definition=assets.groundLogic.get(event[1]);
    const actor=new (hunter?GroundWallHunter:GroundWallRam)(event,definition,camera,sprite);
    if(!hunter&&mode==='movement')actor.counter=252;
    const states=[];
    let score=0, flashTest=false;
    for(let i=0;i<240;i++){
      const delta=mode==='expire'?3:i%54<18?1:i%54<36?-1:0;
      camera-=delta;
      const ceiling=camera+16, player={x:160,y:i%50<25?35:160};
      const hull={x:154,y:player.y-21,w:12,h:17};
      const draw=[], effects=[], rewards=[];
      let box, hits=[], damage=0;
      if(hunter){
        actor.update(camera,ceiling,rng,player);
        if(mode==='movement'&&!flashTest&&actor.phase===2){
          damage=10;
          flashTest=true;
          actor.health-=damage;
          const game={camera,score,kills:0,randomWord:rng,pickups:[],explode:(x,y)=>effects.push([x,y]),
            addPickup(pickup){this.pickups.push(pickup);}};
          actor.destroy(game);
          score=game.score;
          rewards.push(...game.pickups.map(p=>[p.x,p.y,p.state,p.direction,p.value]));
        }
        box=actor.bounds().w?bounds(actor.bounds()):null;
        if(!actor.dead&&actor.motion.y<=220){
          draw.push([frame(actor.frame),actor.motion.x,actor.motion.y]);
          const region=actor.drawHatch(camera);
          if(region)draw.push([region.width,region.tiles.length/region.width,region.x,region.y,region.tiles]);
        }
      }else{
        actor.update(delta,rng);
        box=bounds(actor.bounds());
        if(!actor.dead){
          if(box[0]<hull.x+hull.w&&box[2]>=hull.x&&box[1]<hull.y+hull.h&&box[3]>=hull.y)
            hits.push(definition.contactDamage);
          const region=actor.extension;
          if(region)draw.push([region.width,2,region.x,region.y,region.tiles]);
          draw.push([frame(actor.frame),actor.tipX,actor.y+8]);
        }
      }
      states.push({camera,ceiling,delta,player,hull,draw,hits,damage,effects,rewards,score,seed,
        actor:actor.dead?null:hunter?[actor.motion.x,actor.worldY,actor.phase,actor.health,
          frame(actor.frame),actor.frameTicks,box]:
          [actor.y,actor.length,actor.speed,actor.counter,frame(actor.frame),actor.frameTicks,box]});
      if(actor.dead)break;
    }
    cases.push({event,initial,initialSeed,mode,states});
  }
}
console.log(JSON.stringify(cases));
""",
], cwd=ROOT))


def signed(value):
    return value - 65536 if value > 32767 else value


for case in cases:
    event = case["event"]
    hunter = event[1] == 3
    cpu, actor = machine(event, case["initial"], case["initialSeed"])
    if not hunter and case["mode"] == "movement":
        word(cpu, actor + 0x48, 252)
    draw, hits = [], []

    def hook(uc, address, _size, _data):
        address -= LOAD * 16
        if address == 0x941:
            width, height, x, y, tile_address = [
                uc.reg_read(reg) for reg in (UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_CX,
                                             UC_X86_REG_DX, UC_X86_REG_SI)]
            tiles = struct.unpack_from(f"<{width * height}H", image, tile_address)
            draw.append([width, height, signed(x) * 2, signed(y), list(tiles)])
        elif address == 0x875:
            frame, x, y = [uc.reg_read(reg) for reg in (UC_X86_REG_SI, UC_X86_REG_CX, UC_X86_REG_DX)]
            draw.append([frame, signed(x), signed(y)])
        elif address == 0x3C4F:
            hits.append(uc.reg_read(UC_X86_REG_AX))
        else:
            return
        pop_return(uc)

    cpu.hook_add(UC_HOOK_CODE, hook)
    for tick, state in enumerate(case["states"]):
        draw.clear()
        hits.clear()
        word(cpu, 0x9190, state["camera"])
        word(cpu, 0x91AA, state["ceiling"])
        word(cpu, 0x9198, state["delta"])
        word(cpu, 0x9F16, state["player"]["y"])
        h = state["hull"]
        for reg, coord in zip(range(0x9F28, 0x9F30, 2),
                              (h["x"], h["y"], h["x"] + h["w"] - 1, h["y"] + h["h"] - 1)):
            word(cpu, reg, coord)
        cpu.reg_write(UC_X86_REG_SI, actor)
        call(cpu, word(cpu, actor + 2))
        effects, rewards = [], []
        if state["damage"]:
            cpu.reg_write(UC_X86_REG_DI, actor)
            cpu.reg_write(UC_X86_REG_AX, state["damage"])
            call(cpu, word(cpu, actor + 6))
            reward = word(cpu, 0x90A0)
            effect = word(cpu, reward + 0xA)
            offsets = [0x12, 0x16]
            effects.append([word(cpu, effect + off, signed=True) for off in offsets])
            rewards.append([word(cpu, reward + off, signed=True) for off in offsets + [0x1A]]
                           + [word(cpu, reward + 0x1C), 100 if word(cpu, reward) == 0x18 else 50])
        actual = None
        if word(cpu, actor) != 4:
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 4))
            slots = [0x12, 0x16, 0x1A, 0x24, 0xC, 0xE] if hunter else [0x16, 0x1A, 0x1C, 0x48, 0xC, 0xE]
            box = [word(cpu, actor + off, signed=True) for off in range(0x28, 0x30, 2)]
            actual = [word(cpu, actor + off, signed=off in (0x12, 0x16, 0x1C)) for off in slots]
            actual.append(None if box[0] == 1000 else box)
        context = (event, case["mode"], tick)
        assert actual == state["actor"], (context, actual, state["actor"])
        assert draw == state["draw"], (context, draw, state["draw"])
        assert hits == state["hits"], (context, hits, state["hits"])
        assert effects == state["effects"] and rewards == state["rewards"], (
            context, effects, state["effects"], rewards, state["rewards"])
        assert word(cpu, 0x9152) == state["score"] and word(cpu, 0x304A) == state["seed"], context

print(f"PASS {len(cases)} stage-four encounter traces, {sum(len(c['states']) for c in cases):,} ticks: "
      "original animation, movement, bounds, RNG, draw calls, damage, expiry and hunter rewards")

boss_cases = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game} from './src/game.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), assets=campaign.stages[3];
const bounds=b=>b.w?[b.x,b.y,b.x+b.w-1,b.y+b.h-1]:null;
const frame=f=>(f.offset+8)|f.bank;
const event=assets.background.find(e=>e[1]===4);
const cases=[];
for(const profile of ['survive','left-first','right-first']){
  const initial=profile==='survive'?event[0]:12, initialSeed=0x5FAE;
  const g=new Game(campaign);
  g.start(4);
  g.camera=initial;
  g.seed=initialSeed;
  const boss=g.boss;
  boss.spawn(g);
  const states=[];
  const order=profile==='left-first'?[1,2]:[2,1];
  for(let tick=1;tick<=520;tick++){
    const delta=profile==='survive'?(tick<=144?1:tick%60<16?-1:tick%60<32?1:0):0;
    const ceiling=profile==='survive'&&tick<130?initial-tick:0;
    const player={x:24+tick*5%272,y:16+tick*9%160};
    Object.assign(g,{tick,player,control:{delta,ceiling},bullets:[],sounds:[],pickups:[],effects:[]});
    let bx=0x5a5a;
    const carry=boss.parts.map(actor=>(bx=boss.updatePart(actor,g,bx))&65535);
    const damage=profile==='survive'?null:({
      100:[order[0],14],125:[order[0],36],185:[order[1],50],220:[0,1],240:[0,99],
    }[tick]??null);
    if(damage){
      const [index,dmg]=damage, actor=boss.parts[index];
      actor.hit=3;
      actor.health-=dmg;
      if(actor.health<=0)boss.destroy(actor,g);
    }
    const parts=boss.dead?[]:boss.parts.map(a=>{
      const {x,y}=a.motion;
      if(!a.index)return [x,y,a.health,a.counter,boss.phase,bounds(a.box)];
      if(a.index<3)return [x,y,a.indestructible?-1:a.direction,a.counter,a.indestructible,bounds(a.box)];
      return [a.xFixed,a.yFixed,a.heading,a.turn,a.acceleration,a.length,frame(a.frame),bounds(a.box)];
    });
    const draw=boss.dead?[]:boss.parts.flatMap(a=>{
      if(a.index<3){
        const r=boss.tileRegion(a);
        return [[a.hit>0,r.width,r.tiles.length/r.width,r.x,r.y,r.tiles]];
      }
      return a.length?[[frame(a.frame),a.motion.x,a.motion.y]]:[];
    });
    const bullets=g.bullets.slice().reverse().map(b=>[b.x,b.y,b.direction,frame(b.frame),b.frames[0].duration]);
    const effects=g.effects.map(({x,y})=>[x,y]);
    states.push({tick,delta,ceiling,player,damage,seed:g.seed,parts,draw,bullets,effects,carry,dead:!!boss.dead,
      turrets:boss.turrets,reverseCeiling:g.control.ceiling,credits:g.pickups.map(p=>[p.x,p.y,p.value])});
    if(boss.dead)break;
    for (const slot of (g.actorLists.get(ActorList.transient)??[]).slice())
      g.run.actorPool.release(g.actorLists,ActorList.transient,slot);
  }
  cases.push({profile,event,initial,initialSeed,states});
}
console.log(JSON.stringify(cases));
""",
], cwd=ROOT))


def actors(cpu, sentinel):
    actor = word(cpu, sentinel + 0xA)
    while actor != sentinel:
        yield actor
        actor = word(cpu, actor + 0xA)


camera_cases = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {Game} from './src/game.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), assets=campaign.stages[3];
const path=[10,100,60,2,36,0,0,1000,0];
const xy=a=>[a.motion.x,a.motion.y];
const bounds=b=>b.w?[b.x,b.y,b.x+b.w-1,b.y+b.h-1]:null;
const cases=[2,4].map(type=>{
 const game=new Game(campaign);game.start(4);
 const event=assets.background.find(e=>e[1]===type), camera=event[0], ceiling=camera+16;
 const events=[[camera,3,1,1,0,0,3]];
 const background=[[camera,1,0,0,104,camera+80,0],[camera,3,0,0,56,camera+68,0],
  [camera,5,0,0,248,camera+152,1],event];
 game.assets={...assets,events,background,paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]}};
 game.camera=game.control.camera=camera+1;game.control.ceiling=ceiling;
 game.foregroundEventLimit=game.backgroundEventLimit=camera+1;
 if(type===4)game.endCamera=0;
 Object.assign(game.player,{x:300,y:24});
 Object.assign(game.checkpoint,{camera:4608,x:160,worldY:180,credits:700});
 game.credits=900;
 game.shipTouchesTerrain=()=>false;
 const states=Array.from({length:2},()=>{
  game.update();
  const [gun,hunter]=game.ground, [ram]=game.scenery, [enemy]=game.enemies;
  const arena=type===2?game.miniboss:game.boss, paint=game.actorPaint;
  const cells=[0,1,20,21].map(i=>gun.cell+i);
  return {camera:game.camera,delta:game.control.delta,ceiling:game.control.ceiling,seed:game.seed,
   limits:[game.foregroundEventLimit,game.backgroundEventLimit],
   painted:[(paint?.enemies??game.enemies).length,(paint?.ground??game.ground).filter(a=>a.spriteActor).length,
    (paint?.scenery??game.scenery).length,(type===2?paint?.minibossParts:paint?.bossParts)?.length??arena.parts.length],
   paintTiles:cells.map(i=>paint?(paint.mapPatches.get(i)??assets.map[i]):game.map[i]),
   tiles:cells.map(i=>game.map[i]),count:arena.parts.length,head:xy(arena.parts[0]),
   enemy:enemy.age?xy(enemy):null,hunter:[hunter.motion.x,hunter.worldY,hunter.phase],
   ram:[ram.y,ram.counter,ram.length],gun:[gun.fireCounter,bounds(gun.bounds(game.camera))],
   arenaState:type===2?arena.remaining:arena.turrets,
   checkpoint:['camera','x','worldY','credits'].map(key=>game.checkpoint[key])};
 });
 return {type,camera,events,background,states};
});
console.log(JSON.stringify({path,map:Array.from(assets.map),cases}));
""",
], cwd=ROOT))

for case in camera_cases["cases"]:
    cpu, _ = machine(None, case["camera"] + 1, 0x5845)
    cpu.mem_write(DS, struct.pack("<6000H", *camera_cases["map"]))
    cpu.mem_write(DS + 0xF000, struct.pack("<9h", *camera_cases["path"]))
    for field, base in (("events", 0xD274), ("background", 0xDA9E)):
        cpu.mem_write(DS + base, b"".join(struct.pack("<7H", *event) for event in case[field]) + b"\xff\xff")
    for offset, value in [(0x9192, case["camera"] + 1), (0x9194, case["camera"] + 1),
                          (0x91AC, 1), (0x991A, 1), (0x991C, 4), (0xDE30, 0xF000),
                          (0x9F12, 300), (0x9F16, 24), (0x91A6, 4608), (0x91A2, 160),
                          (0x91A4, 180), (0x9166, 700), (0x9168, 0), (0x915A, 900)]:
        word(cpu, offset, value)
    call(cpu, 0xC79F)
    kind = 0x54 if case["type"] == 2 else 0x50
    paint_kinds = (0x100, 0xE0, 0x110, kind)
    painted = []

    def trace_draw(uc, _address, _size, _data):
        actor = uc.reg_read(UC_X86_REG_SI)
        if word(uc, actor + 4) != 0x761:
            painted.append(word(uc, actor))
        uc.reg_write(UC_X86_REG_IP, 0x3716)

    cpu.hook_add(UC_HOOK_CODE, trace_draw, begin=LOAD * 16 + 0x3713, end=LOAD * 16 + 0x3713)
    gun_x, gun_y = case["background"][0][4:6]
    cell = ((gun_y - 8) // 16 * 20 + (gun_x - 8) // 16) * 2
    tiles = lambda: [word(cpu, cell + offset) for offset in (0, 2, 40, 42)]
    for tick, state in enumerate(case["states"], 1):
        painted.clear()
        word(cpu, 0x9190, state["camera"])
        word(cpu, 0x9198, state["delta"])
        word(cpu, 0x919A, 1)
        word(cpu, 0x91AA, state["ceiling"])
        cpu.emu_start(LOAD * 16 + 0x3D26, LOAD * 16 + 0x3D47)
        call(cpu, 0xB555)
        call(cpu, 0x3682)
        paint_tiles = tiles()
        call(cpu, 0x36D3)
        call(cpu, 0x3615)
        main = list(actors(cpu, 0x904A))
        parts = [a for a in main if word(cpu, a) == kind]
        enemy, hunter, gun = (next(a for a in main if word(cpu, a) == t) for t in (0x100, 0xE0, 0xD4))
        ram, = actors(cpu, 0x90E2)
        xy = lambda a: [word(cpu, a + offset, signed=True) for offset in (0x12, 0x16)]
        actual = {
            "camera": word(cpu, 0x9190), "delta": word(cpu, 0x9198), "ceiling": word(cpu, 0x91AA),
            "limits": [word(cpu, offset) for offset in (0x9192, 0x9194)],
            "seed": word(cpu, 0x304A), "painted": [painted.count(t) for t in paint_kinds],
            "paintTiles": paint_tiles, "tiles": tiles(), "count": len(parts), "head": xy(parts[0]),
            "enemy": xy(enemy) if tick > 1 else None, "hunter": xy(hunter) + [word(cpu, hunter + 0x1A)],
            "ram": [word(cpu, ram + offset, signed=True) for offset in (0x16, 0x48, 0x1A)],
            "gun": [cpu.mem_read(DS + gun + 0x48, 1)[0], None if word(cpu, gun + 0x28) == 1000 else
                    [word(cpu, gun + off, signed=True) for off in (0x28, 0x2A, 0x2C, 0x2E)]],
            "arenaState": word(cpu, 0x9210 if kind == 0x54 else 0x9212),
            "checkpoint": [word(cpu, offset) for offset in (0x91A6, 0x91A2, 0x91A4, 0x9166)],
        }
        for key, value in actual.items():
            assert value == state[key], ("camera events", case["type"], tick, key, value, state[key])
print("PASS stage-four camera events: mixed wall and foreground births, map paint, first callbacks and both arena entries")

corridor_cases = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {Game} from './src/game.js';
import {ActorList} from './src/actor-pool.js';
import {unpack} from './src/formats.js';
import {StageFourCorridorPod} from './src/stage-four-ground.js';
import {loadTestCampaign,read} from './test/helpers.js';
const campaign=loadTestCampaign();
const frame=f=>(f.offset+8)|f.bank;
const bounds=b=>b.w?[b.x,b.y,b.x+b.w-1,b.y+b.h-1]:null;
const cases=[
 {camera:3681,seed:0x5845,length:118,phase:0},
 {camera:3000,seed:0x5845,length:175,phase:960,hold:true},
 {camera:3000,seed:0x5844,length:360,phase:960,hold:true},
 {camera:3000,seed:0x5844,length:360,phase:960,hold:true,capacity:12},
 {camera:2785,seed:0x5845,length:360,phase:15},
 {camera:2785,seed:0x5845,length:360,phase:47},
 {camera:2785,seed:0x5845,length:65,phase:15,kill:true},
 {camera:3000,seed:0x5845,length:235,phase:15,hold:true,walls:true},
 {camera:3000,seed:0x5845,length:235,phase:15,hold:true,walls:true,capacity:12},
 {camera:3900,seed:0x5845,length:30,phase:15,hold:true,walls:true,capacity:2},
 {camera:3000,seed:0x5845,length:260,phase:15,hold:true,walls:true,waves:true},
 {camera:3000,seed:0x5845,length:260,phase:15,hold:true,walls:true,waves:true,capacity:28},
].map(({camera,seed,length,phase,hold,kill,capacity,walls,waves})=>{
 const game=new Game(campaign);game.start(4);game.seed=seed;
 const {actorPool:pool}=game.run;
 if(capacity)pool.free.splice(0,pool.free.length-capacity);
 const first=pool.free.at(-1), count=pool.free.length;
 const linked=()=>[ActorList.main,ActorList.transient,ActorList.scenery].map(list=>(game.actorLists.get(list)??[])
  .map(({address,type,actor})=>[address,actor.dead?4:type,...(pool.subpixels.get(address)??[0,0]),
    pool.fireCounterHighBytes.get(address)??0]));
 game.camera=game.control.camera=camera;game.control.ceiling=camera+16;
 game.endCamera=hold?camera:camera-length;
 game.tick=game.run.formationClock.tick=phase;
 const background=walls?[[camera,1,0,0,104,camera+80,0],[camera,1,0,0,248,camera+64,1],
  [camera,3,0,0,56,camera+68,0],[camera,5,0,0,248,camera+120,1]]:[];
 if(capacity===2)background.splice(1,2);
 const events=waves?game.assets.events.filter(e=>[4576,4032,3744,1600].includes(e[0]))
  .map(e=>[camera,...e.slice(1)]):[];
 game.assets={...game.assets,events,background};
 const cells=background.filter((e)=>e[1]===1).flatMap((e)=>{
  const cell=((e[5]-8)>>4)*20+((e[4]-8)>>4);
  return [cell,cell+1,cell+20,cell+21];
 });
 Object.assign(game.player,{x:160,y:176});
 game.shipTouchesTerrain=()=>false;
 const states=Array.from({length},(_,index)=>{
  const previous=game.camera, ceiling=game.control.ceiling;
  game.divePhase=4;
  game.update();
  const damage=(capacity?{}:waves?{4:0x64,27:0xe8}:walls?{35:0xe0,184:0xd4}:{})[index]??0;
  const records=(list)=>(game.actorLists.get(list)??[]).filter(({actor})=>!actor.dead);
  if(damage){
   game.hitWithWeapon(records(ActorList.main).find(({type,actor})=>
    type===damage&&(damage!==0xe8||actor.foregroundRoot)).actor,{damage:127});
  }
  return {camera:game.camera,delta:game.control.delta,ceiling:game.control.ceiling,seed:game.seed,
   enteringCeiling:Math.min(ceiling,previous-game.control.delta+16),
   linked:linked(),freeHead:pool.free.at(-1)??0,
   foreground:records(ActorList.main).filter(({actor})=>actor.parts).map(({type,actor:a})=>
    [type,a.motion.x,a.motion.y,frame(game.enemyFrame(a)),a.motion.remaining,a.fireCounter,
      (a.foregroundRoot??a).actorAddress,a.formationId??0,bounds(game.targetBounds(a))]),
   damage,tiles:cells.map(i=>game.map[i]),score:game.score,
   walls:records(ActorList.main).filter(({type})=>[0xd0,0xd4,0xe0,0xe4].includes(type)).map(({type,actor:a})=>
    [type,a.motion.x,a.worldY,a.phase,a.health,a.fireCounter??0,a.frame?frame(a.frame):0,
     a.frameTicks??0,bounds(a.bounds(game.camera))]),
   rams:records(ActorList.scenery).map(({type,actor:a,address})=>
    [type,a.x,a.y,a.length,pool.headings.get(address)??0,a.counter,frame(a.frame),a.frameTicks]),
   drops:records(ActorList.transient).filter(({actor})=>actor.kind==="credit").map(({type,actor:a})=>
    [type,a.x,a.y,a.state,a.direction&7,frame(game.pickupFrame(a))]),
   rewards:records(ActorList.transient).filter(({actor})=>actor.kind==="reward").map(({type,actor:a})=>
    [type,a.x,a.y,a.state,a.direction&7,frame(game.pickupFrame(a)),a.reward]),
   blasts:records(ActorList.transient).filter(({type})=>type===0x0c)
    .map(({actor:a})=>[a.x,a.y,frame(a.frame??a.frames[a.age]),a.frameTicks??1]),
   clock:game.run.formationClock.next,groups:[...game.formationCredits].sort(([a],[b])=>a-b),
   main:game.ground.filter(a=>a.definition.type>=0xc8).map(a=>[a.definition.type,a.motion.x,a.motion.y,frame(a.frame),a.frameTicks,
    bounds(a.box),a.phase??a.motion.remaining,a.fireCounter??0,a.shotCounter??0,a.formationId??0]),
   pods:game.bullets.filter(b=>b instanceof StageFourCorridorPod&&!b.exploding).map(b=>
    [b.definition.type,b.x,b.y,frame(b.frame),b.frameTicks]),
   shots:game.bullets.filter(b=>!(b instanceof StageFourCorridorPod)).map(b=>
    [b.x,b.y,b.direction,frame(b.frame)]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]),
  };
 });
 let death;
 if(kill){
  game.hitWithWeapon(game.ground.find(a=>a.definition.type===0xf8),{damage:2});
  const [globe]=game.pickups, [blast]=game.effects;
  death=[game.seed,game.score,[globe.x,globe.y,globe.value,globe.direction],[blast.x,blast.y],linked()];
 }
 return {camera,seed,phase,first,count,states,death,events,background,cells};
});
const shared=Buffer.from(unpack(read('X2SPR.DAT')));
const weapons=Buffer.from(unpack(read('X2WEAPS.DAT')));
console.log(JSON.stringify({cases,map:Array.from(campaign.stages[3].map),shared:Buffer.concat([shared,weapons]).toString('base64')}));
""",
], cwd=ROOT))

corridor_types = (0xC8, 0xCC, 0xD8, 0xDC, 0xF8)
foreground_types = (0x64, 0xE8, 0xEC, 0xFC, 0x100, 0x104, 0x108)
for case in corridor_cases["cases"]:
    if case["count"] in (12, 28):
        assert any(not state["freeHead"] for state in case["states"]), "Corridor did not fill the reduced pool"
    if case["count"] == 2:
        _, _, [(ram, *_)] = case["states"][0]["linked"]
        assert any(any(row[:2] == [ram, 0x14] for row in state["linked"][1])
                   for state in case["states"]), "No shot reclaimed the scenery ram's slot"
    first = case["first"]
    cpu, _ = machine(None, case["camera"], case["seed"], range(first, first + 0x4C * case["count"], 0x4C))
    cpu.mem_write((LOAD + 0x349B) * 16, base64.b64decode(corridor_cases["shared"]))
    cpu.mem_write(DS, struct.pack("<6000H", *corridor_cases["map"]))
    for field, base in (("events", 0xD274), ("background", 0xDA9E)):
        events = b"".join(struct.pack("<7H", *event) for event in case[field])
        cpu.mem_write(DS + base, events + b"\xff\xff")
    word(cpu, 0x9192, 0x7FEE)
    word(cpu, 0x9194, 0x7FEE)
    paths = (ROOT / "S4/PATHS.BIN").read_bytes()
    cpu.mem_write(DS + 0xDE30, paths)
    for i, offset in enumerate(struct.unpack_from("<115H", paths)):
        word(cpu, 0xDE30 + 2 * i, 0xDE30 + 230 + offset)
    for offset, value in [(0x919C, case["phase"]), (0x91AC, 1), (0x991A, 1), (0x991C, 4),
                          (0x9F12, 160), (0x9F16, 176), (0x9F28, 1000), (0x9F2C, 1000)]:
        word(cpu, offset, value)
    call(cpu, 0xC79F)

    def skip_paint(uc, _address, _size, _data):
        uc.reg_write(UC_X86_REG_IP, 0x3716)

    def linked():
        return [[[actor, word(cpu, actor), word(cpu, actor + 0x14), word(cpu, actor + 0x18),
                  cpu.mem_read(DS + actor + 0x49, 1)[0]] for actor in actors(cpu, sentinel)]
                for sentinel in (0x904A, 0x9096, 0x90E2)]

    def bounds(actor):
        return None if word(cpu, actor + 0x28) == 1000 else [
            word(cpu, actor + off, signed=True) for off in (0x28, 0x2A, 0x2C, 0x2E)]

    cpu.hook_add(UC_HOOK_CODE, skip_paint, begin=LOAD * 16 + 0x3713, end=LOAD * 16 + 0x3713)
    for tick, state in enumerate(case["states"], 1):
        word(cpu, 0x9190, state["camera"])
        word(cpu, 0x9198, state["delta"])
        word(cpu, 0x91AA, state["enteringCeiling"])
        cpu.emu_start(LOAD * 16 + 0x3D26, LOAD * 16 + 0x3D47)
        call(cpu, 0xB555)
        call(cpu, 0x3682)
        call(cpu, 0x36D3)
        call(cpu, 0x3615)
        if state["damage"]:
            actor = next(a for a in actors(cpu, 0x904A) if word(cpu, a) == state["damage"]
                         and (state["damage"] != 0xE8 or word(cpu, a + 0x44) != a))
            cpu.reg_write(UC_X86_REG_DI, actor)
            cpu.reg_write(UC_X86_REG_AX, 127)
            call(cpu, word(cpu, actor + 6))
        main, pods, shots, walls, drops, blasts, rams, foreground, rewards = [], [], [], [], [], [], [], [], []
        for actor in actors(cpu, 0x904A):
            kind = word(cpu, actor)
            if kind in foreground_types:
                foreground.append([kind] + [word(cpu, actor + off, signed=off != 0xC)
                                            for off in (0x12, 0x16, 0xC, 0x1A)] +
                                  [cpu.mem_read(DS + actor + 0x48, 1)[0], word(cpu, actor + 0x44),
                                   word(cpu, actor + 0x36), bounds(actor)])
            if kind in (0xD0, 0xD4, 0xE0, 0xE4):
                walls.append([kind, word(cpu, actor + 0x12, signed=True), word(cpu, actor + 0x16),
                              word(cpu, actor + 0x1A), word(cpu, actor + 0x24),
                              cpu.mem_read(DS + actor + 0x48, 1)[0] if kind in (0xD0, 0xD4) else 0,
                              word(cpu, actor + 0xC) if kind in (0xE0, 0xE4) else 0,
                              word(cpu, actor + 0xE) if kind in (0xE0, 0xE4) else 0, bounds(actor)])
            if kind not in corridor_types:
                continue
            main.append([kind] + [word(cpu, actor + off, signed=off in (0x12, 0x16))
                                 for off in (0x12, 0x16, 0xC, 0xE)] +
                        [bounds(actor), word(cpu, actor + 0x1A, signed=True), cpu.mem_read(DS + actor + 0x48, 1)[0],
                         cpu.mem_read(DS + actor + 0x49, 1)[0] if kind in (0xC8, 0xCC) else 0,
                         word(cpu, actor + 0x36)])
        for actor in actors(cpu, 0x9096):
            kind = word(cpu, actor)
            xy = [word(cpu, actor + off, signed=True) for off in (0x12, 0x16)]
            if kind in (0xF0, 0xF4):
                pods.append([kind, *xy, word(cpu, actor + 0xC), word(cpu, actor + 0xE)])
            elif kind == 0xC:
                blasts.append([*xy, word(cpu, actor + 0xC), word(cpu, actor + 0xE)])
            elif kind == 0x14:
                shots.append([*xy, word(cpu, actor + 0x1C), word(cpu, actor + 0xC)])
            elif kind in (0x18, 0x60):
                drops.append([kind, *xy, word(cpu, actor + 0x1A, signed=True),
                              word(cpu, actor + 0x1C) & 7, word(cpu, actor + 0xC)])
            elif kind == 0x5C:
                rewards.append([kind, *xy, word(cpu, actor + 0x1A, signed=True),
                                word(cpu, actor + 0x1C) & 7, word(cpu, actor + 0xC), word(cpu, actor + 0x22)])
        for actor in actors(cpu, 0x90E2):
            if word(cpu, actor) in (0x10C, 0x110):
                rams.append([word(cpu, actor)] + [word(cpu, actor + off, signed=off in (0x12, 0x16))
                             for off in (0x12, 0x16, 0x1A, 0x1C, 0x48, 0xC, 0xE)])
        actual = {
            "ceiling": word(cpu, 0x91AA), "seed": word(cpu, 0x304A), "clock": word(cpu, 0x91AC),
            "groups": sorted([word(cpu, i), word(cpu, i + 2)]
                             for i in range(0x8E8C, 0x8EAC, 4) if word(cpu, i)),
            "main": main, "pods": pods, "shots": sorted(shots), "linked": linked(), "freeHead": word(cpu, 0x8E7C),
            "walls": walls, "rams": rams, "drops": drops, "blasts": blasts, "foreground": foreground, "rewards": rewards,
            "tiles": [word(cpu, cell * 2) for cell in case["cells"]], "score": word(cpu, 0x9152),
        }
        mismatches = {key: (value, state[key]) for key, value in actual.items() if value != state[key]}
        assert not mismatches, ("corridor", case["camera"], case["seed"], case["count"], tick, mismatches)
    if "death" in case:
        actor = next(a for a in actors(cpu, 0x904A) if word(cpu, a) == 0xF8)
        cpu.reg_write(UC_X86_REG_DI, actor)
        cpu.reg_write(UC_X86_REG_AX, 2)
        call(cpu, word(cpu, actor + 6))
        transients = list(actors(cpu, 0x9096))
        globe = next(a for a in transients if word(cpu, a) == 0x60)
        blast = next(a for a in transients if word(cpu, a) == 0xC)
        xy = lambda a: [word(cpu, a + offset, signed=True) for offset in (0x12, 0x16)]
        actual = [word(cpu, 0x304A), word(cpu, 0x9152),
                  [*xy(globe), 50, word(cpu, globe + 0x1C)], xy(blast), linked()]
        assert actual == case["death"], ("corridor drone death", actual, case["death"])
print(f"PASS stage-four corridor, wall and foreground pool: {sum(len(c['states']) for c in corridor_cases['cases']):,} ticks, "
      "mixed callbacks, composite attachments, reward/blast allocations, wall tiles, and saturation at 2/12/28 slots")

orphans = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game} from './src/game.js';
import {frameAt} from './src/motion.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), event=[3900,1,1,1,0,0,3], path=[10,100,60,4,90,0];
const frame=f=>(f.offset+8)|f.bank;
const cases=['round','marked','free','blast','reward','credit','cannon'].map(mode=>{
 const game=new Game(campaign);game.start(4);game.campaignRound=2;
 game.camera=game.control.camera=game.endCamera=3900;game.control.ceiling=3916;
 game.assets={...game.assets,events:[],background:[],paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]}};
 game.shipTouchesTerrain=()=>false;
 const {actorPool:pool}=game.run, first=pool.free.at(-1), count=pool.free.length;
 game.spawn(event,[256,258]);
 const [root]=game.enemies, [attachment]=root.children;
 const free=pool.free.splice(0);
 const round={x:150,y:80,dx:0,dy:0,direction:2,fixed:true,frame:game.assets.logic.foregroundShot.frame};
 game.addPooledHostileRound(round,0);
 let replacement=round;
 if(mode==='blast')replacement=game.explode(150,80,true,true).actor;
 if(mode==='cannon'){
  const frames=game.assets.logic.cannon.shot;
  replacement={x:150,y:90,dy:-10,age:0,damage:2,cannon:true,frames,frame:frames[0]};
  game.addPlayerRound(replacement,0x30);
 }
 if(mode==='reward'||mode==='credit'){
  replacement=mode==='reward'?{kind:'reward',reward:16}:{kind:'credit',value:50,direction:game.randomWord()};
  Object.assign(replacement,{x:150,y:80,age:0,state:7});
  game.addPickup(replacement,true);
 }
 pool.free.push(...free);
 game.update();
 if(mode==='marked'||mode==='free'){
  round.dead=true;
  if(mode==='free')pool.release(game.actorLists,ActorList.transient,pool.recordsByAddress.get(round.actorAddress));
 }
 const linked=[ActorList.main,ActorList.transient];
 const hit=()=>{
  const {x,y,w,h}=game.targetBounds(attachment);
  const shot={};
  game.hitPlayerRound(shot,{x:x+(w>>1),y:y+(h>>1),w:1,h:1});
  if(!shot.dead)throw new Error('Orphan did not consume the point round');
 };
 hit();
 const flash=[root.health,attachment.motion.x,attachment.motion.y,
  replacement.flashTick===game.tick,attachment.flashTick===game.tick,
  game.actorLists.get(ActorList.transient).some(({actor})=>actor===replacement&&(!actor.dead||actor.markedFlashTick===game.tick))];
 root.health=1;
 hit();
 const lists=linked.map(list=>(game.actorLists.get(list)??[]).map(({address,type,actor:a})=>{
  if(a.dead)return [address,4];
  const sprite=a.kind==='reward'||a.kind==='credit'?game.pickupFrame(a):a.frame??frameAt(a.frames,a.age);
  return [address,type,a.x,a.y,frame(sprite)];
 }));
 return {mode,first,count,flash,root:root.actorAddress,attachment:attachment.actorAddress,
  death:[game.seed,game.score,lists]};
});
console.log(JSON.stringify({event,path,cases}));
""",
], cwd=ROOT))

for case in orphans["cases"]:
    mode, first = case["mode"], case["first"]
    cpu, _ = machine(None, 3900, 0x5845, range(first, first + 0x4C * case["count"], 0x4C))
    cpu.mem_write((LOAD + 0x349B) * 16, base64.b64decode(corridor_cases["shared"]))
    for offset, value in [(0x991A, 2), (0x991C, 4), (0x8EB0, 256), (0x8EB2, 258), (0x91AC, 1),
                          (0x9F28, 1000), (0x9F2C, 1000), (0x9198, 0)]:
        word(cpu, offset, value)
    call(cpu, 0xC79F)
    word(cpu, 0xDE30, 0xF100)
    cpu.mem_write(DS + 0xF100, struct.pack("<6h", *orphans["path"]))
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *orphans["event"]))
    cpu.reg_write(UC_X86_REG_SI, 0xF000)
    cpu.reg_write(UC_X86_REG_BX, 1)
    call(cpu, 0xC771)
    root, attachment = actors(cpu, 0x904A)
    assert [root, attachment] == [case["root"], case["attachment"]]

    free = word(cpu, 0x8E7C)
    word(cpu, 0x8E7C, 0)
    for register, value in [(UC_X86_REG_AX, 150), (UC_X86_REG_BX, 80), (UC_X86_REG_CX, 2),
                            (UC_X86_REG_DX, 0), (UC_X86_REG_BP, word(cpu, 0x8E72))]:
        cpu.reg_write(register, value)
    call(cpu, 0x1ED3)
    if mode == "blast":
        for register, value in [(UC_X86_REG_AX, 150), (UC_X86_REG_BX, 80), (UC_X86_REG_DX, 0x853),
                                (UC_X86_REG_BP, 0x124C)]:
            cpu.reg_write(register, value)
        call(cpu, 0x3326)
    elif mode == "cannon":
        word(cpu, 0xF212, 150)
        word(cpu, 0xF216, 101)
        cpu.reg_write(UC_X86_REG_SI, 0xF200)
        call(cpu, 0x24C4)
    elif mode in ("reward", "credit"):
        for offset, value in [(0xF212, 150), (0xF216, 80), (0xF222, 16), (0xF227, 0)]:
            word(cpu, offset, value)
        cpu.reg_write(UC_X86_REG_DI, 0xF200)
        call(cpu, 0x1E61 if mode == "reward" else 0x3AEC)
    assert word(cpu, 0x90A0) == root
    word(cpu, 0x8E7C, free)
    for sentinel in (0x904A, 0x9096):
        cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
        call(cpu, 0x36FC)
    if mode in ("marked", "free"):
        cpu.reg_write(UC_X86_REG_SI, root)
        call(cpu, 0x7C0)
        if mode == "free":
            call(cpu, 0x7A0)

    def hit_attachment():
        cpu.reg_write(UC_X86_REG_DI, attachment)
        cpu.reg_write(UC_X86_REG_AX, 1)
        call(cpu, word(cpu, attachment + 6))

    hit_attachment()
    flash = [word(cpu, root + 0x24), word(cpu, attachment + 0x12, signed=True),
             word(cpu, attachment + 0x16, signed=True), word(cpu, root + 4) == 0x8B9,
             word(cpu, attachment + 4) == 0x8B9,
             root in list(actors(cpu, 0x9096)) and word(cpu, root + 4) == 0x8B9]
    assert flash == case["flash"], ("stage-four orphan hit", mode, flash, case["flash"])
    word(cpu, root + 0x24, 1)
    hit_attachment()
    lists = []
    for sentinel in (0x904A, 0x9096):
        records = []
        for actor in actors(cpu, sentinel):
            kind = word(cpu, actor)
            state = [] if kind == 4 else [word(cpu, actor + off, signed=off != 0xC) for off in (0x12, 0x16, 0xC)]
            records.append([actor, kind, *state])
        lists.append(records)
    actual = [word(cpu, 0x304A), word(cpu, 0x9152), lists]
    assert actual == case["death"], ("stage-four orphan death", mode, actual, case["death"])
print("PASS stage-four recycled formation roots: live/marked/freed hostile rounds, blasts, rewards, credits and Cannon")


contacts = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game} from './src/game.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), camera=3900, y=174;
const modes=['steer-away','steer-in','small-first','large-first','marked','fatal','protected','invincible','counted',
 'dive','shades','shades-marked','gun','gun-unready','gun-cache','gun-recycled','ram-edge','ram-fatal','ram-dive'];
console.log(JSON.stringify(modes.map(mode=>{
 const game=new Game(campaign);game.start(4);
 game.camera=game.control.camera=game.endCamera=camera;game.control.ceiling=camera+16;
 const {actorPool:pool}=game.run, first=pool.free.at(-1), count=pool.free.length;
 const gun=mode.startsWith('gun'), ram=mode.startsWith('ram');
 const x=mode.startsWith('shades')?220:160;
 const path=[10,mode==='steer-in'?183:mode==='steer-away'?181:mode==='gun-recycled'?50:160,y,4,90,0];
 const types=mode==='gun-recycled'?[1]:gun||ram?[]:mode.startsWith('steer')?[3]:
  mode==='small-first'?[1,3]:[3,1];
 const events=types.map(type=>[camera,type,1,1,0,0,3]);
 game.assets={...game.assets,events:[],background:[],paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]}};
 game.shipTouchesTerrain=()=>false;
 for(const event of events)game.spawn(event,[256,258]);
 if(mode==='gun-recycled'){
  const slots=game.actorLists.get(ActorList.main);
  while(slots.length){slots[0].actor.dead=true;pool.release(game.actorLists,ActorList.main,slots[0]);}
 }
 if(mode.endsWith('marked'))game.actorLists.get(ActorList.main)[0].actor.dead=true;
 const wall=gun?[camera,1,0,0,168,camera+(mode==='gun-cache'?142:164),0]:ram?[camera,5,0,0,142,camera+164,0]:null;
 const warm=gun&&mode!=='gun-unready';
 if(wall){
  game.assets.background=[wall];
  game.dispatchCameraEvents();
  if(warm){
   game.camera+=Number(mode==='gun-cache');
   game.updateGroundActor(game.ground[0]);
   game.camera=camera;
  }
 }
 const health=mode==='fatal'?16:mode==='ram-fatal'?6:39;
 const invincible=mode==='invincible'?9:0, shades=Number(mode.startsWith('shades'));
 const protection=Number(mode==='protected'), counted=Number(mode==='counted'), dive=mode.endsWith('dive')?4:0;
 Object.assign(game.player,{x,y,health,shades,protection});
 Object.assign(game,{invincible,countedCredits:counted,divePhase:dive});
 const input=mode==='steer-away'?4:mode==='steer-in'||ram?8:0;
 game.update({left:input===4,right:input===8});
 const lists=[ActorList.main,ActorList.transient,ActorList.scenery].map(list=>
  (game.actorLists.get(list)??[]).map(({address,actor,type})=>[address,actor.dead?4:type]));
 return {mode,camera,path,events,wall,warm,first,count,input,x,y,health,invincible,shades,protection,counted,dive,
  expected:{lists,free:pool.free.at(-1),x:game.player.x,health:game.player.health,score:game.score,
   flash:game.shipHitFlash,dying:game.status==='dying'}};
})));
""",
], cwd=ROOT))

for case in contacts:
    mode, first, camera = case["mode"], case["first"], case["camera"]
    cpu, _ = machine(None, camera, 0x5845, range(first, first + 0x4C * case["count"], 0x4C))
    cpu.mem_write((LOAD + 0x349B) * 16, base64.b64decode(corridor_cases["shared"]))
    cpu.mem_write(DS, bytes(12000))
    for offset, value in [(0x991A, 1), (0x991C, 4), (0x9198, 0), (0x919E, 0), (0x91AA, camera + 16),
                          (0x8E7E, 0), (0x8EB0, 256), (0x8EB2, 258), (0x91AC, 1),
                          (0x9F0C, word(cpu, 0x3058)), (0x9F12, case["x"]), (0x9F16, case["y"]),
                          (0x9186, case["health"]), (0x9188, case["invincible"]), (0x9150, case["shades"]),
                          (0x9223, case["protection"]), (0x9164, case["counted"]), (0x8E80, case["dive"])]:
        word(cpu, offset, value)
    call(cpu, 0xC79F)
    word(cpu, 0xDE30, 0xF100)
    cpu.mem_write(DS + 0xF100, struct.pack("<6h", *case["path"]))
    for event in case["events"]:
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        cpu.reg_write(UC_X86_REG_BX, event[1])
        call(cpu, 0xC771)
    if mode == "gun-recycled":
        for actor in list(actors(cpu, 0x904A)):
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, 0x7A0)
    if mode.endswith("marked"):
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
        call(cpu, 0x7C0)
    if wall := case["wall"]:
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *wall))
        cpu.reg_write(UC_X86_REG_DI, 0xF000)
        call(cpu, 0xC5C3 if wall[1] == 1 else 0xC1F3)
        if case["warm"]:
            word(cpu, 0x9190, camera + (mode == "gun-cache"))
            call(cpu, 0xC61A)
            word(cpu, 0x9190, camera)
    cpu.mem_write(DS + 0x8F59, bytes([case["input"]]))
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x4311)
    sentinels = (0x904A, 0x9096, 0x90E2)
    for sentinel in sentinels:
        cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
        call(cpu, 0x36FC)
    actual = {"lists": [[[a, word(cpu, a)] for a in actors(cpu, s)] for s in sentinels],
              "free": word(cpu, 0x8E7C), "x": word(cpu, 0x9F12), "health": word(cpu, 0x9186),
              "score": word(cpu, 0x9152), "flash": word(cpu, 0x9F04) == 0x8B9,
              "dying": cpu.mem_read(DS + 0x9224, 1) != b"\0"}
    assert actual == case["expected"], ("stage-four ship contact", mode, actual, case["expected"])
print(f"PASS stage-four ship contact: {len(contacts)} cases, pre-steering edges, linked order, Protection/Shades, "
      "retained gun boxes and flags, and wall ram flash")


rounds = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game} from './src/game.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), camera=3900, wall=[camera,1,0,0,104,3980,0],
 event=[camera,3,1,1,0,0,3], path=[10,160,80,4,90,0];
const cases=['wall','wall-full','straight-kill','cannon'].map(mode=>{
 const game=new Game(campaign);game.start(4);
 game.camera=game.control.camera=game.endCamera=camera;game.control.ceiling=camera+16;
 const {actorPool:pool}=game.run, first=pool.free.at(-1), count=mode==='wall'?3:2;
 pool.free.splice(0,pool.free.length-count);
 const gun=mode.startsWith('wall'), cannon=mode==='cannon';
 game.assets={...game.assets,events:[],background:gun?[wall]:[],
  paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]}};
 game.shipTouchesTerrain=()=>false;
 if(gun){
  game.dispatchCameraEvents();
  game.ground[0].phase=3;
 }else game.spawn(event,[256,258]);
 const enemy=game.enemies[0];
 if(cannon){
  const frames=game.assets.logic.cannon.shot;
  game.addPlayerRound({x:160,y:99,dy:-10,age:0,damage:2,cannon:true,frame:frames[0],frames},0x30);
 }else if(!gun){
  enemy.health=1;
  game.player.y=90;
 }
 const states=Array.from({length:cannon?3:1},(_,i)=>{
  game.update({fire:!cannon&&!i});
  const lists=[ActorList.main,ActorList.transient].map(list=>(game.actorLists.get(list)??[]).map(({address,actor:a,type})=>
   [address,a.dead?4:type,...(list===ActorList.main||a.dead?[]:
    [a.x,a.y,...(type===0x30?[(a.frame.offset+8)|a.frame.bank]:[])])]));
  return {lists,seed:game.seed,score:game.score,health:enemy?.dead||!enemy?null:enemy.health,free:pool.free.at(-1)??0};
 });
 return {mode,first,count,y:game.player.y,states};
});
console.log(JSON.stringify({path,event,wall,cases}));
""",
], cwd=ROOT))

for case in rounds["cases"]:
    mode, first, camera = case["mode"], case["first"], rounds["event"][0]
    cpu, _ = machine(None, camera, 0x5845, range(first, first + 0x4C * case["count"], 0x4C))
    cpu.mem_write((LOAD + 0x349B) * 16, base64.b64decode(corridor_cases["shared"]))
    for offset, value in [(0x991A, 1), (0x991C, 4), (0x9198, 0), (0x91AA, camera + 16), (0x91AC, 1),
                          (0x8EB0, 256), (0x8EB2, 258), (0x9F12, 160), (0x9F16, case["y"]),
                          (0x9F28, 1000), (0x9F2C, 1000)]:
        word(cpu, offset, value)
    call(cpu, 0xC79F)
    gun, cannon = mode.startswith("wall"), mode == "cannon"
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *rounds["wall" if gun else "event"]))
    if gun:
        cpu.reg_write(UC_X86_REG_DI, 0xF000)
        call(cpu, 0xC5C3)
        word(cpu, first + 0x1A, 3)
    else:
        word(cpu, 0xDE30, 0xF100)
        cpu.mem_write(DS + 0xF100, struct.pack("<6h", *rounds["path"]))
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        cpu.reg_write(UC_X86_REG_BX, 3)
        call(cpu, 0xC771)
        if not cannon:
            word(cpu, first + 0x24, 1)
    for i, expected in enumerate(case["states"]):
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
        call(cpu, 0x36FC)
        if not i:
            cpu.reg_write(UC_X86_REG_SI, 0xF200)
            if cannon:
                word(cpu, 0xF212, 160)
                word(cpu, 0xF216, 110)
                call(cpu, 0x24C4)
            else:
                cpu.mem_write(DS + 0x8FAE, b"\xff")
                word(cpu, 0xF234, 0)
                call(cpu, 0x37DF)
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x90A0))
        call(cpu, 0x36FC)
        lists = []
        for sentinel in (0x904A, 0x9096):
            records = []
            for actor in actors(cpu, sentinel):
                kind = word(cpu, actor)
                fields = [] if sentinel == 0x904A or kind == 4 else [0x12, 0x16] + ([0xC] if kind == 0x30 else [])
                records.append([actor, kind, *[word(cpu, actor + off) for off in fields]])
            lists.append(records)
        actual = {"lists": lists, "seed": word(cpu, 0x304A), "score": word(cpu, 0x9152),
                  "health": None if gun or word(cpu, first) == 4 else word(cpu, first + 0x24),
                  "free": word(cpu, 0x8E7C)}
        assert actual == expected, ("stage-four player rounds", mode, i + 1, actual, expected)
print("PASS stage-four player rounds: mount birth after wall fire, full-pool round reuse and Cannon damage/animation")


laser_hits = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game} from './src/game.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), camera=3900, path=[10,160,80,4,90,0],
 events=[3,1].map(type=>[camera,type,1,1,0,0,3]);
const cases=['root','attachment','marked','counted','orphan-live','orphan-freed','recycled-successor'].map(mode=>{
 const game=new Game(campaign);game.start(4);game.camera=camera;
 game.assets={...game.assets,paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]}};
 const {actorPool:pool}=game.run, first=pool.free.at(-1);
 const crossList=mode.startsWith('orphan')||mode==='recycled-successor';
 const count=crossList?4:pool.free.length;
 pool.free.splice(0,pool.free.length-count);
 for(const event of events)game.spawn(event,[256,258]);
 const [tail,root]=game.enemies, [attachment]=root.children;
 const counted=game.countedCredits=Number(mode==='counted');
 if(mode==='marked')attachment.dead=true;
 if(crossList){
  const free=pool.free.pop();
  const round={x:160,y:80,dx:0,dy:0,direction:2,fixed:true,frame:game.assets.logic.foregroundShot.frame};
  game.addPooledHostileRound(round,0);
  if(round.actorAddress!==root.actorAddress)throw Error('Root was not recycled into the transient list');
  pool.free.push(free);
  pool.allocate(game.actorLists,ActorList.transient,0x10,{dead:true},null);
  if(mode!=='orphan-live')root.health=3;
  if(mode==='orphan-freed'){
   round.dead=true;
   pool.release(game.actorLists,ActorList.transient,pool.recordsByAddress.get(round.actorAddress));
  }
 }
 const x=mode==='root'||mode==='marked'?152:crossList?158:162, box={x,y:64,w:16,h:33};
 const visits=[], bounds=game.stageFourTargetBounds.bind(game);
 game.stageFourTargetBounds=actor=>{
  const {address,type}=pool.recordsByAddress.get(actor.actorAddress);
  visits.push([address,actor.dead?4:type]);
  return bounds(actor);
 };
 game.hitMainArea({damage:3},box);
 return {mode,first,count,counted,box,crossList,visits,expected:{score:game.score,seed:game.seed,
  health:[root,tail].map(a=>a.dead&&!(a===root&&mode==='orphan-live')?null:a.health),
  lists:[ActorList.main,ActorList.transient].map(list=>(game.actorLists.get(list)??[])
   .map(({address,actor,type})=>[address,actor.dead?4:type]))}};
});
console.log(JSON.stringify({camera,path,events,cases}));
""",
], cwd=ROOT))

for case in laser_hits["cases"]:
    mode, first, camera = case["mode"], case["first"], laser_hits["camera"]
    cpu, _ = machine(None, camera, 0x5845, range(first, first + 0x4C * case["count"], 0x4C))
    cpu.mem_write((LOAD + 0x349B) * 16, base64.b64decode(corridor_cases["shared"]))
    for offset, value in [(0x991A, 1), (0x991C, 4), (0x91AC, 1), (0x8EB0, 256), (0x8EB2, 258),
                          (0x9164, case["counted"])]:
        word(cpu, offset, value)
    call(cpu, 0xC79F)
    word(cpu, 0xDE30, 0xF100)
    cpu.mem_write(DS + 0xF100, struct.pack("<6h", *laser_hits["path"]))
    for event in laser_hits["events"]:
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        cpu.reg_write(UC_X86_REG_BX, event[1])
        call(cpu, 0xC771)
    root, attachment, tail = actors(cpu, 0x904A)
    visits = []

    def watch_area_scan(uc, _address, _size, _data):
        slot = uc.reg_read(UC_X86_REG_DI)
        if kind := word(uc, slot):
            visits.append([slot, kind])

    if mode == "marked":
        cpu.reg_write(UC_X86_REG_SI, attachment)
        call(cpu, 0x7C0)
    if case["crossList"]:
        spare = word(cpu, 0x8E7C)
        word(cpu, 0x8E7C, 0)
        for register, value in [(UC_X86_REG_AX, 160), (UC_X86_REG_BX, 80), (UC_X86_REG_CX, 2),
                                (UC_X86_REG_DX, 0), (UC_X86_REG_BP, word(cpu, 0x8E72))]:
            cpu.reg_write(register, value)
        call(cpu, 0x1ED3)
        assert word(cpu, 0x90A0) == root
        word(cpu, 0x8E7C, spare)
        call(cpu, 0x1022)
        cpu.reg_write(UC_X86_REG_DI, 0x9096)
        call(cpu, 0x78E)
        call(cpu, 0x7C0)
        if mode != "orphan-live":
            word(cpu, root + 0x24, 3)
        if mode == "orphan-freed":
            cpu.reg_write(UC_X86_REG_SI, root)
            call(cpu, 0x7C0)
            call(cpu, 0x7A0)
    cpu.hook_add(UC_HOOK_CODE, watch_area_scan, begin=LOAD * 16 + 0x1C18, end=LOAD * 16 + 0x1C18)
    box = case["box"]
    for register, value in [(UC_X86_REG_AX, box["x"]), (UC_X86_REG_BX, box["y"]),
                            (UC_X86_REG_CX, box["x"] + box["w"] - 1), (UC_X86_REG_DX, box["y"] + box["h"] - 1),
                            (UC_X86_REG_BP, 3), (UC_X86_REG_SI, 0xF200)]:
        cpu.reg_write(register, value)
    call(cpu, 0x1C4F)
    actual = {"score": word(cpu, 0x9152), "seed": word(cpu, 0x304A),
              "health": [None if word(cpu, a) == 4 else word(cpu, a + 0x24) for a in (root, tail)],
              "lists": [[[a, word(cpu, a)] for a in actors(cpu, s)] for s in (0x904A, 0x9096)]}
    assert actual == case["expected"], ("stage-four Laser area", mode, actual, case["expected"])
    assert visits == case["visits"], ("stage-four Laser area scan", mode, visits, case["visits"])
    if case["crossList"]:
        assert all(slot != tail for slot, _ in visits)
        if mode in ("orphan-live", "orphan-freed"):
            assert visits == [[attachment, 0xE8]], (mode, visits)
        else:
            assert len(visits) > 1 and visits[1] == [spare, 0x18], (mode, visits)
print("PASS stage-four Laser area: composite skips, marked/count stops and saved-address reuse across lists")

area_ground = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game,frameAt} from './src/game.js';
import {Renderer} from './src/renderer.js';
import {StageFourCorridorPod} from './src/stage-four-ground.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), seed=0x5845;
const cases=[
 ['gun','survives'],['gun','dies'],['gun','miss'],
 ['hunter','flash'],['hunter','hatch'],['hunter','dies'],
 ['drone','survives'],['drone','dies'],
].map(([kind,mode])=>{
 const hunter=kind==='hunter', drone=kind==='drone', camera=drone?3400:hunter&&mode!=='flash'?960:16;
 const damage=drone?1:3, path=[10,161,hunter?96:80,4,90,0];
 const wall=hunter?[camera,3,0,0,136,camera+82,0]:[camera,1,0,0,232,camera+80,1];
 const tail=[camera,3,1,1,0,0,3], pod=[camera,0,1,1,0,0,hunter?0:16];
 const game=new Game(campaign);game.start(4);game.camera=camera;game.control.ceiling=camera+16;game.seed=seed;
 const {actorPool:pool}=game.run, first=pool.free.at(-1), count=3;
 pool.free.splice(0,pool.free.length-count);
 const paths={bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]};
 game.assets={...game.assets,events:[],background:drone?[]:[wall],paths};
 game.spawn(tail,[256,258]);
 const later=game.enemies[0];
 game.dispatchCameraEvents();
 let podPose, nextGroup;
 if(drone){
  game.assets.paths=campaign.stages[3].paths;
  const launch=new StageFourCorridorPod(game.assets.logic.corridor.pods[0],92);
  launch.frameIndex=4;launch.frameTicks=1;
  podPose=[launch.x,launch.y];
  nextGroup=game.run.formationClock.next;
  launch.step(game,{});
  game.assets.paths=paths;
 }
 const target=game.ground[0];
 if(drone)target.updateBounds(game);
 else if(hunter)target.box=game.bounds(game.sprite(target.frame),target.motion.x,target.motion.y);
 else game.updateGroundActor(target,0);
 const health=target.health=mode==='dies'?damage:target.health;
 game.spawn(pod,[272,274]);
 game.enemies.at(-1).health=damage;
 const box={x:drone?16:120,y:62,w:drone?264:mode==='miss'?56:160,h:70};
 const visits=[], bounds=game.stageFourTargetBounds.bind(game);
 game.stageFourTargetBounds=actor=>{
  const {address,type}=pool.recordsByAddress.get(actor.actorAddress);
  visits.push([address,actor.dead?4:type]);
  return bounds(actor);
 };
 game.hitMainArea({damage},box);
 const slot=pool.recordsByAddress.get(target.actorAddress), a=slot.actor;
 const f=a.kind?game.pickupFrame(a):frameAt(a.frames,a.age);
 const cells=kind==='gun'?[0,1,20,21].map(i=>target.cell+i):[], tiles=cells.map(i=>game.map[i]);
 const pixels=[], renderer=Object.assign(Object.create(Renderer.prototype),{
  drawSprite:(_,x,y,alpha,mask)=>pixels.push(mask?[x,y,mask]:[x,y]),
  drawOverlay:({width,x,y,tiles},mask)=>pixels.push([width,x,y,tiles,mask??null]),
 });
 const before=[slot.address,a.dead?4:slot.type,a.x,a.y,(f.offset+8)|f.bank];
 renderer.drawTransient(game,[slot]);
 const paints=[pixels.splice(0)];
 if(!a.dead){
  game.tick++;
  game.updateTransientActor(slot);
  renderer.drawTransient(game,[slot]);
  paints.push(pixels.splice(0));
 }
 return {kind,mode,camera,path,wall,tail,pod,podPose,nextGroup,first,count,target:target.actorAddress,health,damage,box,
  cells,visits,expected:{before,paints,tiles,after:[a.x,a.y],score:game.score,seed:game.seed,
   health:[target.health,later.health],groups:game.formationCredits.size}};
});
console.log(JSON.stringify({cases,seed}));
""",
], cwd=ROOT))

for case in area_ground["cases"]:
    first, count, camera, kind = (case[k] for k in ("first", "count", "camera", "kind"))
    cpu, _ = machine(None, camera, area_ground["seed"], range(first, first + count * 0x4C, 0x4C))
    cpu.mem_write((LOAD + 0x349B) * 16, base64.b64decode(corridor_cases["shared"]))
    cpu.mem_write(DS, struct.pack("<6000H", *corridor_cases["map"]))
    for offset, value in [(0x991A, 1), (0x991C, 4), (0x91AC, 1), (0x9F28, 1000), (0x9F2C, 1000)]:
        word(cpu, offset, value)
    call(cpu, 0xC79F)
    word(cpu, 0x91AA, camera + 16)
    word(cpu, 0xDE30, 0xF100)
    cpu.mem_write(DS + 0xF100, struct.pack("<6h", *case["path"]))
    for field, group in (("tail", 256), ("wall", 0), ("pod", 272)):
        event = case[field]
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        if field == "wall":
            if kind == "drone":
                word(cpu, 0x91AC, case["nextGroup"])
                word(cpu, 0xF212, case["podPose"][0])
                word(cpu, 0xF216, case["podPose"][1])
                for reg, value in ((UC_X86_REG_SI, 0xF200), (UC_X86_REG_AX, 0), (UC_X86_REG_BX, 10),
                                   (UC_X86_REG_BP, 0xF100)):
                    cpu.reg_write(reg, value)
                call(cpu, 0xB751)
            else:
                cpu.reg_write(UC_X86_REG_DI, 0xF000)
                call(cpu, 0xC368 if kind == "hunter" else 0xC5C3)
            target = word(cpu, 0x9054)
            assert target == case["target"]
            cpu.reg_write(UC_X86_REG_SI, target)
            call(cpu, {"hunter": 0xC4CB, "drone": 0x3589}.get(kind, word(cpu, target + 2)))
            word(cpu, target + 0x24, case["health"])
        else:
            word(cpu, 0x8EB0, group)
            word(cpu, 0x8EB2, group + 2)
            cpu.reg_write(UC_X86_REG_SI, 0xF000)
            cpu.reg_write(UC_X86_REG_BX, event[1])
            call(cpu, 0xC771)
            if field == "tail":
                tail = word(cpu, 0x9054)
            else:
                word(cpu, word(cpu, 0x9054) + 0x24, case["damage"])
    visited, drawn = [], []

    def trace_area_ground(uc, address, _size, _data):
        offset = address - LOAD * 16
        if offset == 0x1C18:
            record = uc.reg_read(UC_X86_REG_DI)
            if kind := word(uc, record):
                visited.append([record, kind])
        elif offset in (0x941, 0x963):
            width, height, x, y, tiles = (uc.reg_read(r) for r in (
                UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_CX, UC_X86_REG_DX, UC_X86_REG_SI))
            drawn.append([width, signed(x) * 2, signed(y),
                          list(struct.unpack_from(f"<{width * height}H", image, tiles)),
                          "vga-hit" if offset == 0x963 else None])
            pop_return(uc)
        elif offset in (0x853, 0x8B9):
            record = uc.reg_read(UC_X86_REG_SI)
            row = [word(uc, record + off, signed=True) for off in (0x12, 0x16)]
            if offset == 0x8B9:
                row.append("vga-hit")
                word(uc, record + 4, 0x853)
            drawn.append(row)
            pop_return(uc)
        elif offset in (0x875, 0x8FD):
            row = [signed(uc.reg_read(reg)) for reg in (UC_X86_REG_CX, UC_X86_REG_DX)]
            if offset == 0x8FD:
                row.append("vga-hit")
            drawn.append(row)
            pop_return(uc)

    cpu.hook_add(UC_HOOK_CODE, trace_area_ground)
    box = case["box"]
    for reg, value in ((UC_X86_REG_AX, box["x"]), (UC_X86_REG_BX, box["y"]),
                       (UC_X86_REG_CX, box["x"] + box["w"] - 1), (UC_X86_REG_DX, box["y"] + box["h"] - 1),
                       (UC_X86_REG_BP, case["damage"]), (UC_X86_REG_SI, 0xF200)):
        cpu.reg_write(reg, value)
    call(cpu, 0x1C4F)
    assert visited == case["visits"], ("stage-four area inherited ground visits", kind, case["mode"], visited, case["visits"])
    assert word(cpu, 0x90A0) == target
    before = [target, word(cpu, target)] + [word(cpu, target + off, signed=off != 0xC) for off in (0x12, 0x16, 0xC)]
    paints = []
    for tick in range(1 if before[1] == 4 else 2):
        if tick:
            cpu.reg_write(UC_X86_REG_SI, target)
            call(cpu, word(cpu, target + 2))
        cpu.reg_write(UC_X86_REG_SI, target)
        call(cpu, word(cpu, target + 4))
        paints.append(drawn[:])
        drawn.clear()
    actual = {"before": before, "paints": paints, "after": [word(cpu, target + off, signed=True) for off in (0x12, 0x16)],
              "score": word(cpu, 0x9152), "seed": word(cpu, 0x304A),
              "tiles": [word(cpu, i * 2) for i in case["cells"]],
              "health": [word(cpu, a + 0x24, signed=True) for a in (target, tail)],
              "groups": sum(bool(word(cpu, i)) for i in range(0x8E8C, 0x8EAC, 4))}
    assert actual == case["expected"], ("stage-four area inherited ground", kind, case["mode"],
                                       {k: (v, case["expected"][k]) for k, v in actual.items()
                                        if v != case["expected"][k]})
print("PASS stage-four area damage: wall-gun, hunter and grouped drone inherited damage, paint and retirement")

area_formations = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game,frameAt} from './src/game.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), camera=3900, seed=0x5845, path=[10,160,80,4,90,0];
const events=[[3,3],[1,3],[0,16]].map(([type,reward])=>[camera,type,1,1,0,0,reward]);
const box={x:120,y:62,w:70,h:48};
const cases=[false,true].map(fatal=>{
 const game=new Game(campaign);game.start(4);game.camera=camera;game.seed=seed;
 const {actorPool:pool}=game.run, first=pool.free.at(-1), count=4;
 pool.free.splice(0,pool.free.length-count);
 game.assets={...game.assets,paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]}};
 events.forEach((event,i)=>game.spawn(event,[256+i*8,258+i*8]));
 const [later,root,pod]=game.enemies;
 const [child]=root.children;
 pod.health=3;
 if(fatal)root.health=3;
 game.hitMainArea({damage:3},box);
 const lists=[ActorList.main,ActorList.transient].map(list=>game.actorLists.get(list).map(({address,actor,type})=>{
  const row=[address,actor.dead?4:type,!actor.dead&&actor.flashTick===game.tick];
  if(list===ActorList.transient&&!actor.dead){
   const f=actor.kind?game.pickupFrame(actor):frameAt(actor.frames,actor.age);
   row.push(actor.x,actor.y,(f.offset+8)|f.bank);
  }
  return row;
 }));
 return {fatal,first,count,expected:{lists,health:[later.health,root.health],score:game.score,seed:game.seed}};
});
console.log(JSON.stringify({cases,camera,seed,path,events,box}));
""",
], cwd=ROOT))

for case in area_formations["cases"]:
    first, count = case["first"], case["count"]
    cpu, _ = machine(None, area_formations["camera"], area_formations["seed"], range(first, first + count * 0x4C, 0x4C))
    cpu.mem_write((LOAD + 0x349B) * 16, base64.b64decode(corridor_cases["shared"]))
    for offset, value in [(0x991A, 1), (0x991C, 4), (0x91AC, 1)]:
        word(cpu, offset, value)
    call(cpu, 0xC79F)
    word(cpu, 0xDE30, 0xF100)
    cpu.mem_write(DS + 0xF100, struct.pack("<6h", *area_formations["path"]))
    for i, event in enumerate(area_formations["events"]):
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        word(cpu, 0x8EB0, 256 + i * 8)
        word(cpu, 0x8EB2, 258 + i * 8)
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        cpu.reg_write(UC_X86_REG_BX, event[1])
        call(cpu, 0xC771)
    pod, root, _, later = actors(cpu, 0x904A)
    word(cpu, pod + 0x24, 3)
    if case["fatal"]:
        word(cpu, root + 0x24, 3)
    box = area_formations["box"]
    for reg, value in ((UC_X86_REG_AX, box["x"]), (UC_X86_REG_BX, box["y"]),
                       (UC_X86_REG_CX, box["x"] + box["w"] - 1), (UC_X86_REG_DX, box["y"] + box["h"] - 1),
                       (UC_X86_REG_BP, 3), (UC_X86_REG_SI, 0xF200)):
        cpu.reg_write(reg, value)
    call(cpu, 0x1C4F)
    lists = []
    for sentinel in (0x904A, 0x9096):
        rows = []
        for actor in actors(cpu, sentinel):
            kind = word(cpu, actor)
            row = [actor, kind, kind != 4 and word(cpu, actor + 4) == 0x8B9]
            if sentinel == 0x9096 and kind != 4:
                row.extend(word(cpu, actor + off, signed=off != 0xC) for off in (0x12, 0x16, 0xC))
            rows.append(row)
        lists.append(rows)
    actual = {"lists": lists, "health": [word(cpu, a + 0x24, signed=True) for a in (later, root)],
              "score": word(cpu, 0x9152), "seed": word(cpu, 0x304A)}
    assert actual == case["expected"], ("stage-four area inherited formation", case["fatal"],
                                       {k: (v, case["expected"][k]) for k, v in actual.items()
                                        if v != case["expected"][k]})
print("PASS stage-four area damage: a recycled formation slot shares health, flash, and death with its attachment")


z_cases = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game} from './src/game.js';
import {frameAt} from './src/motion.js';
import {dispatchStageFourCorridor,StageFourCorridorPod} from './src/stage-four-ground.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), path=[10,160,80,4,90,0], pointer=f=>(f.offset+8)|f.bank;
const modes=['regular','self-right','pod-gun','pod-formation','self-hunter-left','self-hunter-right',
 'pod-hunter-left','pod-hunter-right','self-corridor','pod-corridor','self-drone','pod-drone'];
const cases=modes.map(mode=>{
 const regular=mode==='regular', self=mode.startsWith('self'), formation=mode==='pod-formation';
 const hunter=mode.includes('-hunter'), ship=mode.endsWith('-corridor'), drone=mode.endsWith('-drone');
 const camera=ship||drone?3400:3900;
 const game=new Game(campaign);game.start(4);game.camera=camera;
 const wall=(x,side)=>[camera,1,0,0,x,3980,side];
 const background=regular?[wall(104,0),wall(232,1),[camera,3,0,0,80,3980,0]]:
  hunter?[[camera,3,0,0,mode.endsWith('left')?80:232,3980,Number(mode.endsWith('right'))]]:
  formation||ship||drone?[]:[wall(232,1)];
 game.assets={...game.assets,events:[],background,
  paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]}};
 const {actorPool:pool}=game.run, first=pool.free.at(-1), count=regular?pool.free.length:self?1:formation?4:3;
 pool.free.splice(0,pool.free.length-count);
 const foreground=(type,id,reward=3)=>({event:[camera,type,1,1,0,0,reward],id});
 const spawn=({event,id})=>game.spawn(event,[id,id+2]);
 const before=self?[]:[foreground(3,256)], after=self?[]:formation?
  [foreground(1,264),foreground(0,272,16)]:[foreground(0,272,16)];
 for(const event of before)spawn(event);
 game.dispatchCameraEvents();
 const nextGroup=game.run.formationClock.next;
 let podPose;
 if(ship){
  game.tick=16;
  dispatchStageFourCorridor(game);
 }else if(drone){
  const pod=new StageFourCorridorPod(game.assets.logic.corridor.pods[0],52);
  pod.frameIndex=4;
  pod.frameTicks=1;
  podPose=[pod.x,pod.y];
  const syntheticPaths=game.assets.paths;
  game.assets.paths=campaign.stages[3].paths;
  pod.step(game,{});
  game.assets.paths=syntheticPaths;
 }
 const damaged=game.ground[0];
 for(const event of after)spawn(event);
 const cells=game.ground.flatMap(a=>a.cell===undefined?[]:[a.cell,a.cell+1,a.cell+20,a.cell+21]);
 if(regular){
  const pod=new StageFourCorridorPod(game.assets.logic.corridor.pods[0],52);
  pool.allocate(game.actorLists,ActorList.transient,pod.definition.type,pod);game.bullets.push(pod);
  game.addPickup({kind:'credit',value:50,x:200,y:90,age:0,state:7,direction:0},true);
  game.addPlayerRound({point:true,x:164,y:90,dx:0,dy:-9});
  game.addPooledHostileRound({x:84,y:90,dx:0,dy:0,direction:2,fixed:true,
   frame:game.assets.logic.foregroundShot.frame},0);
 }
 game.clearScreen();
 const lists=[ActorList.main,ActorList.transient].map(list=>(game.actorLists.get(list)??[]).map(({address,actor:a,type})=>{
  if(a.dead)return [address,4];
  if(a.parts||a.ground)return [address,type,a.health];
  if(type===0x0c)return [address,type,a.x,a.y,pointer(frameAt(a.frames,a.age))];
  if(a.kind==='reward'||a.kind==='credit')return [address,type,a.x,a.y,a.state,a.direction&7,pointer(game.pickupFrame(a))];
  return [address,type];
 }));
 const resetSlot=hunter?pool.recordsByAddress.get(damaged.actorAddress):undefined, reset=resetSlot?.actor;
 const expected={lists,score:game.score,seed:game.seed,hunterReset:reset?[reset.contactBox.x,damaged.health]:null,
  tiles:cells.map(i=>game.map[i]),groups:game.formationCredits.size,free:pool.free.at(-1)??0};
 let expiry;
 if(reset?.kind==='credit'){
  game.countedCredits=1;
  game.updateTransientActor(resetSlot);
  expiry=[reset.y,reset.dead,game.countedCredits,resetSlot.list,pool.free.at(-1)??0];
  game.updateTransientActor(resetSlot);
  expiry.push(pool.free.at(-1));
 }
 return {mode,camera,first,count,before,after,background,cells,ship,podPose,nextGroup,hunterAddress:hunter?damaged.actorAddress:0,
  expected,expiry};
});
console.log(JSON.stringify({cases,path}));
""",
], cwd=ROOT))

for case in z_cases["cases"]:
    mode, first, camera = case["mode"], case["first"], case["camera"]
    cpu, _ = machine(None, camera, 0x5845, range(first, first + 0x4C * case["count"], 0x4C))
    cpu.mem_write((LOAD + 0x349B) * 16, base64.b64decode(corridor_cases["shared"]))
    cpu.mem_write(DS, struct.pack("<6000H", *corridor_cases["map"]))
    for offset, value in [(0x991A, 1), (0x991C, 4), (0x91AC, 1)]:
        word(cpu, offset, value)
    call(cpu, 0xC79F)
    word(cpu, 0xDE30, 0xF100)
    cpu.mem_write(DS + 0xF100, struct.pack("<6h", *z_cases["path"]))
    cpu.hook_add(UC_HOOK_CODE, lambda uc, *_: pop_return(uc), begin=LOAD * 16 + 0xEB3, end=LOAD * 16 + 0xEB3)

    def spawn_z_foreground(spec):
        event = spec["event"]
        word(cpu, 0x8EB0, spec["id"])
        word(cpu, 0x8EB2, spec["id"] + 2)
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        cpu.reg_write(UC_X86_REG_BX, event[1])
        call(cpu, 0xC771)

    for spec in case["before"]:
        spawn_z_foreground(spec)
    for event in case["background"]:
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        cpu.reg_write(UC_X86_REG_DI, 0xF000)
        call(cpu, 0xC368 if event[1] == 3 else 0xC5C3)
    if case["ship"]:
        word(cpu, 0x919C, 16)
        call(cpu, 0xB555)
    if pose := case.get("podPose"):
        word(cpu, 0x91AC, case["nextGroup"])
        word(cpu, 0xF212, pose[0])
        word(cpu, 0xF216, pose[1])
        for register, value in [(UC_X86_REG_SI, 0xF200), (UC_X86_REG_AX, 0),
                                (UC_X86_REG_BX, 10), (UC_X86_REG_BP, 0xF100)]:
            cpu.reg_write(register, value)
        call(cpu, 0xB751)
    for spec in case["after"]:
        spawn_z_foreground(spec)
    if mode == "regular":
        call(cpu, 0x1022)
        cpu.reg_write(UC_X86_REG_DI, 0x9096)
        call(cpu, 0x77C)
        word(cpu, word(cpu, 0x90A0), 0xF0)
        for offset, value in [(0xF212, 200), (0xF216, 90), (0xF227, 0)]:
            word(cpu, offset, value)
        cpu.reg_write(UC_X86_REG_DI, 0xF200)
        seed = word(cpu, 0x304A)
        call(cpu, 0x3AEC)
        word(cpu, word(cpu, 0x90A0) + 0x1C, 0)
        word(cpu, 0x304A, seed)
        call(cpu, 0x1022)
        cpu.reg_write(UC_X86_REG_DI, 0x9096)
        call(cpu, 0x77C)
        word(cpu, word(cpu, 0x90A0), 0x10)
        for register, value in [(UC_X86_REG_AX, 84), (UC_X86_REG_BX, 90), (UC_X86_REG_CX, 2),
                                (UC_X86_REG_DX, 0), (UC_X86_REG_BP, word(cpu, 0x8E72))]:
            cpu.reg_write(register, value)
        call(cpu, 0x1ED3)
    call(cpu, 0x2AD0)
    drops = (0x18, 0x60, word(cpu, 0x31FE + 16 * 4))
    lists = []
    for sentinel in (0x904A, 0x9096):
        linked = []
        for actor in actors(cpu, sentinel):
            kind = word(cpu, actor)
            row = [actor, kind]
            if kind != 4 and sentinel == 0x904A:
                row.append(word(cpu, actor + 0x24))
            if kind == 0xC or kind in drops:
                row.extend(word(cpu, actor + offset, signed=offset in (0x12, 0x16)) for offset in (0x12, 0x16))
                if kind in drops:
                    row.extend([word(cpu, actor + 0x1A), word(cpu, actor + 0x1C) & 7])
                row.append(word(cpu, actor + 0xC))
            linked.append(row)
        lists.append(linked)
    hunter_address = case["hunterAddress"]
    actual = {"lists": lists, "score": word(cpu, 0x9152), "seed": word(cpu, 0x304A),
              "hunterReset": [word(cpu, hunter_address + off) for off in (0x28, 0x24)] if hunter_address else None,
              "tiles": [word(cpu, i * 2) for i in case["cells"]],
              "groups": sum(bool(word(cpu, i)) for i in range(0x8E8C, 0x8EAC, 4)), "free": word(cpu, 0x8E7C)}
    assert actual == case["expected"], ("stage-four Z", mode,
                                       {k: (v, case["expected"][k]) for k, v in actual.items()
                                        if v != case["expected"][k]})
    if "expiry" in case:
        word(cpu, 0x9164, 1)
        cpu.reg_write(UC_X86_REG_SI, hunter_address)
        call(cpu, word(cpu, hunter_address + 2))
        expiry = [word(cpu, hunter_address + 0x16, signed=True), word(cpu, hunter_address) == 4,
                  word(cpu, 0x9164), 0x9096 if hunter_address in actors(cpu, 0x9096) else None,
                  word(cpu, 0x8E7C)]
        cpu.reg_write(UC_X86_REG_SI, hunter_address)
        call(cpu, word(cpu, hunter_address + 2))
        expiry.append(word(cpu, 0x8E7C))
        assert expiry == case["expiry"], ("stage-four Z hunter credit expiry", mode, expiry, case["expiry"])
print("PASS stage-four Z: filtering, gun/hunter/ship/drone slot reuse, inherited damage and hunter credit expiry")


specialist_rounds = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game} from './src/game.js';
import {frameAt} from './src/motion.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), camera=3900, pointer=f=>(f.offset+8)|f.bank;
const cases=['flamer-0','flamer-1','flamer-2','bomb','bomb-counted','bomb-edge','bomb-full','mine-full'].map(mode=>{
 const flamer=mode.startsWith('flamer'), mine=mode==='mine-full', edge=mode==='bomb-edge'||mode.endsWith('-full');
 const power=flamer?Number(mode.at(-1)):0, counted=Number(mode==='bomb-counted');
 const game=new Game(campaign);game.start(4);game.releaseWeaponRecords();game.inventory.fill(null);
 game.replaceWeapon(flamer?0:mine?5:6,{id:flamer?20:mine?9:21,power});
 game.camera=game.control.camera=game.endCamera=camera;game.control.ceiling=camera+16;
 const {actorPool:pool}=game.run, mount=game.actorLists.get(ActorList.mounts)[0].address;
 const count=mode.endsWith('-full')?2:pool.free.length;
 pool.free.splice(0,pool.free.length-count);
 const event=x=>[camera,1,0,0,x,camera+(mine?73:edge?81:80),0];
 const background=edge?[event(mine?120:136)]:[event(104),event(flamer?104:136)];
 game.assets={...game.assets,events:[],background};
 game.shipTouchesTerrain=()=>false;
 game.dispatchCameraEvents();
 for(const gun of game.ground)if(edge)gun.phase=4;
 if(mine){
  game.ground[0].health=4;
  game.run.mineChargeCount=1;
  game.addPlayerRound({mine:true,x:104,y:48,age:0,fuse:-1,power,frames:game.assets.logic.mountFrames[9]},0x38);
 }
 game.countedCredits=counted;
 const states=[];
 for(let tick=1;tick<=(mine?2:edge?17:56);tick++){
  if(tick===55)game.killPlayer();
  game.invincible=999;game.posture=0;
  const sweep=flamer&&tick>=21&&tick<49;
  game.player.x=sweep?(tick%4<2?8:311):104;
  game.player.y=edge?126:sweep&&tick%3===0?52:174;
  const fire=!mine&&tick<55&&(flamer?tick%12<8:[1,25,49].includes(tick));
  game.update({fire});
  const {x,y}=game.player;
  const main=(game.actorLists.get(ActorList.main)??[]).map(({address,actor:a,type})=>
   [address,a.dead?4:type,...(a.dead?[]:[a.health,Number(a.flashTick===game.tick)])]);
  const transient=(game.actorLists.get(ActorList.transient)??[]).map(({address,actor:a,type})=>{
   const record=[address,a.dead?4:type];
   if(a.dead)return record;
   record.push(a.x,a.y,pointer(type===0x0c?frameAt(a.frames,a.age):a.frame));
   if(type===0x28)record.push(a.fuse);
   if(type===0xb4){
    record.push(a.xFixed&65535,a.dxFixed/1024,Number(a.damaging));
    if(a.damaging){
     const {x,y,w,h}=game.bounds(game.sprite(a.frame),a.x,a.y);
     record.push(x,y,x+w-1,y+h-1);
    }
   }
   return record;
  });
  states.push({x,y,fire,main,transient,score:game.score,seed:game.seed,free:pool.free.at(-1)??0,
   mineCount:game.run.mineChargeCount});
 }
 return {mode,power,mount,count,counted,background,states};
});
console.log(JSON.stringify(cases));
""",
], cwd=ROOT))


def flamer_sound(cpu, interrupt, _):
    assert interrupt == 0x80 and cpu.reg_read(UC_X86_REG_AX) >> 8 == 0x11
    cpu.reg_write(UC_X86_REG_AX, 0x1101)


for case in specialist_rounds:
    mode, mount = case["mode"], case["mount"]
    edge, mine = mode == "bomb-edge" or mode.endswith("-full"), mode == "mine-full"
    flamer = mode.startswith("flamer")
    camera = case["background"][0][0]
    cpu, _ = machine(None, camera, 0x5845, range(mount, mount + 0x4C * (case["count"] + 1), 0x4C))
    cpu.mem_write((LOAD + 0x349B) * 16, base64.b64decode(corridor_cases["shared"]))
    for offset, value in [(0x991A, 1), (0x991C, 4), (0x9198, 0), (0x91AA, camera + 16),
                          (0x9164, case["counted"]), (0x9F28, 1000), (0x9F2C, 1000)]:
        word(cpu, offset, value)
    call(cpu, 0xC79F)
    call(cpu, 0x2DF0 if flamer else 0x2F7C if mine else 0x2D2A)
    word(cpu, mount + 0x34, case["power"])
    if flamer:
        cpu.hook_add(UC_HOOK_INTR, flamer_sound)
    for event in case["background"]:
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        cpu.reg_write(UC_X86_REG_DI, 0xF000)
        call(cpu, 0xC5C3)
        if edge:
            word(cpu, cpu.reg_read(UC_X86_REG_SI) + 0x1A, 4)
    if mine:
        word(cpu, word(cpu, 0x9054) + 0x24, 4)
        for offset, value in [(0x12, 104), (0x16, 48), (0x1A, 2)]:
            word(cpu, mount + offset, value)
        cpu.mem_write(DS + 0x8F59, b"\x80")
        cpu.reg_write(UC_X86_REG_SI, mount)
        call(cpu, 0x2697)
        word(cpu, word(cpu, 0x90A0) + 0x1A, -1)
    for tick, expected in enumerate(case["states"], 1):
        word(cpu, 0x919C, tick)
        word(cpu, 0x9F12, expected["x"])
        word(cpu, 0x9F16, expected["y"])
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
        call(cpu, 0x36FC)
        cpu.mem_write(DS + 0x8FAE, bytes([255 if expected["fire"] else 0]))
        cpu.mem_write(DS + 0x8F59, bytes([128 if expected["fire"] else 0]))
        if tick == 55:
            cpu.mem_write(DS + 0x9224, b"\xff")
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9008))
        call(cpu, 0x36FC)
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x90A0))
        call(cpu, 0x36FC)
        main, transient = [], []
        for actor in actors(cpu, 0x904A):
            kind = word(cpu, actor)
            main.append([actor, kind, *([] if kind == 4 else
                        [word(cpu, actor + 0x24), int(word(cpu, actor + 4) == 0xC746)])])
        for actor in actors(cpu, 0x9096):
            kind = word(cpu, actor)
            record = [actor, kind]
            if kind != 4:
                record.extend(word(cpu, actor + offset, signed=True) for offset in (0x12, 0x16))
                record.append(word(cpu, actor + 0xC))
                if kind == 0x28:
                    record.append(word(cpu, actor + 0x1A, signed=True))
                if kind == 0xB4:
                    damaging = word(cpu, actor + 0x22)
                    record.extend([word(cpu, actor + 0x14), word(cpu, actor + 0x1C, signed=True), damaging])
                    if damaging:
                        record.extend(struct.unpack("<4h", cpu.mem_read(DS + actor + 0x28, 8)))
            transient.append(record)
        actual = {"main": main, "transient": transient, "score": word(cpu, 0x9152), "mineCount": word(cpu, 0x8E86),
                  "seed": word(cpu, 0x304A), "free": word(cpu, 0x8E7C)}
        assert all(expected[key] == value for key, value in actual.items()), (
            mode, tick, {key: (value, expected[key]) for key, value in actual.items() if expected[key] != value})
        # The wall gun's flash callback resets during paint, after both actor passes.
        for actor in actors(cpu, 0x904A):
            if word(cpu, actor + 4) == 0xC746:
                word(cpu, actor + 4, 0x761)
    if mine:
        assert word(cpu, 0x9152) == 400
print("PASS stage-four Flamer and Bomb: 314 linked ticks; Mine damage and source marking after two full-pool reuses")


seeker_targets = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game} from './src/game.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), path=[10,160,80,4,90,0];
const cases=['corridor-birth','composite'].map(mode=>{
 const birth=mode==='corridor-birth', camera=birth?3600:3900, seed=birth?0x5844:0x5845;
 const game=new Game(campaign);game.start(4);
 game.camera=game.control.camera=game.endCamera=camera;game.control.ceiling=camera+16;
 game.tick=game.run.formationClock.tick=birth?15:0;game.seed=seed;
 game.assets={...game.assets,events:[],background:birth?[104,216].map(x=>[camera,1,0,0,x,camera+80,0]):[],
  paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]}};
 game.shipTouchesTerrain=()=>false;
 const {actorPool:pool}=game.run, first=pool.free.at(-1), count=pool.free.length;
 const events=birth?game.assets.background:[3,1].map(type=>[camera,type,1,1,0,0,3]);
 if(birth)game.dispatchCameraEvents();
 else for(const event of events)game.spawn(event,[256,258]);
 const rocket={x:160,y:150,direction:0,phase:0,age:0,launch:true,homing:true};
 game.addPlayerRound(rocket,0x48);
 const states=[];
 for(let i=0;i<3;i++){
  game.update();
  const {x,y,direction,phase,targetAddress,frame}=rocket;
  const main=game.actorLists.get(ActorList.main);
  if(i===0&&targetAddress!==main[2].address)throw Error('Incorrect first lock: '+mode);
  states.push({target:[x,y,direction,phase,targetAddress,(frame.offset+8)|frame.bank],seed:game.seed});
 }
 return {birth,camera,events,seed,first,count,rocket:rocket.actorAddress,states};
});
console.log(JSON.stringify({cases,path}));
""",
], cwd=ROOT))

for case in seeker_targets["cases"]:
    birth, camera, first = case["birth"], case["camera"], case["first"]
    cpu, _ = machine(None, camera, case["seed"], range(first, first + 0x4C * case["count"], 0x4C))
    cpu.mem_write((LOAD + 0x349B) * 16, base64.b64decode(corridor_cases["shared"]))
    for offset, value in [(0x991A, 1), (0x991C, 4), (0x91AA, camera + 16), (0x8EB0, 256), (0x8EB2, 258),
                          (0x91AC, 1), (0x9F12, 160), (0x9F16, 174), (0x9F28, 1000), (0x9F2C, 1000)]:
        word(cpu, offset, value)
    call(cpu, 0xC79F)
    word(cpu, 0xDE30, 0xF100)
    cpu.mem_write(DS + 0xF100, struct.pack("<6h", *seeker_targets["path"]))
    for event in case["events"]:
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        if birth:
            cpu.reg_write(UC_X86_REG_DI, 0xF000)
            call(cpu, 0xC5C3)
        else:
            cpu.reg_write(UC_X86_REG_SI, 0xF000)
            cpu.reg_write(UC_X86_REG_BX, event[1])
            call(cpu, 0xC771)
    rocket = case["rocket"]
    assert word(cpu, 0x8E7C) == rocket
    call(cpu, 0x1022)
    cpu.reg_write(UC_X86_REG_DI, 0x9096)
    call(cpu, 0x77C)
    opening, duration = struct.unpack_from("<HH", image, word(cpu, 0x324A))
    for offset, value in [(0, 0x48), (2, 0x1FF3), (0xC, opening), (0xE, duration),
                          (0x10, word(cpu, 0x324A) + 4), (0x12, 160), (0x16, 150)]:
        word(cpu, rocket + offset, value)
    for tick, expected in enumerate(case["states"], 16 if birth else 1):
        word(cpu, 0x919C, tick)
        call(cpu, 0x373D)
        call(cpu, 0xB555)
        for sentinel in (0x904A, 0x9096):
            cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
            call(cpu, 0x36FC)
        actual = {"seed": word(cpu, 0x304A), "target": [
            word(cpu, rocket + offset, signed=offset == 0x1A) for offset in (0x12, 0x16, 0x1C, 0x1A, 0x22, 0xC)]}
        assert actual == expected, ("stage-four seeker target order", birth, tick, actual, expected)
print("PASS stage-four seeker locks: pre-corridor population, composite skip and lock retention")


flashes = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game} from './src/game.js';
import {Renderer} from './src/renderer.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), camera=3900;
console.log(JSON.stringify([0,1].flatMap(side=>[-4,72,178].map(y=>{
 const game=new Game(campaign);game.start(4);game.camera=camera;game.control.ceiling=camera+16;
 const event=[camera,1,0,0,side?248:104,camera+y+8,side];
 game.assets={...game.assets,events:[],background:[event]};
 game.dispatchCameraEvents();
 const [gun]=game.ground;
 gun.phase=1;
 game.updateGroundActor(gun);
 game.hitWithWeapon(gun,{damage:1});
 const pixels=[];
 const drawOverlay=(region,mask)=>{
  if(mask!=='vga-hit')throw Error('Missing VGA flash mask');
  for(const [i,tile] of region.tiles.entries()){
   const x=region.x+i%2*16,y=region.y+(i>>1)*16;
   game.assets.tiles[tile>>>6].forEach((value,i)=>{
    const row=y+(i>>4);
    if((value||!(tile&1))&&row>=0&&row<192)pixels.push(row*320+x+(i&15));
   });
  }
 };
 Renderer.prototype.drawStageFourMain.call({drawOverlay},game,game.actorLists.get(ActorList.main),camera);
 return {event,pixels:pixels.sort((a,b)=>a-b),health:gun.health};
}))));
""",
], cwd=ROOT))

tile_masks = b"".join(struct.pack(">H", a | b | c | d)
                      for a, b, c, d in struct.iter_unpack(">4H", (ROOT / "S4/MODS.VGA").read_bytes()))
for case in flashes:
    event = case["event"]
    cpu, _ = machine(None, event[0], 0x5845)
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
    cpu.reg_write(UC_X86_REG_DI, 0xF000)
    call(cpu, 0xC5C3)
    actor = cpu.reg_read(UC_X86_REG_SI)
    cpu.mem_write(DS + 0x5538, tile_masks)
    word(cpu, 0x3044, 0)
    word(cpu, 0x425B, 0)
    word(cpu, 0x91AA, event[0] + 16)
    word(cpu, actor + 0x1A, 1)
    call(cpu, 0xC61A)
    cpu.reg_write(UC_X86_REG_DI, actor)
    cpu.reg_write(UC_X86_REG_AX, 1)
    call(cpu, word(cpu, actor + 6))
    assert word(cpu, actor + 0x24) == case["health"]
    assert word(cpu, actor + 4) == 0xC746
    registers, pixels = {8: 255}, set()

    def flash_out(_cpu, port, size, value, _data):
        if port == 0x3CE:
            registers["index"] = value & 255
            if size == 2:
                registers[value & 255] = value >> 8
        elif port == 0x3CF:
            registers[registers["index"]] = value

    def flash_write(_cpu, _access, address, size, _value, _data):
        assert size == 1 and registers[1] == 15 and registers[0] == 7
        pixels.update((address - 0xA0000) * 8 + bit for bit in range(8) if registers[8] & (0x80 >> bit))

    cpu.hook_add(UC_HOOK_INSN, flash_out, None, 1, 0, UC_X86_INS_OUT)
    cpu.hook_add(UC_HOOK_MEM_WRITE, flash_write, begin=0xA0000, end=0xA1FFF)
    cpu.reg_write(UC_X86_REG_SI, actor)
    call(cpu, 0xC746)
    assert sorted(pixels) == case["pixels"], ("stage-four wall gun flash", event, len(pixels), len(case["pixels"]))
    assert word(cpu, actor + 4) == 0x761
print("PASS stage-four wall gun hit paint: both initial poses, palette-7 pixels, clipping and callback reset")


for case in boss_cases:
    cpu, _ = machine(case["event"], case["initial"], case["initialSeed"])
    parts = list(actors(cpu, 0x904A))
    assert len(parts) == 19
    drawn = []

    def boss_draw(uc, address, _size, _data):
        address -= LOAD * 16
        if address in (0x941, 0x963):
            width, height, x, y, tile_address = [
                uc.reg_read(reg) for reg in (UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_CX,
                                             UC_X86_REG_DX, UC_X86_REG_SI)]
            tiles = struct.unpack_from(f"<{width * height}H", image, tile_address)
            drawn.append([address == 0x963, width, height, signed(x) * 2, signed(y), list(tiles)])
        elif address == 0x853:
            actor = uc.reg_read(UC_X86_REG_SI)
            drawn.append([word(uc, actor + off, signed=off != 0xC) for off in (0xC, 0x12, 0x16)])
        else:
            return
        pop_return(uc)

    cpu.hook_add(UC_HOOK_CODE, boss_draw)
    for state in case["states"]:
        context = (case["profile"], state["tick"])
        drawn.clear()
        word(cpu, 0x9198, state["delta"])
        word(cpu, 0x919C, state["tick"])
        word(cpu, 0x91AA, state["ceiling"])
        word(cpu, 0x9F12, state["player"]["x"])
        word(cpu, 0x9F16, state["player"]["y"])
        cpu.reg_write(UC_X86_REG_BX, 0x5A5A)
        for index, actor in enumerate(parts):
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 2))
            assert cpu.reg_read(UC_X86_REG_BX) == state["carry"][index], (
                context, "BX", index, cpu.reg_read(UC_X86_REG_BX), state["carry"][index])
        if state["damage"]:
            index, damage = state["damage"]
            cpu.reg_write(UC_X86_REG_DI, parts[index])
            cpu.reg_write(UC_X86_REG_AX, damage)
            call(cpu, word(cpu, parts[index] + 6))
        alive_parts = list(actors(cpu, 0x904A))
        assert bool(alive_parts) != state["dead"], context
        for index, actor in enumerate(alive_parts):
            def at(off, signed=False):
                return word(cpu, actor + off, signed=signed)

            box = [at(off, True) for off in range(0x28, 0x30, 2)] if at(0x28) != 1000 else None
            x, y = at(0x12, True), at(0x16, True)
            if not index:
                actual = [x, y, at(0x24), at(0x48), at(0x1A), box]
            elif index < 3:
                actual = [x, y, at(0x1C, True), at(0x48), at(6) == 0x761, box]
            else:
                actual = [(x << 16) + at(0x14), (y << 16) + at(0x18), (at(0x1C) << 16) + at(0x1E),
                          (at(0x3E, True) << 16) + at(0x3C), at(0x40, True), at(0x42), at(0xC), box]
            assert actual == state["parts"][index], (context, index, actual, state["parts"][index])
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, at(4))
        assert drawn == state["draw"], (context, drawn, state["draw"])
        assert word(cpu, 0x9212) == state["turrets"], context
        assert word(cpu, 0x91AA) == state["reverseCeiling"], context
        assert word(cpu, 0x304A) == state["seed"], context
        assert word(cpu, 0x9164) == len(state["credits"]), context
        bullets, effects, credits = [], [], []
        for actor in list(actors(cpu, 0x9096)):
            kind = word(cpu, actor)
            xy = [word(cpu, actor + off, signed=True) for off in (0x12, 0x16)]
            if kind == 0x14:
                bullets.append(xy + [word(cpu, actor + off) for off in (0x1C, 0xC, 0xE)])
            elif kind == 0xC:
                effects.append(xy)
            else:
                assert kind in (0x60, 0x18), (context, kind)
                credits.append(xy + [50 if kind == 0x60 else 100])
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, 0x7A0)
        assert bullets[::-1] == state["bullets"], (context, bullets, state["bullets"])
        assert effects[::-1] == state["effects"], (context, effects, state["effects"])
        assert credits == state["credits"], (context, credits, state["credits"])
    print(f"PASS stage-four boss {case['profile']}: {len(case['states'])} controller ticks, "
          "all parts, fixed-point beam, aimed shots, draw calls, damage, cleanup and rewards")

linked_boss_cases = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game,frameAt} from './src/game.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), seed=0x5845;
const frame=f=>(f.offset+8)|f.bank;
const profiles=[[4,21],[4,22],[4,64],[2,22],[2,23],[2,120]];
console.log(JSON.stringify(profiles.map(([type,count])=>{
 const camera=type===4?0:2390;
 const event=campaign.stages[3].background.find(e=>e[1]===type).slice();
 const wall=[camera,1,0,0,104,camera+80,0];
 const game=new Game(campaign);game.start(4);
 const pool=game.run.actorPool, lists=game.actorLists;
 pool.free.splice(0,pool.free.length-count);
 const first=pool.free.at(-1);
 pool.fireCounterLowBytes.set(first+0x4c,240);
 pool.fireCounterHighBytes.set(first+0x4c,0x33);
 game.camera=game.control.camera=game.control.ceiling=game.endCamera=camera;
 game.seed=seed;
 Object.assign(game.player,{x:300,y:174});
 game.shipTouchesTerrain=()=>false;
 event[0]=camera;
 game.assets={...game.assets,events:[],background:[wall,event]};
 game.dispatchCameraEvents();
 const arena=type===4?game.boss:game.miniboss, parts=arena.parts;
 const core=parts[type===4?0:4];
 const firing=type===4?[0,1,2]:[5,15,16];
 if(type===2)parts[5].counter=240;
 game.ground[0].fireCounter=255;
 for(const i of firing.slice(1))parts[i].counter=255;
 const spent={x:20,y:80,dx:0,dy:0,dead:true};
 game.addPooledHostileRound(spent,4);
 pool.subpixels.set(spent.actorAddress,[0x7000,0x4800]);
 const snapshot=()=>({
  main:lists.get(ActorList.main).map(({address,type,actor})=>[address,actor.dead?4:type]),
  arena:firing.map(i=>parts[i]).filter(a=>!a.dead&&!arena.dead)
   .map(a=>[a.counter,pool.fireCounterHighBytes.get(a.actorAddress)??0]),
  phase:type===4&&!arena.dead?core.phase:null,
  transient:lists.get(ActorList.transient).map(({address,type,actor:a})=>a.dead?[address,4]:[address,type,a.x,a.y,
   ...(type===0x14?[a.direction,frame(a.frame),a.xFixed&65535,a.yFixed&65535]:
   type===0x0c?[frame(frameAt(a.frames,a.age))]:[a.direction])]),
  free:pool.free.at(-1)??0,seed:game.seed,credits:game.countedCredits
 });
 game.update();
 const fired=snapshot();
 const attacks=type===4?[[1,50],[2,50],[0,100]]:[[15,127],[16,127],[17,127],[18,127],[19,127],[5,175]];
 for(const [i,damage] of attacks){
  const a=parts[i], x=a.box.x+(a.box.w>>1),y=a.box.y+(a.box.h>>1);
  game.hitWithWeapon(a,{damage,point:true,x,y});
 }
 return {type,camera,seed,event,wall,count,first,spent:spent.actorAddress,firing,attacks,fired,death:snapshot()};
})));
""",
], cwd=ROOT))

for case in linked_boss_cases:
    first, count, kind = case["first"], case["count"], case["type"]
    cpu, _ = machine(None, case["camera"], case["seed"], range(first, first + count * 0x4C, 0x4C))
    cpu.mem_write((LOAD + 0x349B) * 16, base64.b64decode(corridor_cases["shared"]))
    cpu.mem_write(DS, struct.pack("<6000H", *corridor_cases["map"]))
    call(cpu, 0xC79F)
    if kind == 4:
        word(cpu, first + 0x4C + 0x48, 0x33F0)
    for event, constructor in ((case["wall"], 0xC5C3), (case["event"], 0xBC00 if kind == 4 else 0xC12C)):
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        cpu.reg_write(UC_X86_REG_DI, 0xF000)
        call(cpu, constructor)
    wall, *parts = actors(cpu, 0x904A)
    core = parts[0]
    firing = [parts[i] for i in case["firing"]]
    if kind == 2:
        word(cpu, firing[0] + 0x48, 240)
    for actor in (wall, *firing[1:]):
        word(cpu, actor + 0x48, 255)
    spent = case["spent"]
    call(cpu, 0x1022)
    assert cpu.reg_read(UC_X86_REG_SI) == spent
    cpu.reg_write(UC_X86_REG_DI, 0x9096)
    call(cpu, 0x77C)
    call(cpu, 0x7C0)
    for offset, value in [(spent + 0x14, 0x7000), (spent + 0x18, 0x4800), (0x919C, 1),
                          (0x9F12, 300), (0x9F16, 174), (0x9F28, 1000), (0x9F2C, 1000)]:
        word(cpu, offset, value)

    def skip_boss_paint(uc, _address, _size, _data):
        uc.reg_write(UC_X86_REG_IP, 0x3716)

    cpu.hook_add(UC_HOOK_CODE, skip_boss_paint, begin=LOAD * 16 + 0x3713, end=LOAD * 16 + 0x3713)

    def linked_boss_snapshot():
        transient = []
        for actor in actors(cpu, 0x9096):
            kind = word(cpu, actor)
            if kind == 4:
                transient.append([actor, 4])
                continue
            row = [actor, kind] + [word(cpu, actor + off, signed=True) for off in (0x12, 0x16)]
            fields = (0x1C, 0xC, 0x14, 0x18) if kind == 0x14 else (0xC,) if kind == 0x0C else (0x1C,)
            transient.append(row + [word(cpu, actor + off) for off in fields])
        return {"main": [[actor, word(cpu, actor)] for actor in actors(cpu, 0x904A)],
                "arena": [[word(cpu, a + 0x48) & 255, word(cpu, a + 0x48) >> 8]
                          for a in firing if word(cpu, a) == (0x50 if case["type"] == 4 else 0x54)],
                "phase": word(cpu, core + 0x1A) if case["type"] == 4 and word(cpu, core) == 0x50 else None,
                "transient": transient, "free": word(cpu, 0x8E7C),
                "seed": word(cpu, 0x304A), "credits": word(cpu, 0x9164)}

    call(cpu, 0x3682)
    assert (actual := linked_boss_snapshot()) == case["fired"], (kind, count, "fired", actual, case["fired"])
    for index, damage in case["attacks"]:
        actor = parts[index]
        x1, y1, x2, y2 = (word(cpu, actor + offset, signed=True) for offset in range(0x28, 0x30, 2))
        x, y = (x1 + x2 + 1) // 2, (y1 + y2 + 1) // 2
        for offset, coord in zip(range(0x8EB4, 0x8EBC, 2), (x, y, x, y)):
            word(cpu, offset, coord)
        cpu.reg_write(UC_X86_REG_DI, actor)
        cpu.reg_write(UC_X86_REG_AX, damage)
        call(cpu, word(cpu, actor + 6))
    assert (actual := linked_boss_snapshot()) == case["death"], (kind, count, "death", actual, case["death"])
print("PASS stage-four linked arenas: mixed wall/boss slot order, same-tick rounds, retained fractions and full-pool core cleanup")

mid_cases = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game} from './src/game.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), assets=campaign.stages[3];
const bounds=b=>[b.x,b.y,b.x+b.w-1,b.y+b.h-1];
const frame=f=>(f.offset+8)|f.bank;
const event=assets.background.find(e=>e[1]===2);
const cases=[];
for(const profile of ['survive','tail-first','guns-first']){
  const initial=profile==='survive'?event[0]:2390, initialSeed=0x5FAE;
  const g=new Game(campaign);
  g.start(4);
  g.seed=initialSeed;
  g.camera=initial;
  g.map.fill(0x5a5a,0x1658/2,0x1658/2+320);
  const mid=g.miniboss;
  mid.spawn(g);
  const states=[];
  const order=profile==='tail-first'?[15,16,17,18,19]:[19,18,17,16,15];
  for(let tick=1;tick<=520;tick++){
    const delta=profile==='survive'?(tick<=250?1:tick%60<16?-1:tick%60<32?1:0):0;
    const ceiling=profile==='survive'&&tick<130?initial-tick:2176;
    Object.assign(g.control,{delta,ceiling});
    const player={x:24+tick*5%272,y:16+tick*9%160};
    Object.assign(g,{tick,player,bullets:[],sounds:[],pickups:[],effects:[]});
    let bx=0x5a5a;
    const carry=mid.parts.map(actor=>actor.dead?null:(bx=mid.updatePart(actor,g,bx))&65535);
    let damage=null;
    if(profile!=='survive'){
      const step=tick>=100&&tick<=200&&tick%25===0?(tick-100)/25:-1;
      if(step>=0)damage=[order[step],127,false];
      else if(tick===50)damage=[17,10,true];
      else if(tick===65)damage=[4,127,false];
      else if(tick===225)damage=[5,14,false];
      else if(tick===240)damage=[4,161,false];
    }
    if(damage){
      const [index,dmg,edge]=damage, actor=mid.parts[index];
      const x=actor.box.x+Math.floor(actor.box.w/2),y=actor.box.y+(edge?0:Math.floor(actor.box.h/2));
      damage.push(x,y);
      g.hitWithWeapon(actor,{point:true,x,y,damage:dmg});
    }
    const parts=mid.parts.map(a=>a.dead?null:[a.motion.x,a.motion.y,a.heading,a.turn,a.acceleration,a.length,
      frame(a.frame),a.frameTicks,bounds(a.box),Boolean(a.hit)]);
    const bullets=g.bullets.slice().reverse().map(b=>[b.x,b.y,b.direction,frame(b.frame),b.frames?.[0].duration??0]);
    const effects=g.effects.map(({x,y})=>[x,y]);
    const patches=mid.dead?Array.from(g.map.slice(0x1658/2,0x1658/2+320),(tile,i)=>[0x1658/2+i,tile]):[];
    states.push({tick,delta,ceiling,player,damage,seed:g.seed,parts,bullets,effects,patches,carry,dead:!!mid.dead,
      health:mid.parts[4].health,remaining:mid.remaining,extension:mid.extension,score:g.score,
      floor:g.endCamera,reverseCeiling:g.control.ceiling,scroll:g.control.scrollDirection,
      credits:g.pickups.map(p=>[p.x,p.y,p.value])});
    if(mid.dead)break;
    for (const slot of (g.actorLists.get(ActorList.transient)??[]).slice())
      g.run.actorPool.release(g.actorLists,ActorList.transient,slot);
  }
  cases.push({profile,event,initial,initialSeed,states});
}
console.log(JSON.stringify(cases));
""",
], cwd=ROOT))


for case in mid_cases:
    cpu, _ = machine(case["event"], case["initial"], case["initialSeed"])
    for offset in range(0x1656, 0x18DA, 2):
        word(cpu, offset, 0x5A5A)
    parts = list(actors(cpu, 0x904A))
    assert len(parts) == 20
    for state in case["states"]:
        context = (case["profile"], state["tick"])
        word(cpu, 0x9198, state["delta"])
        word(cpu, 0x919C, state["tick"])
        word(cpu, 0x91AA, state["ceiling"])
        word(cpu, 0x9F12, state["player"]["x"])
        word(cpu, 0x9F16, state["player"]["y"])
        cpu.reg_write(UC_X86_REG_BX, 0x5A5A)
        for index, actor in enumerate(parts):
            if word(cpu, actor) == 4:
                continue
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 2))
            assert cpu.reg_read(UC_X86_REG_BX) == state["carry"][index], (
                context, "BX", index, cpu.reg_read(UC_X86_REG_BX), state["carry"][index])
        if state["damage"]:
            index, damage, _, x, y = state["damage"]
            for offset, pos in zip(range(0x8EB4, 0x8EBC, 2), (x, y, x, y)):
                word(cpu, offset, pos)
            shot = 0xF080
            word(cpu, shot, 0x14)
            cpu.reg_write(UC_X86_REG_SI, shot)
            cpu.reg_write(UC_X86_REG_DI, parts[index])
            cpu.reg_write(UC_X86_REG_AX, damage)
            call(cpu, word(cpu, parts[index] + 6))
        for index, actor in enumerate(parts):
            def at(off, signed=False):
                return word(cpu, actor + off, signed=signed)

            actual = None
            if at(0) == 0x54:
                box = [at(off, True) for off in range(0x28, 0x30, 2)]
                actual = [at(0x12, True), at(0x16, True), (at(0x1C) << 16) + at(0x1E),
                          (at(0x3E, True) << 16) + at(0x3C), at(0x40, True), at(0x42), at(0xC),
                          at(0xE), box, at(4) == 0x8B9]
            assert actual == state["parts"][index], (context, index, actual, state["parts"][index])
            if at(4) == 0x8B9:
                word(cpu, actor + 4, 0x853)  # The white renderer restores the normal draw callback.
        assert word(cpu, 0x9210) == state["remaining"], context
        assert word(cpu, parts[0] + 0x1A) == state["extension"], context
        assert word(cpu, parts[4] + 0x24, signed=True) == state["health"], context
        assert word(cpu, 0x91A8) == state["floor"], context
        assert word(cpu, 0x91AA) == state["reverseCeiling"], context
        assert word(cpu, 0x918C, signed=True) == state["scroll"], context
        assert word(cpu, 0x304A) == state["seed"], context
        assert word(cpu, 0x9152) == state["score"], context
        assert word(cpu, 0x9164) == len(state["credits"]), context
        if state["dead"]:
            assert word(cpu, 0x9190) == 2208, context
            cleared = [[offset // 2, word(cpu, offset)] for offset in range(0x1658, 0x18D8, 2)]
            assert cleared == state["patches"] and all(tile == 0 for _, tile in cleared), context
            assert word(cpu, 0x1656) == word(cpu, 0x18D8) == 0x5A5A, context
        bullets, effects, credits = [], [], []
        for actor in list(actors(cpu, 0x9096)):
            kind = word(cpu, actor)
            xy = [word(cpu, actor + off, signed=True) for off in (0x12, 0x16)]
            if kind == 0x14:
                bullets.append(xy + [word(cpu, actor + off) for off in (0x1C, 0xC, 0xE)])
            elif kind == 0xC:
                effects.append(xy)
            else:
                assert kind in (0x60, 0x18), (context, kind)
                credits.append(xy + [50 if kind == 0x60 else 100])
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, 0x7A0)
        assert bullets[::-1] == state["bullets"], (context, bullets, state["bullets"])
        assert effects[::-1] == state["effects"], (context, effects, state["effects"])
        assert credits == state["credits"], (context, credits, state["credits"])
    print(f"PASS stage-four miniboss {case['profile']}: {len(case['states'])} controller ticks, "
          "all parts, fixed-point arms, aimed/ring fire, guarded damage, reverse and rewards")

arena_predecessors = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game} from './src/game.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), seed=0x5845;
const path=[10,148,90,4,50,0];
console.log(JSON.stringify([2,4].map(type=>{
 const game=new Game(campaign);game.start(4);game.seed=seed;
 const {actorPool:pool}=game.run, lists=game.actorLists, main=()=>lists.get(ActorList.main);
 game.camera=type===4?0:2390;
 Object.assign(game.player,{x:160,y:170});
 const event=game.assets.background.find(e=>e[1]===type);
 const donor=[game.camera,3,1,1,0,0,3], waiting=[game.camera,3,1,1,0,199,3];
 game.assets={...game.assets,paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]}};
 const arc=[161,85,0xfedc,0x7654,64,0xabcd,0x1234,-2,111,5];
 if(type===2){
  game.spawn(donor,[256,258]);
  const [x,y,xf,yf,angle,hf,t,th,accel,length]=arc, actor=game.enemies[0];
  Object.assign(actor.motion,{xFixed:x*65536+xf,yFixed:y*65536+yf,heading:angle*65536+hf,
   turn:th*65536+t,acceleration:accel});
  actor.speed=length;
  game.saveActorMotion(actor,actor.motion);
 }
 game.spawn(waiting,[256,258]);
 const followerTarget=game.enemies.at(-1), waitingSlot=main().shift();
 followerTarget.fireCounter=255;
 followerTarget.motion.remaining=-8;
 const boss=type===4?game.boss:game.miniboss;
 boss.spawn(game);
 main().push(waitingSlot);
 const removed=boss.parts[type===4?3:0], part=boss.parts[type===4?4:1];
 const first=type===4?waitingSlot.address:game.enemies[0].actorAddress;
 pool.release(lists,ActorList.main,pool.recordsByAddress.get(removed.actorAddress));
 if(type===4)game.destroy(boss.parts[2]);
 else game.explode(212,30,true,true);
 const inherited=game.updateStageFourMainActor(pool.recordsByAddress.get(part.actorAddress),0x5a5a);
 const carry=game.updateStageFourMainActor(waitingSlot,inherited);
 const target=game.bullets[0];
 return {type,camera:game.camera,seed,first,event,path,arc,donor,waiting,part:part.actorAddress,
  removed:removed.actorAddress,replacement:game.effects[0].actorAddress,
  state:[part.xFixed,part.yFixed,part.heading,part.turn,part.acceleration,part.length,inherited&65535,carry,
   target.x,target.y,target.direction,game.seed]};
})));
""",
], cwd=ROOT))

for case in arena_predecessors:
    first, kind = case["first"], case["type"]
    cpu, _ = machine(None, case["camera"], case["seed"], range(first, first + 40 * 0x4C, 0x4C))
    cpu.mem_write((LOAD + 0x349B) * 16, base64.b64decode(corridor_cases["shared"]))
    call(cpu, 0xC79F)
    word(cpu, 0xDE30, 0xF100)
    cpu.mem_write(DS + 0xF100, struct.pack("<6h", *case["path"]))
    word(cpu, 0x9F12, 160)
    word(cpu, 0x9F16, 170)

    def spawn_arena_wave(event):
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        cpu.reg_write(UC_X86_REG_BX, event[1])
        call(cpu, 0xC771)
        return word(cpu, 0x9054)

    if kind == 2:
        donor = spawn_arena_wave(case["donor"])
        for offset, value in zip((0x12, 0x16, 0x14, 0x18, 0x1C, 0x1E, 0x3C, 0x3E, 0x40, 0x42), case["arc"]):
            word(cpu, donor + offset, value)
    waiting = spawn_arena_wave(case["waiting"])
    word(cpu, waiting + 0x48, 0xC7FF)
    cpu.reg_write(UC_X86_REG_SI, waiting)
    call(cpu, 0x7DC)
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["event"]))
    cpu.reg_write(UC_X86_REG_DI, 0xF000)
    call(cpu, 0xBC00 if kind == 4 else 0xC12C)
    parts = [a for a in actors(cpu, 0x904A) if word(cpu, a) in (0x50, 0x54)]
    assert case["removed"] in parts and case["part"] in parts
    cpu.reg_write(UC_X86_REG_SI, waiting)
    cpu.reg_write(UC_X86_REG_DI, 0x904A)
    call(cpu, 0x78E)
    cpu.reg_write(UC_X86_REG_SI, case["removed"])
    call(cpu, 0x7A0)
    if kind == 4:
        cpu.reg_write(UC_X86_REG_DI, parts[2])
        cpu.reg_write(UC_X86_REG_AX, 50)
        call(cpu, 0xB930)
    else:
        for reg, value in ((UC_X86_REG_AX, 212), (UC_X86_REG_BX, 30), (UC_X86_REG_BP, 0x124C), (UC_X86_REG_DX, 0x853)):
            cpu.reg_write(reg, value)
        call(cpu, 0x3326)
    assert word(cpu, 0x90A0) == case["replacement"] == case["removed"]
    part = case["part"]
    cpu.reg_write(UC_X86_REG_SI, part)
    cpu.reg_write(UC_X86_REG_BX, 0x5A5A)
    call(cpu, word(cpu, part + 2))
    inherited = cpu.reg_read(UC_X86_REG_BX)
    word(cpu, waiting + 0x1A, -8)
    cpu.reg_write(UC_X86_REG_SI, waiting)
    call(cpu, word(cpu, waiting + 2))
    shot = word(cpu, 0x90A0)
    assert word(cpu, shot) == 0x14

    def fixed(hi, lo, signed=True):
        return word(cpu, part + hi, signed=signed) * 65536 + word(cpu, part + lo)

    actual = [fixed(0x12, 0x14), fixed(0x16, 0x18), fixed(0x1C, 0x1E, False), fixed(0x3E, 0x3C),
              word(cpu, part + 0x40, signed=True), word(cpu, part + 0x42), inherited, cpu.reg_read(UC_X86_REG_BX),
              *[word(cpu, shot + off) for off in (0x12, 0x16, 0x1C)], word(cpu, 0x304A)]
    assert actual == case["state"], (kind, actual, case["state"])
print("PASS stage-four reclaimed arena predecessors: original fixed-point limb motion, BX carry and the next aimed shot")

arena_damage = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game} from './src/game.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), camera=2390, seed=0x5845;
const event=campaign.stages[3].background.find(e=>e[1]===2);
const cases=['gun','core'].map(mode=>{
 const game=new Game(campaign);game.start(4);game.camera=camera;game.seed=seed;
 const {actorPool:pool}=game.run, lists=game.actorLists, mid=game.miniboss;
 mid.spawn(game);
 const [, , , limb, core, gun]=mid.parts;
 limb.health=20;
 const removed=mode==='gun'?core:gun, hit=mode==='gun'?gun:core;
 pool.release(lists,ActorList.main,pool.recordsByAddress.get(removed.actorAddress));
 const blast=game.explode(212,30,true,true);
 const steps=[14,14,...(mode==='gun'?[6]:[])].map((damage,i)=>{
  if(i)mid.remaining=0;
  game.hitWithWeapon(hit,{damage});
  return {damage,remaining:mid.remaining,score:game.score,seed:game.seed,camera:game.camera,credits:game.countedCredits,
   links:lists.get(ActorList.main).map(({address,actor,type})=>
    [address,actor.dead?4:type,actor.health,!actor.dead&&actor.flashTick===game.tick]),
   blastFlash:blast.actor.flashTick===game.tick};
 });
 return {mode,first:mid.parts[0].actorAddress,event,removed:removed.actorAddress,
  hit:hit.actorAddress,camera,seed,steps};
});
console.log(JSON.stringify(cases));
""",
], cwd=ROOT))

for case in arena_damage:
    first = case["first"]
    cpu, _ = machine(case["event"], case["camera"], case["seed"], range(first, first + 80 * 0x4C, 0x4C))
    parts = list(actors(cpu, 0x904A))
    word(cpu, parts[3] + 0x24, 20)
    removed = case["removed"]
    cpu.reg_write(UC_X86_REG_SI, removed)
    call(cpu, 0x7A0)
    for reg, value in ((UC_X86_REG_AX, 212), (UC_X86_REG_BX, 30), (UC_X86_REG_BP, 0x124C), (UC_X86_REG_DX, 0x853)):
        cpu.reg_write(reg, value)
    call(cpu, 0x3326)
    assert word(cpu, 0x90A0) == removed and word(cpu, removed) == 0xC
    for i, step in enumerate(case["steps"]):
        if i:
            word(cpu, 0x9210, 0)
        cpu.reg_write(UC_X86_REG_DI, case["hit"])
        cpu.reg_write(UC_X86_REG_AX, step["damage"])
        call(cpu, word(cpu, case["hit"] + 6))
        actual = {
            "damage": step["damage"], "remaining": word(cpu, 0x9210), "score": word(cpu, 0x9152),
            "seed": word(cpu, 0x304A), "camera": word(cpu, 0x9190), "credits": word(cpu, 0x9164),
            "links": [[a, word(cpu, a), word(cpu, a + 0x24, signed=True), word(cpu, a + 4) == 0x8B9]
                      for a in actors(cpu, 0x904A)], "blastFlash": word(cpu, removed + 4) == 0x8B9,
        }
        assert actual == step, ("stage-four arena relinked damage", case["mode"], i,
                                {k: (v, step[k]) for k, v in actual.items() if v != step[k]})
print("PASS stage-four miniboss relinked damage: guarded hits, raw predecessor health and successor flash, lethal cleanup")

tail_deaths = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game,frameAt} from './src/game.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), camera=2390, seed=0x5845;
const event=campaign.stages[3].background.find(e=>e[1]===2);
const cases=['gap','full','gap-full'].map(mode=>{
 const game=new Game(campaign);game.start(4);game.camera=camera;game.seed=seed;
 const {actorPool:pool}=game.run, lists=game.actorLists, mid=game.miniboss;
 const count=mode==='gap'?40:20, first=pool.free.at(-1);
 pool.free.splice(0,pool.free.length-count);
 mid.spawn(game);
 let removed;
 if(mode!=='full'){
  removed=pool.recordsByAddress.get(mid.parts[11].actorAddress);
  pool.release(lists,ActorList.main,removed);
  game.explode(212,30,true,true);
 }
 game.hitWithWeapon(mid.parts[15],{damage:127});
 const main=lists.get(ActorList.main).map(({address,actor,type})=>[address,actor.dead?4:type]);
 const transient=lists.get(ActorList.transient).map(({address,actor,type})=>[address,actor.dead?4:type,
  actor.x,actor.y,(frameAt(actor.frames,actor.age).offset+8)|frameAt(actor.frames,actor.age).bank]);
 return {mode,first,count,event,removed:removed?.address,camera,seed,result:{main,transient,remaining:mid.remaining,
  score:game.score,seed:game.seed,scroll:game.control.scrollDirection,free:pool.free.at(-1)??0}};
});
console.log(JSON.stringify(cases));
""",
], cwd=ROOT))

for case in tail_deaths:
    first, count = case["first"], case["count"]
    cpu, _ = machine(case["event"], case["camera"], case["seed"], range(first, first + count * 0x4C, 0x4C))
    cpu.mem_write((LOAD + 0x349B) * 16, base64.b64decode(corridor_cases["shared"]))
    parts = list(actors(cpu, 0x904A))
    if removed := case.get("removed"):
        cpu.reg_write(UC_X86_REG_SI, removed)
        call(cpu, 0x7A0)
        for reg, value in ((UC_X86_REG_AX, 212), (UC_X86_REG_BX, 30), (UC_X86_REG_BP, 0x124C), (UC_X86_REG_DX, 0x853)):
            cpu.reg_write(reg, value)
        call(cpu, 0x3326)
        assert word(cpu, 0x90A0) == removed
    cpu.reg_write(UC_X86_REG_DI, parts[15])
    cpu.reg_write(UC_X86_REG_AX, 127)
    call(cpu, word(cpu, parts[15] + 6))
    actual = {
        "main": [[a, word(cpu, a)] for a in actors(cpu, 0x904A)],
        "transient": [[a, word(cpu, a), word(cpu, a + 0x12, signed=True), word(cpu, a + 0x16, signed=True),
                       word(cpu, a + 0xC)] for a in actors(cpu, 0x9096)],
        "remaining": word(cpu, 0x9210), "score": word(cpu, 0x9152), "seed": word(cpu, 0x304A),
        "scroll": word(cpu, 0x918C, signed=True), "free": word(cpu, 0x8E7C),
    }
    assert actual == case["result"], ("stage-four miniboss tail death", case["mode"], actual, case["result"])
print("PASS stage-four miniboss tail death: live backward traversal, blast reuse at capacity and reverse scroll")

turret_blasts = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {ActorList} from './src/actor-pool.js';
import {Game,frameAt} from './src/game.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), camera=0, seed=0x5845;
const event=campaign.stages[3].background.find(e=>e[1]===4);
const cases=[1,2].map(index=>{
 const game=new Game(campaign);game.start(4);game.camera=camera;game.seed=seed;
 const {actorPool:pool}=game.run, lists=game.actorLists, boss=game.boss;
 const count=19, first=pool.free.at(-1);
 pool.free.splice(0,pool.free.length-count);
 boss.spawn(game);
 const main=lists.get(ActorList.main), [turret]=main.splice(index,1);
 main.unshift(turret);
 game.hitWithWeapon(turret.actor,{damage:50});
 const slot=pool.recordsByAddress.get(turret.address), blast=slot.actor;
 const states=Array.from({length:24},(_,i)=>{
  const delta=i%5-1;
  boss.scrollY=delta;
  game.updateTransientActor(slot);
  const f=frameAt(blast.frames,blast.age), b=blast.box;
  return {delta,x:blast.x,y:blast.y,frame:(f.offset+8)|f.bank,box:[b.x,b.y,b.x+b.w-1,b.y+b.h-1],
   type:blast.dead?4:slot.type,heading:pool.headings.get(slot.address)};
 });
 return {index,first,count,event,camera,seed,states,turrets:boss.turrets};
});
console.log(JSON.stringify(cases));
""",
], cwd=ROOT))

for case in turret_blasts:
    first, count = case["first"], case["count"]
    cpu, _ = machine(case["event"], case["camera"], case["seed"], range(first, first + count * 0x4C, 0x4C))
    turret = list(actors(cpu, 0x904A))[case["index"]]
    cpu.reg_write(UC_X86_REG_SI, turret)
    call(cpu, 0x7DC)
    cpu.reg_write(UC_X86_REG_DI, 0x904A)
    call(cpu, 0x77C)
    cpu.reg_write(UC_X86_REG_DI, turret)
    cpu.reg_write(UC_X86_REG_AX, 50)
    call(cpu, word(cpu, turret + 6))
    assert word(cpu, 0x90A0) == turret and word(cpu, turret + 2) == 0xBAAB
    assert word(cpu, 0x9212) == case["turrets"]
    for i, state in enumerate(case["states"]):
        word(cpu, 0x9214, state["delta"])
        cpu.reg_write(UC_X86_REG_SI, turret)
        cpu.reg_write(UC_X86_REG_BX, 0x5A5A)
        call(cpu, 0x36FC)
        assert cpu.reg_read(UC_X86_REG_BX) == 0x5A5A
        actual = {"delta": state["delta"], "x": word(cpu, turret + 0x12, signed=True),
                  "y": word(cpu, turret + 0x16, signed=True), "frame": word(cpu, turret + 0xC),
                  "box": [word(cpu, turret + off, signed=True) for off in range(0x28, 0x30, 2)],
                  "type": word(cpu, turret), "heading": word(cpu, turret + 0x1C)}
        assert actual == state, ("stage-four self-reused turret blast", case["index"], i, actual, state)
print("PASS stage-four final turret self-reuse: blast preserves frame and moves with the arena, including bounds and BX")
