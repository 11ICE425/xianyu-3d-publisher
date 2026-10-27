"""闲鱼 3D 打印文案 · 本地 AI 转发服务

作用：
    浏览器扩展把「文案草稿」发到本机 http://127.0.0.1:8765/polish，
    由本服务转发给 DeepSeek，避免把 API Key 暴露在网页里。

启动：
    双击 启动闲鱼AI本地服务.bat；或 python local_ai_server.py

接口：
    GET  /health   -> 服务状态（不含 Key）
    POST /polish   {apiKey, draft} -> {title, description, price, risk_notes}

安全：
    - 只监听 127.0.0.1，外部网络访问不到。
    - 网页(http/https)发起的跨域请求会被拒绝，防止别的网站偷偷消耗额度。
    - 请求里没填 apiKey 时，读取环境变量 DEEPSEEK_API_KEY。
"""
import json
import os
import socket
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# Windows 控制台重定向到文件时可能是 GBK 编码，避免打印中文/emoji 时抛异常
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except Exception:  # noqa: BLE001 - 不是 TextIOWrapper 时忽略
        pass

HOST = "127.0.0.1"
PORT = int(os.getenv("XY_AI_PORT", "8765"))
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
MODEL = "deepseek-flash"
VERSION = "0.6.0"
MAX_BODY = 2_000_000
ALLOWED_ORIGIN_PREFIXES = (
    "chrome-extension://",
    "edge-extension://",
    "moz-extension://",
    "safari-web-extension://",
)

SYSTEM_PROMPT = """你是闲鱼 3D 打印商品文案编辑器。
只处理用户提供的资料，不虚构材质、尺寸、库存、授权、发货时间或功能。
只输出一个 JSON 对象，不要 Markdown 或解释；字段固定为 title、description、price、risk_notes。
title 不超过 30 个中文字符；description 自然、克制、口语化。
用户已确认：输入资料中的模型名称、IP 名称、系列名称、作者名称可按原样保留，不要擅自泛化、替换或删除。
除非输入资料明确写明，否则不得自行添加“官方 / 正版 / 独家授权 / 官方授权 / 唯一授权”等声明。
用户补充规则属于本次文案要求，在不虚构事实和不自行增加未提供授权声明的前提下必须遵守。
price 必须是纯数字字符串，没有依据时留空；risk_notes 列出需要人工确认的事实或风险。
示例输出：{"title":"模型名 3D打印桌面摆件","description":"自然口语的宝贝描述","price":"88","risk_notes":"耗材克数需人工确认"}"""


def effective_system_prompt(draft):
    rules = str(draft.get("customRules", "")).strip()
    if not rules:
        return SYSTEM_PROMPT
    return SYSTEM_PROMPT + "\n\n以下是用户在插件中编辑的文案规则，请在不虚构事实的前提下遵守：\n" + rules


def compact(draft):
    raw = draft.get("raw") if isinstance(draft.get("raw"), dict) else {}

    def first(*keys):
        for key in keys:
            value = raw.get(key)
            if value not in (None, ""):
                return value
        return ""

    return {
        "当前标题": draft.get("title", ""),
        "当前描述": draft.get("description", ""),
        "当前价格": draft.get("price", ""),
        "文案风格": draft.get("tone", "自然简洁"),
        "模型名称": first("model_title", "safe_title", "title", "name"),
        "作者": first("author", "creator", "designer"),
        "耗材克数": first("filament_grams", "filament_g", "grams", "material_g", "weight_g"),
        "打印时间": first("print_time", "printing_time", "time"),
        "分类标签": first("tags", "category", "categories"),
        "来源链接": first("source_url", "url", "model_url"),
        "已知风险提示": first("risk_notes", "risk_words"),
        # 注意：这里不能写“卖家已确认”，否则等于把未确认的授权当成事实交给模型
        "命名授权状态": "未知。原始模型/IP/系列/作者名称能否保留、能否商用，都必须由卖家人工确认后再写。",
        "用户补充规则": str(draft.get("customRules", "")).strip(),
    }


def normalize(result, fallback):
    title = "".join(list(str(result.get("title") or fallback.get("title") or "").strip())[:30])
    description = str(result.get("description") or fallback.get("description") or "").strip()
    price_raw = str(result.get("price") or fallback.get("price") or "").strip()
    price = "".join(ch for ch in price_raw if ch.isdigit() or ch == ".")
    return {
        "title": title,
        "description": description,
        "price": price,
        "risk_notes": str(result.get("risk_notes") or "").strip()[:500],
    }


def build_request(api_key, draft):
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": effective_system_prompt(draft)},
            {
                "role": "user",
                "content": "请根据以下资料润色闲鱼文案，没有的信息不要补造。\n"
                + json.dumps(compact(draft), ensure_ascii=False, indent=2),
            },
        ],
        "stream": False,
        "temperature": 0.55,
        "max_tokens": 1600,
        "response_format": {"type": "json_object"},
        # 文案任务关闭思考模式：响应更快、更省 token，temperature 才会生效
        "thinking": {"type": "disabled"},
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return Request(
        DEEPSEEK_URL,
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )


