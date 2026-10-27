"""根据采集 JSON 生成一份「初版」闲鱼草稿（不调用 AI，快速看效果）。

用法：
    python 工具脚本/generate_draft.py data/collected/model_xxx.json
    python 工具脚本/generate_draft.py data/collected/model_xxx.json --out data/processed/草稿.md

说明：
    正式发布建议用 工具脚本/extract_model_info.py（输出结构化 JSON，发布助手可直接读取）。
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path

# 模型简介里常带 emoji，重定向输出到文件时 Windows 的 GBK 编码会抛 UnicodeEncodeError
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except Exception:  # noqa: BLE001 - 不是 TextIOWrapper 时忽略
        pass


def clean_title(value: str) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"\s*[-|｜]\s*(?:免费\s*)?3D\s*打印模型\s*[-|｜]\s*MakerWorld.*$", "", text, flags=re.I)
    text = re.sub(r"\s*[-|｜]\s*MakerWorld.*$", "", text, flags=re.I)
    return re.sub(r"\s+", " ", text).strip()


def build(data: dict) -> str:
    title = clean_title(data.get("title") or "")
    grams = ", ".join(data.get("guessed_filament_grams") or []) or "未识别"
    times = ", ".join(data.get("guessed_print_times") or []) or "未识别"
    description = html.unescape(str(data.get("description") or ""))[:300]
    return f"""# 闲鱼草稿待优化

模型：{title}
链接：{data.get('url', '')}
耗材：{grams}
打印时间：{times}

## 初版标题
3D打印定制 {title} 桌面摆件/收藏装饰 可选颜色

## 初版描述
这是一款 3D 打印作品，适合桌面摆放、收藏展示或礼物赠送。

模型特点：
- 造型有辨识度
- 可按需选择颜色
- 接单打印，制作周期以实际打印时间为准

打印参数参考：耗材 {grams}，打印时间 {times}。

说明：请先确认模型商业打印授权；图片建议优先使用自己实拍图。

## 原简介
{description}
"""


def main(argv=None):
    parser = argparse.ArgumentParser(description="根据采集 JSON 生成初版闲鱼草稿")
    parser.add_argument("json_file")
    parser.add_argument("--out", help="写入文件（不填则打印到屏幕）")
    args = parser.parse_args(argv)

    path = Path(args.json_file)
    if not path.is_file():
        print(f"找不到文件：{path}", file=sys.stderr)
        return 1
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:  # noqa: BLE001
        print(f"读取 JSON 失败：{path}（{error}）", file=sys.stderr)
        return 1

    text = build(data)
    if args.out:
        output = Path(args.out)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text, encoding="utf-8")
        print(f"已写入：{output}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
