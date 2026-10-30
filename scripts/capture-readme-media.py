#!/usr/bin/env python3
"""Renders ZDM's real interface (renderer/) with SAMPLE downloads and records the images used in README.md.

    pip install pillow playwright && python -m playwright install chromium
    python scripts/capture-readme-media.py

Only the desktop bridge (window.downloader, normally provided by the Electron preload script) is replaced by sample data;
the HTML, CSS and JavaScript are the application's own. Nothing here downloads anything. The pages are drawn by Chromium
(the engine inside Electron), with Liberation Sans standing in for Segoe UI when it is not installed.

Output (docs/media/): screenshot-main.png, screenshot-add.png, screenshot-details.png, demo.gif
"""
import hashlib
import http.server
import io
import json
import math
import socketserver
import threading
from functools import partial
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs' / 'media'
OUT.mkdir(parents=True, exist_ok=True)
MB, GB = 1024 ** 2, 1024 ** 3
MAIN_SIZE = (1180, 600)          # window used for the GIF
LIST_SIZE = (1180, 470)          # window used for the list screenshot
ADD_SIZE = (1180, 690)           # tall enough for the whole Add dialog with Advanced open
PROGRESS_SIZE = (565, 600)       # the real details ("progress") window, a little taller than its 485 px default so the mirror table fits
FONT_FIX = ':root,button,input,textarea,select,dialog,table{font-family:"Segoe UI","Liberation Sans",Arial,sans-serif !important}'


# --- sample data -----------------------------------------------------------------------------------------------------
def digest(name):
    return hashlib.sha256(name.encode()).hexdigest(), hashlib.md5(name.encode()).hexdigest()


def sample(id_, name, category, total, fraction, status, speed=0, minute=0, **extra):
    d = dict(id=id_, filename=name, url=f'https://downloads.example.com/{name}', category=category, total=total,
             downloaded=int(total * fraction), status=status, speed=speed, resumable=True, layout='direct', protocol='h2',
             kind='file', createdAt=f'2026-10-30T08:{minute:02d}:00Z', lastTry=f'2026-10-30T08:{minute:02d}:00Z', description='')
    d.update(extra)
    return d


def live_transfer(active=32, drops=2):
    return dict(configured=32, allowed=32, active=active, adaptive=True, drops=drops, multiplex=False,
                hashing=dict(enabled=True, threaded=True),
                sources=[dict(host='cdn.example.com', protocol='h2', active=20, allowed=20, speed=26 * MB, dead=False, coolingMs=0),
                         dict(host='mirror.example.org', protocol='h2', active=12, allowed=12, speed=12 * MB, dead=False, coolingMs=0)])


def connections(fraction, count=32, seed=1):
    out = []
    for i in range(count):
        wobble = 0.14 * math.sin(i * 1.7 + seed) + 0.07 * math.cos(i * 0.9)
        part = max(0.02, min(1.0, fraction + wobble))
        out.append(dict(downloaded=int(4 * MB * part), total=4 * MB, status='complete' if part >= 0.999 else ''))
    return out


def initial_downloads():
    sha, md5 = digest('blender')
    return [
        sample('d1', 'ubuntu-24.04.2-desktop-amd64.iso', 'Archives', int(6.2 * GB), 0.63, 'downloading', 38 * MB, 14,
               transfer=live_transfer(), connectionsProgress=connections(0.63)),
        sample('d2', 'open-movie-1080p.mp4', 'Video', int(1.1 * GB), 0.41, 'downloading', int(12.4 * MB), 12,
               transfer=live_transfer(16, 0)),
        sample('d3', 'dataset-images-2026.tar.zst', 'Archives', int(3.4 * GB), 0.08, 'downloading', 21 * MB, 11,
               transfer=live_transfer(24, 1)),
        sample('d4', 'blender-4.2.0-windows-x64.msi', 'Programs', 391 * MB, 1, 'completed', 0, 3,
               integrity=dict(status='verified', sha256=sha, md5=md5)),
        sample('d5', 'annual-report-2026.pdf', 'Documents', int(4.2 * MB), 1, 'completed', 0, 2),
        sample('d6', 'podcast-episode-114.mp3', 'Audio', 58 * MB, 1, 'completed', 0, 1),
        sample('d7', 'lecture-03-networks.mp4', 'Video', 740 * MB, 0, 'queued', 0, 9),
        sample('d8', 'photo-album-2026.zip', 'Archives', int(1.8 * GB), 0.54, 'paused', 0, 6, description='Stopped by user'),
        sample('d9', 'wallpapers-pack.zip', 'Archives', 212 * MB, 0, 'scheduled', 0, 5, scheduledAt='2026-10-31T02:00:00Z'),
    ]


