"""Optional independent oracle. Requires Python's unicorn package; not used by the game."""

import hashlib
import json
from pathlib import Path
import struct
import subprocess

from unicorn import Uc, UC_ARCH_X86, UC_MODE_16, UC_HOOK_INTR
from unicorn.x86_const import (
    UC_X86_REG_AH, UC_X86_REG_AX, UC_X86_REG_CS, UC_X86_REG_CX,
    UC_X86_REG_DS, UC_X86_REG_DX, UC_X86_REG_EFLAGS, UC_X86_REG_ES,
    UC_X86_REG_IP, UC_X86_REG_SI, UC_X86_REG_SP, UC_X86_REG_SS,
)


ROOT = Path(__file__).resolve().parent.parent
LOAD = 0x1000
DS = (LOAD + 0x1853) * 16
STOP = 0x1FF00


def original_image():
    exe = (ROOT / "XENON2.EXE").read_bytes()
    image = bytearray(exe[0x800:])
    for index in range(struct.unpack_from("<H", exe, 6)[0]):
        offset, segment = struct.unpack_from("<HH", exe, 0x22 + index * 4)
        position = segment * 16 + offset
        value = struct.unpack_from("<H", image, position)[0]
        struct.pack_into("<H", image, position, (value + LOAD) & 65535)
    return bytes(image)


IMAGE = original_image()


def machine():
    cpu = Uc(UC_ARCH_X86, UC_MODE_16)
    cpu.mem_map(0, 0x200000)
    cpu.mem_write(LOAD * 16, IMAGE)
    cpu.reg_write(UC_X86_REG_CS, LOAD)
    cpu.reg_write(UC_X86_REG_DS, LOAD + 0x1853)
    cpu.reg_write(UC_X86_REG_ES, LOAD + 0x1853)
    cpu.reg_write(UC_X86_REG_SS, 0x9000)
    return cpu


def call(cpu, address, count=100000):
    cpu.reg_write(UC_X86_REG_SP, 0xFFFC)
    cpu.mem_write(0x9FFFC, b"\x00\xff")
    cpu.emu_start(LOAD * 16 + address, STOP, count=count)
    assert cpu.reg_read(UC_X86_REG_IP) == 0xFF00, "Original routine did not return"


def decompress(name):
    data = (ROOT / name).read_bytes()
    cpu = machine()
    cpu.reg_write(UC_X86_REG_ES, 0x7000)
    position = 0

    def interrupt(uc, number, _):
        nonlocal position
        assert number == 0x21, f"Unexpected interrupt {number}"
        function = uc.reg_read(UC_X86_REG_AH)
        if function == 0x3D:
            uc.reg_write(UC_X86_REG_AX, 5)
        elif function == 0x3F:
            block = data[position:position + uc.reg_read(UC_X86_REG_CX)]
            position += len(block)
            uc.mem_write(uc.reg_read(UC_X86_REG_DS) * 16 + uc.reg_read(UC_X86_REG_DX), block)
            uc.reg_write(UC_X86_REG_AX, len(block))
        else:
            assert function == 0x3E, f"Unexpected DOS function {function}"
        uc.reg_write(UC_X86_REG_EFLAGS, uc.reg_read(UC_X86_REG_EFLAGS) & ~1)

    cpu.hook_add(UC_HOOK_INTR, interrupt)
    call(cpu, 0x11C, 30_000_000)
    size = struct.unpack_from("<I", data, 11)[0]
    return hashlib.sha256(cpu.mem_read(0x70000, size)).hexdigest()


def path_trace(index):
    paths = (ROOT / "S1/PATHS.BIN").read_bytes()
    cpu = machine()
    cpu.mem_write(DS + 0xDE30, paths)
    cpu.reg_write(UC_X86_REG_SI, 0x9F4C)
    obj = DS + 0x9F4C

    def set_word(offset, value):
        cpu.mem_write(obj + offset, struct.pack("<H", value & 65535))

    def word(offset, signed=False):
        return struct.unpack("<h" if signed else "<H", cpu.mem_read(obj + offset, 2))[0]

    start = 230 + struct.unpack_from("<H", paths, (index - 1) * 2)[0]
    command, x, y = struct.unpack_from("<hhh", paths, start)
    assert command == 10
    for offset, value in [(0, 200), (0x12, x), (0x16, y),
                          (0x38, 0xDE30 + start), (0x3A, 0xDE30 + start + 6), (0x42, 7)]:
        set_word(offset, value)
    trace = []
    for _ in range(20):
        call(cpu, 0x4871)
        trace.append([
            word(0x12, True) * 65536 + word(0x14),
            word(0x16, True) * 65536 + word(0x18),
            word(0x1C) * 65536 + word(0x1E),
            word(0x3E, True) * 65536 + word(0x3C),
            word(0x1A, True), word(0x3A) - 0xDE30,
        ])
    return trace


native = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unpack,decodePaths,decodeStageOneLogic} from './src/formats.js';
import {PathMotion} from './src/motion.js';
const names=['X2SPR.DAT','X2WEAPS.DAT','SHOP.DAT','GR.DAT'];
const hashes=Object.fromEntries(names.map(n=>[n,createHash('sha256').update(unpack(readFileSync(n))).digest('hex')]));
const paths=decodePaths(readFileSync('S1/PATHS.BIN'));
const {sine}=decodeStageOneLogic(readFileSync('XENON2.EXE'));
const traces=Array.from({length:5},(_,i)=>{
 const m=new PathMotion(paths,i+1,sine);
 return Array.from({length:20},()=>{
  m.step(7);
  return [m.xFixed,m.yFixed,m.heading,m.turn,m.remaining,m.cursor];
 });
});
console.log(JSON.stringify({hashes,traces}));
""",
], cwd=ROOT, text=True))

for name, expected in native["hashes"].items():
    assert decompress(name) == expected, f"Decompressor mismatch: {name}"
    print(f"PASS {name}: native output matches original DOS decompressor")
for index, expected in enumerate(native["traces"], 1):
    assert path_trace(index) == expected, f"Movement mismatch: path {index}"
    print(f"PASS path {index}: 20 native ticks match original 8086 movement")
