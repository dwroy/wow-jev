import math
import random

from jevbridge import schema

EDGE_VALUES = [float("nan"), float("inf"), float("-inf"), True, False]


def random_value(rng, t):
    maxv = schema.MAXES[t]
    x = rng.random()
    if x < 0.45:
        return rng.randint(0, maxv)
    if x < 0.60:
        return rng.uniform(-10, maxv * 1.2)
    if x < 0.68:
        return rng.randint(0, min(maxv, 1000)) + 0.5  # 四舍五入边界
    if x < 0.74:
        return -rng.randint(1, 100000)
    if x < 0.80:
        return maxv + rng.randint(1, 100000)
    if x < 0.88:
        return rng.choice(EDGE_VALUES)
    return None  # 缺字段


def random_fields(rng, fields):
    obj = {}
    for f in fields:
        t = f["type"]
        if t == "array":
            n = rng.randint(0, f["count"] + 2)
            obj[f["name"]] = [random_fields(rng, f["fields"]) for _ in range(n)]
        elif t in ("bits8", "bits16"):
            names = f["bits"] + ["unknown_flag"]
            obj[f["name"]] = {nm: rng.random() < 0.5 for nm in names if rng.random() < 0.8}
        else:
            v = random_value(rng, t)
            if v is not None:
                obj[f["name"]] = v
    return obj


def random_state(seed):
    return random_fields(random.Random(seed), schema.SCHEMA["fields"])


def is_nan(v):
    return isinstance(v, float) and math.isnan(v)
