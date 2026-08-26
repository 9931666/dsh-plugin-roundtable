<#
  process-logos.ps1 — 把 src/client/assets/logos/ 下的原始厂商 logo 处理成
  圆形头像用的透明 PNG（抠底 + 裁掉文字区 + 居中到 256×256 透明画布）。

  用法（插件目录）：powershell -ExecutionPolicy Bypass -File scripts/process-logos.ps1

  说明：
  - 原始图用 hash 命名（用户上传）；本脚本按"品牌 key → 输入文件 + 参数"处理，
    输出 <brand>.png 到同目录，并删除原始 hash 图（避免 generate-logos 误扫）。
  - 参数：crop = 先裁掉的像素区域（去掉图标旁的品牌文字），backdropRGB/tol = 抠底颜色与容差。
#>
Add-Type -AssemblyName System.Drawing | Out-Null

$logoDir = Join-Path $PSScriptRoot '..\src\client\assets\logos'

if (-not (Test-Path $logoDir)) { Write-Error "logos dir missing: $logoDir"; exit 1 }

# C# 图像处理器：抠底 + 裁剪 + 等比缩放 + 居中到透明方形
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;

public static class LogoProcessor {
  // 将接近 (tr,tg,tb) 且三通道都在容差内的像素置为透明
  public static void MakeTransparent(Bitmap bmp, int tr, int tg, int tb, int tol) {
    for (int y = 0; y < bmp.Height; y++) for (int x = 0; x < bmp.Width; x++) {
      Color px = bmp.GetPixel(x, y);
      if (Math.Abs(px.R-tr) <= tol && Math.Abs(px.G-tg) <= tol && Math.Abs(px.B-tb) <= tol)
        bmp.SetPixel(x, y, Color.FromArgb(0, px.R, px.G, px.B));
    }
  }
  // 非透明内容的包围盒
  public static Rectangle GetBBox(Bitmap bmp) {
    int minX = bmp.Width, minY = bmp.Height, maxX = -1, maxY = -1;
    for (int y = 0; y < bmp.Height; y++) for (int x = 0; x < bmp.Width; x++) {
      if (bmp.GetPixel(x, y).A > 8) {
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return new Rectangle(0, 0, bmp.Width, bmp.Height);
    return new Rectangle(minX, minY, maxX - minX + 1, maxY - minY + 1);
  }
  // crop = 可选先裁区域; 流程: 转32bpp -> crop -> 抠底 -> bbox裁 -> 缩放 -> 居中
  public static Bitmap Process(Bitmap src, Rectangle? crop, int tr, int tg, int tb, int tol, int size) {
    Bitmap work = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(work)) g.DrawImage(src, 0, 0, src.Width, src.Height);

    Bitmap stage = work;
    if (crop.HasValue) {
      Rectangle c = crop.Value;
      Bitmap cut = new Bitmap(c.Width, c.Height, PixelFormat.Format32bppArgb);
      using (Graphics g = Graphics.FromImage(cut)) g.DrawImage(work, 0, 0, c, GraphicsUnit.Pixel);
      stage = cut;
    }
    MakeTransparent(stage, tr, tg, tb, tol);

    Rectangle bbox = GetBBox(stage);
    Bitmap content = new Bitmap(bbox.Width, bbox.Height, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(content)) g.DrawImage(stage, 0, 0, bbox, GraphicsUnit.Pixel);

    float scale = Math.Min((float)size / content.Width, (float)size / content.Height);
    int w = Math.Max(1, (int)(content.Width * scale));
    int h = Math.Max(1, (int)(content.Height * scale));
    Bitmap scaled = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(scaled)) {
      g.InterpolationMode = InterpolationMode.HighQualityBicubic;
      g.PixelOffsetMode = PixelOffsetMode.HighQuality;
      g.DrawImage(content, 0, 0, w, h);
    }
    Bitmap outBmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(outBmp)) g.DrawImage(scaled, (size - w) / 2, (size - h) / 2);
    return outBmp;
  }
}
'@

# 品牌 key -> { 输入文件, crop区域(像素，相对原始宽高), 抠底颜色, 容差 }
$jobs = @(
  @{ key = 'deepseek'; file = 'ffb4657e0bd98d3e3dca87949632189a.jpg'; crop = $null;   tr = 255; tg = 255; tb = 255; tol = 30 },
  @{ key = 'minimax';  file = '89785a95d03ac8d46939ae925efa1829.jpg'; crop = @(0, 0, 960, 685); tr = 255; tg = 255; tb = 255; tol = 26 },
  @{ key = 'gemini';   file = '8edeb5ee5af925f7d679a296bc996e9b.jpg'; crop = @(0, 0, 155, 474); tr = 255; tg = 255; tb = 255; tol = 24 },
  @{ key = 'claude';   file = 'f7f9e682804953ff257d904e1676ee5d.jpg'; crop = @(60, 0, 140, 266); tr = 244; tg = 243; tb = 238; tol = 16 },
  @{ key = 'glm';      file = 'd39e2891144cf1166c817ddd4577859e.jpg'; crop = $null;   tr = 0;   tg = 0;   tb = 0;   tol = 28 },
  @{ key = 'kimi';     file = 'e1a4ee253d21e9278773f941423c2b38.jpg'; crop = $null;   tr = 0;   tg = 0;   tb = 0;   tol = 28 }
)

$const  = 256
$outputs = @()
$kept = @()

foreach ($job in $jobs) {
  $inPath = Join-Path $logoDir $job.file
  if (-not (Test-Path $inPath)) { Write-Warning "[skip] missing $($job.file)"; continue }
  $src = [System.Drawing.Image]::FromFile($inPath)
  $bmp = New-Object System.Drawing.Bitmap $src

  $crop = $null
  if ($job.crop -ne $null) {
    # crop 数组按原始尺寸给出 (x, y, w, h)
    $crop = New-Object System.Drawing.Rectangle @($job.crop[0], $job.crop[1], $job.crop[2], $job.crop[3])
  }
  $result = [LogoProcessor]::Process($bmp, $crop, [int]$job.tr, [int]$job.tg, [int]$job.tb, [int]$job.tol, $const)

  $outPath = Join-Path $logoDir "$($job.key).png"
  $result.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose(); $src.Dispose(); $result.Dispose()
  $outputs += "$($job.key).png"
  $kept += $job.file
  Write-Host "[ok] $($job.key) <- $($job.file) ($($job.tol) tol, crop=$($job.crop -join ','))"
}

# 删除原始 hash 图（含重复的 MiniMax 与未使用的，仅保留 <brand>.png）
Get-ChildItem $logoDir -Filter '*.jpg' -File | ForEach-Object { Remove-Item $_.FullName -Force; Write-Host "[del] $($_.Name)" }

Write-Host "---"
foreach ($o in $outputs) { Write-Host "  output: $o" }
Write-Host "DONE ($($outputs.Count) logos)"
