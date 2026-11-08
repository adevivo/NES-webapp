#!/usr/bin/env python3
"""Generate public/homebrew/test-pattern.nes: a tiny original NROM test cartridge.

Behaviour (backdrop colour, whole screen):
  blue  = no buttons held
  red   = any player-1 button held
  green = any player-2 button held (wins over player 1)

Used to check (a) an emulator boots at all, (b) controller 1 and 2 input reach the game,
(c) later: that two lockstepped emulators stay in sync. Released CC0 with this project.

Usage: python3 scripts/make-test-rom.py public/homebrew/test-pattern.nes
"""
import sys

BASE = 0xC000  # 16 KB PRG is mapped at $C000-$FFFF (mirrored at $8000)

# (label, bytes) or (label, bytes-with-("rel", target)) assembled in two passes.
prog = [
    ("reset", "78 D8 A2 FF 9A"),                 # SEI CLD LDX #$FF TXS
    ("vb1",   "2C 02 20"), (None, ("bpl", "vb1")),  # wait vblank #1
    ("vb2",   "2C 02 20"), (None, ("bpl", "vb2")),  # wait vblank #2 (PPU warm-up)
    (None,    "A9 0A 8D 01 20"),                 # PPUMASK = show background
    (None,    "A9 80 8D 00 20"),                 # PPUCTRL = NMI on vblank
    ("loop",  ("jmp", "loop")),
    ("nmi",   "A9 01 8D 16 40 A9 00 8D 16 40"),  # strobe controllers
    (None,    "A2 08"),                          # LDX #8
    ("rd",    "AD 16 40 4A 26 00"),              # LDA $4016 / LSR / ROL $00   (P1)
    (None,    "AD 17 40 4A 26 01"),              # LDA $4017 / LSR / ROL $01   (P2)
    (None,    "CA"), (None, ("bne", "rd")),      # DEX / BNE rd
    (None,    "A9 21"),                          # A = blue
    (None,    "A6 00"), (None, ("beq", "+2")),   # if P1 pressed:
    (None,    "A9 16"),                          #   A = red
    (None,    "A6 01"), (None, ("beq", "+2")),   # if P2 pressed:
    (None,    "A9 2A"),                          #   A = green
    (None,    "A2 3F 8E 06 20 A2 00 8E 06 20"),  # PPUADDR = $3F00
    (None,    "8D 07 20"),                       # backdrop colour = A
    (None,    "A2 00 8E 05 20 8E 05 20"),        # scroll 0,0
    (None,    "A9 80 8D 00 20"),                 # PPUCTRL again (reset nametable bits)
    (None,    "40"),                             # RTI
]
OPC = {"bpl": 0x10, "bne": 0xD0, "beq": 0xF0}


def size(item):
    if isinstance(item, tuple):
        return 3 if item[0] == "jmp" else 2
    return len(bytes.fromhex(item))


labels, pc = {}, BASE
for label, item in prog:
    if label:
        labels[label] = pc
    pc += size(item)

code, pc = bytearray(), BASE
for _, item in prog:
    if isinstance(item, tuple):
        op, target = item
        if op == "jmp":
            addr = labels[target]
            code += bytes([0x4C, addr & 0xFF, addr >> 8])
        else:
            dest = pc + 2 + int(target[1:]) if target.startswith("+") else labels[target]
            off = dest - (pc + 2)
            assert -128 <= off <= 127
            code += bytes([OPC[op], off & 0xFF])
    else:
        code += bytes.fromhex(item)
    pc += size(item)

prg = bytearray(16384)
prg[: len(code)] = code
nmi, reset = labels["nmi"], labels["reset"]
prg[0x3FFA:0x4000] = bytes([nmi & 0xFF, nmi >> 8, reset & 0xFF, reset >> 8, nmi & 0xFF, nmi >> 8])
header = b"NES\x1a" + bytes([1, 1, 0, 0]) + bytes(8)  # 1x16KB PRG, 1x8KB CHR, mapper 0
open(sys.argv[1], "wb").write(header + prg + bytes(8192))
print(f"wrote {sys.argv[1]} ({len(code)} bytes of code)")