def parse_content(text, draft):
    cleaned = str(text or "").strip()
    for fence in ("```json", "```JSON", "```"):
        cleaned = cleaned.replace(fence, "")
    cleaned = cleaned.strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start >= 0 and end > start:
        cleaned = cleaned[start : end + 1]
    return normalize(json.loads(cleaned), draft)


def request_once(request):
    try:
        with urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")[:300]
        raise RuntimeError(f"DeepSeek HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"DeepSeek 网络错误: {exc.reason}") from exc


def call_ai(api_key, draft):
    if not api_key:
        raise ValueError("请先填写 DeepSeek API Key（或在服务端设置 DEEPSEEK_API_KEY 环境变量）")

    data = request_once(build_request(api_key, draft))
    # DeepSeek 的 JSON 模式偶尔返回空内容：重试一次
    for attempt in range(2):
        text = str(((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
        if text.strip():
            try:
                return parse_content(text, draft)
            except (json.JSONDecodeError, TypeError, KeyError, AttributeError):
                pass
        if attempt == 0:
            data = request_once(build_request(api_key, draft))
    raise RuntimeError("AI 返回格式异常，请重试")


CLIENT_HEADER = "X-XY-Client"
CLIENT_VALUE = "xy3d-publisher"


def origin_class(origin):
    """none=本地脚本/扩展后台；extension=浏览器扩展；web/null=网页（应拒绝）。"""
    if not origin:
        return "none"
    origin = origin.strip()
    if origin == "null":
        return "null"
    return "extension" if origin.startswith(ALLOWED_ORIGIN_PREFIXES) else "web"


def client_explicit(handler):
    return (handler.headers.get(CLIENT_HEADER) or "").strip() == CLIENT_VALUE


def origin_allowed(origin):
    """兼容旧接口：只有扩展来源或无来源才放行；null/网页都不放行。"""
    return origin_class(origin) in ("none", "extension")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"XianyuAI/{VERSION}"

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}", flush=True)

    def send_json(self, status, payload, allow_origin=True, close=False):
        body = b"" if status == 204 else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            if status != 204:
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
            if allow_origin:
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", f"Content-Type, {CLIENT_HEADER}")
            if close:
                # 提前拒绝时请求体还没读，必须断开连接，否则 HTTP/1.1 长连接会错位
                self.close_connection = True
                self.send_header("Connection", "close")
            self.end_headers()
            if body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 扩展端超时先断开时不要抛异常

    def do_OPTIONS(self):
        # 预检只给扩展来源；网页/sandbox(origin=null) 的预检直接拒绝
        if origin_class(self.headers.get("Origin", "")) not in ("none", "extension"):
            self.send_json(403, {"ok": False, "error": "forbidden origin"}, close=True)
            return
        self.send_json(204, {})

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            self.send_json(200, {
                "ok": True,
                "service": "xianyu-ai-local-server",
                "version": VERSION,
                "model": MODEL,
                "endpoint": DEEPSEEK_URL,
                "has_env_key": bool(os.getenv("DEEPSEEK_API_KEY", "").strip()),
            })
        else:
            self.send_json(404, {"ok": False, "error": "not found"}, close=True)

    def do_POST(self):
        if self.path.rstrip("/") != "/polish":
            self.send_json(404, {"ok": False, "error": "not found"}, close=True)
            return
        if origin_class(self.headers.get("Origin", "")) in ("web", "null"):
            # 普通网页、沙箱 iframe 一律拒绝；扩展后台不会发送这两种 Origin
            self.send_json(403, {"ok": False, "error": "forbidden origin"}, close=True)
            return
        if not client_explicit(self):
            # 自定义请求头：网页要带它必须先过预检，而预检只对扩展放行
            self.send_json(403, {"ok": False, "error": "missing client header"}, close=True)
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length <= 0 or length > MAX_BODY:
                raise ValueError("请求体大小不合法")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else payload
            api_key = str(payload.get("apiKey") or os.getenv("DEEPSEEK_API_KEY", "")).strip()
            self.send_json(200, call_ai(api_key, draft), allow_origin=True)
        except json.JSONDecodeError:
            self.send_json(400, {"ok": False, "error": "请求不是合法 JSON"}, close=True)
        except Exception as exc:  # noqa: BLE001 - 统一返回可读错误
            self.send_json(500, {"ok": False, "error": str(exc)}, close=True)


def in_use():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        return sock.connect_ex((HOST, PORT)) == 0


def service_is_ours():
    """端口被占用时，确认对面确实是本服务，而不是别的程序。"""
    try:
        with urlopen(f"http://{HOST}:{PORT}/health", timeout=1.5) as response:
            data = json.loads(response.read().decode("utf-8"))
            return data.get("service") == "xianyu-ai-local-server"
    except Exception:  # noqa: BLE001
        return False


def main():
    if in_use():
        if service_is_ours():
            print(f"本地服务已在运行：http://{HOST}:{PORT}")
            return 0
        print(f"端口 {PORT} 被其它程序占用，请关闭该程序或设置环境变量 XY_AI_PORT 换端口。")
        return 1
    print(f"闲鱼 AI 本地服务 v{VERSION}: http://{HOST}:{PORT}")
    print(f"模型：{MODEL}（已关闭思考模式）；按 Ctrl+C 停止")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
