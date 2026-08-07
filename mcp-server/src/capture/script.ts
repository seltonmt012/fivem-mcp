/**
 * The Windows screen-capture worker, as a string.
 *
 * It lives in a .ts file rather than next to it as a .ps1 on purpose: `npm run
 * build` is a bare `tsc`, which emits only .ts files into dist/. A .ps1 in src/
 * would simply not exist at runtime, and the failure would only show up on a
 * built install.
 *
 * The script reads its options from the FIVEM_AGENT_CAPTURE_ARGS environment
 * variable as JSON and writes exactly one line of JSON to stdout. Nothing is
 * interpolated into the source, so no path or device name can break out into
 * PowerShell syntax.
 *
 * It exits 0 even when the capture fails -- the JSON says whether it worked. A
 * non-zero exit therefore means PowerShell itself fell over, which the caller
 * reports differently.
 */
export const CAPTURE_SCRIPT = `# fivem-mcp screen capture worker. Generated from src/capture/script.ts -- do not edit.
$ErrorActionPreference = 'Stop'
# PowerShell 5.1 wraps the progress stream in CLIXML on a redirected stderr.
$ProgressPreference = 'SilentlyContinue'

$displays = @()

function Emit($payload) {
  [Console]::Out.WriteLine((ConvertTo-Json $payload -Compress -Depth 6))
}

function Fail($message) {
  Emit @{ ok = $false; error = [string]$message; displays = $script:displays }
  exit 0
}

try {
  $raw = $env:FIVEM_AGENT_CAPTURE_ARGS
  if ([string]::IsNullOrWhiteSpace($raw)) { throw 'FIVEM_AGENT_CAPTURE_ARGS is empty' }
  $opt = ConvertFrom-Json $raw
} catch {
  Emit @{ ok = $false; error = "Could not read the capture arguments: $($_.Exception.Message)"; displays = @() }
  exit 0
}

if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Emit @{
    ok = $false
    error = "PowerShell is running in $($ExecutionContext.SessionState.LanguageMode), where the capture cannot compile the Windows API bindings it needs. This is usually AppLocker or WDAC. Set ""screenshot.enabled"" to false in fivem-mcp.config.json to stop offering the tool."
    displays = @()
  }
  exit 0
}

try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class FiveMAgentCapture {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }

  public delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data);
  public delegate bool WindowEnumProc(IntPtr window, IntPtr data);

  [DllImport("user32.dll")]
  private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFOEX info);
  [DllImport("user32.dll")]
  private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll")]
  private static extern bool EnumWindows(WindowEnumProc callback, IntPtr data);
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]
  private static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")]
  private static extern int GetWindowThreadProcessId(IntPtr window, out int processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowTextW(IntPtr window, StringBuilder text, int max);
  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")]
  private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
  private static extern int DwmGetWindowAttributeRect(IntPtr window, int attribute, out RECT value, int size);
  [DllImport("user32.dll")]
  private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("shcore.dll")]
  private static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")]
  private static extern bool SetProcessDPIAware();

  // Must run before any monitor rectangle is read. Without it PowerShell is not
  // DPI aware and every bound comes back multiplied by the primary display's
  // scale factor: a 1920x1080 secondary reports 2880x1620 next to a 150% 4K
  // primary, and the capture is a stretched, wrongly placed region.
  public static string MakeDpiAware() {
    try { if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return "per-monitor-v2"; }
    catch (EntryPointNotFoundException) { }
    catch (DllNotFoundException) { }
    try { if (SetProcessDpiAwareness(2) == 0) return "per-monitor"; }
    catch (EntryPointNotFoundException) { }
    catch (DllNotFoundException) { }
    try { if (SetProcessDPIAware()) return "system"; } catch { }
    return "none";
  }

  public class Monitor {
    public string Device;
    public int Left; public int Top; public int Right; public int Bottom;
    public bool Primary;
  }

  private static Monitor Describe(IntPtr handle) {
    var info = new MONITORINFOEX();
    info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
    if (!GetMonitorInfoW(handle, ref info)) return null;
    return new Monitor {
      Device = info.szDevice,
      Left = info.rcMonitor.Left, Top = info.rcMonitor.Top,
      Right = info.rcMonitor.Right, Bottom = info.rcMonitor.Bottom,
      Primary = (info.dwFlags & 1) != 0
    };
  }

  public static List<Monitor> Monitors() {
    var found = new List<Monitor>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero,
      delegate (IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data) {
        var described = Describe(monitor);
        if (described != null) found.Add(described);
        return true;
      }, IntPtr.Zero);
    return found;
  }

  public static Monitor MonitorOf(long window) {
    return Describe(MonitorFromWindow(new IntPtr(window), 2)); // MONITOR_DEFAULTTONEAREST
  }

  public class Candidate {
    public long Handle;
    public int ProcessId;
    public string Title;
    public int Area;
    public bool Foreground;
    public bool Minimised;
    public int Left; public int Top; public int Right; public int Bottom;
  }

  public static List<Candidate> WindowsOf(int[] processIds) {
    var list = new List<Candidate>();
    IntPtr foreground = GetForegroundWindow();
    EnumWindows(delegate (IntPtr window, IntPtr data) {
      int processId;
      GetWindowThreadProcessId(window, out processId);
      if (Array.IndexOf(processIds, processId) < 0) return true;
      if (!IsWindowVisible(window)) return true;

      var title = new StringBuilder(512);
      GetWindowTextW(window, title, title.Capacity);
      if (title.Length == 0) return true;

      RECT rect;
      if (!GetWindowRect(window, out rect)) return true;
      int width = rect.Right - rect.Left;
      int height = rect.Bottom - rect.Top;
      if (width < 200 || height < 200) return true;

      // FiveM's CEF subprocesses leave cloaked ghost windows behind.
      int cloaked = 0;
      try { DwmGetWindowAttribute(window, 14, out cloaked, sizeof(int)); } catch { }
      if (cloaked != 0) return true;

      // The extended frame bounds exclude the invisible resize border and drop
      // shadow GetWindowRect includes, so a window crop has no dead margin.
      RECT ext;
      try {
        if (DwmGetWindowAttributeRect(window, 9, out ext, Marshal.SizeOf(typeof(RECT))) == 0 &&
            ext.Right > ext.Left && ext.Bottom > ext.Top) rect = ext;
      } catch { }

      list.Add(new Candidate {
        Handle = window.ToInt64(),
        ProcessId = processId,
        Title = title.ToString(),
        Area = width * height,
        Foreground = (window == foreground),
        Minimised = IsIconic(window),
        Left = rect.Left, Top = rect.Top, Right = rect.Right, Bottom = rect.Bottom
      });
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@
} catch {
  Emit @{ ok = $false; error = "The capture could not compile its Windows API bindings: $($_.Exception.Message)"; displays = @() }
  exit 0
}

$dpiMode = [FiveMAgentCapture]::MakeDpiAware()

function ConvertTo-Display($monitor, $index) {
  return @{
    index = [int]$index
    device = [string]$monitor.Device
    primary = [bool]$monitor.Primary
    x = [int]$monitor.Left
    y = [int]$monitor.Top
    width = [int]($monitor.Right - $monitor.Left)
    height = [int]($monitor.Bottom - $monitor.Top)
  }
}

$monitors = @([FiveMAgentCapture]::Monitors())
for ($i = 0; $i -lt $monitors.Count; $i++) {
  $displays += (ConvertTo-Display $monitors[$i] $i)
}
if ($displays.Count -eq 0) {
  Fail 'Windows reports no displays. There is nothing to capture on a session without a desktop.'
}

function Get-Primary {
  foreach ($d in $script:displays) { if ($d.primary) { return $d } }
  return $script:displays[0]
}

function Find-ByDevice($device) {
  foreach ($d in $script:displays) { if ($d.device -eq $device) { return $d } }
  return $null
}

$mode = 'auto'
if ($null -ne $opt.display -and "$($opt.display)" -ne '') { $mode = "$($opt.display)" }

# 'window' narrows the capture to the FiveM window itself; 'display' keeps the
# whole monitor. Only meaningful in auto mode -- naming a display explicitly is
# already a request for that whole screen.
$cropMode = 'window'
if ($null -ne $opt.crop -and "$($opt.crop)" -ne '') { $cropMode = "$($opt.crop)" }

$bounds = $null
$chosen = $null
$source = $mode
$matched = $null
$note = $null
$crop = 'display'

if ($mode -eq 'all') {
  $left = ($displays | ForEach-Object { $_.x } | Measure-Object -Minimum).Minimum
  $top = ($displays | ForEach-Object { $_.y } | Measure-Object -Minimum).Minimum
  $right = ($displays | ForEach-Object { $_.x + $_.width } | Measure-Object -Maximum).Maximum
  $bottom = ($displays | ForEach-Object { $_.y + $_.height } | Measure-Object -Maximum).Maximum
  $bounds = @{ x = [int]$left; y = [int]$top; width = [int]($right - $left); height = [int]($bottom - $top) }
  $source = 'virtual-desktop'
  $crop = 'all'
} elseif ($mode -match '^[0-9]+$') {
  $idx = [int]$mode
  if ($idx -ge $displays.Count) {
    Fail "There is no display $idx. This machine has $($displays.Count), numbered 0 to $($displays.Count - 1)."
  }
  $chosen = $displays[$idx]
  $source = 'explicit-index'
} elseif ($mode -eq 'primary') {
  $chosen = Get-Primary
  $source = 'primary'
} elseif ($mode -eq 'auto') {
  $patterns = @()
  if ($null -ne $opt.processNames) { $patterns = @($opt.processNames) }

  $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $name = $_.ProcessName
    $hit = $false
    foreach ($p in $patterns) { if ($name -like $p) { $hit = $true; break } }
    $hit
  })

  $candidates = @()
  if ($procs.Count -gt 0) {
    $byPid = @{}
    foreach ($p in $procs) { $byPid[[int]$p.Id] = [string]$p.ProcessName }
    foreach ($c in [FiveMAgentCapture]::WindowsOf([int[]]@($procs | ForEach-Object { [int]$_.Id }))) {
      $candidates += @{
        handle = [long]$c.Handle
        pid = [int]$c.ProcessId
        process = [string]$byPid[[int]$c.ProcessId]
        title = [string]$c.Title
        area = [int]$c.Area
        foreground = [bool]$c.Foreground
        minimised = [bool]$c.Minimised
        left = [int]$c.Left
        top = [int]$c.Top
        right = [int]$c.Right
        bottom = [int]$c.Bottom
      }
    }
  }

  # The window the user is looking at wins. Otherwise the game process beats the
  # launcher -- "FiveM.exe" is the updater window, the game lives in
  # FiveM_b<build>_GTAProcess.exe -- then a visible window beats a minimised one,
  # then the largest, then the lowest handle so the choice is deterministic.
  $ranking = @(
    @{ Expression = { if ($_.foreground) { 0 } else { 1 } } },
    @{ Expression = { if ($_.process -like '*GTAProcess*') { 0 } else { 1 } } },
    @{ Expression = { if ($_.minimised) { 1 } else { 0 } } },
    @{ Expression = { - $_.area } },
    @{ Expression = { $_.handle } }
  )
  $best = $candidates | Sort-Object $ranking | Select-Object -First 1

  if ($null -eq $best) {
    $looked = ($patterns -join ', ')
    if ($opt.fallbackToPrimary) {
      $chosen = Get-Primary
      $source = 'primary-fallback'
      $note = "No FiveM window was found (looked for a process named like: $looked). Captured the primary display instead."
    } else {
      Fail "No FiveM window is open. Looked for a visible window of a process named like: $looked. Start the game, or pass display: ""primary"" to capture a screen regardless of what is running on it."
    }
  } else {
    $monitor = [FiveMAgentCapture]::MonitorOf($best.handle)
    if ($null -eq $monitor) {
      $chosen = Get-Primary
      $note = 'The FiveM window was found but its monitor could not be resolved. Captured the primary display instead.'
    } else {
      $chosen = Find-ByDevice ([string]$monitor.Device)
      if ($null -eq $chosen) { $chosen = ConvertTo-Display $monitor -1 }
    }
    $source = 'game-window'
    $matched = @{ process = $best.process; pid = $best.pid; title = $best.title }
    if ($best.minimised) {
      $note = 'The FiveM window is minimised, so the capture shows whatever else is on that screen rather than the game.'
    } elseif ($cropMode -eq 'window') {
      # Clip the window rectangle to its display: CopyFromScreen reads the
      # desktop surface, and a window half off-screen has nothing to read there.
      # A minimised window is skipped above -- its rect is the bogus -32000 one.
      $wl = [Math]::Max([int]$best.left, [int]$chosen.x)
      $wt = [Math]::Max([int]$best.top, [int]$chosen.y)
      $wr = [Math]::Min([int]$best.right, [int]$chosen.x + [int]$chosen.width)
      $wb = [Math]::Min([int]$best.bottom, [int]$chosen.y + [int]$chosen.height)
      if ($wr - $wl -ge 50 -and $wb - $wt -ge 50) {
        $bounds = @{ x = [int]$wl; y = [int]$wt; width = [int]($wr - $wl); height = [int]($wb - $wt) }
        $crop = 'window'
      } else {
        $note = 'The FiveM window rectangle is (almost) entirely off its display, so the whole display was captured instead.'
      }
    }
  }
} else {
  Fail "Unknown display target ""$mode"". Use auto, primary, all, or a display index."
}

if ($null -eq $bounds) {
  $bounds = @{ x = $chosen.x; y = $chosen.y; width = $chosen.width; height = $chosen.height }
}
if ($bounds.width -le 0 -or $bounds.height -le 0) {
  Fail "The chosen display reports an empty rectangle ($($bounds.width)x$($bounds.height))."
}

$shot = $null
$final = $null
try {
  $shot = New-Object System.Drawing.Bitmap($bounds.width, $bounds.height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $gfx = [System.Drawing.Graphics]::FromImage($shot)
  try {
    $gfx.CopyFromScreen($bounds.x, $bounds.y, 0, 0, (New-Object System.Drawing.Size($bounds.width, $bounds.height)), [System.Drawing.CopyPixelOperation]::SourceCopy)
  } finally {
    $gfx.Dispose()
  }

  $maxWidth = 0
  if ($null -ne $opt.maxWidth) { $maxWidth = [int]$opt.maxWidth }
  # The virtual desktop is far wider than one screen, so the usual width would
  # squash it into an unreadable strip.
  if ($source -eq 'virtual-desktop' -and $maxWidth -gt 0) {
    $maxWidth = [Math]::Max($maxWidth, 2048)
  }

  if ($maxWidth -gt 0 -and $shot.Width -gt $maxWidth) {
    $scale = $maxWidth / $shot.Width
    $tw = [Math]::Max(1, [int][Math]::Round($shot.Width * $scale))
    $th = [Math]::Max(1, [int][Math]::Round($shot.Height * $scale))
    $final = New-Object System.Drawing.Bitmap($tw, $th, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $scaler = [System.Drawing.Graphics]::FromImage($final)
    try {
      $scaler.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $scaler.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $scaler.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $scaler.DrawImage($shot, 0, 0, $tw, $th)
    } finally {
      $scaler.Dispose()
    }
  } else {
    $final = $shot
  }

  # Exclusive-fullscreen Direct3D is not part of the GDI desktop surface, so
  # BitBlt hands back an all-black frame. Sampling a grid catches that.
  $threshold = 8
  if ($null -ne $opt.blackThreshold) { $threshold = [int]$opt.blackThreshold }
  $brightest = 0
  $stepX = [Math]::Max(1, [int]($final.Width / 32))
  $stepY = [Math]::Max(1, [int]($final.Height / 32))
  for ($px = 0; $px -lt $final.Width -and $brightest -le $threshold; $px += $stepX) {
    for ($py = 0; $py -lt $final.Height; $py += $stepY) {
      $pixel = $final.GetPixel($px, $py)
      $value = [Math]::Max($pixel.R, [Math]::Max($pixel.G, $pixel.B))
      if ($value -gt $brightest) { $brightest = $value }
      if ($brightest -gt $threshold) { break }
    }
  }
  $black = $brightest -le $threshold

  $format = 'jpeg'
  if ($null -ne $opt.format) { $format = "$($opt.format)".ToLowerInvariant() }
  $outPath = [string]$opt.outputPath

  if ($format -eq 'png') {
    $final.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $mime = 'image/png'
  } else {
    $quality = 80
    if ($null -ne $opt.quality) { $quality = [int]$opt.quality }
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    if ($null -eq $codec) { Fail 'This system has no JPEG encoder. Use format: "png".' }
    $params = New-Object System.Drawing.Imaging.EncoderParameters 1
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$quality)
    $final.Save($outPath, $codec, $params)
    $params.Dispose()
    $mime = 'image/jpeg'
  }

  Emit @{
    ok = $true
    path = $outPath
    mimeType = $mime
    format = $format
    width = [int]$final.Width
    height = [int]$final.Height
    nativeWidth = [int]$shot.Width
    nativeHeight = [int]$shot.Height
    black = [bool]$black
    brightest = [int]$brightest
    dpiMode = [string]$dpiMode
    source = [string]$source
    crop = [string]$crop
    note = $note
    display = $chosen
    bounds = $bounds
    matched = $matched
    displays = $displays
  }
} catch {
  Fail "The capture failed: $($_.Exception.Message)"
} finally {
  if ($null -ne $final -and -not [Object]::ReferenceEquals($final, $shot)) { $final.Dispose() }
  if ($null -ne $shot) { $shot.Dispose() }
}
`;
