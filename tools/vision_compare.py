"""同图、同五字段题面，对比当前Qwen服务与Seed；显式允许上传才运行。"""
import argparse
import base64
import hashlib
import http.client
import json
from pathlib import Path
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from perception.seed_worker import BASE64_TEXT, ENV_PATH, Failure, ark_transport, bounded_request, read_credentials
from tools.vision_service_probe import COMPACT_PROMPT, fixture_bytes, load_token, model_content, request, validate_compact


def summarize(rows):
    result = {}
    for provider in ("qwen", "seed"):
        selected = [row for row in rows if row["provider"] == provider]
        timings = [row["elapsed_ms"] for row in selected if row["status"] == "ok"]
        scores = [item for row in selected for item in row.get("comparisons", {}).values()]
        result[provider] = {"requests": len(selected), "valid_responses": len(timings),
                            "median_ms": statistics.median(timings) if timings else None,
                            "mean_ms": statistics.mean(timings) if timings else None,
                            "min_ms": min(timings) if timings else None, "max_ms": max(timings) if timings else None,
                            "labelled_values": len(scores), "correct": sum(x["correct"] for x in scores),
                            "unknown": sum(x["status"] == "unknown" for x in scores),
                            "wrong_known": sum(not x["correct"] and x["status"] == "known" for x in scores)}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-game-image-upload", action="store_true")
    parser.add_argument("--fixtures", required=True, type=Path)
    parser.add_argument("--token-file", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--base-url", default="http://127.0.0.1:18792")
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    if not args.allow_game_image_upload:
        parser.error("需要显式--allow-game-image-upload，仅使用已授权WoW截图")
    if not 1 <= args.repeats <= 5:
        parser.error("repeats应为1..5")
    args.out.mkdir(parents=True, exist_ok=False, mode=0o700)
    qwen_key = load_token(args.token_file)
    seed_key, seed_model = read_credentials(ENV_PATH)
    fixture = json.loads(args.fixtures.read_text())
    health, _ = request(args.base_url, "/health", None, timeout=3)
    if health.get("ready") is not True or health.get("inference_busy") is True:
        raise ValueError("local_service_not_ready_or_busy")
    rows = []
    aborted = False
    with (args.out / "results.jsonl").open("x", encoding="utf-8") as log:
        for repeat in range(args.repeats):
            for index, item in enumerate(fixture["images"]):
                raw_image = fixture_bytes(item, 2 * 1024 * 1024)
                messages = [{"role": "system", "content": COMPACT_PROMPT}, {"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(raw_image).decode()}}]}]
                # 交替先后，降低固定调用顺序对时延的影响；不并发、不重试。
                order = ("qwen", "seed") if (repeat + index) % 2 == 0 else ("seed", "qwen")
                for provider in order:
                    row = {"provider": provider, "repeat": repeat, "case": item["id"], "source_sha256": item["sha256"]}
                    payload = {"model": "wow-vision-qwen" if provider == "qwen" else seed_model,
                               "messages": messages, "stream": False, "max_tokens": 256,
                               "temperature": 0.1, "response_format": {"type": "json_object"}}
                    if provider == "seed":
                        payload["thinking"] = {"type": "disabled"}
                    started = time.monotonic()
                    try:
                        if provider == "qwen":
                            response, elapsed = request(args.base_url, "/v1/chat/completions", qwen_key, payload, timeout=30)
                        else:
                            response = bounded_request(ark_transport, payload, seed_key, 15)
                            elapsed = round((time.monotonic() - started) * 1000, 3)
                        text = model_content(response)
                        if any(key in text for key in (qwen_key, seed_key)) or "data:image/" in text.lower() or BASE64_TEXT.search(text):
                            raise Failure("unsafe_model_text")
                        row.update({"elapsed_ms": elapsed, "raw_text": text, "model": response.get("model"),
                                    "usage": response.get("usage"), "vision_service": response.get("vision_service"),
                                    "backend_timings": response.get("timings")})
                        if provider == "qwen":
                            frames = response.get("vision_service", {}).get("frames", [])
                            if len(frames) != 1 or frames[0].get("source_sha256") != item["sha256"]:
                                raise ValueError("image_sampling_source_mismatch")
                        fields = validate_compact(text)
                        row.update({"status": "ok", "fields": fields, "comparisons": {
                            key: {"expected": value, "actual": fields[key]["value"], "status": fields[key]["status"],
                                  "correct": fields[key]["status"] == "known" and fields[key]["value"] == value}
                            for key, value in item["labels"].items()}})
                    except (Failure, ValueError, OSError, http.client.HTTPException) as error:
                        code = error.code if isinstance(error, Failure) else str(error) if isinstance(error, ValueError) else type(error).__name__
                        row.update({"status": "failed", "error": code, "elapsed_ms": round((time.monotonic() - started) * 1000, 3)})
                    rows.append(row)
                    log.write(json.dumps(row, ensure_ascii=False) + "\n")
                    log.flush()
                    print(json.dumps({key: row[key] for key in ("provider", "repeat", "case", "status", "elapsed_ms")}), flush=True)
                    # 失败即停止整轮；超时后不能假设服务端已停止生成。
                    if row["status"] != "ok":
                        aborted = True
                        break
                if aborted:
                    break
            if aborted:
                break
    summary = {"model_names": {"qwen": "Qwen3.5-9B Q4_K_M / llama.cpp", "seed": seed_model},
               "prompt_version": "eye-retail-compact-v1", "prompt_sha256": hashlib.sha256(COMPACT_PROMPT.encode()).hexdigest(),
               "code_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "fixture_sha256": hashlib.sha256(args.fixtures.read_bytes()).hexdigest(),
               "max_tokens": 256, "temperature": 0.1, "thinking": False, "repeats": args.repeats,
               "summary": summarize(rows), "aborted": aborted,
               "note": "同源三张2048×1536游戏图/同题面；当前Qwen网关缩到1280×960，Seed内部预处理不同；属于部署链路对照。重复图不增加独立样本量，未测复杂场景/视频/并发。"}
    (args.out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(summary["summary"], ensure_ascii=False), flush=True)
    return 0 if len(rows) == args.repeats * len(fixture["images"]) * 2 and all(r["status"] == "ok" for r in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
