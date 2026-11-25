"""Compare stage three with DOS, correcting the worm bullet timer in memory."""

import json
from pathlib import Path
import struct
import subprocess

from unicorn import Uc, UC_ARCH_X86, UC_MODE_16, UC_HOOK_CODE
from unicorn.x86_const import (
    UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_BP, UC_X86_REG_CS, UC_X86_REG_CX,
    UC_X86_REG_DI, UC_X86_REG_DS, UC_X86_REG_DX, UC_X86_REG_ES, UC_X86_REG_IP,
    UC_X86_REG_SI, UC_X86_REG_SP, UC_X86_REG_SS, UC_X86_REG_EFLAGS,
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

# Read animation duration, not its sprite pointer; leave the disk image untouched.
assert image[0x9CBF:0x9CC3] == bytes.fromhex("2e 8b 46 00")
image[0x9CC2] = 2


def word(cpu, offset, value=None, signed=False):
    if value is not None:
        cpu.mem_write(DS + offset, struct.pack("<H", value & 65535))
    return struct.unpack("<h" if signed else "<H", cpu.mem_read(DS + offset, 2))[0]


def call(cpu, address):
    cpu.reg_write(UC_X86_REG_SP, 0xFFFC)
    cpu.mem_write(0x9FFFC, b"\x00\xff")
    cpu.emu_start(LOAD * 16 + address, STOP, count=100000)
    assert cpu.reg_read(UC_X86_REG_IP) == 0xFF00, "Original routine did not return"


def returning(cpu):
    sp = cpu.reg_read(UC_X86_REG_SP)
    ip = struct.unpack("<H", cpu.mem_read(0x90000 + sp, 2))[0]
    cpu.reg_write(UC_X86_REG_SP, sp + 2)
    cpu.reg_write(UC_X86_REG_IP, ip)
    return ip


native = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {Game} from './src/game.js';
import {GroundArm,GroundSkater,GroundCrawler,GroundTurret} from './src/stage-three-ground.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(),assets=campaign.stages[2],sprite=f=>assets.lookup[f.bank].get(f.offset);
const pointer=f=>(f.offset+8)|f.bank;
const constructors={1:GroundArm,2:GroundSkater,5:GroundTurret,6:GroundCrawler};
const make=(type,event,camera)=>new constructors[type](event,assets.groundLogic.get(type),camera,sprite);
const mapFor=profile=>Array.from(assets.map,(tile,i)=>profile==='empty'?0:profile==='solid'?1:
 profile==='corners'?((i%20>=5&&i%20<=12&&Math.floor(i/20)%8<4)?1:0):tile);
const serial=a=>{
 if(a instanceof GroundArm)return [a.length,a.extension,a.wait,
  a.chain.map(p=>[p.motion.x,p.motion.y,pointer(p.frame),p.frameTicks,!p.hidden,
   p.box.x,p.box.y,p.box.x+p.box.w-1,p.box.y+p.box.h-1])];
 if(a instanceof GroundSkater)return [a.motion.x,a.motion.y,a.dx,a.attack,pointer(a.frame),a.frameTicks,
  a.box.x,a.box.y,a.box.x+a.box.w-1,a.box.y+a.box.h-1];
 if(a instanceof GroundCrawler)return [a.motion.x,a.motion.y,a.direction,a.fireCounter,pointer(a.frame),a.frameTicks,
  a.box.x,a.box.y,a.box.x+a.box.w-1,a.box.y+a.box.h-1];
 return [a.phase,a.fireCounter,a.health,a.box.x,a.box.y,a.box.x+a.box.w-1,a.box.y+a.box.h-1];
};
const cases=[];
for(const type of [1,2,5,6]){
 const variants=type===6?8:2;
 const profiles=type===6?['empty','solid','corners','map','reverse','expire']:
  type===5?['forward','freeze','boundary','expire']:['forward','reverse','distant','expire'];
 for(let variant=0;variant<variants;variant++)for(const profile of profiles){
  const event=[1120,type,0,type===6?variant:0,variant&&type!==6?248:56,1108,type===1?variant:0];
  if(type===5){event[4]=136;event[5]=1000;}
  const initialCamera=type===5&&profile==='boundary'?992+(variant?27:90):1000;
  const a=make(type,event,initialCamera),map=mapFor(profile);
  if(a.patches)a.patches.forEach((v,i)=>map[a.cell+i%(a.patchWidth||2)+Math.floor(i/(a.patchWidth||2))*20]=v);
  const g=new Game(campaign);g.start(3);g.camera=initialCamera;g.map=map;
  if(type===5&&variant)a.destroy(g);
  let seed=0x5845,previousCamera=initialCamera;const states=[];
  for(let tick=0;tick<(type===6?320:600);tick++){
   const camera=profile==='boundary'||profile==='freeze'?initialCamera:
    profile==='reverse'?1000+(tick<80?-tick:tick-160):1000-Math.min(tick,200);
   const ceiling=profile==='expire'?850:camera+16,delta=previousCamera-camera;previousCamera=camera;
   const player={x:tick%280+20,y:profile==='distant'?190:100};
   const bullets=a.update(camera,ceiling,()=>seed=(seed*0x6255+0x3619)&65535,player,tick,delta,map,
    (cell,value)=>{map[cell]=value;});
   const shots=bullets?(Array.isArray(bullets)?bullets:[bullets]):[];
   const state={camera,ceiling,delta,player,seed,dead:a.dead,state:serial(a),
    bullets:shots.map(b=>[b.x,b.y,b.direction,
     b.corridor?b.corridor.bulletSpeed:type===5&&variant?a.definition.coreBulletSpeed:a.definition.bulletSpeed,
     pointer(b.frame),b.frames.length>1?b.frames.map(f=>[pointer(f),f.duration]):null])};
   if(type===5)state.tiles=Array.from({length:24},(_,i)=>map[a.cell+i%4+Math.floor(i/4)*20]);
   states.push(state);if(a.dead)break;
  }
  cases.push({type,variant,profile,event,initialCamera,states,map:mapFor(profile)});
 }
}
const deaths=[];
for(const type of [1,2,5,6])for(const side of [0,1]){
 const g=new Game(campaign);g.start(3);g.camera=1000;
 const event=[1120,type,0,side?3:2,side?248:56,1108,side];
 const a=make(type,event,g.camera);g.ground=a.chain||[a];if(a.patches)g.patchGround(a,a.patches);
 const states=[];
 for(let hit=0;hit<(type===5?2:1);hit++){
  const target=a.chain?.[7]||a;target.health-=127;g.destroy(target);
  states.push({health:a.health,dead:a.dead,score:g.score,
   effects:g.effects.map(e=>[e.x,e.y,e.large]),
   tiles:type===5?Array.from({length:24},(_,i)=>g.map[a.cell+i%4+Math.floor(i/4)*20]):null});
 }
 deaths.push({type,side,event,states});
}
const corridors=[];
for(const x of [96,128,160,192,224])for(const direction of [0,3,5,7]){
 const g=new Game(campaign);g.start(3);g.camera=1000;g.control.ceiling=1016;
 g.miniboss=undefined;g.endCamera=224;
 g.assets={...g.assets,events:[],background:[]};g.player.x=10;g.player.y=16;
 g.shipTouchesTerrain=()=>false;
 const d=g.assets.groundLogic.get(2),frame=d.bulletFrames[direction>=4?1:0];
 const b={x,y:20,direction,frame,frames:[frame],dx:d.vectors[direction][0]*d.bulletSpeed,
  dy:d.vectors[direction][1]*d.bulletSpeed,fixed:true,corridor:d};
 g.bullets.push(b);const states=[];
 for(let tick=0;tick<60;tick++){
  g.invincible=999;g.update();
  states.push({delta:g.control.delta,state:[b.x,b.y,b.xFixed,b.yFixed,b.direction,pointer(b.frame),!!b.dead]});
  if(b.dead)break;
 }
 corridors.push({x,direction,frame:pointer(frame),states});
}
const compositeState=m=>m.parts.map(a=>{
 const b=a.box,p=a.motion;
 return [p.xFixed,p.yFixed,p.heading,p.turn,p.acceleration,p.remaining,p.cursor,a.speed,
  a.fireCounter,a.amplitude,a.amplitudeDelta,pointer(a.frame),a.frameTicks,a.enabled,
  a.enabled?b.x:1000,b.y,!a.enabled&&a.health>0?1000:b.x+b.w-1,b.y+b.h-1];
});
const cameraEvents=(()=>{
 const game=new Game(campaign);game.start(3);
 const events=[[2816,1,1,1,0,0,3]];
 const background=[[2816,2,0,0,56,2924,0],[2816,5,0,0,136,2872,0],
  assets.background.find(e=>e[1]===3)];
 const path=[10,100,60,2,36,0,0,1000,0];
 const bytes=new Uint8Array(assets.paths.bytes.length+path.length*2);
 bytes.set(assets.paths.bytes);
 const paths={bytes,offsets:assets.paths.offsets.slice()};
 paths.offsets[0]=assets.paths.bytes.length;
 const data=new DataView(bytes.buffer);
 path.forEach((v,i)=>data.setInt16(paths.offsets[0]+i*2,v,true));
 game.assets={...game.assets,events,background,paths};
 game.camera=2817;game.control.ceiling=2832;game.player.x=300;game.player.y=24;
 game.shipTouchesTerrain=()=>false;
 const cell=178*20+8,cells=Array.from({length:24},(_,i)=>cell+i%4+Math.floor(i/4)*20);
 const states=Array.from({length:6},()=>{
  game.update();
  const paint=game.actorPaint?.tick===game.tick?game.actorPaint:undefined;
  const [skater,turret]=game.ground, [enemy]=game.enemies, m=game.miniboss;
  return {camera:game.camera,delta:game.control.delta,ceiling:game.control.ceiling,seed:game.seed,
   painted:[(paint?.enemies??game.enemies).length,(paint?.ground??game.ground).filter(a=>a.spriteActor).length,
    (paint?.minibossParts??m.parts).length],
   paintTiles:cells.map(i=>paint?(paint.mapPatches.get(i)??assets.map[i]):game.map[i]),
   tiles:cells.map(i=>game.map[i]),miniCount:m.parts.length,
   mini:game.tick===1?null:compositeState(m),skater:serial(skater),
   turret:serial(turret).slice(0,turret.box.w?7:4),
   enemy:game.tick===1?null:[enemy.motion.x,enemy.motion.y]};
 });
 return {events,background,path,cells,states};
})();
const miniGame=()=>{
 const g=new Game(campaign);g.start(3);g.camera=g.control.camera=2800;g.control.ceiling=2816;
 g.miniboss.spawn();return g;
};
const composites=[];
for(const health of [[20,20],[0,20],[20,0],[0,0]]){
 const g=miniGame(),m=g.miniboss;m.parts[3].health=health[0];m.parts[4].health=health[1];
 const states=[];
 for(let tick=1;tick<=1000;tick++){
  g.tick=tick;g.control.scroll=1;g.player.x=tick%300+10;g.player.y=tick%150+20;g.bullets=[];
  m.update(g);
  states.push({player:{x:g.player.x,y:g.player.y},state:compositeState(m),seed:g.seed,
   bullets:g.bullets.map(b=>[b.x,b.y,b.direction,b.frames.map(f=>[pointer(f),f.duration])]),
   floor:g.endCamera,ceiling:g.control.ceiling,scroll:g.control.scroll});
 }
 composites.push({health,states});
}
const compositeDeaths=[];
for(const order of [[3,4],[4,3]]){
 const g=miniGame(),m=g.miniboss;
 for(let tick=1;tick<=300;tick++){g.tick=tick;m.update(g);}
 const states=[];
 for(const index of order){
  const a=m.parts[index];a.health-=127;g.destroy(a);
  states.push({index,health:m.parts.slice(3,5).map(a=>a.health),remaining:m.remaining,
   dead:m.dead,score:g.score,seed:g.seed,counted:g.countedCredits,
   effects:g.effects.map(e=>[e.x,e.y,e.large]),credits:g.pickups.map(p=>[p.x,p.y,p.value])});
 }
 const gates=[];
 for(let tick=0;tick<3;tick++){g.control.scroll=1;m.update(g);gates.push([g.endCamera,g.control.ceiling,g.control.scroll]);}
 compositeDeaths.push({order,states,gates});
}
const wormState=b=>b.parts.map(a=>{
 const p=a.motion,v=a.box;
 return [p.xFixed,p.yFixed,p.heading,p.turn,p.acceleration,p.remaining,p.cursor,
  pointer(a.frame),a.frameTicks,a.fireCounter,a.dead,v.x,v.y,v.x+v.w-1,v.y+v.h-1];
});
const wormGame=()=>{
 const g=new Game(campaign);g.start(3);g.endCamera=0;g.miniboss.dead=true;
 return g;
};
const worms=[];
for(let selection=0;selection<7;selection++)for(const profile of ['freeze','approach','reverse']){
 const g=wormGame(),b=g.boss;b.pathCounter=selection?1:0;b.pathSeed=selection?selection<<5:0xe496;
 let previous=profile==='freeze'?0:profile==='approach'?320:208;const states=[];
 for(let tick=0;tick<600;tick++){
  const camera=profile==='freeze'?0:profile==='approach'?Math.max(0,320-tick):
   tick<150?208-tick:tick<310?58+tick-150:Math.max(0,218-(tick-310));
  g.camera=camera;g.control.delta=previous-camera;g.control.scroll=camera>previous?-1:1;
  previous=camera;g.bullets=[];b.update(g);g.miniboss.update(g);
  states.push({camera,delta:g.control.delta,scroll:g.control.scroll,state:wormState(b),
   pathCounter:b.pathCounter,pathSeed:b.pathSeed,present:b.present,ceiling:g.control.ceiling,
   bullets:g.bullets.map(p=>[p.x,p.y,p.direction,b.definition.bulletSpeed,pointer(p.frame),p.frame.duration])});
 }
 worms.push({selection,profile,states});
}
const wormDeaths=[];
for(const damage of [[1,79],[80],[81],[127]]){
 const g=wormGame(),b=g.boss;g.camera=0;g.control.delta=0;g.control.scroll=1;
 for(let tick=0;tick<20;tick++){b.update(g);g.miniboss.update(g);}
 g.bullets=[{x:160,y:120,dx:0,dy:1}];g.enemies=[{}];g.ground=[{}];const states=[];
 for(const amount of damage){
  b.parts[0].health-=amount;if(b.health<=0)g.destroy(b.parts[0]);
  states.push({health:b.health,dead:b.dead,pending:b.rewardsPending,seed:g.seed,score:g.score,
   effects:g.effects.map(e=>[e.x,e.y,e.large]),counted:g.countedCredits});
 }
 for(let tick=0;tick<10;tick++){b.update(g);g.miniboss.update(g);}
 wormDeaths.push({damage,states,seed:g.seed,counted:g.countedCredits,
  credits:g.pickups.map(p=>[p.x,p.y,p.value])});
}
const wormBullets=[];
for(let direction=0;direction<8;direction++){
 const g=wormGame(),d=g.boss.definition;g.boss=undefined;g.miniboss.dead=false;
 g.assets={...g.assets,events:[],background:[]};g.camera=0;g.control.ceiling=32;
 g.shipTouchesTerrain=()=>false;g.invincible=999;g.player.x=g.player.y=16;
 const [dx,dy]=d.vectors[direction],b={x:160,y:96,dx:dx*d.bulletSpeed,dy:dy*d.bulletSpeed,
  direction,frame:d.bullet[0],frames:d.bullet,fixed:true};g.bullets=[b];const states=[];
 for(let tick=0;tick<30;tick++){
  g.update();states.push([b.x,b.y,pointer(b.frame),!!b.dead]);
  if(b.dead)break;
 }
 wormBullets.push({direction,frame:pointer(d.bullet[0]),duration:d.bullet[0].duration,states});
}
console.log(JSON.stringify({cases,deaths,corridors,composites,compositeDeaths,worms,wormDeaths,wormBullets,cameraEvents,
 map:Array.from(assets.map)}));
""",
], cwd=ROOT))


def machine(map_data):
    cpu = Uc(UC_ARCH_X86, UC_MODE_16)
    cpu.mem_map(0, 0x100000)
    cpu.mem_write(LOAD * 16, bytes(image))
    for register, value in [(UC_X86_REG_CS, LOAD), (UC_X86_REG_DS, LOAD + 0x1853),
                            (UC_X86_REG_ES, LOAD + 0x1853), (UC_X86_REG_SS, 0x9000)]:
        cpu.reg_write(register, value)
    cpu.mem_write(DS, struct.pack("<6000H", *map_data))
    cpu.mem_write(DS + 0xA000, bytes(0x4000))
    for actor in range(0xA000, 0xCC00, 0x4C):
        word(cpu, actor + 8, actor + 0x4C)
    word(cpu, 0x8E7C, 0xA000)
    for sentinel in [0x904A, 0x9096]:
        word(cpu, sentinel, 0)
        word(cpu, sentinel + 8, sentinel)
        word(cpu, sentinel + 0xA, sentinel)
    cpu.mem_write((LOAD + 0x4489) * 16, (ROOT / "S3/SPRITES.VGA").read_bytes())
    return cpu


def construct(cpu, event, camera):
    word(cpu, 0x9190, camera)
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
    cpu.reg_write(UC_X86_REG_DI, 0xF000)
    call(cpu, {1: 0xA1D2, 2: 0xA33F, 5: 0xA3BF, 6: 0x9DB3}[event[1]])
    actor = word(cpu, 0x9054)
    if event[1] == 1:
        while word(cpu, actor) not in [0xC8, 0xCC]:
            actor = word(cpu, actor + 0xA)
        actor = word(cpu, actor + 0x44)
    return actor


def signed(cpu, actor, offsets):
    return [word(cpu, actor + offset, signed=True) for offset in offsets]


for case in native["cases"]:
    cpu = machine(case["map"])
    actor = construct(cpu, case["event"], case["initialCamera"])
    kind, variant = case["type"], case["variant"]
    bullets, effects = [], []
    pending = False

    def hook(uc, address, _size, _data):
        global pending
        if address == LOAD * 16 + 0x1ED3:
            x, y, direction, speed, pointer = [uc.reg_read(register) for register in (
                UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_CX, UC_X86_REG_DX, UC_X86_REG_BP)]
            sp = uc.reg_read(UC_X86_REG_SP)
            ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
            frames = None
            if ip == 0xAA7F:
                frames = []
                frame_address = pointer
                while True:
                    frame, duration = struct.unpack_from("<HH", image, frame_address)
                    if not frame:
                        break
                    frames.append([frame, duration])
                    frame_address += 4
                pointer = frames[0][0]
            bullets.append([x if x < 32768 else x - 65536, y if y < 32768 else y - 65536,
                            direction, speed, pointer, frames])
            uc.reg_write(UC_X86_REG_DI, 0xE000)
            returning(uc)
        elif address == LOAD * 16 + 0xA79C:
            pending = True
        elif address == LOAD * 16 + 0xA7AD and pending:
            bullet_actor = uc.reg_read(UC_X86_REG_DI)
            bullets.append(signed(uc, bullet_actor, [0x12, 0x16])
                           + [word(uc, bullet_actor + offset) for offset in (0x1C, 0x42, 0xC)] + [None])
            pending = False
        elif address == LOAD * 16 + 0x3326:
            returning(uc)

    cpu.hook_add(UC_HOOK_CODE, hook)
    if kind == 5 and variant:
        cpu.reg_write(UC_X86_REG_DI, actor)
        cpu.reg_write(UC_X86_REG_AX, 127)
        call(cpu, 0xA8D4)
    word(cpu, 0x304A, 0x5845)
    parts = [actor]
    if kind == 1:
        while word(cpu, parts[-1] + 0x46):
            parts.append(word(cpu, parts[-1] + 0x46))
        assert len(parts) == 8
    for tick, expected in enumerate(case["states"]):
        bullets.clear()
        word(cpu, 0x9190, expected["camera"])
        word(cpu, 0x91AA, expected["ceiling"])
        word(cpu, 0x9198, expected["delta"])
        word(cpu, 0x9F12, expected["player"]["x"])
        word(cpu, 0x9F16, expected["player"]["y"])
        for part in parts:
            cpu.reg_write(UC_X86_REG_SI, part)
            call(cpu, word(cpu, part + 2))
        dead = word(cpu, actor) == 4
        assert dead == expected["dead"], (kind, variant, case["profile"], tick, "dead")
        if dead:
            break
        if kind == 1:
            state = signed(cpu, actor, [0x1A, 0x1C, 0x22]) + [[
                signed(cpu, part, [0x12, 0x16]) + [word(cpu, part + 0xC), word(cpu, part + 0xE),
                                                  word(cpu, part + 4) != 0x761]
                + signed(cpu, part, [0x28, 0x2A, 0x2C, 0x2E]) for part in parts]]
        elif kind == 2:
            state = signed(cpu, actor, [0x12, 0x16, 0x1C, 0x1A])
            state += [word(cpu, actor + offset) for offset in (0xC, 0xE)]
            state += signed(cpu, actor, [0x28, 0x2A, 0x2C, 0x2E])
        elif kind == 6:
            state = signed(cpu, actor, [0x12, 0x16, 0x1C])
            state += [cpu.mem_read(DS + actor + 0x48, 1)[0],
                      word(cpu, actor + 0xC), word(cpu, actor + 0xE)]
            state += signed(cpu, actor, [0x28, 0x2A, 0x2C, 0x2E])
        else:
            state = [word(cpu, actor + 0x1A), cpu.mem_read(DS + actor + 0x48, 1)[0],
                     word(cpu, actor + 0x24)] + signed(cpu, actor, [0x28, 0x2A, 0x2C, 0x2E])
            cell = word(cpu, actor + 0x38)
            tiles = [word(cpu, cell + i % 4 * 2 + i // 4 * 40) for i in range(24)]
            assert tiles == expected["tiles"], (kind, variant, case["profile"], tick, "tiles")
        assert state == expected["state"], (kind, variant, case["profile"], tick, state, expected["state"])
        assert bullets == expected["bullets"], (kind, variant, case["profile"], tick, bullets, expected["bullets"])
        assert word(cpu, 0x304A) == expected["seed"], (kind, variant, case["profile"], tick, "RNG")
    print(f"PASS stage-three type {kind}/{variant}/{case['profile']}: constructor, updates, bounds, shots, RNG")

for case in native["deaths"]:
    cpu = machine(native["map"])
    actor = construct(cpu, case["event"], 1000)
    kind = case["type"]
    effects = []

    def death_hook(uc, address, _size, _data):
        if address == LOAD * 16 + 0x3326:
            x, y, animation = [uc.reg_read(register) for register in
                               (UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_BP)]
            effects.append([x if x < 32768 else x - 65536,
                            y if y < 32768 else y - 65536, animation == 0x124C])
            returning(uc)

    cpu.hook_add(UC_HOOK_CODE, death_hook)
    word(cpu, 0x9152, 0)
    word(cpu, 0x9154, 0)
    for expected in case["states"]:
        target = actor
        if kind == 1:
            while word(cpu, target + 0x46):
                target = word(cpu, target + 0x46)
        cpu.reg_write(UC_X86_REG_DI, target)
        cpu.reg_write(UC_X86_REG_AX, 127)
        call(cpu, word(cpu, target + 6))
        assert (word(cpu, actor) == 4) == expected["dead"]
        assert word(cpu, actor + 0x24) == (expected["health"] & 65535)
        assert word(cpu, 0x9152) == expected["score"]
        assert effects == expected["effects"], (kind, case["side"], effects, expected["effects"])
        if kind == 5:
            cell = word(cpu, actor + 0x38)
            tiles = [word(cpu, cell + i % 4 * 2 + i // 4 * 40) for i in range(24)]
            assert tiles == expected["tiles"], (kind, case["side"], "death tiles")
    print(f"PASS stage-three type {kind}/{case['side']}: damage, shared/two-stage health, score, death effects and tiles")

for case in native["corridors"]:
    cpu = machine(native["map"])
    actor = 0xA000
    for offset, value in [(0, 0x14), (0xC, case["frame"]), (0x12, case["x"]), (0x16, 20),
                          (0x1C, case["direction"]), (0x42, 6)]:
        word(cpu, actor + offset, value)
    word(cpu, 0x9F12, 10)
    word(cpu, 0x9F16, 16)

    def corridor_hook(uc, address, _size, _data):
        if address == LOAD * 16 + 0x42AE:
            uc.reg_write(UC_X86_REG_EFLAGS, uc.reg_read(UC_X86_REG_EFLAGS) | 64)
            returning(uc)

    cpu.hook_add(UC_HOOK_CODE, corridor_hook)
    for tick, expected in enumerate(case["states"]):
        word(cpu, 0x9198, expected["delta"])
        cpu.reg_write(UC_X86_REG_SI, actor)
        call(cpu, 0xA7B4)
        x, y = signed(cpu, actor, [0x12, 0x16])
        state = [x, y, (x << 16) | word(cpu, actor + 0x14), (y << 16) | word(cpu, actor + 0x18),
                 word(cpu, actor + 0x1C), word(cpu, actor + 0xC), word(cpu, actor) == 4]
        assert state == expected["state"], (case["x"], case["direction"], tick, state, expected["state"])
    print(f"PASS skater projectile {case['x']}/{case['direction']}: fixed-point movement, corridor turns, frames and expiry")

print(f"PASS {len(native['cases'])} actor traces "
      f"({sum(len(case['states']) for case in native['cases'])} updates), "
      f"{len(native['deaths'])} damage/death scenarios and {len(native['corridors'])} projectile traces")


def install_paths(cpu):
    paths = (ROOT / "S3/PATHS.BIN").read_bytes()
    cpu.mem_write(DS + 0xDE30, paths)
    for i, offset in enumerate(struct.unpack_from("<115H", paths)):
        word(cpu, 0xDE30 + i * 2, offset + 0xDF16)


def mini_machine():
    cpu = machine(native["map"])
    install_paths(cpu)
    for offset, value in [(0x91A8, 2800), (0x91AA, 2816), (0x9190, 2800),
                          (0x9204, 20), (0x9206, 20), (0x920E, 2), (0x304A, 0x5845)]:
        word(cpu, offset, value)
    call(cpu, 0xA0E5)
    parts = [word(cpu, 0x9054)]
    while word(cpu, parts[-1] + 0x46):
        parts.append(word(cpu, parts[-1] + 0x46))
    assert len(parts) == 17
    return cpu, parts


def composite_state(cpu, parts):
    states = []
    for actor in parts:
        x, y = signed(cpu, actor, [0x12, 0x16])
        states.append([(x << 16) | word(cpu, actor + 0x14),
                       (y << 16) | word(cpu, actor + 0x18),
                       (word(cpu, actor + 0x1C) << 16) | word(cpu, actor + 0x1E),
                       (word(cpu, actor + 0x3E, signed=True) << 16) | word(cpu, actor + 0x3C),
                       word(cpu, actor + 0x40, signed=True), word(cpu, actor + 0x1A, signed=True),
                       word(cpu, actor + 0x3A) - 0xDE30, word(cpu, actor + 0x42),
                       cpu.mem_read(DS + actor + 0x48, 1)[0], word(cpu, actor + 0x30),
                       word(cpu, actor + 0x20, signed=True), word(cpu, actor + 0xC),
                       word(cpu, actor + 0xE), word(cpu, actor + 0x28) != 1000]
                      + signed(cpu, actor, [0x28, 0x2A, 0x2C, 0x2E]))
    return states


def mini_bullet_hook(bullets):
    def hook(uc, address, _size, _data):
        if address == LOAD * 16 + 0x1ED3:
            x, y, direction = [uc.reg_read(register) for register in
                               (UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_CX)]
            frames = [list(struct.unpack_from("<HH", image, 0x989C + i * 4)) for i in range(4)]
            bullets.append([x if x < 32768 else x - 65536, y if y < 32768 else y - 65536,
                            direction, frames])
            uc.reg_write(UC_X86_REG_DI, 0xD000)
            returning(uc)
    return hook


case = native["cameraEvents"]
cpu = machine(native["map"])
install_paths(cpu)
word(cpu, 0xDE30, 0xF000)
cpu.mem_write(DS + 0xF000, struct.pack("<9h", *case["path"]))
for field, base in (("events", 0xD274), ("background", 0xDA9E)):
    cpu.mem_write(DS + base, b"".join(struct.pack("<7H", *event) for event in case[field]) + b"\xff\xff")
for offset, value in [(0x9192, 2817), (0x9194, 2817), (0x91A8, 2800), (0x91AA, 2832),
                      (0x991A, 1), (0x991C, 3), (0x9F12, 300), (0x9F16, 24),
                      (0x9204, 20), (0x9206, 20), (0x920E, 2), (0x304A, 0x5845), (0x91AC, 1)]:
    word(cpu, offset, value)
call(cpu, 0xACCE)


def visible_main():
    result = []
    actor = word(cpu, 0x9054)
    while word(cpu, actor):
        if word(cpu, actor + 4) != 0x761:
            result.append(word(cpu, actor))
        actor = word(cpu, actor + 0xA)
    return result


def camera_tiles():
    return [word(cpu, cell * 2) for cell in case["cells"]]


for tick, expected in enumerate(case["states"], 1):
    word(cpu, 0x9190, expected["camera"])
    word(cpu, 0x9198, expected["delta"])
    word(cpu, 0x919A, 1)
    word(cpu, 0x91AA, expected["ceiling"])
    cpu.emu_start(LOAD * 16 + 0x3D26, LOAD * 16 + 0x3D47)
    call(cpu, 0x9A99)
    cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
    call(cpu, 0x36FC)
    visible = visible_main()
    paint_tiles = camera_tiles()
    call(cpu, 0x3615)
    if tick == 1:
        actor = word(cpu, 0x9054)
        parts = []
        while word(cpu, actor):
            kind = word(cpu, actor)
            if kind == 0x54:
                parts.append(actor)
            elif kind == 0xD4:
                enemy = actor
            elif kind == 0xD0:
                skater = actor
            elif kind == 0xF8:
                turret = actor
            actor = word(cpu, actor + 0xA)
        parts = [parts[0]]
        while word(cpu, parts[-1] + 0x46):
            parts.append(word(cpu, parts[-1] + 0x46))
    skater_type = word(cpu, skater)
    actual = {
        "camera": word(cpu, 0x9190), "delta": word(cpu, 0x9198), "ceiling": word(cpu, 0x91AA),
        "seed": word(cpu, 0x304A), "paintTiles": paint_tiles, "tiles": camera_tiles(),
        "painted": [visible.count(t) for t in (0xD4, skater_type, 0x54)],
        "miniCount": len(parts), "mini": composite_state(cpu, parts) if tick > 1 else None,
        "enemy": signed(cpu, enemy, [0x12, 0x16]) if tick > 1 else None,
        "skater": signed(cpu, skater, [0x12, 0x16, 0x1C, 0x1A]) + [word(cpu, skater + 0xC),
                   word(cpu, skater + 0xE)] + signed(cpu, skater, [0x28, 0x2A, 0x2C, 0x2E]),
        "turret": [word(cpu, turret + 0x1A), cpu.mem_read(DS + turret + 0x48, 1)[0], word(cpu, turret + 0x24)]
                  + signed(cpu, turret, [0x28] if word(cpu, turret + 0x28) == 1000 else [0x28, 0x2A, 0x2C, 0x2E]),
    }
    for key, value in actual.items():
        assert value == expected[key], ("camera events", tick, key, value, expected[key])
print("PASS stage-three camera events: mixed foreground, skater, turret and miniboss births after paint")


for case in native["composites"]:
    cpu, parts = mini_machine()
    for offset, value in zip([0x9204, 0x9206], case["health"]):
        word(cpu, offset, value)
    bullets = []
    cpu.hook_add(UC_HOOK_CODE, mini_bullet_hook(bullets))
    for tick, expected in enumerate(case["states"], 1):
        bullets.clear()
        word(cpu, 0x919C, tick)
        word(cpu, 0x919A, 1)
        word(cpu, 0x9F12, expected["player"]["x"])
        word(cpu, 0x9F16, expected["player"]["y"])
        call(cpu, 0x9A99)
        for actor in parts:
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 2))
        actual = composite_state(cpu, parts)
        for index, (state, target) in enumerate(zip(actual, expected["state"])):
            assert state == target, (case["health"], tick, index, state, target)
        assert bullets == expected["bullets"], (case["health"], tick, "bullets", bullets, expected["bullets"])
        assert word(cpu, 0x304A) == expected["seed"], (case["health"], tick, "RNG")
        assert [word(cpu, 0x91A8), word(cpu, 0x91AA), word(cpu, 0x919A)] == [
            expected["floor"], expected["ceiling"], expected["scroll"]]
    print(f"PASS stage-three miniboss {case['health']}: 1000 original 17-part motion/animation/arm/eye/fire/RNG/camera ticks")

for case in native["compositeDeaths"]:
    cpu, parts = mini_machine()
    cpu.hook_add(UC_HOOK_CODE, mini_bullet_hook([]))
    for tick in range(1, 301):
        word(cpu, 0x919C, tick)
        word(cpu, 0x9F12, 160)
        word(cpu, 0x9F16, 174)
        for actor in parts:
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 2))
    effects = []

    def composite_death_hook(uc, address, _size, _data):
        if address == LOAD * 16 + 0x3326:
            x, y, animation = [uc.reg_read(register) for register in
                               (UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_BP)]
            effects.append([x if x < 32768 else x - 65536,
                            y if y < 32768 else y - 65536, animation == 0x124C])
            returning(uc)

    cpu.hook_add(UC_HOOK_CODE, composite_death_hook)
    word(cpu, 0x9152, 0)
    word(cpu, 0x9154, 0)
    for expected in case["states"]:
        cpu.reg_write(UC_X86_REG_DI, parts[expected["index"]])
        cpu.reg_write(UC_X86_REG_AX, 127)
        call(cpu, 0x9F1C)
        assert signed(cpu, 0, [0x9204, 0x9206]) == expected["health"]
        assert word(cpu, 0x920E) == expected["remaining"]
        assert all(word(cpu, actor) == 4 for actor in parts) == expected["dead"]
        assert word(cpu, 0x9152) == expected["score"]
        assert word(cpu, 0x304A) == expected["seed"]
        assert word(cpu, 0x9164) == expected["counted"]
        assert effects == expected["effects"], (case["order"], "effects", effects, expected["effects"])
        credits = []
        actor = word(cpu, 0x90A0)
        while word(cpu, actor):
            credits.append(signed(cpu, actor, [0x12, 0x16]) + [50 if word(cpu, actor) == 0x60 else 100])
            actor = word(cpu, actor + 0xA)
        assert credits == expected["credits"], (case["order"], credits, expected["credits"])
    for expected in case["gates"]:
        word(cpu, 0x919A, 1)
        call(cpu, 0x9A99)
        assert [word(cpu, 0x91A8), word(cpu, 0x91AA), word(cpu, 0x919A)] == expected
    assert cpu.mem_read(DS + 0x9225, 1)[0] == 0
    print(f"PASS stage-three miniboss death {case['order']}: weak health, 17-part cleanup, effects, score, ten credits, RNG and delayed floor release")


def worm_machine():
    cpu = machine(native["map"])
    paths = (ROOT / "S3/PATHS.BIN").read_bytes()
    cpu.mem_write(DS + 0xDE30, paths)
    for i, offset in enumerate(struct.unpack_from("<115H", paths)):
        word(cpu, 0xDE30 + i * 2, offset + 0xDF16)
    for offset, value in [(0x91A8, 0), (0x91AA, 4607), (0x9208, 0), (0x91F4, 0xE496),
                          (0x920A, 80), (0x304A, 0x5845)]:
        word(cpu, offset, value)
    for offset, value in [(0x9231, 0), (0x9232, 255), (0x9233, 0), (0x9234, 0), (0x8F61, 0)]:
        cpu.mem_write(DS + offset, bytes([value]))
    return cpu


def worm_parts(cpu):
    head = word(cpu, 0x9054)
    if head == 0x904A:
        return []
    parts = [word(cpu, head + 0x44)]
    while word(cpu, parts[-1] + 0x46):
        parts.append(word(cpu, parts[-1] + 0x46))
    assert len(parts) == 11
    return parts


def worm_state(cpu, parts):
    states = []
    for actor in parts:
        x, y = signed(cpu, actor, [0x12, 0x16])
        states.append([(x << 16) | word(cpu, actor + 0x14),
                       (y << 16) | word(cpu, actor + 0x18),
                       (word(cpu, actor + 0x1C) << 16) | word(cpu, actor + 0x1E),
                       (word(cpu, actor + 0x3E, signed=True) << 16) | word(cpu, actor + 0x3C),
                       word(cpu, actor + 0x40, signed=True), word(cpu, actor + 0x1A, signed=True),
                       word(cpu, actor + 0x3A) - 0xDE30, word(cpu, actor + 0xC),
                       word(cpu, actor + 0xE), cpu.mem_read(DS + actor + 0x48, 1)[0],
                       word(cpu, actor) == 4] + signed(cpu, actor, [0x28, 0x2A, 0x2C, 0x2E]))
    return states


def worm_bullet_hook(bullets):
    def hook(uc, address, _size, _data):
        if address == LOAD * 16 + 0x1ED3:
            x, y, direction, speed = [uc.reg_read(register) for register in
                                      (UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_CX, UC_X86_REG_DX)]
            bullets.append([x if x < 32768 else x - 65536, y if y < 32768 else y - 65536,
                            direction, speed])
            uc.reg_write(UC_X86_REG_DI, 0xD000)
            returning(uc)
        elif address == LOAD * 16 + 0x9CCC:
            bullets[-1].extend([word(uc, 0xD00C), word(uc, 0xD00E)])
    return hook


for case in native["worms"]:
    cpu = worm_machine()
    word(cpu, 0x9208, 1 if case["selection"] else 0)
    word(cpu, 0x91F4, case["selection"] << 5 if case["selection"] else 0xE496)
    bullets = []
    cpu.hook_add(UC_HOOK_CODE, worm_bullet_hook(bullets))
    for tick, expected in enumerate(case["states"]):
        bullets.clear()
        word(cpu, 0x9190, expected["camera"])
        word(cpu, 0x9198, expected["delta"])
        word(cpu, 0x919A, expected["scroll"])
        call(cpu, 0x9A99)
        parts = worm_parts(cpu)
        for actor in reversed(parts):
            if word(cpu, actor) == 4:
                continue
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 2))
        actual = worm_state(cpu, parts)
        for index, (state, target) in enumerate(zip(actual, expected["state"])):
            assert state == target, (case["selection"], case["profile"], tick, index, state, target)
        assert len(actual) == len(expected["state"])
        assert bullets == expected["bullets"], (case["selection"], case["profile"], tick, "bullets")
        assert word(cpu, 0x9208) == expected["pathCounter"]
        assert word(cpu, 0x91F4) == expected["pathSeed"]
        assert bool(cpu.mem_read(DS + 0x9233, 1)[0]) == expected["present"]
        assert word(cpu, 0x91AA) == expected["ceiling"]
        assert word(cpu, 0x304A) == 0x5845
    print(f"PASS final worm path {case['selection']}/{case['profile']}: 600 original eleven-part movement/animation/fire/respawn/selector/camera ticks")

for case in native["wormDeaths"]:
    cpu = worm_machine()
    cpu.hook_add(UC_HOOK_CODE, worm_bullet_hook([]))
    word(cpu, 0x9190, 0)
    word(cpu, 0x919A, 1)
    for _ in range(20):
        call(cpu, 0x9A99)
        for actor in reversed(worm_parts(cpu)):
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 2))
    root = worm_parts(cpu)[0]
    for actor, sentinel in [(0xD100, 0x904A), (0xD200, 0x9096)]:
        word(cpu, actor, 0x14)
        cpu.reg_write(UC_X86_REG_SI, actor)
        cpu.reg_write(UC_X86_REG_DI, sentinel)
        call(cpu, 0x77C)
    for amount, expected in zip(case["damage"], case["states"]):
        cpu.reg_write(UC_X86_REG_DI, root)
        cpu.reg_write(UC_X86_REG_AX, amount)
        call(cpu, 0x9D4D)
        assert word(cpu, 0x920A, signed=True) == expected["health"]
        assert bool(cpu.mem_read(DS + 0x9231, 1)[0]) == expected["dead"]
        assert word(cpu, 0x9152) == expected["score"]
        assert word(cpu, 0x9164) == expected["counted"]
        assert word(cpu, 0x304A) == expected["seed"]
        assert (word(cpu, 0x9054) == 0x904A) == expected["dead"]
        effects = []
        actor = word(cpu, 0x90A0)
        while word(cpu, actor):
            if word(cpu, actor) == 0xC:
                effects.append(signed(cpu, actor, [0x12, 0x16]) + [True])
            actor = word(cpu, actor + 0xA)
        assert effects[::-1] == expected["effects"]
        assert word(cpu, 0xD200) == 0x14
        assert bool(cpu.mem_read(DS + 0x8F61, 1)[0]) is False
    for _ in range(10):
        call(cpu, 0x9A99)
    assert cpu.mem_read(DS + 0x8F61, 1)[0] == 255
    assert word(cpu, 0x9164) == case["counted"] == 20
    assert word(cpu, 0x304A) == case["seed"]
    credits = []
    actor = word(cpu, 0x90A0)
    while word(cpu, actor):
        if word(cpu, actor) in [0x60, 0x18]:
            credits.append(signed(cpu, actor, [0x12, 0x16]) + [50 if word(cpu, actor) == 0x60 else 100])
        actor = word(cpu, actor + 0xA)
    assert credits == case["credits"], (case["damage"], credits, case["credits"])
    print(f"PASS final worm damage {case['damage']}: unsigned health, main-list cleanup, preserved bullets, twenty random effects, score/RNG and next-tick twenty-credit/end-level trigger")

for case in native["wormBullets"]:
    cpu = worm_machine()
    word(cpu, 0x9198, 0)
    actor = 0xA000
    for offset, value in [(0, 0x14), (0xC, case["frame"]), (0xE, case["duration"]),
                          (0x10, 0x9722), (0x12, 160), (0x16, 96), (0x1C, case["direction"]), (0x42, 12)]:
        word(cpu, actor + offset, value)

    def worm_collision_hook(uc, address, _size, _data):
        if address == LOAD * 16 + 0x42AE:
            uc.reg_write(UC_X86_REG_EFLAGS, uc.reg_read(UC_X86_REG_EFLAGS) | 64)
            returning(uc)

    cpu.hook_add(UC_HOOK_CODE, worm_collision_hook)
    for expected in case["states"]:
        cpu.reg_write(UC_X86_REG_SI, actor)
        call(cpu, 0x1F4D)
        actual = signed(cpu, actor, [0x12, 0x16]) + [word(cpu, actor + 0xC), word(cpu, actor) == 4]
        assert actual == expected, (case["direction"], actual, expected)
        assert 0 < word(cpu, actor + 0xE) <= case["duration"]
    print(f"PASS corrected final worm bullet {case['direction']}: fixed-point movement, recovered animation timing and expiry")
