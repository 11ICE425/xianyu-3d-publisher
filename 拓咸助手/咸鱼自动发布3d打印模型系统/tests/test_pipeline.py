"""Python 端回归测试：提取脚本 + 搬运脚本。

运行：python tests/test_pipeline.py
没有 pytest 依赖，直接 python 运行即可。
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import time
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except Exception:  # noqa: BLE001
        pass

HERE = Path(__file__).resolve().parent
SYSTEM_DIR = HERE.parent
WORKSPACE = HERE.parents[2]
# 日常运行时采集扩展在项目根目录；单独分发本系统时用项目内副本
COLLECTOR_DIR = next(
    (
        candidate
        for candidate in (WORKSPACE / "3D模型一键采集扩展", SYSTEM_DIR / "采集扩展")
        if (candidate / "move_to_storage.py").exists()
    ),
    SYSTEM_DIR / "采集扩展",
)
TOOLS_DIR = SYSTEM_DIR / "工具脚本"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


extract = load_module("extract_model_info", TOOLS_DIR / "extract_model_info.py")
generate = load_module("generate_draft", TOOLS_DIR / "generate_draft.py")
mover = load_module("move_to_storage", COLLECTOR_DIR / "move_to_storage.py")
server = load_module("local_ai_server", SYSTEM_DIR / "本地AI服务" / "local_ai_server.py")

passed = 0


def check(name: str, fn):
    global passed
    try:
        fn()
        passed += 1
        print(f"  OK   {name}")
    except AssertionError as error:
        print(f"  FAIL {name}: {error}")
        raise


# ---------------------------------------------------------------------------
# 提取脚本
# ---------------------------------------------------------------------------
def test_clean_title():
    assert extract.clean_title("链锯人电次：释放终极链锯人Q版 - 免费 3D 打印模型 - MakerWorld") == "链锯人电次：释放终极链锯人Q版"
    assert extract.clean_title("无职转生Q版挂件 - MakerWorld") == "无职转生Q版挂件"


def test_pick_print_time_rejects_cross_line_junk():
    candidates = ["1\nH", "1 m", "0.16m", "4.5 h", "3M", "494293576\nh", "703h", "801\nm"]
    assert extract.pick_print_time(candidates, "") == "4.5 h"
    assert extract.pick_print_time(["999 h"], "") == ""
    assert extract.pick_print_time([], "打印时间参考 143.9 h") == "143.9 h"
    # 采集端会输出 "2 h 30 min"，不能丢分钟
    assert extract.pick_print_time(["2 h 30 min"], "") == "2 h 30 min"
    assert extract.pick_print_time([], "打印时间参考 2 小时 30 分钟") == "2 h 30 min"
    # 跨行数字不能拼成时长 / 克数
    assert extract.pick_print_time([], "1\nh") == ""
    assert extract.normalize_grams([], "43\n g") == []


def test_normalize_grams():
    values = extract.normalize_grams(["43 g", "1g", "99999 g", "abc", "0.2 g"], "")
    assert values == ["43 g", "1 g"], values


def test_dedupe_images():
    base = "https://makerworld.bblmw.cn/makerworld/model/CNa1de29ad059f9/design/ebda2a779a82de10.png"
    urls = [
        base + "?x-oss-process=image/resize,w_1200/ignore-error,1",
        base + "?x-oss-process=image/resize,w_1000/format,webp/ignore-error,1",
        base + "?x-oss-process=image%2Fresize%2Cw_400%2Fformat%2Cwebp%2Fignore-error%2C1",
        "https://makerworld.bblmw.cn/makerworld/model/CNa1de29ad059f9/design/6eeff579ddcbf495.png?x-oss-process=image/resize,w_1000/format,webp/ignore-error,1",
    ]
    result = extract.dedupe_images(urls, 9)
    assert len(result) == 2, result
    assert result[0] == urls[0], "同一设计图应保留 w_1200 版本"


def test_clean_description():
    raw = "免费下载由 Dario 设计的 3D 打印模型文件。这是模型介绍。为我助力 支持我的作品！"
    cleaned = extract.clean_description(raw)
    assert cleaned == "这是模型介绍。", cleaned


def test_make_title_and_copy():
    high = extract.make_title("战锤 40K 重型机甲", "high")
    assert "战锤" not in high and len(high) <= 30
    medium = extract.make_title("大天使伊纳瑞斯 - 暗黑破坏神 IV", "medium")
    assert "大天使" in medium and len(medium) <= 30, medium
    copy = extract.make_copy("大天使伊纳瑞斯", "4.5 h", 43.0, "medium")
    assert "大天使伊纳瑞斯" in copy and "4.5 h" in copy and "43g" in copy


def test_analyze_fixture_sample():
    fixture = HERE / "fixtures" / "sample_model.json"
    data = json.loads(fixture.read_text(encoding="utf-8"))
    result = extract.analyze_data(data, fixture)
    assert result["title"] == "示例机甲摆件", result["title"]
    assert result["author"] == "Demo"
    assert result["print_time"] == "4.5 h", result["print_time"]
    assert result["filament_grams"] == 43.0
    assert len(result["images"]) == 1, "同一张图的三种分辨率应去重成 1 张"
    assert "测试标签" in result["tags"]
    assert all("发布于" not in tag for tag in result["tags"])


def test_analyze_real_sample():
    sample = COLLECTOR_DIR / "信息储存" / "2026-08-01_23-35-04" / "model_2479285.json"
    if not sample.exists():
        print("    （跳过：没有真实采集样例）")
        return
    data = json.loads(sample.read_text(encoding="utf-8"))
    result = extract.analyze_data(data, sample)
    assert result["title"] == "链锯人电次：释放终极链锯人Q版", result["title"]
    assert result["author"] == "Dario"
    assert result["print_time"] == "143.9 h", result["print_time"]
    assert len(result["images"]) <= 9
    assert result["ip_risk"] in {"low", "medium", "high"}
    assert all("发布于" not in tag for tag in result["tags"])
    assert all(len(tag) <= 20 for tag in result["tags"])


def test_generate_draft():
    text = generate.build({
        "title": "测试模型 - 免费 3D 打印模型 - MakerWorld",
        "guessed_filament_grams": ["43 g"],
        "guessed_print_times": ["4.5 h"],
        "description": "简介 &amp; 内容",
    })
    assert "测试模型" in text and "MakerWorld" not in text
    assert "43 g" in text


# ---------------------------------------------------------------------------
# 搬运脚本
# ---------------------------------------------------------------------------
def test_image_ext():
    assert mover.image_ext("https://x/a.png?x-oss-process=image/resize,w_1200") == "png"
    assert mover.image_ext("https://x/a", "image/webp") == "webp"
    assert mover.image_ext("https://x/a.jpeg") == "jpg"


def test_folder_stability():
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp) / "2026-01-01_00-00-00"
        folder.mkdir()
        (folder / "model_1.json").write_text("{}", encoding="utf-8")
        old = time.time() - 60
        os.utime(folder / "model_1.json", (old, old))
        assert mover.folder_is_stable(folder, 5) is True
        (folder / "x.crdownload").write_text("x", encoding="utf-8")
        os.utime(folder / "x.crdownload", (old, old))
        assert mover.has_incomplete_download(folder) is True
        assert mover.folder_is_stable(folder, 5) is False


def test_merge_or_move_keeps_both_versions():
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "src"
        target = Path(tmp) / "dst"
        (source / "sub").mkdir(parents=True)
        target.mkdir()
        (source / "same.txt").write_text("same", encoding="utf-8")
        (target / "same.txt").write_text("same", encoding="utf-8")
        (source / "diff.txt").write_text("new", encoding="utf-8")
        (target / "diff.txt").write_text("old", encoding="utf-8")
        (source / "sub" / "x.txt").write_text("x", encoding="utf-8")

        mover.merge_or_move(source, target)

        assert not source.exists()
        assert (target / "same.txt").read_text(encoding="utf-8") == "same"
        assert (target / "diff.txt").read_text(encoding="utf-8") == "old"
        assert any(path.read_text(encoding="utf-8") == "new" for path in target.iterdir() if path.name.startswith("diff__"))
        assert (target / "sub" / "x.txt").read_text(encoding="utf-8") == "x"


def test_convert_images_to_png():
    from PIL import Image

    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        images = folder / "images"
        images.mkdir()
        Image.new("RGB", (4, 4), (255, 0, 0)).save(images / "image_01.jpg", "JPEG")
        Image.new("RGB", (4, 4), (0, 255, 0)).save(images / "image_02.webp", "WEBP")
        mover.convert_images_to_png(folder)
        assert (images / "image_01.png").exists()
        assert (images / "image_02.png").exists()
        assert not (images / "image_01.jpg").exists()
        assert not (images / "image_02.webp").exists()


def test_main_once_moves_folder():
    with tempfile.TemporaryDirectory() as tmp:
        source_root = Path(tmp) / "模型发布信息采集"
        source = source_root / "2026-01-01_00-00-00"
        (source / "images").mkdir(parents=True)
        (source / "model_1.json").write_text(json.dumps({"images": [], "title": "t"}), encoding="utf-8")
        (source / "screenshot_visible.png").write_bytes(b"png")
        (source / "images" / "image_01.png").write_bytes(b"x")
        # 把时间戳往前拨 2 秒，避免刚写完文件时 mtime 与 time.time() 的微小误差导致“未稳定”
        past = time.time() - 2
        for path in source.rglob("*"):
            os.utime(path, (past, past))
        os.utime(source, (past, past))
        target = Path(tmp) / "target"

        code = mover.main(["--source", str(source_root), "--target", str(target), "--min-age", "0"])

        assert code == 0
        assert not source.exists(), "源文件夹应已搬走"
        assert (target / "2026-01-01_00-00-00" / "model_1.json").exists()
        assert (target / "2026-01-01_00-00-00" / "images" / "image_01.png").exists()


# ---------------------------------------------------------------------------
# 本地 AI 服务
# ---------------------------------------------------------------------------
def test_prompt_is_readable_chinese():
    prompt = server.SYSTEM_PROMPT
    assert "?" not in prompt, "提示词里不应再有乱码问号"
    assert "不虚构" in prompt and "JSON" in prompt


def test_origin_allowlist():
    assert server.origin_allowed("chrome-extension://abcdefg") is True
    assert server.origin_allowed("") is True
    assert server.origin_allowed("https://evil.example") is False
    assert server.origin_allowed("http://127.0.0.1:3000") is False
    assert server.origin_allowed("null") is False, "sandbox iframe 不应被放行"
    assert server.origin_class("") == "none"
    assert server.origin_class("chrome-extension://x") == "extension"
    assert server.origin_class("null") == "null"
    assert server.origin_class("https://evil.example") == "web"


def test_client_header_required():
    class GoodRequest:
        headers = {server.CLIENT_HEADER: server.CLIENT_VALUE}

    class BadRequest:
        headers = {}

    assert server.client_explicit(GoodRequest()) is True
    assert server.client_explicit(BadRequest()) is False


def test_normalize_and_parse_content():
    result = server.normalize({"title": "甲乙" * 20, "price": "¥88.50", "description": "描述"}, {})
    assert len(result["title"]) <= 30
    assert result["price"] == "88.50"
    parsed = server.parse_content('```json\n{"title":"测试标题","description":"描述"}\n```', {})
    assert parsed["title"] == "测试标题"


def test_deepseek_request_params():
    request = server.build_request("sk-test", {"title": "t", "description": "d"})
    payload = json.loads(request.data.decode("utf-8"))
    assert payload["model"] == "deepseek-flash"
    assert payload["thinking"] == {"type": "disabled"}
    assert payload["response_format"] == {"type": "json_object"}
    assert payload["temperature"] == 0.55


def test_error_log_follows_target():
    with tempfile.TemporaryDirectory() as tmp:
        old = mover._LOG_DIR
        try:
            mover._LOG_DIR = Path(tmp)
            assert mover.error_log_path() == Path(tmp) / "_搬运错误.log"
        finally:
            mover._LOG_DIR = old


def test_download_images_skips_existing_without_network():
    class NoNetworkSession:
        def get(self, *args, **kwargs):  # noqa: ANN001
            raise AssertionError("已有图片时不应再联网下载")

    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        images = folder / "images"
        images.mkdir(parents=True)
        (images / "image_01.png").write_bytes(b"x")
        data = {"images": ["https://example.com/image.png"], "url": "https://makerworld.com.cn/x"}
        done, total = mover.download_images(folder, data, NoNetworkSession())
        assert (done, total) == (1, 1), (done, total)


def main():
    checks = [
        ("clean_title 去掉平台后缀", test_clean_title),
        ("打印时长过滤跨行垃圾", test_pick_print_time_rejects_cross_line_junk),
        ("耗材克数范围过滤", test_normalize_grams),
        ("图片按设计图去重并优先高清", test_dedupe_images),
        ("描述去掉下载前缀与助力段", test_clean_description),
        ("标题/文案生成不超过 30 字", test_make_title_and_copy),
        ("真实采集样例可解析", test_analyze_real_sample),
        ("示例 JSON 可解析（CI 用）", test_analyze_fixture_sample),
        ("初版草稿生成", test_generate_draft),
        ("图片扩展名识别", test_image_ext),
        ("下载完成判定", test_folder_stability),
        ("合并文件夹不覆盖不同内容", test_merge_or_move_keeps_both_versions),
        ("webp/jpg 转 PNG", test_convert_images_to_png),
        ("命令行搬一次的全流程", test_main_once_moves_folder),
        ("错误日志跟随 --target", test_error_log_follows_target),
        ("AI 提示词无乱码", test_prompt_is_readable_chinese),
        ("本地服务只放行扩展来源", test_origin_allowlist),
        ("本地服务要求客户端请求头", test_client_header_required),
        ("AI 结果归一化与 JSON 解析", test_normalize_and_parse_content),
        ("DeepSeek 请求参数（模型/关闭思考/JSON 模式）", test_deepseek_request_params),
        ("已有图片时跳过联网", test_download_images_skips_existing_without_network),
    ]
    print("Python 管线")
    for name, fn in checks:
        check(name, fn)
    print(f"\nPython 测试通过：{passed} 项")
    return 0


if __name__ == "__main__":
    sys.exit(main())