SETTINGS = dict(defaultDirectory='C:\\Downloads', categoryDirectories={}, maxConcurrent=3, connections=32, speedLimitKbps=0,
                notifyOnComplete=True, hideCompletionDialog=False)

# The stand-in for the Electron preload bridge. Every method resolves with the current sample state.
STUB = """
(() => {
  const clone = v => JSON.parse(JSON.stringify(v));
  const state = { downloads: %s, settings: %s, integration: { packaged: false, connectedBrowsers: ['Chrome'] } };
  const listeners = [];
  window.__push = next => { if (next) state.downloads = next; listeners.forEach(cb => cb(clone(state))); };
  window.__lastAdd = null;
  const ok = async () => clone(state);
  window.downloader = {
    snapshot: ok, settings: ok, action: ok, review: ok, clipboard: async () => ({}), integration: async () => clone(state.integration),
    browserSetup: ok, registerBrowser: ok, closeProgress: ok, resizeProgress: ok, about: ok, chooseDirectory: async () => '',
    openProgress: async () => ({}),
    add: async request => { window.__lastAdd = request; return ['d10']; },
    subscribe: cb => { listeners.push(cb); return () => {}; },
    onCommand: () => () => {}
  };
})();
"""


# --- helpers ---------------------------------------------------------------------------------------------------------
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve():
    server = socketserver.TCPServer(('127.0.0.1', 0), partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_address[1]}'


def new_page(browser, base, size, query='', scale=1, downloads=None):
    context = browser.new_context(viewport=dict(width=size[0], height=size[1]), device_scale_factor=scale, locale='en-US', timezone_id='UTC', bypass_csp=True)  # bypass_csp: only so the font stand-in below can be injected
    page = context.new_page()
    page.add_init_script(STUB % (json.dumps(downloads or initial_downloads()), json.dumps(SETTINGS)))
    page.goto(f'{base}/renderer/index.html{query}')
    page.add_style_tag(content=FONT_FIX)
    page.wait_for_selector('#details-dialog[open]' if query else '.download-row')
    return page


def shot(page):
    return Image.open(io.BytesIO(page.screenshot())).convert('RGB')


def frame_of(image):
    """A soft shadow and a thin border, so a screenshot reads as a window on a page. The padding is transparent, so it works on
    GitHub's light and dark themes."""
    pad = 36
    size = (image.width + 2 * pad, image.height + 2 * pad)
    shadow = Image.new('L', size, 0)
    ImageDraw.Draw(shadow).rectangle((pad, pad + 8, pad + image.width, pad + image.height + 8), fill=110)
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    canvas = Image.new('RGBA', size, (0, 0, 0, 0))
    canvas.paste(Image.new('RGBA', size, (0, 0, 0, 255)), (0, 0), shadow)
    canvas.paste(image.convert('RGBA'), (pad, pad))
    ImageDraw.Draw(canvas).rectangle((pad - 1, pad - 1, pad + image.width, pad + image.height), outline=(150, 150, 150, 255))
    return canvas


# --- animation state -------------------------------------------------------------------------------------------------
def progressed(downloads, step):
    """Sample state after `step` animation steps: active downloads advance, speeds breathe a little."""
    out = json.loads(json.dumps(downloads))
    for d in out:
        if d['status'] != 'downloading':
            continue
        rate = {'d1': 0.0105, 'd2': 0.0072, 'd3': 0.0052, 'd10': 0.0135}.get(d['id'], 0.005)
        fraction = min(0.995, d['downloaded'] / d['total'] + rate * step)
        d['downloaded'] = int(d['total'] * fraction)
        d['speed'] = int(d['speed'] * (1 + 0.07 * math.sin(step * 0.9 + len(d['id']))))
        if 'connectionsProgress' in d:
            d['connectionsProgress'] = connections(fraction, len(d['connectionsProgress']), seed=step * 0.3)
    return out


