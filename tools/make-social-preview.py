#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 GitHub「Social preview（链接卡片图）」：1280x640，深紫底 + 白色标题 + 真实面板截图。
只需要 Pillow：  pip install pillow
用法：  python3 tools/make-social-preview.py
输出：  assets/social-1280x640.png

⚠️ 坑：DroidSansFallbackFull（中文字体）没有拉丁字形，直接拿它画英文会出豆腐块；
   所以所有文字都走 auto_runs() 按「中文 / 拉丁」切段混排。
"""
import math
import os
import re

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1280, 640
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT = os.path.join(ROOT, 'assets', 'screenshot-panel.jpg')
OUT = os.path.join(ROOT, 'assets', 'social-1280x640.png')

LATIN_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
LATIN = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
CJK = '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf'

VIOLET = (139, 123, 234)
VIOLET_L = (167, 139, 250)
DIM = (200, 189, 230)
LIGHT = (236, 232, 250)
LINK = (185, 167, 224)

CJK_RE = re.compile(r'[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]')


def is_cjk(ch):
    return bool(CJK_RE.match(ch))


def auto_runs(text):
    """把字符串按「中文 / 拉丁」切成段，避免用中文字体画英文（会豆腐块）"""
    runs, buf, cur = [], '', None
    for ch in text:
        k = is_cjk(ch)
        if cur is None or k == cur:
            buf += ch
        else:
            runs.append((buf, cur))
            buf = ch
        cur = k
    if buf:
        runs.append((buf, cur))
    return runs


def font(path, size):
    return ImageFont.truetype(path, size)


def mixed(d, xy, text, size, fill, latin_bold=False):
    """混排绘制一段文字，返回结束时的 x"""
    x, y = xy
    lf = font(LATIN_BOLD if latin_bold else LATIN, size)
    cf = font(CJK, size)
    for part, cjk in auto_runs(text):
        f = cf if cjk else lf
        d.text((x, y), part, font=f, fill=fill)
        x += d.textlength(part, font=f)
    return x


def mixed_width(d, text, size, latin_bold=False):
    lf = font(LATIN_BOLD if latin_bold else LATIN, size)
    cf = font(CJK, size)
    return sum(d.textlength(p, font=(cf if c else lf)) for p, c in auto_runs(text))


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def bg_gradient():
    """135° 对角渐变 #2A1745 → #4A2E80 → #5B2E7C（小图算完再放大，过渡更顺）"""
    n = 256
    small = Image.new('RGB', (n, n))
    px = small.load()
    c1, c2, c3 = (0x2A, 0x17, 0x45), (0x4A, 0x2E, 0x80), (0x5B, 0x2E, 0x7C)
    for y in range(n):
        for x in range(n):
            t = (x + y) / (2 * (n - 1))
            px[x, y] = lerp(c1, c2, t / 0.6) if t < 0.6 else lerp(c2, c3, (t - 0.6) / 0.4)
    return small.resize((W, H), Image.BICUBIC)


def radial(size, color, power=2.0, solid=0.0, scale=1.0):
    """径向光斑（RGBA）"""
    n = 128
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    px = img.load()
    for y in range(n):
        for x in range(n):
            dx, dy = (x - n / 2) / (n / 2), (y - n / 2) / (n / 2)
            d = min(1.0, math.hypot(dx, dy))
            a = 0.0 if d <= solid else max(0.0, (1 - (d - solid) / (1 - solid))) ** power
            px[x, y] = (color[0], color[1], color[2], round(255 * a * scale))
    return img.resize(size, Image.BICUBIC)


