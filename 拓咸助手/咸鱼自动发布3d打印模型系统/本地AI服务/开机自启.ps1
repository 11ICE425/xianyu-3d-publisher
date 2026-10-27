# 闲鱼AI本地服务 · 开机自启设置
# 用法：
#   双击 设置开机自启.bat   -> 把“静默启动闲鱼AI服务.vbs”的快捷方式放进 Windows 启动文件夹
#   双击 取消开机自启.bat   -> 删除该快捷方式
param(
    [ValidateSet('install', 'remove')]
    [string]$Action = 'install'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $here '静默启动闲鱼AI服务.vbs'
$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup '闲鱼AI本地服务.lnk'

if ($Action -eq 'install') {
    if (-not (Test-Path $vbs)) { throw "找不到启动脚本：$vbs" }
    $ws = New-Object -ComObject WScript.Shell
    $shortcut = $ws.CreateShortcut($link)
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $shortcut.Arguments = '"' + $vbs + '"'
    $shortcut.WorkingDirectory = $here
    $shortcut.Description = '闲鱼AI本地服务（开机静默启动）'
    $shortcut.Save()
    Write-Host "已加入开机启动：$link"
    Write-Host "下次登录 Windows 会自动静默启动本地 AI 服务。"
} else {
    if (Test-Path $link) {
        Remove-Item $link -Force
        Write-Host "已取消开机启动：$link"
    } else {
        Write-Host "没有找到开机启动项：$link"
    }
}
