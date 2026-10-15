import argparse
import json
import time
from pathlib import Path
from urllib import request


ROOT = Path(__file__).resolve().parents[1]


QUERIES = [
    "mountain,lake,landscape",
    "forest,river,landscape",
    "coast,cliff,ocean",
    "waterfall,mountain,valley",
    "city,skyline,architecture",
    "modern,building,architecture",
    "historic,building,architecture",
    "bridge,river,architecture",
    "lake,reflection,mountain",
    "quiet,street,architecture",
]


def parse_args():
    parser = argparse.ArgumentParser(description="下载早报卡片风景底图")
    parser.add_argument("--count", type=int, default=50, help="下载图片数量，默认 50")
    parser.add_argument("--out-dir", default=str(ROOT / "assets" / "scenery"), help="输出目录")
    parser.add_argument("--width", type=int, default=1080)
    parser.add_argument("--height", type=int, default=1620)
    parser.add_argument("--sleep", type=float, default=0.35, help="下载间隔秒数")
    return parser.parse_args()


def download(url: str, path: Path) -> dict:
    req = request.Request(url, headers={"User-Agent": "workday-morning-card/1.0"})
    with request.urlopen(req, timeout=18) as resp:
        data = resp.read()
        final_url = resp.geturl()
        content_type = resp.headers.get("Content-Type", "")
    path.write_bytes(data)
    return {"path": str(path), "url": final_url, "content_type": content_type, "bytes": len(data)}


def main():
    args = parse_args()
    out_dir = Path(args.out_dir)
    if not out_dir.is_absolute():
        out_dir = ROOT / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest = []
    for idx in range(1, args.count + 1):
        query = QUERIES[(idx - 1) % len(QUERIES)]
        urls = [
            f"https://source.unsplash.com/{args.width}x{args.height}/?{query}&sig={idx}",
            f"https://picsum.photos/seed/workday-landscape-architecture-{idx}/{args.width}/{args.height}",
        ]
        suffix = f"{idx:02d}"
        path = out_dir / f"scenery-{suffix}.jpg"
        if path.exists() and path.stat().st_size > 10_000:
            manifest.append({"path": str(path), "query": query, "provider": "existing file", "bytes": path.stat().st_size})
            print(f"[{idx}/{args.count}] exists {path}")
            continue
        last_error = ""
        for url in urls:
            try:
                item = download(url, path)
                item["query"] = query
                item["provider"] = "Unsplash Source / LoremFlickr / Picsum fallback"
                manifest.append(item)
                print(f"[{idx}/{args.count}] {path}")
                last_error = ""
                break
            except Exception as exc:
                last_error = str(exc)
        if last_error:
            print(f"[{idx}/{args.count}] failed: {last_error}")
        time.sleep(args.sleep)

    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print("提示：下载后请查看 _contact_sheet.jpg 或手动抽检，只保留山水/建筑照片。")
    print(out_dir / "manifest.json")


if __name__ == "__main__":
    main()
