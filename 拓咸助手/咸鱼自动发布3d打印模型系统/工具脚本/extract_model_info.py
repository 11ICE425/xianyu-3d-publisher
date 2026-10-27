"""从采集扩展保存的 JSON 里提取闲鱼发布需要的信息。

用法：
    python 工具脚本/extract_model_info.py data/collected/model_xxx.json
    python 工具脚本/extract_model_info.py 信息储存/2026-08-01_23-35-04/model_2479285.json --limit-images 9

输出：
    <out-dir>/<文件名>.extracted.json   结构化结果（发布助手可直接读）
    <out-dir>/<文件名>.draft.md         人看的草稿
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

# 模型简介里常带 emoji，重定向输出到文件时 Windows 的 GBK 编码会抛 UnicodeEncodeError
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except Exception:  # noqa: BLE001 - 不是 TextIOWrapper 时忽略
        pass

STOP_DESC = ["为我助力", "助力", "评论 & 评分", "许可证", "相关模型"]
# 只做提示，不改变事实：命中关键词说明需要人工确认授权/命名风险
RISK_KEYWORDS = [
    "战锤", "40K", "Warhammer", "高达", "Gundam", "万代", "Bandai",
    "暴雪", "Blizzard", "Diablo", "暗黑", "任天堂", "Nintendo", "宝可梦", "Pokemon",
    "漫威", "Marvel", "迪士尼", "Disney", "原神", "米哈游", "英雄联盟", "League of Legends",
    "鬼灭", "火影", "海贼", "咒术", "EVA", "动漫", "二次元", "官方", "正版", "替代模型", "代理",
]
# 这些 IP 的二次销售风险最高，标题/文案会改成泛化描述
HIGH_RISK_KEYWORDS = ["战锤", "40K", "Warhammer", "高达", "Gundam", "万代", "Bandai"]
MAX_IMAGES = 9

GRAM_RE = re.compile(r"(?<![\d./])(\d{1,4}(?:\.\d{1,2})?)[ \t]*(?:grams?|g|克)(?![\w])", re.I)
TIME_RE = re.compile(r"(?<![\d./])(\d{1,4}(?:\.\d{1,2})?)[ \t]*(?:hrs|hr|h|小时)(?![\w])", re.I)
# 采集端会输出 "2 h 30 min" 这种带分钟的格式，这里两种都要认
TIME_LINE_RE = re.compile(
    r"^(\d{1,4}(?:\.\d{1,2})?)[ \t]*(?:h|hr|小时)(?:[ \t]*(\d{1,3})[ \t]*(?:min|分钟|分))?$",
    re.I,
)


def clean_title(title: str) -> str:
    text = html.unescape(str(title or ""))
    text = re.sub(r"\s*[-|｜]\s*(?:免费\s*)?3D\s*打印模型\s*[-|｜]\s*MakerWorld.*$", "", text, flags=re.I)
    text = re.sub(r"\s*[-|｜]\s*MakerWorld.*$", "", text, flags=re.I)
    return re.sub(r"\s+", " ", text).strip()


def first_match(pattern, text, default=""):
    match = re.search(pattern, text or "", re.I)
    return match.group(0).strip() if match else default


def extract_between(lines, start_word, stop_words):
    try:
        start = next(index for index, line in enumerate(lines) if line.strip() == start_word) + 1
    except StopIteration:
        return ""
    out = []
    for line in lines[start:]:
        stripped = line.strip()
        if any(stripped.startswith(word) for word in stop_words):
            break
        if stripped:
            out.append(stripped)
    return "\n".join(out).strip()


def looks_like_tag(text):
    """判断一行是否像 MakerWorld 标签（而不是描述段落/物料清单/发布时间）。"""
    value = text.strip()
    if not (1 <= len(value) <= 20):
        return False
    if re.search(r"[，。！？；：、,.!?;:（）()\[\]]", value):
        return False
    if re.fullmatch(r"[\d\s()./×x]+", value):
        return False
    if re.fullmatch(r"[A-Z]\d{2}-[A-Z0-9-]+", value):  # 耗材色号
        return False
    if value in {"描述", "助力", "物料清单", "下载物料清单", "评论"} or value.startswith("发布于"):
        return False
    if re.match(r"^\d{2,4}\s+\S", value):  # “10200 红色”这种物料行
        return False
    return True


def collect_tags_backwards(lines, boundary):
    tags = []
    for index in range(boundary - 1, -1, -1):
        line = lines[index].strip()
        if not line or not looks_like_tag(line):
            break
        tags.append(line)
    return list(dict.fromkeys(reversed(tags)))[:30]


def extract_tags(lines):
    """MakerWorld 标签是紧挨在“评论 / 物料清单”之前的一串短词，从后往前收集更稳。"""
    boundaries = []
    for index, line in enumerate(lines):
        value = line.strip()
        if "评论 &" in value or value in {"物料清单", "下载物料清单"}:
            boundaries.append(index)
    if not boundaries:
        return []
    # 先试离标签最近的“物料清单”，不行再试“评论”
    for boundary in sorted(set(boundaries)):
        tags = collect_tags_backwards(lines, boundary)
        if len(tags) >= 2:
            return tags
    return []


def extract_author(lines, title):
    if not title:
        return ""
    for index, line in enumerate(lines):
        if clean_title(line).startswith(title[:10]) or title.startswith(clean_title(line)[:10]):
            for candidate in lines[index + 1 : index + 5]:
                value = candidate.strip()
                if value and value not in {"已关注", "关注"} and ">" not in value:
                    return value
    return ""


def parse_number(value):
    match = re.search(r"\d+(?:\.\d{1,2})?", str(value or ""))
    return float(match.group()) if match else None


def normalize_grams(candidates, joined):
    """统一成 [("43 g"), ...]，过滤 0.5~5000g 之外的数字。"""
    out = []
    raw = list(candidates or [])
    if not raw:
        raw = [match.group(0) for match in GRAM_RE.finditer(joined or "")]
    for value in raw:
        number = parse_number(value)
        if number is None or not (0.5 <= number <= 5000):
            continue
        label = f"{number:g} g"
        if label not in out:
            out.append(label)
    return out


def pick_print_time(candidates, joined):
    """只保留 0.2~500 小时的值，避免把模型 ID、URL 里的数字当成打印时长。

    - 旧版采集扩展的 guessed_print_times 里有跨行垃圾（如 "1\\nH"），直接拒收带换行的候选值；
    - 新版采集扩展会输出 "2 h 30 min"，这里保留分钟。
    """
    values = []
    for value in candidates or []:
        text = str(value or "").strip()
        if "\n" in text or "\r" in text:
            continue
        text = re.sub(r"[ \t]+", " ", text)
        match = TIME_LINE_RE.match(text)
        if not match:
            continue
        number = float(match.group(1))
        if not (0.2 <= number <= 500):
            continue
        minutes = match.group(2)
        label = f"{number:g} h"
        if minutes and 0 < int(minutes) < 60:
            label += f" {int(minutes)} min"
        values.append(label)
    if not values:
        text = joined or ""
        for match in TIME_RE.finditer(text):
            number = float(match.group(1))
            if not (0.2 <= number <= 500):
                continue
            label = f"{number:g} h"
            min_match = re.match(r"[ \t]*(\d{1,3})[ \t]*(?:min|分钟|分)", text[match.end() : match.end() + 12], re.I)
            if min_match and 0 < int(min_match.group(1)) < 60:
                label += f" {int(min_match.group(1))} min"
            values.append(label)
            break
    return values[0] if values else ""


def image_key(url: str) -> str:
    parsed = urlparse(url)
    return parsed.netloc + re.sub(r"\.[a-zA-Z0-9]+$", "", parsed.path)


def image_score(url: str) -> float:
    parsed = urlparse(url)
    query = unquote(parsed.query or "")
    score = 0.0
    width = re.search(r"w_(\d{2,5})", query)
    if width:
        score += min(int(width.group(1)), 2400) / 100
    if re.search(r"format,webp", query, re.I):
        score -= 3
    if re.search(r"\.png$", parsed.path, re.I):
        score += 3
    elif re.search(r"\.jpe?g$", parsed.path, re.I):
        score += 2
    elif re.search(r"\.webp$", parsed.path, re.I):
        score += 1
    return score


def dedupe_images(urls, limit=MAX_IMAGES):
    """同一张设计图的 w_1200/w_1000/w_400 只留一张，优先高清版本。"""
    best = {}
    order = []
    for url in urls or []:
        if not isinstance(url, str) or not url.startswith("http"):
            continue
        key = image_key(url)
        if key not in best:
            best[key] = url
            order.append(key)
        elif image_score(url) > image_score(best[key]):
            best[key] = url
    return [best[key] for key in order][:limit]


def clean_description(value):
    """去掉 MakerWorld 附带的“免费下载由…设计”前缀和“为我助力”推广段。"""
    text = html.unescape(str(value or ""))
    text = re.sub(r"^免费下载由.*?设计的\s*3D\s*打印模型文件[。.]?\s*", "", text)
    text = re.split(r"为我助力|如果您喜欢这个模型|支持我的作品", text)[0]
    return re.sub(r"\s+", " ", text).strip()[:1200]


def analyze_data(data, source_path, material_yuan_per_kg=45.0):
    # 兼容旧版采集：老版本把浮层文本存成 hover_text_preview
    overlay_text = data.get("overlay_text_preview") or data.get("hover_text_preview") or ""
    visible_text = data.get("visible_text_preview", "") or ""
    lines = [line.strip() for line in visible_text.splitlines() if line.strip()]
    title = clean_title(data.get("title") or "")
    if not title:
        for line in lines:
            if "3D" not in line and len(line) > 6 and any(key in line for key in ["模型", "机", "摆件", "雕像"]):
                title = line
                break

    description = clean_description(data.get("description") or extract_between(lines, "描述", STOP_DESC))

    joined = "\n".join([visible_text, data.get("attribute_text_preview", "") or "", overlay_text])

    grams = normalize_grams(data.get("guessed_filament_grams"), joined)
    print_time = pick_print_time(data.get("guessed_print_times"), joined)

    print_configs = data.get("print_configs") or []
    print_config = ""
    if isinstance(print_configs, list) and print_configs:
        print_config = str(print_configs[0])
    if not print_config:
        print_config = next((line for line in lines if "层高" in line or "填充" in line or "wall" in line.lower()), "")

    category = next((line for line in lines if ">" in line and len(line) < 40), "")
    published = first_match(r"发布于\s*\d{4}-\d{2}-\d{2}", joined)

    license_lines = [str(line).strip() for line in (data.get("license_related_lines") or []) if str(line).strip()]
    license_text = "\n".join(dict.fromkeys(license_lines))
    if not license_text and "许可证" in lines:
        license_text = extract_between(lines, "许可证", ["相关模型", "评论"])

    risk_hits = [keyword for keyword in RISK_KEYWORDS if keyword.lower() in joined.lower()]
    ip_risk = "high" if any(keyword in risk_hits for keyword in HIGH_RISK_KEYWORDS) else ("medium" if risk_hits else "low")

    gram_number = parse_number(grams[0]) if grams else None
    material_cost = round(gram_number * material_yuan_per_kg / 1000, 2) if gram_number is not None else None

    return {
        "source_file": str(source_path),
        "url": data.get("url", ""),
        "model_id": data.get("model_id", ""),
        "profile_id": data.get("profile_id", ""),
        "title": title,
        "author": extract_author(lines, title),
        "category": category,
        "print_config": print_config,
        "print_time": print_time,
        "filament_grams_candidates": grams[:10],
        "filament_grams": gram_number,
        "material_cost_yuan": material_cost,
        "published_at": published.replace("发布于", "").strip() if published else "",
        "tags": extract_tags(lines),
        "license_text": license_text,
        "ip_risk": ip_risk,
        "risk_keywords": risk_hits,
        "images": dedupe_images(data.get("images") or []),
        "description": description,
        "risk_notes": make_risk_notes(ip_risk, risk_hits),
        "xianyu_title_safe": make_title(title, ip_risk),
        "xianyu_copy_safe": make_copy(title, print_time, gram_number, ip_risk),
        "need_manual_fields": [name for name, ok in [("耗材克数", gram_number is not None), ("图片使用授权", False), ("模型商业授权", False)] if not ok],
    }


def make_risk_notes(risk, hits):
    if not hits:
        return "发布前请确认模型作者是否允许商业打印/售卖，以及图片是否有使用授权。"
    return f"命中风险关键词：{', '.join(hits)}；请人工确认是否拥有商用与图片使用授权。"


def make_title(title, risk):
    """闲鱼标题最长 30 字。只有高风险 IP 才改成泛化描述，其余保留原名。"""
    base = re.sub(r"\s+", " ", title or "").strip(" -")
    if risk == "high":
        return "科幻重型机甲灰模 3D打印桌面摆件 涂装练习模型"[:30]
    base = base.replace("战锤 40K", "").replace("替代模型", "").strip(" -")
    if not base:
        return "3D打印桌面摆件 可选颜色"
    prefix, suffix = "3D打印 ", " 桌面摆件"
    room = 30 - len(prefix) - len(suffix)
    if len(base) > room:
        base = base[:room].rstrip(" -")
    return f"{prefix}{base}{suffix}"[:30]


def make_copy(title, print_time, grams, risk):
    if risk == "high":
        lines = ["科幻机甲风格 3D 打印模型，适合桌面展示、灰模收藏、涂装练习或场景搭建。"]
    else:
        name = re.sub(r"\s+", " ", title or "").strip(" -")
        lines = [f"{name} 3D 打印模型，适合桌面展示、收藏或涂装练习。"]
    lines.append("默认 PLA 打印，可沟通颜色和尺寸。")
    if print_time:
        lines.append(f"打印时间参考：约 {print_time}。")
    if grams:
        lines.append(f"耗材参考：约 {grams:g}g。")
    if risk in {"high", "medium"}:
        lines.append("说明：非官方商品，未使用官方标识；相关 IP 名称与授权请自行确认。")
    return "\n".join(lines)


def build_markdown(result):
    grams = result["filament_grams"] if result["filament_grams"] is not None else "未识别"
    return f"""# 模型提取结果

