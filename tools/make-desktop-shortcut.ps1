# 在桌面上创建启动快捷方式。
#
# ⚠️ 本文件必须存成**带 BOM 的 UTF-8**（PS 5.1 否则按 GBK 读坏中文，
#    快捷方式的名字会变成乱码）。改完用 node -e 补 BOM 再跑。
#
# 名字与图标来自用户要求：名字「好看的」，图标用项目自己生成的那个
# （assets\video-vault.ico —— 图案是"视频落进保险箱"，与界面同一套配色）。

$ErrorActionPreference = 'Stop'

$projectRoot = 'D:\AI\works\20260920_视频下载工具'
$targetPath  = Join-Path $projectRoot '启动.cmd'
$iconPath    = Join-Path $projectRoot 'assets\video-vault.ico'
$shortcutName = '好看的.lnk'
$desktop     = [Environment]::GetFolderPath('Desktop')
$linkPath    = Join-Path $desktop $shortcutName

foreach ($need in @($targetPath, $iconPath)) {
    if (-not (Test-Path $need)) { throw "找不到 $need" }
}

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($linkPath)
$link.TargetPath       = $targetPath
$link.WorkingDirectory = $projectRoot
$link.IconLocation     = "$iconPath,0"
$link.Description      = '视频下载工具 Video Vault'
$link.WindowStyle      = 1
$link.Save()
[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)

# 回报实情，别只说"建好了"
$info = Get-Item $linkPath
Write-Host "  已创建 $($info.FullName)"
Write-Host "  指向     $targetPath"
Write-Host "  图标     $iconPath"
Write-Host "  大小     $([math]::Round($info.Length / 1024, 1)) KB"
