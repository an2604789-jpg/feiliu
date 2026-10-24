# 生成 DownloadX 应用图标：build/icon.png (256) 与 build/icon.ico (内嵌 256 PNG)
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$size = 256

$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

# 圆角方形背景 + 蓝色渐变
$radius = 56
$rect = New-Object System.Drawing.Rectangle(0, 0, ($size - 1), ($size - 1))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
$path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
$path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
$path.CloseFigure()

$c1 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 47, 111, 237))
$c2 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 29, 78, 216))
$lg = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1.Color, $c2.Color, 55)
$g.FillPath($lg, $path)

# 字母 D
$font = New-Object System.Drawing.Font("Segoe UI", 150, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = New-Object System.Drawing.RectangleF(-6, 6, $size, $size)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$g.DrawString("D", $font, $white, $textRect, $sf)

$g.Flush()

# 保存 PNG
$pngPath = Join-Path $here "icon.png"
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

# 读取 PNG 字节并封装为单帧(256) ICO
$pngBytes = [System.IO.File]::ReadAllBytes($pngPath)
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
# ICONDIR
$bw.Write([UInt16]0)        # reserved
$bw.Write([UInt16]1)        # type = icon
$bw.Write([UInt16]1)        # count
# ICONDIRENTRY
$bw.Write([Byte]0)          # width 0 = 256
$bw.Write([Byte]0)          # height 0 = 256
$bw.Write([Byte]0)          # palette
$bw.Write([Byte]0)          # reserved
$bw.Write([UInt16]1)        # planes
$bw.Write([UInt16]32)       # bpp
$bw.Write([UInt32]$pngBytes.Length)
$bw.Write([UInt32]22)       # offset = 6 + 16
$bw.Write($pngBytes)
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $here "icon.ico"), $ms.ToArray())
$bw.Close(); $ms.Close(); $g.Dispose(); $bmp.Dispose()

Write-Output ("wrote " + $pngPath)
Write-Output ("wrote " + (Join-Path $here "icon.ico"))
