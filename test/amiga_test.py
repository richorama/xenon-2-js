import importlib.util
import io
import json
from pathlib import Path
import struct
import unittest
import wave


ROOT = Path(__file__).resolve().parent.parent
ARCHIVE = ROOT / "amiga" / "Xenon II - Megablast (1989)(ImageWorks)[cr BS1][t +3 BS1](Disk 1 of 2).zip"
spec = importlib.util.spec_from_file_location("amiga", ROOT / "tools/extract-amiga-audio.py")
amiga = importlib.util.module_from_spec(spec)
spec.loader.exec_module(amiga)


def packed(bits, length):
    first = len(bits) % 32
    initial = sum(bit << index for index, bit in enumerate(bits[:first])) | (1 << first)
    words = [sum(bit << index for index, bit in enumerate(bits[start:start + 32]))
             for start in range(first, len(bits), 32)]
    return b"".join(struct.pack(">I", value) for value in [*reversed(words), initial, length])


def bits(value, length):
    return [int(bit) for bit in f"{value:0{length}b}"]


class AmigaAudioTests(unittest.TestCase):
    def test_literal_and_overlapping_back_reference_across_bit_refill(self):
        stream = bits(2, 3) + bits(ord("b"), 8) + bits(ord("a"), 8)
        stream += bits(2, 2) + [0] + bits(2, 16)
        self.assertEqual(amiga.unpack_backwards(packed(stream, 6)), b"ababab")
        literal = bits(3, 3) + [bit for char in b"cba" for bit in bits(char, 8)]
        self.assertEqual(amiga.unpack_backwards(packed(literal, 3)), b"abc")

    def test_rejects_truncation_oversized_output_and_invalid_distance(self):
        for data in [b"", b"\0" * 8, struct.pack(">I", 0x10000000),
                     packed(bits(0, 3) + bits(0, 2) + bits(0, 8), 3)]:
            with self.assertRaises(ValueError):
                amiga.unpack_backwards(data)

    def test_wav_preserves_signed_sample_values_and_source_rate(self):
        data = bytes([0, 1, 127, 128, 255])
        with wave.open(io.BytesIO(amiga.sample_wav(data, 8100)), "rb") as wav:
            self.assertEqual(wav.getframerate(), 8100)
            self.assertEqual(wav.getnchannels(), 1)
            self.assertEqual(wav.getsampwidth(), 1)
            self.assertEqual(wav.readframes(5), bytes([128, 129, 255, 0, 127]))

    def test_supported_disk_yields_complete_game_audio_not_crack_intro(self):
        if not ARCHIVE.exists():
            self.skipTest("Optional original Amiga disk not supplied")
        unpacked, samples, manifest = amiga.recover(ARCHIVE)
        self.assertEqual(amiga.digest(unpacked), amiga.UNPACKED_HASH)
        self.assertEqual(len(samples), 38)
        self.assertEqual(sum(s["bank"] == "music" for s in samples), 20)
        self.assertEqual(sum(s["bank"] == "effect" for s in samples), 18)
        self.assertEqual(sum(s["bytes"] for s in samples), 123700)
        self.assertEqual(samples[0]["rate"], 8100)
        self.assertEqual(samples[-1]["rate"], 19900)
        self.assertEqual(manifest["module"]["bytes"], 134902)
        self.assertTrue(manifest["gameFile"].endswith("/XENON-II"))

    def test_original_dive_requests_same_cue_on_entry_and_timer_expiry(self):
        if not ARCHIVE.exists():
            self.skipTest("Optional original Amiga disk not supplied")
        try:
            from unicorn import Uc, UC_ARCH_M68K, UC_MODE_BIG_ENDIAN, UC_HOOK_CODE, UC_HOOK_MEM_WRITE
            from unicorn.m68k_const import UC_CPU_M68K_M68000, UC_M68K_REG_PC, UC_M68K_REG_SR, UC_M68K_REG_A7
        except ImportError:
            self.skipTest("Original 68000 execution needs Unicorn")
        unpacked, _, _ = amiga.recover(ARCHIVE)
        for cancel in (False, True):
            with self.subTest(cancel=cancel):
                cpu = Uc(UC_ARCH_M68K, UC_MODE_BIG_ENDIAN)
                cpu.ctl_set_cpu_model(UC_CPU_M68K_M68000)
                cpu.mem_map(0, 0x100000)
                cpu.mem_write(0x400, unpacked)
                cpu.reg_write(UC_M68K_REG_SR, 0x2000)
                cpu.reg_write(UC_M68K_REG_A7, 0x90000)
                cpu.mem_write(0xCA0, b"\x00\x01")
                cues = []

                def skip_meter_draw(uc, _addr, _size, _data):
                    sp = uc.reg_read(UC_M68K_REG_A7)
                    uc.reg_write(UC_M68K_REG_PC, int.from_bytes(uc.mem_read(sp, 4), "big"))
                    uc.reg_write(UC_M68K_REG_A7, sp + 4)

                def run(start, end):
                    cpu.emu_start(start, end, count=100)
                    self.assertEqual(cpu.reg_read(UC_M68K_REG_PC), end)

                cpu.hook_add(UC_HOOK_CODE, skip_meter_draw, begin=0x635E, end=0x635E)
                cpu.hook_add(UC_HOOK_MEM_WRITE, lambda _, _access, _addr, _size, value, _data: cues.append(value),
                             begin=0x414, end=0x414)
                run(0x797A, 0x79D6)
                self.assertEqual(cues, [0x10])
                cues.clear()
                for tick in range(1, (8 if cancel else 136)):
                    run(0x63CC, 0x63FC)
                    self.assertEqual(cues, [], tick)
                if cancel:
                    run(0x797A, 0x79D6)
                    self.assertEqual(cues, [])
                run(0x63CC, 0x63FC)
                self.assertEqual(cues, [0x10])
                run(0x63CC, 0x63FC)
                cpu.mem_write(0x430, b"\x00\x00")
                run(0x797A, 0x79D6)
                self.assertEqual(cues, [0x10])

    def test_original_effect_latches_dispatch_only_the_pending_code_in_lane_order(self):
        if not ARCHIVE.exists():
            self.skipTest("Optional original Amiga disk not supplied")
        try:
            from unicorn import Uc, UC_ARCH_M68K, UC_MODE_BIG_ENDIAN, UC_HOOK_CODE
            from unicorn.m68k_const import (
                UC_CPU_M68K_M68000, UC_M68K_REG_D0, UC_M68K_REG_PC, UC_M68K_REG_SR, UC_M68K_REG_A7,
            )
        except ImportError:
            self.skipTest("Original 68000 execution needs Unicorn")
        unpacked, _, _ = amiga.recover(ARCHIVE)
        cpu = Uc(UC_ARCH_M68K, UC_MODE_BIG_ENDIAN)
        cpu.ctl_set_cpu_model(UC_CPU_M68K_M68000)
        cpu.mem_map(0, 0x100000)
        cpu.mem_write(0x400, unpacked)
        cpu.reg_write(UC_M68K_REG_SR, 0x2000)
        cpu.reg_write(UC_M68K_REG_A7, 0x90000)
        cpu.mem_write(0x100, b"\x4e\x75")  # Stub the driver entry with RTS.
        cpu.mem_write(0x2094, b"\x00\x00\x01\x00")
        for latch in (0x414, 0x418):
            cpu.mem_write(latch, b"\xff\xff")
        dispatched = []
        cpu.hook_add(UC_HOOK_CODE, lambda uc, _addr, _size, _data: dispatched.append(uc.reg_read(UC_M68K_REG_D0)),
                     begin=0x100, end=0x100)

        def run(start, end):
            cpu.emu_start(start, end, count=100)
            self.assertEqual(cpu.reg_read(UC_M68K_REG_PC), end)

        run(0x615A, 0x6166)  # Normal shot, followed by a newer credit and another shot.
        run(0x472C, 0x4736)
        run(0x615A, 0x6166)
        run(0x31F2, 0x3206)  # Large explosion.
        run(0x2170, 0x219C)
        self.assertEqual(dispatched, [0x205, 0x183])
        run(0x615A, 0x6166)
        run(0x2170, 0x219C)
        self.assertEqual(dispatched[-1], 0x289)
        run(0x5D00, 0x5D1E)  # Death claims both lanes; health overwrites only lane 2.
        run(0x4894, 0x48A0)
        run(0x615A, 0x6166)
        run(0x2170, 0x219C)
        run(0x2170, 0x219C)  # Both latches were acknowledged, so neither replays.
        self.assertEqual(dispatched, [0x205, 0x183, 0x289, 0x207, 0x10A])

        first = b"".join(amiga.replay(unpacked, [0x10A]))
        second = b"".join(amiga.replay(unpacked, [0x20A]))
        self.assertEqual(first, second)
        with wave.open(str(ROOT / "amiga/audio/sfx-death.wav"), "rb") as wav:
            combined = wav.readframes(wav.getnframes())
        self.assertEqual(len(combined), len(first))
        self.assertTrue(all(both[0] == 2 * voice[0] for voice, both in
                            zip(struct.iter_unpack("<h", first), struct.iter_unpack("<h", combined))))

    def test_disk_checksums_and_file_cycles_are_rejected(self):
        image = bytearray(901120)
        image[:4] = b"DOS\0"
        offset = 881 * 512
        struct.pack_into(">I", image, offset + 16, 882)
        struct.pack_into(">I", image, offset + 324, 1)
        struct.pack_into(">I", image, offset + 20,
                         -sum(struct.unpack_from(">128I", image, offset)) & 0xFFFFFFFF)
        offset = 882 * 512
        struct.pack_into(">5I", image, offset, 8, 881, 1, 1, 882)
        image[offset + 24] = 65
        struct.pack_into(">I", image, offset + 20,
                         -sum(struct.unpack_from(">128I", image, offset)) & 0xFFFFFFFF)
        with self.assertRaisesRegex(ValueError, "Cyclic Amiga file"):
            amiga.AmigaDisk(image).read(881)
        image[offset + 24] = 66
        with self.assertRaisesRegex(ValueError, "Bad checksum"):
            amiga.AmigaDisk(image).read(881)

    def test_rendered_gameplay_effects_have_complete_nonzero_original_audio(self):
        manifest_path = ROOT / "amiga/audio/effects.json"
        if not manifest_path.exists():
            self.skipTest("Optional extracted Amiga effects not supplied")
        manifest = json.loads(manifest_path.read_text())
        self.assertEqual(set(manifest["effects"]), set(amiga.GAME_EFFECTS))
        for name, effect in manifest["effects"].items():
            with self.subTest(name=name):
                data = (ROOT / "amiga/audio" / effect["file"]).read_bytes()
                self.assertEqual(amiga.digest(data), effect["sha256"])
                with wave.open(io.BytesIO(data), "rb") as wav:
                    self.assertEqual((wav.getnchannels(), wav.getsampwidth()), (2, 2))
                    self.assertEqual(wav.getframerate(), effect["rate"])
                    self.assertEqual(wav.getnframes(), effect["frames"])
                    self.assertTrue(0 < wav.getnframes() < wav.getframerate() * 10)
                    pcm = wav.readframes(wav.getnframes())
                    self.assertTrue(any(struct.unpack("<" + "h" * (len(pcm) // 2), pcm)))


if __name__ == "__main__":
    unittest.main()
