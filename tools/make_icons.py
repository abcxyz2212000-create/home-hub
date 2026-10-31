"""Generate the PWA icons (simple house mark) with the Python standard library only.

Usage: python tools/make_icons.py
Writes web/icons/icon-192.png, icon-512.png, icon-512-maskable.png
"""
import struct
import zlib
from pathlib import Path

BG = (42, 93, 176)
FG = (255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "web" / "icons"


def house_pixel(x: float, y: float, scale: float) -> tuple:
    """Return the colour at normalised coordinates (0..1) for a house drawn at `scale`."""
    # map into the house's own box, centred
    u = (x - 0.5) / scale + 0.5
    v = (y - 0.5) / scale + 0.5
    roof = 0.12 <= v <= 0.48 and abs(u - 0.5) <= (v - 0.12) / 0.36 * 0.42
    body = 0.46 <= v <= 0.86 and 0.2 <= u <= 0.8
    door = 0.62 <= v <= 0.86 and 0.43 <= u <= 0.57
    if door:
        return BG
    if roof or body:
        return FG
    return BG


def png(size: int, scale: float, rounded: bool) -> bytes:
    rows = []
    radius = size * 0.18
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            x, y = (px + 0.5) / size, (py + 0.5) / size
            alpha = 255
            if rounded:
                cx = min(max(px + 0.5, radius), size - radius)
                cy = min(max(py + 0.5, radius), size - radius)
                if (px + 0.5 - cx) ** 2 + (py + 0.5 - cy) ** 2 > radius ** 2:
                    alpha = 0
            row.extend((*house_pixel(x, y, scale), alpha))
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "icon-192.png").write_bytes(png(192, 0.9, True))
    (OUT / "icon-512.png").write_bytes(png(512, 0.9, True))
    # maskable: full-bleed background, mark inside the 80% safe zone
    (OUT / "icon-512-maskable.png").write_bytes(png(512, 0.65, False))
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
