"""慢系统"看一眼"：把截图交给火山方舟 Seed 视觉模型，返回结构化结果、耗时和 token 用量。

key 和模型 ID 只在运行时从 ~/.config/wow-jev/api.env 读取（ARK_API_KEY、ARK_MODEL），不打印、不落盘。
选型依据（2026-09 横评）：Seed-2.0-mini 读名字/等级/法术/字幕准且便宜；血量、蓝量这类百分比
视觉模型误差 10–30 个百分点，交给颜色 CV。关闭思考、全画面、detail 用默认。
依赖 openai 包：uv run --with openai ...
"""
import base64
import io
import json
import re
import time
from pathlib import Path

from PIL import Image

ENV_FILE = Path("~/.config/wow-jev/api.env").expanduser()
BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
PRICE_IN, PRICE_OUT = 0.2, 2.0  # 元/百万 token，Seed-2.0-mini 官方价（2026-09）

SYSTEM = "你是游戏画面分析器。输入是一张《魔兽世界》截图。只输出一个 JSON 对象，不要任何其他文字。"
PROMPT = """读取这张《魔兽世界》截图，只输出 JSON（看不到填 null）：
{"in_combat": 玩家头像外圈是否为红色,
 "target": null 或 {"name": 目标名字, "level": 目标等级, "dead": 目标是否已死亡},
 "casting": null 或 {"spell": 施法条上的法术名, "remaining_s": 剩余秒数},
 "subtitle": 画面中下方的解说大字幕,
 "scene": 20 字以内描述正在发生什么}
布局：玩家头像框在画面中部偏左；目标头像框在它右侧（名字在红色底条上，等级在头像右下角圆圈里）；施法条是两者之间下方的金色长条。"""

# 真实客户端（零售版默认界面）。"目标"必须严格限定为目标头像框，否则模型会把场景里高亮的 NPC 当成目标。
PROMPT_LIVE = """读取这张《魔兽世界》游戏截图，只输出 JSON（看不到填 null）：
{"player": {"name": 玩家头像框里的名字, "level": 玩家头像框里的等级数字},
 "in_combat": 玩家是否在战斗中,
 "target": 只看玩家头像框右侧的第二个带头像的框（目标头像框）；画面里没有这个框就填 null，不要把场景里的 NPC 当成目标。有则填 {"name", "level", "dead"},
 "casting": null 或 {"spell": 施法条上的法术名, "remaining_s": 剩余秒数},
 "tutorial": 屏幕中间的教程或任务提示文字,
 "quest_npcs": [头顶有 ! 或 ? 标记的 NPC 名字],
 "chat_last": 聊天框最后一行,
 "scene": 20 字以内描述正在发生什么}
布局：玩家头像框在画面中下偏左，动作条在底部中间，聊天框在左下角，鼠标提示在右下角（提示里的等级不是玩家等级）。"""


def load_env(path=ENV_FILE):
    out = {}
    for ln in Path(path).read_text().splitlines():
        if "=" in ln and not ln.lstrip().startswith("#"):
            k, v = ln.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def jpeg_b64(image, quality=90):
    buf = io.BytesIO()
    image.convert("RGB").save(buf, "JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode()


def parse_json(text):
    """取出第一个 JSON 对象。Seed 偶尔漏写嵌套对象的右括号（实测约 3%），按缺几个补几个再试。"""
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    s = m.group(0)
    for fix in ("", "}" * (s.count("{") - s.count("}"))):
        try:
            return json.loads(s + fix)
        except json.JSONDecodeError:
            pass
    return None


class Seed:
    def __init__(self, model=None, env_file=ENV_FILE, timeout=30):
        from openai import OpenAI

        env = load_env(env_file)
        self.model = model or env["ARK_MODEL"]
        self.client = OpenAI(base_url=BASE_URL, api_key=env["ARK_API_KEY"], timeout=timeout)

    def look(self, image, prompt=PROMPT, system=SYSTEM, max_tokens=200, max_side=1920):
        """image 为 PIL 图。返回 text、json、ttft、total（秒）、in_tokens、out_tokens、cost（元）。

        上传前把最长边缩到 max_side：Seed 按固定 token 计费，4K 原图只会多花约 0.25 秒传输时间。
        """
        if max(image.size) > max_side:
            k = max_side / max(image.size)
            image = image.resize((round(image.width * k), round(image.height * k)), Image.LANCZOS)
        t0 = time.perf_counter()
        ttft, parts, usage = None, [], None
        stream = self.client.chat.completions.create(
            model=self.model, max_tokens=max_tokens, stream=True, stream_options={"include_usage": True},
            extra_body={"thinking": {"type": "disabled"}},
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": [
                          {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{jpeg_b64(image)}"}},
                          {"type": "text", "text": prompt}]}])
        for ch in stream:
            if ch.usage:
                usage = ch.usage
            if ch.choices and ch.choices[0].delta.content:
                ttft = ttft or time.perf_counter() - t0
                parts.append(ch.choices[0].delta.content)
        text = "".join(parts)
        tin = getattr(usage, "prompt_tokens", 0) or 0
        tout = getattr(usage, "completion_tokens", 0) or 0
        return {"text": text, "json": parse_json(text), "ttft": ttft, "total": time.perf_counter() - t0,
                "in_tokens": tin, "out_tokens": tout, "cost": (tin * PRICE_IN + tout * PRICE_OUT) / 1e6}