def main():
    server, base = serve()
    frames, durations = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ---- stills (2x for crisp text) -------------------------------------------------------------------------
        page = new_page(browser, base, LIST_SIZE, scale=2)
        page.click('.download-row[data-id="d1"]')
        page.wait_for_timeout(150)
        frame_of(shot(page)).save(OUT / 'screenshot-main.png', optimize=True)
        page.context.close()

        page = new_page(browser, base, ADD_SIZE, scale=2)
        page.click('#new-download')
        page.fill('#download-urls', 'https://downloads.example.com/releases/distro-24.04-desktop-amd64.iso')
        page.click('summary')
        page.fill('#download-mirrors', 'https://mirror.example.org/releases/distro-24.04-desktop-amd64.iso')
        page.fill('#download-checksum', 'sha256:3f2a9c1e5b7d4a60b8c2e9f1a4d7035c6b8e1f2a9d4c7e0b3a5f6d8c1e2b4a70')
        page.wait_for_timeout(150)
        # just the dialog: it stays legible when README shows it at half width
        frame_of(Image.open(io.BytesIO(page.locator('#add-dialog').screenshot())).convert('RGB')).save(OUT / 'screenshot-add.png', optimize=True)
        page.context.close()

        details = new_page(browser, base, PROGRESS_SIZE, query='?progress=d1', scale=2)
        details.wait_for_timeout(200)
        frame_of(shot(details)).save(OUT / 'screenshot-details.png', optimize=True)
        details.context.close()

        # ---- demo GIF: 1x, real UI, scripted like a user ---------------------------------------------------------
        page = new_page(browser, base, MAIN_SIZE)
        page.click('.download-row[data-id="d1"]')
        base_state = initial_downloads()
        step = 0

        def push_and_grab(hold=120, extra_steps=1):
            nonlocal step
            step += extra_steps
            page.evaluate('s => window.__push(s)', progressed(base_state, step))
            page.wait_for_timeout(40)
            frames.append(shot(page)); durations.append(hold)

        for _ in range(9):
            push_and_grab()
        # open Add URL, type the address, confirm
        page.click('#new-download'); page.wait_for_timeout(60)
        url = 'https://downloads.example.com/releases/distro-24.04-desktop-amd64.iso'
        for i in range(0, len(url) + 1, 14):
            page.fill('#download-urls', url[:i]); page.wait_for_timeout(30)
            frames.append(shot(page)); durations.append(90)
        page.fill('#download-urls', url); page.wait_for_timeout(30)
        frames.append(shot(page)); durations.append(700)
        page.click('#add-submit'); page.wait_for_timeout(120)
        added = sample('d10', 'distro-24.04-desktop-amd64.iso', 'Archives', int(2.9 * GB), 0.02, 'downloading', 41 * MB, 15,
                       transfer=live_transfer(32, 0), connectionsProgress=connections(0.02))
        base_state = [added] + base_state
        for _ in range(5):
            push_and_grab()
        main_after_add = frames[-1]

        # the details window of the new download opens (it is its own window in the real app)
        scene_state = progressed(base_state, step)  # continue exactly where the list left off
        details = new_page(browser, base, PROGRESS_SIZE, query='?progress=d10', downloads=scene_state)
        dim = Image.eval(main_after_add, lambda v: int(v * 0.45))
        px, py = (MAIN_SIZE[0] - PROGRESS_SIZE[0]) // 2, (MAIN_SIZE[1] - PROGRESS_SIZE[1]) // 2
        for i in range(16):
            step += 1
            scene_state = progressed(scene_state, 1)
            details.evaluate('s => window.__push(s)', scene_state)
            page.evaluate('s => window.__push(s)', scene_state)
            details.wait_for_timeout(40)
            win = shot(details)
            canvas = dim.copy()
            shadow = Image.new('L', canvas.size, 0)
            ImageDraw.Draw(shadow).rectangle((px, py + 10, px + win.width, py + win.height + 10), fill=140)
            canvas.paste((0, 0, 0), (0, 0), shadow.filter(ImageFilter.GaussianBlur(12)))
            canvas.paste(win, (px, py))
            frames.append(canvas); durations.append(110)
        browser.close()
    server.shutdown()

    # ---- assemble the GIF (960 px wide, shared palette per frame, looped) -----------------------------------------
    scale = 960 / MAIN_SIZE[0]
    small = [f.resize((960, round(f.height * scale)), Image.LANCZOS) for f in frames]
    palette = [f.quantize(colors=96, method=Image.MEDIANCUT, dither=Image.Dither.NONE) for f in small]
    durations[-1] = 1800
    palette[0].save(OUT / 'demo.gif', save_all=True, append_images=palette[1:], duration=durations, loop=0, optimize=True, disposal=1)
    for name in ('screenshot-main.png', 'screenshot-add.png', 'screenshot-details.png', 'demo.gif'):
        print(f'{name:26s} {(OUT / name).stat().st_size // 1024:5d} KB')


if __name__ == '__main__':
    main()
