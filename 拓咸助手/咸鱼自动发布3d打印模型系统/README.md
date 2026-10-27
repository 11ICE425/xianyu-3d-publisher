# 拓咸助手 · 3D 打印模型闲鱼发布系统

从 MakerWorld 一键采集模型资料 → AI 润色文案 → 半自动填写闲鱼发布页。

> 本次优化修掉了「扫描表单必崩」「Alt+M 采集两次」「图片重复」「时间/克数误识别」等问题，
> 详细清单见 **[修复说明.md](修复说明.md)**。

## 目录结构

```text
咸鱼自动发布3d打印模型系统/
├── 采集扩展/           MakerWorld 一键采集扩展 v0.9.0-10图（Alt+M 采集）
├── 闲鱼发布助手/       闲鱼网页发布插件 v0.8.0（润色 + 填表）
├── 本地AI服务/         本地 DeepSeek 转发服务 v0.6.0
├── 工具脚本/           JSON 提取 / 草稿生成脚本
├── tests/              自动化自测（Node + Python，45 项）
├── data/               采集与处理后的数据存放处
├── requirements.txt    Python 依赖（requests / Pillow）
├── 修复说明.md         这次优化改了什么、怎么验证、怎么回滚
├── 使用规范.md         完整流程、安装教程、注意事项（先看这个）
└── README.md           本文件
```

每个组件文件夹里都有 `_安装说明.txt`，可单独对照使用。

## 快速安装（3 步）

```text
1. 启动本地AI服务：双击 本地AI服务\启动闲鱼AI本地服务.bat
2. 装采集扩展：edge://extensions → 开发人员模式 → 加载解压缩的扩展
   → 选 E:\桌面\咸鱼助手\3D模型一键采集扩展（或项目里的 采集扩展\）
3. 装闲鱼发布助手：同上 → 选 闲鱼发布助手\ 文件夹
```

详细步骤见《使用规范.md》第 2 节。

## 完整流程

```text
1. 采集：MakerWorld 模型页按 Alt+M，自动保存 JSON + 截图 + 最多10张去重图片
2. 搬运：信息自动进入 采集扩展\信息储存\时间文件夹
3. 加工：AI 设置填 DeepSeek Key，读取 JSON，AI 润色标题/描述/价格
4. 发布：闲鱼网页版，插件填写表单，人工确认后发布
```

## 自测（改代码后建议跑一遍）

```powershell
powershell -ExecutionPolicy Bypass -File tests\run_tests.ps1
```

## 当前版本

- 采集扩展 v0.9.0-10图（日常加载：`E:\桌面\咸鱼助手\3D模型一键采集扩展`）
- 闲鱼发布助手 v0.8.0
- 本地 AI 服务 v0.6.0
- 文案模型：`deepseek-flash`（关闭思考模式，速度快、省 token）

## 常见改动入口

| 想改什么 | 改哪里 |
| --- | --- |
| 采集哪些字段、图片怎么筛 | `采集扩展\content.js` 里的 `pickImages()` / `extractGrams()` / `extractTimes()` |
| 下载后放哪、多久搬一次 | `采集扩展\move_to_storage.py` 顶部常量或命令行参数 |
| 闲鱼字段名称/别名 | `闲鱼发布助手\content.js` 的 `FIELD_DEFS` |
| AI 文案规则 | 面板「AI 设置 → AI 文案规则」，或 `local_ai_server.py` 的 `SYSTEM_PROMPT` |
