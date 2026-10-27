"""把浏览器下载目录里的采集结果搬运到「信息储存」，并补齐转 PNG。

采集扩展会先把文件下载到浏览器的下载目录：
    <下载目录>/模型发布信息采集/<时间文件夹>/{model_xxx.json, screenshot_visible.png, images/*}
本脚本把已经下载完成的文件夹搬到脚本旁边的 信息储存/ 里，并做三件事：
    1. 等待下载完成（不存在 .crdownload 且 5 秒内没有新文件）；
    2. 缺图时按 JSON 里的 images 链接补下载（带 Referer 和重试）；
    3. 把 webp/jpg 统一转成 PNG，方便闲鱼上传。

用法：
    双击 搬运一次.bat                      搬一次
    双击 启动自动搬运.bat                  常驻监控（默认每 3 秒检查一次）
    python move_to_storage.py --repair      搬运后顺便补齐历史文件夹缺失的图片
    python move_to_storage.py --source D:\\Downloads\\模型发布信息采集 --target E:\\数据\\信息储存

可用环境变量：
    XY_DOWNLOAD_DIR     浏览器下载目录（默认 用户目录\\Downloads）
    XY_COLLECT_TARGET   信息储存目录（默认脚本同级的 信息储存）
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import requests
from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
MAX_IMAGES = 10
MAX_IMAGE_BYTES = 30 * 1024 * 1024
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)

TARGET = Path(os.getenv("XY_COLLECT_TARGET") or (SCRIPT_DIR / "信息储存")).resolve()
DOWNLOAD_DIR = Path(os.getenv("XY_DOWNLOAD_DIR") or (Path.home() / "Downloads"))
SOURCE = DOWNLOAD_DIR / "模型发布信息采集"

_REPAIRED: set[str] = set()
_WARNED_SOURCE = False
_LOG_DIR: Path | None = None  # 由 main() 设置为本次实际使用的 --target


def log(message: str) -> None:
    print(message, flush=True)


def error_log_path() -> Path:
    return (_LOG_DIR or TARGET) / "_搬运错误.log"


def log_error(message: str) -> None:
    log(f"[错误] {message}")
    try:
        path = error_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {message}\n")
    except OSError:
        pass


def make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    try:
        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry

        retry = Retry(total=3, backoff_factor=0.8, status_forcelist=(429, 500, 502, 503, 504))
        adapter = HTTPAdapter(max_retries=retry)
        session.mount("http://", adapter)
        session.mount("https://", adapter)
    except Exception:  # pragma: no cover - 没有 urllib3 时退化为普通请求
        pass
    return session


def has_incomplete_download(folder: Path) -> bool:
    return any(path.suffix.lower() == ".crdownload" for path in folder.rglob("*"))


def folder_is_stable(folder: Path, min_age_seconds: int = 5) -> bool:
    """文件夹里没有 .crdownload，且最近 min_age_seconds 秒没有新文件写入。"""
    try:
        newest = max((path.stat().st_mtime for path in folder.rglob("*")), default=folder.stat().st_mtime)
    except (FileNotFoundError, PermissionError):
        return False
    return (time.time() - newest) >= min_age_seconds and not has_incomplete_download(folder)


def image_ext(url: str, content_type: str = "") -> str:
    path = urlparse(url).path.lower()
    match = re.search(r"\.([a-z0-9]{3,5})$", path)
    if match and match.group(1) in {"jpg", "jpeg", "png", "webp", "gif"}:
        return "jpg" if match.group(1) == "jpeg" else match.group(1)
    content_type = (content_type or "").lower()
    for keyword in ("png", "webp", "gif"):
        if keyword in content_type:
            return keyword
    return "jpg"


def read_json(folder: Path) -> dict:
    json_files = sorted(folder.glob("model*.json")) or sorted(folder.glob("*.json"))
    for json_file in json_files:
        try:
            return json.loads(json_file.read_text(encoding="utf-8"))
        except Exception as error:  # noqa: BLE001
            log_error(f"读取 JSON 失败：{json_file}（{error}）")
    return {}


# ---------------------------------------------------------------------------
# 图片补下载 / 转 PNG
# ---------------------------------------------------------------------------
def download_images(folder: Path, data: dict, session: requests.Session) -> tuple[int, int]:
    urls = [url for url in (data.get("images") or []) if isinstance(url, str)][:MAX_IMAGES]
    if not urls:
        return 0, 0

    images_dir = folder / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    headers = {
        "Referer": data.get("url") or "https://makerworld.com.cn/",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    }

    done = 0
    for index, url in enumerate(urls, start=1):
        if list(images_dir.glob(f"image_{index:02d}.*")):
            done += 1
            continue
        try:
            response = session.get(url, headers=headers, timeout=(10, 30), stream=True)
            response.raise_for_status()
            content_type = response.headers.get("Content-Type", "")
            if content_type and not content_type.lower().startswith("image/") and "octet-stream" not in content_type.lower():
                raise ValueError(f"返回内容不是图片（{content_type}）")
            chunks = []
            size = 0
            for chunk in response.iter_content(64 * 1024):
                size += len(chunk)
                if size > MAX_IMAGE_BYTES:
                    raise ValueError("图片超过 30MB，已跳过")
                chunks.append(chunk)
            ext = image_ext(url, content_type)
            output = images_dir / f"image_{index:02d}.{ext}"
            output.write_bytes(b"".join(chunks))
            if output.stat().st_size <= 0:
                output.unlink(missing_ok=True)
                raise ValueError("下载到的文件为空")
            done += 1
        except Exception as error:  # noqa: BLE001
            log_error(f"图片下载失败 {index}/{len(urls)}：{url}（{error}）")
    return done, len(urls)


def convert_images_to_png(folder: Path) -> None:
    images_dir = folder / "images"
    if not images_dir.is_dir():
        return
    for image in sorted(images_dir.iterdir()):
        if not image.is_file() or image.suffix.lower() not in {".webp", ".jpg", ".jpeg"}:
            continue
        output = image.with_suffix(".png")
        if output.exists() and output.stat().st_size > 0:
            image.unlink(missing_ok=True)
            continue
        try:
            with Image.open(image) as opened:
                frame = opened
                if opened.mode in {"P", "LA"}:
                    frame = opened.convert("RGBA")
                elif opened.mode == "CMYK":
                    frame = opened.convert("RGB")
                frame.save(output, "PNG")
            if output.stat().st_size > 0:
                image.unlink(missing_ok=True)
                log(f"转 PNG：{image.name} -> {output.name}")
            else:
                output.unlink(missing_ok=True)
        except Exception as error:  # noqa: BLE001
            log_error(f"转 PNG 失败：{image}（{error}）")


def repair_folder(folder: Path) -> tuple[int, int]:
    data = read_json(folder)
    session = make_session()
    done, total = download_images(folder, data, session)
    convert_images_to_png(folder)
    return done, total


# ---------------------------------------------------------------------------
# 搬运
# ---------------------------------------------------------------------------
def unique_path(path: Path) -> Path:
    """目标已存在但内容不同时，生成 name__1.ext，避免覆盖。"""
    candidate = path
    index = 1
    while candidate.exists():
        candidate = path.with_name(f"{path.stem}__{index}{path.suffix}")
        index += 1
    return candidate


def merge_dir(source: Path, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for child in list(source.iterdir()):
        destination = target / child.name
        if child.is_dir():
            merge_dir(child, destination)
        elif not destination.exists():
            shutil.move(str(child), str(destination))
        else:
            try:
                same = child.stat().st_size == destination.stat().st_size and sha256(child) == sha256(destination)
            except OSError:
                same = False
            if same:
                child.unlink(missing_ok=True)
            else:
                shutil.move(str(child), str(unique_path(destination)))


def merge_or_move(source: Path, target: Path) -> None:
    if not target.exists():
        shutil.move(str(source), str(target))
        return
    merge_dir(source, target)
    shutil.rmtree(source, ignore_errors=True)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def move_once(source: Path = SOURCE, target: Path = TARGET, min_age: int = 5, repair: bool = False) -> int:
    global _WARNED_SOURCE
    target.mkdir(parents=True, exist_ok=True)
    if not source.exists():
        if not _WARNED_SOURCE:
            _WARNED_SOURCE = True
            log(f"没有找到下载来源：{source}")
            log("如果浏览器下载目录不在默认位置，请设置环境变量 XY_DOWNLOAD_DIR 后重试。")
        return 0

    moved = 0
    for item in sorted(source.iterdir()):
        if not item.is_dir() or not folder_is_stable(item, min_age_seconds=min_age):
            continue
        destination = target / item.name
        try:
            merge_or_move(item, destination)
        except OSError as error:
            log_error(f"搬运失败：{item} -> {destination}（{error}）")
            continue
        log(f"已搬运：{item.name} -> {destination}")
        moved += 1
        # 统一转 PNG（webp/jpg -> png），保持旧版行为
        convert_images_to_png(destination)
        if repair:
            done, total = repair_folder(destination)
            if total:
                log(f"补图完成：{done}/{total}")

    if repair:
        repair_existing(target)
    return moved


def repair_existing(target: Path = TARGET) -> None:
    """只补历史文件夹缺的图；同一个文件夹在一次运行里不重复尝试。"""
    if not target.exists():
        return
    for folder in sorted(target.iterdir()):
        if not folder.is_dir() or folder.name in _REPAIRED:
            continue
        convert_images_to_png(folder)
        data = read_json(folder)
        urls = [url for url in (data.get("images") or []) if isinstance(url, str)][:MAX_IMAGES]
        if not urls:
            continue
        images_dir = folder / "images"
        missing = [i for i in range(1, len(urls) + 1) if not list(images_dir.glob(f"image_{i:02d}.*"))]
        if not missing:
            _REPAIRED.add(folder.name)
            continue
        _REPAIRED.add(folder.name)
        done, total = repair_folder(folder)
        log(f"检查历史文件夹 {folder.name}：图片 {done}/{total}")


def watch(args: argparse.Namespace) -> int:
    log(f"监控下载目录：{args.source}")
    log(f"保存到：      {args.target}")
    log("按 Ctrl+C 停止")
    # 启动时先补一次历史缺图；之后只处理新下载，避免每 3 秒把整个目录重扫一遍
    repair_existing(args.target)
    while True:
        try:
            move_once(args.source, args.target, args.min_age, repair=False)
        except KeyboardInterrupt:
            raise
        except Exception as error:  # noqa: BLE001 - 常驻进程不能因为单次异常退出
            log_error(f"监控循环异常：{error}")
        time.sleep(args.interval)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="把浏览器下载的采集结果搬运到信息储存，并补齐/转换图片")
    parser.add_argument("--source", type=Path, default=SOURCE, help=f"下载来源目录（默认 {SOURCE}）")
    parser.add_argument("--target", type=Path, default=TARGET, help=f"信息储存目录（默认 {TARGET}）")
    parser.add_argument("--watch", action="store_true", help="持续监控（默认只搬一次）")
    parser.add_argument("--repair", action="store_true", help="顺便补齐历史文件夹缺失的图片")
    parser.add_argument("--min-age", type=int, default=5, help="文件多久没有变化才算下载完成（秒，默认 5）")
    parser.add_argument("--interval", type=int, default=3, help="监控间隔（秒，默认 3）")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    global _LOG_DIR
    args = parse_args(argv)
    args.source = Path(args.source).expanduser()
    args.target = Path(args.target).expanduser().resolve()
    _LOG_DIR = args.target
    if args.watch:
        try:
            return watch(args)
        except KeyboardInterrupt:
            log("已停止监控")
            return 0
    count = move_once(args.source, args.target, args.min_age, repair=args.repair)
    if not args.repair:
        # 单次模式默认做一次补图检查，历史数据也能被修复
        repair_existing(args.target)
    log(f"完成，搬运 {count} 个采集文件夹")
    return 0


if __name__ == "__main__":
    sys.exit(main())
