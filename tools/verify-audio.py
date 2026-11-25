"""Compare the native speaker driver with the original 8086 routines (requires unicorn)."""

import json
from pathlib import Path
import struct
import subprocess

from unicorn import Uc, UC_ARCH_X86, UC_MODE_16
from unicorn.x86_const import (
    UC_X86_REG_AX, UC_X86_REG_CS, UC_X86_REG_DS, UC_X86_REG_IP,
    UC_X86_REG_SP, UC_X86_REG_SS,
)

ROOT = Path(__file__).resolve().parent.parent
SEGMENT = 0x24B9
BASE = SEGMENT * 16
image = (ROOT / "XENON2.EXE").read_bytes()[0x800 + 0x14B90:0x800 + 0x15650]
ranges = [(0x22, 0x30), (0x100, 0x130), (0x40D, 0x41F)]
cases = [(track, effect) for track in (0, 1) for effect in (None, *range(26))]

native = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {readFileSync} from 'node:fs';
import {SpeakerDriver} from './src/audio.js';
const bytes=readFileSync('XENON2.EXE').subarray(0x800+0x14b90,0x800+0x15650);
const results=[];
for(const track of [0,1]) for(const effect of [null,...Array.from({length:26},(_,i)=>i)]){
 const driver=new SpeakerDriver(bytes);
 driver.start(track);
 const states=[];
 for(let i=0;i<4096;i++){
  if(i===17 && effect!==null)driver.effect(effect);
  driver.tick();
  states.push([[0x22,0x30],[0x100,0x130],[0x40d,0x41f]]
   .flatMap(([start,end])=>Array.from(driver.memory.subarray(start,end))));
 }
 results.push(states);
}
console.log(JSON.stringify(results));
""",
], cwd=ROOT, text=True))

for case, expected in zip(cases, native):
    track, effect = case
    cpu = Uc(UC_ARCH_X86, UC_MODE_16)
    cpu.mem_map(0, 0x100000)
    cpu.mem_write(BASE, image)
    for register in (UC_X86_REG_CS, UC_X86_REG_DS):
        cpu.reg_write(register, SEGMENT)
    cpu.reg_write(UC_X86_REG_SS, 0x9000)
    cpu.mem_write(BASE + 0x24, b"\x16")
    cpu.mem_write(BASE + 0x22, b"\x00\x00")

    def call(address, value=0):
        cpu.reg_write(UC_X86_REG_AX, value)
        cpu.reg_write(UC_X86_REG_SP, 0xFFFC)
        cpu.mem_write(0x9FFFC, struct.pack("<H", 0xFF00))
        cpu.emu_start(BASE + address, BASE + 0xFF00, count=100000)
        assert cpu.reg_read(UC_X86_REG_IP) == 0xFF00

    call(0x145, track)
    for tick, state in enumerate(expected):
        if tick == 17 and effect is not None:
            call(0x1A3, effect)
        call(0x1C7)
        actual = [v for start, end in ranges for v in cpu.mem_read(BASE + start, end - start)]
        if actual != state:
            offsets = [offset for start, end in ranges for offset in range(start, end)]
            differences = [(hex(offsets[i]), a, n)
                           for i, (a, n) in enumerate(zip(actual, state)) if a != n]
            raise AssertionError(f"Track {track}, effect {effect}, tick {tick}: {differences}")
    print(f"PASS track {track}, effect {effect}: 4096 ticks match original driver state")
