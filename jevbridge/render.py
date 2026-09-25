"""把档位渲染成图片，并提供测试用的干扰函数（全部离线，不涉及真实截屏）。"""
import math
import random

from PIL import Image, ImageFilter

from .schema import COLUMNS


def render_levels(levels, cell_px=3, columns=COLUMNS, size=None, offset=(0, 0), background=None):
    """levels: [(r, g, b), ...] 每个 0–15 档。返回 RGB 图，色条左上角在 offset。

    size 为 None 时画布正好容纳色条；background 可以是颜色元组或 PIL 图（尺寸需等于 size）。
    """
    rows = (len(levels) + columns - 1) // columns
    w, h = columns * cell_px, rows * cell_px
    if size is None:
        size = (w + offset[0], h + offset[1])
    if isinstance(background, Image.Image):
        img = background.convert("RGB").copy()
    else:
        img = Image.new("RGB", size, background or (0, 0, 0))
    strip = Image.new("RGB", (w, h), (0, 0, 0))
    px = strip.load()
    for i, (r, g, b) in enumerate(levels):
        col, row = i % columns, i // columns
        c = (r * 17, g * 17, b * 17)
        for dy in range(cell_px):
            for dx in range(cell_px):
                px[col * cell_px + dx, row * cell_px + dy] = c
    img.paste(strip, offset)
    return img


def render_rects(rects, size):
    """按物理像素矩形渲染：rects = [(x, y, w, h, (r, g, b)), ...]，颜色为 0–255。"""
    img = Image.new("RGB", size, (0, 0, 0))
    px = img.load()
    for x, y, w, h, c in rects:
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                if 0 <= xx < size[0] and 0 <= yy < size[1]:
                    px[xx, yy] = c
    return img


# ---------- 干扰 ----------

def scale(img, factor):
    w, h = img.size
    return img.resize((round(w * factor), round(h * factor)), Image.BILINEAR)


def blur(img, sigma):
    """精确的高斯模糊（5×5 核，标准差 sigma）。

    不用 PIL 的 GaussianBlur：它用三次盒式模糊近似，小半径时拖尾偏重，
    GaussianBlur(0.6) 会把夹在黑格之间的白格中心压到 245（偏差 10，超出 ±8 容差）。
    """
    w1 = [math.exp(-(d * d) / (2 * sigma * sigma)) for d in range(-2, 3)]
    total = sum(w1) ** 2
    kernel = [a * b / total for a in w1 for b in w1]
    return img.filter(ImageFilter.Kernel((5, 5), kernel, scale=1))


def noise(img, amp, seed=0):
    rng = random.Random(seed)
    data = [max(0, min(255, v + rng.randint(-amp, amp))) for px in img.get_flattened_data() for v in px]
    out = Image.new("RGB", img.size)
    out.putdata([tuple(data[i:i + 3]) for i in range(0, len(data), 3)])
    return out


def gamma(img, g):
    lut = [max(0, min(255, round(255 * (v / 255) ** g))) for v in range(256)]
    return img.point(lut * 3)


def random_background(size, seed=0):
    rng = random.Random(seed)
    img = Image.new("RGB", size)
    img.putdata([(rng.randrange(256), rng.randrange(256), rng.randrange(256))
                 for _ in range(size[0] * size[1])])
    return img


def corrupt_cell(levels, index, channel=0):
    """把第 index 格的某个通道改到另一个档位，返回新列表。"""
    out = list(levels)
    c = list(out[index])
    c[channel] = (c[channel] + 8) % 16
    out[index] = tuple(c)
    return out
