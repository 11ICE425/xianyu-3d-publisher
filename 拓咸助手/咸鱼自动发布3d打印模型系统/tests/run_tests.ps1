# 一键运行项目自测（Windows PowerShell）
# 用法：右键“使用 PowerShell 运行”，或在项目根目录执行：
#   powershell -ExecutionPolicy Bypass -File tests\run_tests.ps1
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host '=== 1/3 采集扩展 content.js ===' -ForegroundColor Cyan
node (Join-Path $root 'test_collector.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`n=== 2/3 闲鱼发布助手 content.js ===" -ForegroundColor Cyan
node (Join-Path $root 'test_publisher.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`n=== 3/3 Python 管线（提取 + 搬运） ===" -ForegroundColor Cyan
python (Join-Path $root 'test_pipeline.py')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`n全部自测通过。" -ForegroundColor Green
