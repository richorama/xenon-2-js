"""Recover audio from the supplied BS1 Amiga disk. Originals are never modified."""

import argparse
from array import array
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import wave
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parent.parent
GAME_HASH = "7561fe0a2508bb2876cf99587a35dbe48ff67da128c0e8b83442f99ff0fa4bdc"
UNPACKED_HASH = "fd28f362956d89a6fbf87bffd5242eef099ee63b82de681ba01f917ff0b62c6b"
DRIVER = 0x19B9E
BANKS = (("music", 0x1B780, 20), ("effect", 0x2B69C, 18))
PAL_CLOCK = 3546895
GAME_EFFECTS = {
    "shot": ([0x289], "003b7e -> 00615a/006160"),
    "explosion": ([0x185], "00597e/005990 -> 0031ec/0031f2"),
    "explosion-large": ([0x183], "005988/005990 -> 0031ec/0031fe"),
    "pickup": ([0x204], "0047be-0047ca"),
    "credit": ([0x205], "00472c-004730"),
    "health": ([0x207], "004894-00489a"),
    "dive": ([0x210], "007990-0079a6"),
    "death": ([0x10A, 0x20A], "005d00-005d24"),
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


class AmigaDisk:
    def __init__(self, data):
        if len(data) != 901120 or data[:4] != b"DOS\0":
            raise ValueError("Expected an 880 KiB Amiga OFS disk")
        self.data = data

    def block(self, index):
        if not 2 <= index < 1760:
            raise ValueError("Invalid Amiga disk block")
        block = self.data[index * 512:(index + 1) * 512]
        if sum(struct.unpack(">128I", block)) & 0xFFFFFFFF:
            raise ValueError(f"Bad checksum in Amiga block {index}")
        return block

    def files(self):
        seen = set()

        def visit(index, parent):
            if index in seen:
                raise ValueError("Cyclic Amiga directory")
            seen.add(index)
            block = self.block(index)
            length = block[432]
            if length > 30:
                raise ValueError("Invalid Amiga filename")
            name = block[433:433 + length].decode("latin1")
            path = f"{parent}/{name}" if parent else name
            kind = struct.unpack_from(">i", block, 508)[0]
            if kind == -3:
                yield path, index
            elif kind in (1, 2):
                for child in struct.unpack_from(">72I", block, 24):
                    chain = set()
                    while child:
                        if child in chain:
                            raise ValueError("Cyclic Amiga hash chain")
                        chain.add(child)
                        yield from visit(child, path)
                        child = struct.unpack_from(">I", self.block(child), 496)[0]

        return visit(880, "")

    def read(self, index):
        header = self.block(index)
        size = struct.unpack_from(">I", header, 324)[0]
        current = struct.unpack_from(">I", header, 16)[0]
        result = bytearray()
        seen = set()
        sequence = 1
        while current:
            if current in seen:
                raise ValueError("Cyclic Amiga file")
            seen.add(current)
            block = self.block(current)
            kind, owner, order, length, current = struct.unpack_from(">5I", block)
            if kind != 8 or owner != index or order != sequence or length > 488:
                raise ValueError("Invalid Amiga OFS data block")
            result.extend(block[24:24 + length])
            if len(result) > size:
                raise ValueError("Amiga file exceeds declared length")
            sequence += 1
        if len(result) != size:
            raise ValueError("Truncated Amiga file")
        return bytes(result)


def unpack_backwards(packed):
    """Translate the game's 68000 depacker at HUNK code offsets 0010-0134."""
    cursor = len(packed)

    def word():
        nonlocal cursor
        cursor -= 4
        if cursor < 0:
            raise ValueError("Truncated packed Amiga data")
        return struct.unpack_from(">I", packed, cursor)[0]

    size = word()
    if not 0 < size <= 4 * 1024 * 1024:
        raise ValueError("Invalid unpacked Amiga length")
    output = bytearray(size)
    position = size
    bits = word()

    def bit():
        nonlocal bits
        value = bits & 1
        bits >>= 1
        if not bits:
            refill = word()
            value = refill & 1
            bits = (refill >> 1) | 0x80000000
        return value

    def get(count):
        value = 0
        for _ in range(count):
            value = (value << 1) | bit()
        return value

    while position:
        length = get(3)
        if length == 7:
            if bit():
                length = get(10)
                if not length:
                    length = get(18)
            else:
                length = get(4) + 7
        if length > position:
            raise ValueError("Literal exceeds unpacked Amiga data")
        for _ in range(length):
            position -= 1
            output[position] = get(8)
        if not position:
            break
        kind = get(2)
        if kind == 0:
            length, width = 2, 8
        elif kind == 1:
            length, width = 3, 8 if bit() else 14
        else:
            length = 4
            if kind == 3:
                extra = get(2)
                length = extra + 5 if extra < 2 else get(2) + 7 if extra == 2 else get(8)
            width = 16 if not bit() else 8 if bit() else 12
        distance = get(width)
        if not 0 < length <= position or not 0 < distance <= size - position:
            raise ValueError("Invalid Amiga back reference")
        for _ in range(length):
            position -= 1
            output[position] = output[position + distance]
    return bytes(output)


def recover(archive):
    with ZipFile(archive) as zipped:
        members = [entry for entry in zipped.infolist() if entry.filename.lower().endswith(".adf")]
        if len(members) != 1 or members[0].file_size != 901120:
            raise ValueError("Expected one 880 KiB ADF in the archive")
        member = members[0]
        image = zipped.read(member)
    disk = AmigaDisk(image)
    matches = [(name, index) for name, index in disk.files()
               if name.rsplit("/", 1)[-1].upper() == "XENON-II"]
    if len(matches) != 1:
        raise ValueError("This archive does not contain the supported BS1 game")
    name, index = matches[0]
    game = disk.read(index)
    if digest(game) != GAME_HASH:
        raise ValueError("Unrecognized Amiga executable; refusing guessed audio offsets")
    unpacked = unpack_backwards(game[0x15A:0x323BA])
    if digest(unpacked) != UNPACKED_HASH:
        raise ValueError("Amiga decompression hash mismatch")
    samples = []
    end = 0
    for bank, cursor, count in BANKS:
        for number in range(1, count + 1):
            size, rate = struct.unpack_from(">IH", unpacked, cursor)
            cursor += 6
            if not 0 < size <= 131070 or size & 1 or not 1000 <= rate <= 48000:
                raise ValueError("Invalid Amiga sample descriptor")
            data = unpacked[cursor:cursor + size]
            if len(data) != size:
                raise ValueError("Truncated Amiga sample")
            samples.append({"bank": bank, "number": number, "offset": cursor,
                            "bytes": size, "rate": rate, "sha256": digest(data), "data": data})
            cursor += size
        end = cursor
    return unpacked, samples, {
        "archive": archive.name, "archiveSha256": digest(archive.read_bytes()),
        "member": member.filename, "diskSha256": digest(image),
        "gameFile": name, "gameSha256": GAME_HASH, "unpackedSha256": UNPACKED_HASH,
        "module": {"file": "megablast.dw", "offset": DRIVER, "bytes": end - DRIVER,
                   "sha256": digest(unpacked[DRIVER:end])},
    }


def sample_wav(data, rate):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(1)
        wav.setframerate(rate)
        # Paula stores signed PCM; 8-bit RIFF PCM is unsigned.
        wav.writeframes(bytes(value ^ 128 for value in data))
    return output.getvalue()


def save(path, data):
    if path.exists():
        if path.read_bytes() != data:
            raise FileExistsError(f"Refusing to overwrite different file: {path}")
        return
    path.write_bytes(data)


def replay(unpacked, effects=None):
    """Offline original-machine replay, not an Amiga emulator shipped in the game."""
    try:
        from unicorn import Uc, UC_ARCH_M68K, UC_MODE_BIG_ENDIAN, UC_HOOK_MEM_WRITE
        from unicorn.m68k_const import (
            UC_CPU_M68K_M68000, UC_M68K_REG_SR, UC_M68K_REG_A7, UC_M68K_REG_D0, UC_M68K_REG_PC,
        )
    except ImportError as error:
        raise RuntimeError("--render needs unicorn in a separate Python environment") from error
    cpu = Uc(UC_ARCH_M68K, UC_MODE_BIG_ENDIAN)
    cpu.ctl_set_cpu_model(UC_CPU_M68K_M68000)
    cpu.mem_map(0, 0x1000000)
    cpu.mem_write(0x400, unpacked)
    cpu.reg_write(UC_M68K_REG_SR, 0x2000)

    def call(address):
        cpu.reg_write(UC_M68K_REG_A7, 0x90000)
        cpu.mem_write(0x90000, b"\x00\x00\x01\x00")
        cpu.emu_start(address, 0x100, count=100000)
        if cpu.reg_read(UC_M68K_REG_PC) != 0x100:
            raise RuntimeError("Amiga replay routine did not return")

    cpu.reg_write(UC_M68K_REG_D0, 0)
    call(DRIVER + 0x400)
    registers = bytearray(256)
    channels = [dict(pointer=0, length=2, phase=0.0, active=False) for _ in range(4)]
    memory = b"\0" * 0x400 + unpacked
    master = 0

    def word(offset):
        return struct.unpack_from(">H", registers, offset)[0]

    def reload(channel, index):
        offset = 0xA0 + index * 16
        channel["pointer"] = struct.unpack_from(">I", registers, offset)[0] & 0x1FFFFE
        channel["length"] = (word(offset + 4) or 65536) * 2
        if channel["pointer"] + channel["length"] > len(memory):
            raise ValueError("Amiga replay references samples outside recovered memory")

    def write(_cpu, _access, address, size, value, _user):
        nonlocal master
        offset = address - 0xDFF000
        if offset < 0 or offset + size > len(registers):
            return
        registers[offset:offset + size] = value.to_bytes(size, "big")
        if offset != 0x96:
            return
        previous = master
        master = master | (value & 0x7FFF) if value & 0x8000 else master & ~value
        for index, channel in enumerate(channels):
            enabled = bool(master & 0x200 and master & (1 << index))
            if enabled and not (previous & 0x200 and previous & (1 << index)):
                channel["phase"] = 0.0
                reload(channel, index)
            channel["active"] = enabled

    cpu.hook_add(UC_HOOK_MEM_WRITE, write)
    if effects:
        call(DRIVER + 0x400 + 0x1C)
        for code in effects:
            cpu.reg_write(UC_M68K_REG_D0, code)
            call(DRIVER + 0x400 + 0x38)
    rate = 44100
    previous_order = 2
    for tick in range(500 if effects else 15000):
        call(DRIVER + 0x400 + 14)
        if effects:
            if not any(cpu.mem_read(0x1B6D0 + channel * 36 + 0x1A, 1)[0]
                       for channel in range(4)):
                return
        else:
            order = struct.unpack(">H", cpu.mem_read(0x1A5A0, 2))[0]
            if order < previous_order:
                return
            previous_order = order
        output = array("h")
        for _ in range(rate // 50):
            left = right = 0
            for index, channel in enumerate(channels):
                if not channel["active"]:
                    continue
                offset = 0xA0 + index * 16
                sample = memory[channel["pointer"] + int(channel["phase"])]
                sample = sample if sample < 128 else sample - 256
                amplitude = sample * min(64, word(offset + 8)) * 2
                if index in (0, 3):
                    left += amplitude
                else:
                    right += amplitude
                period = word(offset + 6) or 65536
                channel["phase"] += PAL_CLOCK / (period * rate)
                while channel["phase"] >= channel["length"]:
                    channel["phase"] -= channel["length"]
                    reload(channel, index)
            output.extend((max(-32768, min(32767, left)), max(-32768, min(32767, right))))
        if sys.byteorder != "little":
            output.byteswap()
        yield output.tobytes()
    raise RuntimeError("Amiga replay did not finish within its time limit")


def render_effects(unpacked, output):
    manifest = {
        "unpackedSha256": UNPACKED_HASH,
        "dispatch": "002170-002196: request 0414 uses channel 2; 0418 uses channel 1",
        "effects": {},
        "notes": [
            "Original 68000 effect dispatch and 50 Hz update, mixed at the PAL Paula clock.",
            "Source addresses are runtime addresses (unpacked-file offset + 0400).",
            "Nonfatal shield damage at 005d6e-005d8a does not request a sound.",
            "DMA writes within a tick and analogue filters are approximated as in the music preview.",
        ],
    }
    for name, (codes, source) in GAME_EFFECTS.items():
        pcm = b"".join(replay(unpacked, codes))
        target = io.BytesIO()
        with wave.open(target, "wb") as wav:
            wav.setnchannels(2)
            wav.setsampwidth(2)
            wav.setframerate(44100)
            wav.writeframes(pcm)
        filename = f"sfx-{name}.wav"
        data = target.getvalue()
        save(output / filename, data)
        manifest["effects"][name] = {
            "file": filename, "codes": codes, "source": source,
            "frames": len(pcm) // 4, "rate": 44100, "sha256": digest(data),
        }
    save(output / "effects.json", (json.dumps(manifest, indent=2) + "\n").encode())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, default=ROOT / "amiga" /
                        "Xenon II - Megablast (1989)(ImageWorks)[cr BS1][t +3 BS1](Disk 1 of 2).zip")
    parser.add_argument("--output", type=Path, default=ROOT / "amiga" / "audio")
    parser.add_argument("--render", action="store_true", help="Also render one music loop; needs unicorn")
    parser.add_argument("--render-effects", action="store_true",
                        help="Render source-identified gameplay effects; needs unicorn")
    args = parser.parse_args()
    unpacked, samples, manifest = recover(args.archive)
    args.output.mkdir(parents=True, exist_ok=True)
    end = DRIVER + manifest["module"]["bytes"]
    save(args.output / "megablast.dw", unpacked[DRIVER:end])
    manifest["samples"] = []
    for sample in samples:
        info = {key: value for key, value in sample.items() if key != "data"}
        filename = f'{sample["bank"]}-{sample["number"]:02}.wav'
        info["file"] = filename
        save(args.output / filename, sample_wav(sample["data"], sample["rate"]))
        manifest["samples"].append(info)
    manifest["notes"] = [
        "Custom David Whittaker replay module, not a ProTracker MOD.",
        "Sample names are neutral indices; individual effect identities are not yet mapped.",
        "WAV samples preserve original rates and signed-to-unsigned PCM exactly.",
        "Music preview executes original replay at 50 Hz with PAL-clock stereo sample mixing.",
        "Preview approximates DMA timing within each tick and omits analogue Paula filters.",
        "Original rights retained by their owners; local extraction does not grant redistribution rights.",
    ]
    save(args.output / "manifest.json", (json.dumps(manifest, indent=2) + "\n").encode())
    print(f"Recovered {len(samples)} samples and megablast.dw into {args.output}")
    if args.render_effects:
        render_effects(unpacked, args.output)
        print(f"Rendered {len(GAME_EFFECTS)} original gameplay effects into {args.output}")
    if args.render:
        target = args.output / "megablast.wav"
        if target.exists():
            raise FileExistsError(f"Refusing to overwrite: {target}")
        try:
            with wave.open(str(target), "wb") as wav:
                wav.setnchannels(2)
                wav.setsampwidth(2)
                wav.setframerate(44100)
                for block in replay(unpacked):
                    wav.writeframesraw(block)
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        print(f"Rendered original music loop into {target}")


if __name__ == "__main__":
    main()