- 模型：{result['title']}
- 作者：{result['author']}
- 链接：{result['url']}
- 分类：{result['category']}
- 打印配置：{result['print_config']}
- 打印时间：{result['print_time'] or '未识别'}
- 耗材克数：{grams}
- IP 风险：{result['ip_risk']} / {', '.join(result['risk_keywords'])}
- 风险提示：{result['risk_notes']}

## 闲鱼标题
{result['xianyu_title_safe']}

## 闲鱼文案
{result['xianyu_copy_safe']}

## 标签
{', '.join(result['tags']) or '无'}

## 待人工补充
{', '.join(result['need_manual_fields']) or '无'}
"""


def main(argv=None):
    parser = argparse.ArgumentParser(description="从采集 JSON 自动提取闲鱼发布所需信息")
    parser.add_argument("json_file", help="采集扩展保存的 model_xxx.json")
    parser.add_argument("--out-dir", default="data/processed", help="输出目录（默认 data/processed）")
    parser.add_argument("--material-yuan-per-kg", type=float, default=45.0, help="耗材单价（元/公斤，默认 45）")
    parser.add_argument("--limit-images", type=int, default=MAX_IMAGES, help="最多输出几张图片链接（默认 9）")
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

    result = analyze_data(data, path, args.material_yuan_per_kg)
    result["images"] = result["images"][: max(1, args.limit_images)]

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^\w.-]+", "_", path.stem)
    out_json = out_dir / f"{stem}.extracted.json"
    out_md = out_dir / f"{stem}.draft.md"
    out_json.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    out_md.write_text(build_markdown(result), encoding="utf-8")

    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"\n已输出：\n{out_json}\n{out_md}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
