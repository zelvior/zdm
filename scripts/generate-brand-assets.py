#!/usr/bin/env python3
"""Builds every icon and installer image from the two source logos in docs/branding/.

    pip install pillow numpy
    python scripts/generate-brand-assets.py

Sources (white artwork):  docs/branding/zdm-logo.jpg  (ZDM + "DOWNLOAD MANAGER" on black)
Rule used for every size: below 96 px the "Z" mark is used (the full wordmark is unreadable that small); from 96 px up the full
logo with its tagline is used. The Z is cut out of the logo along the logo's own slanted gap, so it keeps the artwork's shape.
"""
import io
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'docs' / 'branding' / 'zdm-logo.jpg'

# --- source artwork -----------------------------------------------------------------------------------------------
gray = np.array(Image.open(SRC).convert('L')).astype(np.float32)
# JPEG leaves faint noise around the edges: stretch 12..243 to 0..255 so the background is exactly empty.
coverage = np.clip((gray - 12) / (243 - 12), 0, 1)

H, W = coverage.shape
LETTERS = (394, 1259, 2874, 2000)  # x0, y0, x1, y1 of "ZDM" in the 3264 px source
FULL = (394, 1259, 2874, 2119)     # ... including the tagline
# Z and D are joined in the middle of the artwork. The gap above and below the join is slanted; a straight line through the
# centre of both gaps separates the Z along the logo's own italic angle.
CUT_TOP = (1322, 1259)
CUT_BOTTOM = (1232, 2000)


def mask_image(array):
    return Image.fromarray((array * 255).astype(np.uint8), 'L')


def z_mask():
    out = coverage.copy()
    ys = np.arange(H)
    x_cut = CUT_TOP[0] + (ys - CUT_TOP[1]) * (CUT_BOTTOM[0] - CUT_TOP[0]) / (CUT_BOTTOM[1] - CUT_TOP[1])
    xs = np.arange(W)[None, :]
    out[xs > x_cut[:, None]] = 0
    out[:LETTERS[1] - 4] = 0
    out[LETTERS[3] + 4:] = 0
    return out


Z = mask_image(z_mask())
FULL_MASK = mask_image(coverage)
LETTER_MASK = mask_image(np.where(np.arange(H)[:, None] < LETTERS[3] + 4, coverage, 0))
Z_BOX = Z.getbbox()
FULL_BOX = FULL_MASK.crop((0, FULL[1] - 6, W, FULL[3] + 6)).getbbox()
FULL_BOX = (FULL_BOX[0], FULL_BOX[1] + FULL[1] - 6, FULL_BOX[2], FULL_BOX[3] + FULL[1] - 6)
LETTER_BOX = LETTER_MASK.getbbox()


def glyph(mask, box, width):
    """The artwork cut to its bounding box and scaled to `width` pixels."""
    crop = mask.crop(box)
    height = max(1, round(crop.height * width / crop.width))
    return crop.resize((max(1, round(width)), height), Image.LANCZOS)


def rounded_square(size, radius_fraction=0.14):
    scale = 4
    big = Image.new('L', (size * scale, size * scale), 0)
    ImageDraw.Draw(big).rounded_rectangle((0, 0, size * scale - 1, size * scale - 1), radius=round(size * scale * radius_fraction), fill=255)
    return big.resize((size, size), Image.LANCZOS)


def badge(size, kind):
    """Black rounded square with the white mark centred in it. kind: 'z' or 'full'."""
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    black = Image.new('RGBA', (size, size), (0, 0, 0, 255))
    canvas.paste(black, (0, 0), rounded_square(size))
    art = glyph(Z, Z_BOX, size * 0.60) if kind == 'z' else glyph(FULL_MASK, FULL_BOX, size * 0.80)
    white = Image.new('RGBA', art.size, (255, 255, 255, 255))
    canvas.alpha_composite(Image.merge('RGBA', (*white.split()[:3], art)), ((size - art.width) // 2, (size - art.height) // 2))
    return canvas


def mark_for(size):
    return badge(size, 'z' if size < 96 else 'full')


def save_png(image, relative):
    path = ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, optimize=True)
    print(f'{relative:44s} {image.width}x{image.height}')


def write_ico(sizes, relative):
    frames = []
    for size in sizes:
        buffer = io.BytesIO()
        mark_for(size).save(buffer, 'PNG', optimize=True)
        frames.append((size, buffer.getvalue()))
    header = struct.pack('<HHH', 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    directory, data = b'', b''
    for size, png in frames:
        directory += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(png), offset + len(data))
        data += png
    (ROOT / relative).write_bytes(header + directory + data)
    print(f'{relative:44s} ICO {sizes}')


# --- application icons -------------------------------------------------------------------------------------------
save_png(badge(512, 'full'), 'assets/app-icon.png')          # window/Dock/launcher icon, Linux and macOS packages
save_png(badge(128, 'z'), 'assets/icon-mark.png')             # About window (shown at 64 px)
save_png(badge(32, 'z'), 'assets/tray-icon.png')              # Windows / Linux tray
save_png(badge(64, 'z'), 'assets/tray-icon@2x.png')
for size in (16, 32, 48, 128):
    save_png(mark_for(size), f'extension/icons/icon{size}.png')

# macOS menu bar: a "template" image is black artwork on transparency (the system recolours it for light/dark menu bars).
for name, px in (('tray-iconTemplate.png', 18), ('tray-iconTemplate@2x.png', 36)):
    art = glyph(Z, Z_BOX, px - 1)
    template = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    template.paste(Image.new('RGBA', art.size, (0, 0, 0, 255)), ((px - art.width) // 2, (px - art.height) // 2), art)
    save_png(template, f'assets/{name}')

ico_sizes = [16, 24, 32, 48, 64, 128, 256]
write_ico(ico_sizes, 'build/icon.ico')
write_ico(ico_sizes, 'build/installerIcon.ico')
write_ico(ico_sizes, 'build/uninstallerIcon.ico')

# --- installer artwork (NSIS) ------------------------------------------------------------------------------------
def sidebar():
    image = Image.new('RGB', (164, 314), (0, 0, 0))
    art = glyph(LETTER_MASK, LETTER_BOX, 128)
    top = 118
    image.paste((255, 255, 255), ((164 - art.width) // 2, top), art)
    ImageDraw.Draw(image).line((29, top + art.height + 22, 135, top + art.height + 22), fill=(255, 255, 255), width=1)
    return image


def header():
    image = Image.new('RGB', (150, 57), (255, 255, 255))
    plate_w, plate_h = 128, 45
    scale = 4
    plate = Image.new('L', (plate_w * scale, plate_h * scale), 0)
    ImageDraw.Draw(plate).rounded_rectangle((0, 0, plate_w * scale - 1, plate_h * scale - 1), radius=7 * scale, fill=255)
    plate = plate.resize((plate_w, plate_h), Image.LANCZOS)
    x, y = 150 - plate_w - 4, (57 - plate_h) // 2
    image.paste((0, 0, 0), (x, y), plate)
    art = glyph(FULL_MASK, FULL_BOX, 98)
    image.paste((255, 255, 255), (x + (plate_w - art.width) // 2, y + (plate_h - art.height) // 2), art)
    return image


for relative, factory in (('build/installerSidebar.bmp', sidebar), ('build/uninstallerSidebar.bmp', sidebar), ('build/installerHeader.bmp', header)):
    image = factory()
    image.save(ROOT / relative, 'BMP')
    print(f'{relative:44s} {image.width}x{image.height}')