def main():
    card = bg_gradient().convert('RGBA')

    # 光晕：只堆在截图后面，别扫到左边文字区（否则文字对比度掉下来）
    glow = radial((780, 780), VIOLET, power=1.5, scale=0.5)
    card.alpha_composite(glow, (1030 - 390, 320 - 390))

    # 暗角
    card.alpha_composite(radial((W, H), (10, 6, 24), power=1.1, solid=0.45))

    d = ImageDraw.Draw(card)
    x = 76

    # ── 左侧文字 ─────────────────────────────────────────────
    d.text((x, 130), 'ST Data Janitor', font=font(LATIN_BOLD, 82), fill=(255, 255, 255))
    d.text((x - 4, 228), '数据清洁工', font=font(CJK, 52), fill=VIOLET_L)

    y = 316
    end = mixed(d, (x, y), '给 ', 23, DIM)
    end = mixed(d, (end, y), 'SillyTavern', 23, (240, 236, 253), latin_bold=True)
    mixed(d, (end, y), ' 的自动数据保洁员', 23, DIM)

    mixed(d, (x, 352), '删除先进回收站 · 可一键还原 · 默认只试运行', 23, DIM)

    # 胶囊标签（最后一个实底，当 CTA）
    py, ph = 408, 46
    px = x
    for i, label in enumerate(('回收站可还原', '默认只试运行', '一键安装')):
        f = font(CJK, 21)
        tw = d.textlength(label, font=f)
        solid = i == 2
        d.rounded_rectangle([px, py, px + tw + 44, py + ph], radius=ph // 2,
                            fill=VIOLET_L if solid else None,
                            outline=None if solid else (214, 206, 248, 190), width=2)
        d.text((px + 22, py + 12), label, font=f, fill=(28, 17, 51) if solid else LIGHT)
        px += tw + 44 + 14

    # 底部两行（左下，离截图留足距离）
    mixed(d, (x, 530), 'v1.7.0 · MIT License · Win / macOS / Linux / NAS / Docker / 手机',
          20, DIM)
    d.text((x, 572), 'github.com/wyndam-c/st-data-janitor', font=font(LATIN, 20), fill=LINK)

    # ── 右侧：真实面板截图 ───────────────────────────────────
    shot = Image.open(SHOT).convert('RGB')
    shot = shot.crop((0, 0, shot.width - 10, shot.height))    # 裁掉右边的滚动条细线
    h = 500
    w = round(shot.width * h / shot.height)                    # ≈373
    shot = shot.resize((w, h), Image.LANCZOS)

    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=18, fill=255)

    phone = Image.new('RGBA', (w + 4, h + 4), (0, 0, 0, 0))
    phone.paste(shot, (2, 2), mask)
    rr = Image.new('L', (w + 4, h + 4), 0)
    ImageDraw.Draw(rr).rounded_rectangle([0, 0, w + 3, h + 3], radius=20, fill=255)
    phone.putalpha(rr)
    ImageDraw.Draw(phone).rounded_rectangle([0, 0, w + 3, h + 3], radius=20,
                                           outline=(208, 199, 246, 215), width=3)

    # 外发光 + 投影
    halo = Image.new('RGBA', (w + 300, h + 300), (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hd.rounded_rectangle([150, 150, 150 + w + 3, 150 + h + 3], radius=26,
                         fill=(139, 123, 234, 120))
    halo = halo.filter(ImageFilter.GaussianBlur(48))

    shadow = Image.new('RGBA', (w + 300, h + 300), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([150, 162, 150 + w + 3, 162 + h + 3],
                                             radius=26, fill=(0, 0, 0, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(34))

    cx, cy = 1027, 320
    card.alpha_composite(shadow, (cx - shadow.width // 2, cy - shadow.height // 2))
    card.alpha_composite(halo, (cx - halo.width // 2, cy - halo.height // 2))
    phone = phone.rotate(-2, resample=Image.BICUBIC, expand=True)
    card.alpha_composite(phone, (cx - phone.width // 2, cy - phone.height // 2))

    out = card.convert('RGB')
    out.save(OUT, optimize=True)
    kb = os.path.getsize(OUT) / 1024
    print('已生成 %s  %s  %.1f KB' % (OUT, out.size, kb))
    if kb > 900:
        print('⚠️ 超过 GitHub 的 1MB 限制，得改用 JPEG')


if __name__ == '__main__':
    main()
