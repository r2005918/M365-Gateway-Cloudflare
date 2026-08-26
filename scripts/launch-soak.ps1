param(
  [Parameter(Mandatory = $true)][string]$BaseUrl,
  [ValidateRange(1, 1440)][int]$DurationMinutes = 30,
  [Parameter(Mandatory = $true)][string]$ReportPath,
  [Parameter(Mandatory = $true, ValueFromPipeline = $true)][string]$ApiKey
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ApiKey)) { throw "API key was not supplied on the pipeline." }

$worker = (Resolve-Path (Join-Path $PSScriptRoot "soak.ps1")).Path
$shellPath = (Get-Process -Id $PID).Path
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $shellPath
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$start.Environment["M365_TEST_API_KEY"] = $ApiKey
$start.ArgumentList.Add("-NoProfile")
$start.ArgumentList.Add("-File")
$start.ArgumentList.Add($worker)
$start.ArgumentList.Add("-BaseUrl")
$start.ArgumentList.Add($BaseUrl)
$start.ArgumentList.Add("-DurationMinutes")
$start.ArgumentList.Add([string]$DurationMinutes)
$start.ArgumentList.Add("-ReportPath")
$start.ArgumentList.Add($ReportPath)
$process = [Diagnostics.Process]::Start($start)
Remove-Variable ApiKey -ErrorAction SilentlyContinue

[pscustomobject]@{
  processId = $process.Id
  reportPath = $ReportPath
  startedAt = [DateTimeOffset]::UtcNow.ToString("O")
} | ConvertTo-Json -Compress
