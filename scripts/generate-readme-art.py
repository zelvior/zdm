#!/usr/bin/env python3
"""Draws the README banner, the GitHub social preview image and the animated "how it works" diagram.

    pip install pillow numpy && python scripts/generate-readme-art.py

The diagram is an ILLUSTRATION of the scheduling idea (blocks, parallel connections, a slow connection replaced), drawn from a
simple simulation. It is not a recording of ZDM and shows no real speeds.
Output: docs/branding/banner.png, docs/branding/social-preview.png, docs/media/how-it-works.gif
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
FONTS = Path('/usr/share/fonts/truetype/liberation')
REGULAR, BOLD = str(FONTS / 'LiberationSans-Regular.ttf'), str(FONTS / 'LiberationSans-Bold.ttf')
font = lambda path, size: ImageFont.truetype(path, size)

# --- the logo, cut from the source artwork (white on black) ------------------------------------------------------
import numpy as np
gray = np.array(Image.open(ROOT / 'docs' / 'branding' / 'zdm-logo.jpg').convert('L')).astype(np.float32)
mask = Image.fromarray((np.clip((gray - 12) / 231, 0, 1) * 255).astype(np.uint8), 'L')
logo_mask = mask.crop(mask.getbbox())  # ZDM + tagline, tight


def logo_on(canvas, center, width):
    art = logo_mask.resize((width, round(logo_mask.height * width / logo_mask.width)), Image.LANCZOS)
    canvas.paste((255, 255, 255), (center[0] - art.width // 2, center[1] - art.height // 2), art)
    return art.height


def centered(draw, text, y, f, fill, width):
    box = draw.textbbox((0, 0), text, font=f)
    draw.text(((width - (box[2] - box[0])) // 2 - box[0], y), text, font=f, fill=fill)


# --- banner (README header) --------------------------------------------------------------------------------------
banner = Image.new('RGB', (1600, 440), (0, 0, 0))
logo_on(banner, (800, 220), 980)
banner.save(ROOT / 'docs' / 'branding' / 'banner.png', optimize=True)

# --- social preview (GitHub: Settings > General > Social preview, 1280 x 640) -------------------------------------
social = Image.new('RGB', (1280, 640), (0, 0, 0))
d = ImageDraw.Draw(social)
logo_on(social, (640, 190), 640)
centered(d, 'Fast, free, open-source download manager', 352, font(BOLD, 38), (255, 255, 255), 1280)
centered(d, '64 parallel connections  \u00b7  HTTP/2  \u00b7  browser takeover  \u00b7  video from almost any page', 412, font(REGULAR, 25), (190, 190, 190), 1280)
d.line((380, 490, 900, 490), fill=(70, 70, 70), width=2)
centered(d, 'Windows  \u00b7  macOS  \u00b7  Linux     |     Apache 2.0     |     No ads, no accounts, no telemetry', 522, font(REGULAR, 23), (235, 235, 235), 1280)
social.save(ROOT / 'docs' / 'branding' / 'social-preview.png', optimize=True)

# --- animated diagram --------------------------------------------------------------------------------------------
W, H, S = 960, 360, 2  # drawn at 2x and reduced for smooth edges
BLOCKS, LANES = 48, 6
DROP_AT, REPLACE_AT = 17, 22


def simulate():
    status = [0] * BLOCKS                      # 0 waiting, 1 downloading, 2 done
    lanes = [dict(speed=s, block=None, prog=0.0, state='active') for s in (0.21, 0.19, 0.23, 0.20, 0.03, 0.22)]
    history = []
    for frame in range(400):
        if frame == DROP_AT:
            lane = lanes[4]; lane['state'] = 'dropped'
            if lane['block'] is not None: status[lane['block']] = 0
            lane['block'] = None; lane['prog'] = 0
        if frame == REPLACE_AT:
            lanes[4] = dict(speed=0.22, block=None, prog=0.0, state='new')
        for lane in lanes:
            if lane['state'] == 'dropped':
                continue
            def take(lane):
                if lane['block'] is None and 0 in status:
                    lane['block'] = status.index(0); status[lane['block']] = 1; lane['prog'] = 0
            take(lane)
            if lane['block'] is not None:
                lane['prog'] += lane['speed']
                if lane['prog'] >= 1:
                    status[lane['block']] = 2; lane['block'] = None; lane['prog'] = 0
                    take(lane)  # the next block starts at once, so a lane never sits empty between blocks
        history.append((list(status), [dict(l) for l in lanes]))
        if all(v == 2 for v in status):
            break
    return history


def draw_frame(status, lanes, frame, finished):
    img = Image.new('RGB', (W * S, H * S), (255, 255, 255))
    d = ImageDraw.Draw(img)
    u = lambda v: int(v * S)
    d.rounded_rectangle((u(1), u(1), u(W - 2), u(H - 2)), radius=u(10), outline=(205, 205, 205), width=u(1))
    d.text((u(40), u(22)), 'One file is cut into blocks...', font=font(BOLD, u(15)), fill=(0, 0, 0))
    bw, gap, x0, y0 = 15, 3, 49, 54
    for i, st in enumerate(status):
        x = x0 + i * (bw + gap)
        box = (u(x), u(y0), u(x + bw), u(y0 + 30))
        if st == 2: d.rectangle(box, fill=(0, 0, 0))
        elif st == 1: d.rectangle(box, fill=(150, 150, 150))
        else: d.rectangle(box, outline=(160, 160, 160), width=u(1.2))
    d.text((u(40), u(106)), '...and fetched over many connections at once. A slow connection is dropped and replaced.', font=font(BOLD, u(15)), fill=(0, 0, 0))
    ly = 138
    for index, lane in enumerate(lanes):
        y = ly + index * 30
        label = 'new connection' if lane['state'] == 'new' else 'connection %d' % (index + 1)
        slow = lane['state'] == 'dropped'
        d.text((u(40), u(y + 3)), label, font=font(REGULAR, u(13)), fill=(120, 120, 120) if slow else (30, 30, 30))
        bx, bwid = 176, 430
        d.rectangle((u(bx), u(y), u(bx + bwid), u(y + 20)), outline=(190, 190, 190), width=u(1))
        if slow:
            d.text((u(bx + 10), u(y + 3)), 'too slow - dropped', font=font(REGULAR, u(13)), fill=(130, 130, 130))
            d.line((u(bx + bwid - 26), u(y + 5), u(bx + bwid - 12), u(y + 15)), fill=(130, 130, 130), width=u(2))
            d.line((u(bx + bwid - 26), u(y + 15), u(bx + bwid - 12), u(y + 5)), fill=(130, 130, 130), width=u(2))
        elif lane['block'] is not None:
            d.rectangle((u(bx), u(y), u(bx + bwid * min(1, lane['prog'])), u(y + 20)), fill=(0, 0, 0))
            d.text((u(bx + bwid + 14), u(y + 3)), 'block %d' % (lane['block'] + 1), font=font(REGULAR, u(13)), fill=(90, 90, 90))
    done = sum(1 for v in status if v == 2)
    d.text((u(760), u(150)), '%d / %d blocks' % (done, BLOCKS), font=font(BOLD, u(22)), fill=(0, 0, 0))
    d.text((u(760), u(184)), 'written in place,', font=font(REGULAR, u(14)), fill=(90, 90, 90))
    d.text((u(760), u(204)), 'checksums computed', font=font(REGULAR, u(14)), fill=(90, 90, 90))
    d.text((u(760), u(224)), 'while downloading', font=font(REGULAR, u(14)), fill=(90, 90, 90))
    if finished:
        d.rounded_rectangle((u(760), u(262), u(918), u(296)), radius=u(6), fill=(0, 0, 0))
        d.text((u(774), u(270)), 'Verified', font=font(BOLD, u(16)), fill=(255, 255, 255))
        d.line((u(876), u(280), u(883), u(287), u(899), u(271)), fill=(255, 255, 255), width=u(3), joint='curve')  # check mark, drawn (the font has none)
    d.text((u(40), u(H - 28)), 'Illustration of the scheduling idea, not a recording.', font=font(REGULAR, u(12)), fill=(150, 150, 150))
    return img.resize((W, H), Image.LANCZOS)


history = simulate()
frames, durations = [], []
for i, (status, lanes) in enumerate(history):
    frames.append(draw_frame(status, lanes, i, False)); durations.append(70)
for hold in range(14):
    frames.append(draw_frame(history[-1][0], history[-1][1], len(history), True)); durations.append(130)
palette = [f.quantize(colors=16, method=Image.MEDIANCUT, dither=Image.Dither.NONE) for f in frames]
out = ROOT / 'docs' / 'media'
out.mkdir(parents=True, exist_ok=True)
palette[0].save(out / 'how-it-works.gif', save_all=True, append_images=palette[1:], duration=durations, loop=0, optimize=True, disposal=1)
for path in (ROOT / 'docs' / 'branding' / 'banner.png', ROOT / 'docs' / 'branding' / 'social-preview.png', out / 'how-it-works.gif'):
    print(f'{path.relative_to(ROOT)!s:36s} {path.stat().st_size // 1024:5d} KB')
print('simulation frames:', len(history))
