param(
  [Parameter(Mandatory = $true)][string]$BaseUrl,
  [ValidateRange(1, 1440)][int]$DurationMinutes = 30,
  [string]$ReportPath = ""
)

$ErrorActionPreference = "Stop"
$targetUri = [Uri]$BaseUrl
$protectedHostname = $env:M365_PRODUCTION_HOST
if (-not [string]::IsNullOrWhiteSpace($protectedHostname) -and $targetUri.Host -ieq $protectedHostname.Trim() -and $env:M365_ALLOW_PRODUCTION -ne "1") {
  throw "Refusing to soak the configured production hostname without M365_ALLOW_PRODUCTION=1."
}
$apiKey = $env:M365_TEST_API_KEY
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw "Set M365_TEST_API_KEY in the process environment before running the soak test."
}

$models = @(
  "gpt-5.5",
  "gpt-5.5-reasoning",
  "gpt-5.6-sol",
  "gpt-5.6-reasoning",
  "claude-sonnet",
  "claude-sonnet-reasoning"
)
$marker = "SOAK-MEMORY-8842"
$startedAt = [DateTimeOffset]::UtcNow
$deadline = $startedAt.AddMinutes($DurationMinutes)
$errors = [System.Collections.Generic.List[string]]::new()
$latencies = [System.Collections.Generic.List[double]]::new()
$checks = 0
$toolChains = 0
$contextTurns = 0
$previousResponseId = ""

$handler = [System.Net.Http.SocketsHttpHandler]::new()
$handler.PooledConnectionLifetime = [TimeSpan]::FromMinutes(5)
$handler.ConnectTimeout = [TimeSpan]::FromSeconds(20)
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromMinutes(4)
$client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", $apiKey)
$client.DefaultRequestHeaders.UserAgent.ParseAdd("m365-gateway-soak/1.0")

function Invoke-Gateway {
  param([string]$Path, [object]$Payload)
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$BaseUrl$Path")
  $json = $Payload | ConvertTo-Json -Depth 30 -Compress
  $request.Content = [System.Net.Http.StringContent]::new($json, [Text.Encoding]::UTF8, "application/json")
  $watch = [Diagnostics.Stopwatch]::StartNew()
  try {
    $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $raw = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $watch.Stop()
    return [pscustomobject]@{ Status = [int]$response.StatusCode; Body = $raw; Milliseconds = $watch.Elapsed.TotalMilliseconds }
  } finally {
    $request.Dispose()
  }
}

function Add-Failure {
  param([int]$Iteration, [string]$Stage, [string]$Detail)
  $errors.Add(("iteration={0};stage={1};detail={2}" -f $Iteration, $Stage, $Detail))
}

try {
  for ($iteration = 0; $iteration -le $DurationMinutes; $iteration += 1) {
    if ([DateTimeOffset]::UtcNow -gt $deadline.AddSeconds(15)) { break }
    $iterationStart = [DateTimeOffset]::UtcNow
    $model = $models[$iteration % $models.Count]

    try {
      $health = $client.GetAsync("$BaseUrl/api/health").GetAwaiter().GetResult()
      $healthBody = $health.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if (-not $health.IsSuccessStatusCode -or $healthBody -notmatch '"status"\s*:\s*"ok"') {
        Add-Failure $iteration "health" ("status=" + [int]$health.StatusCode)
      }
      $health.Dispose()
      $checks += 1
    } catch {
      Add-Failure $iteration "health_exception" $_.Exception.GetType().Name
    }

    try {
      if ($iteration % 2 -eq 0) {
        $result = Invoke-Gateway "/v1/chat/completions" @{
          model = $model
          stream = $true
          session_key = "soak-chat-$iteration"
          messages = @(@{ role = "user"; content = "Return exactly: STREAM-OK-$iteration" })
        }
        $valid = $result.Status -eq 200 -and $result.Body -match '\[DONE\]' -and $result.Body -match 'finish_reason'
        if (-not $valid) { Add-Failure $iteration "chat_stream" ("status=" + $result.Status) }
      } else {
        $result = Invoke-Gateway "/v1/responses" @{
          model = $model
          stream = $true
          session_key = "soak-response-$iteration"
          input = "Return exactly: RESPONSE-OK-$iteration"
        }
        $valid = $result.Status -eq 200 -and $result.Body -match 'response.completed' -and $result.Body -match '\[DONE\]'
        if (-not $valid) { Add-Failure $iteration "responses_stream" ("status=" + $result.Status) }
      }
      $latencies.Add($result.Milliseconds)
      $checks += 1
    } catch {
      Add-Failure $iteration "stream_exception" $_.Exception.GetType().Name
    }

    try {
      $contextPayload = if ($previousResponseId) {
        @{ model = $model; previous_response_id = $previousResponseId; input = "Repeat the exact memory marker from this conversation. Output only the marker." }
      } else {
        @{ model = $model; session_key = "soak-context-stable"; input = "Remember this exact memory marker for later turns: $marker. Output only the marker." }
      }
      $contextResult = Invoke-Gateway "/v1/responses" $contextPayload
      if ($contextResult.Status -ne 200) {
        Add-Failure $iteration "context_status" ("status=" + $contextResult.Status)
      } else {
        $parsed = $contextResult.Body | ConvertFrom-Json -Depth 30
        $previousResponseId = [string]$parsed.id
        $contextText = [string]$parsed.output[0].content[0].text
        if ($contextText -notmatch [regex]::Escape($marker)) { Add-Failure $iteration "context_quality" "marker_missing" }
        $contextTurns += 1
      }
      $latencies.Add($contextResult.Milliseconds)
      $checks += 1
    } catch {
      Add-Failure $iteration "context_exception" $_.Exception.GetType().Name
    }

    if ($iteration % 5 -eq 0) {
      try {
        $tool = @{
          type = "function"
          function = @{
            name = "lookup_soak_value"
            description = "Return the requested deterministic soak value"
            parameters = @{ type = "object"; properties = @{ key = @{ type = "string" } }; required = @("key"); additionalProperties = $false }
          }
        }
        $first = Invoke-Gateway "/v1/responses" @{
          model = $model
          input = "Use lookup_soak_value with key iteration-$iteration. Do not answer directly."
          tools = @($tool)
          tool_choice = @{ type = "function"; function = @{ name = "lookup_soak_value" } }
        }
        if ($first.Status -ne 200) { throw "first_status_$($first.Status)" }
        $firstBody = $first.Body | ConvertFrom-Json -Depth 30
        $call = $firstBody.output | Where-Object { $_.type -eq "function_call" } | Select-Object -First 1
        if (-not $call -or $call.name -ne "lookup_soak_value") { throw "missing_function_call" }
        $second = Invoke-Gateway "/v1/responses" @{
          model = $model
          previous_response_id = [string]$firstBody.id
          input = @(@{ type = "function_call_output"; call_id = [string]$call.call_id; output = "{`"value`":`"TOOL-OK-$iteration`"}" })
        }
        if ($second.Status -ne 200 -or $second.Body -notmatch "TOOL-OK-$iteration") { throw "continuation_failed_$($second.Status)" }
        $toolChains += 1
        $latencies.Add($first.Milliseconds)
        $latencies.Add($second.Milliseconds)
        $checks += 2
      } catch {
        Add-Failure $iteration "tool_chain" $_.Exception.Message
      }
    }

    $elapsed = ([DateTimeOffset]::UtcNow - $iterationStart).TotalSeconds
    Write-Output ("SOAK {0}/{1} model={2} elapsed={3:N1}s errors={4}" -f $iteration, $DurationMinutes, $model, $elapsed, $errors.Count)
    $nextTick = $startedAt.AddMinutes($iteration + 1)
    $wait = $nextTick - [DateTimeOffset]::UtcNow
    if ($iteration -lt $DurationMinutes -and $wait.TotalMilliseconds -gt 0) {
      Start-Sleep -Milliseconds ([int][Math]::Min($wait.TotalMilliseconds, 60000))
    }
  }
} finally {
  $client.Dispose()
  $handler.Dispose()
  Remove-Variable apiKey -ErrorAction SilentlyContinue
}

$ordered = $latencies | Sort-Object
$p95Index = if ($ordered.Count) { [Math]::Min($ordered.Count - 1, [Math]::Floor($ordered.Count * 0.95)) } else { 0 }
$report = [ordered]@{
  startedAt = $startedAt.ToString("O")
  finishedAt = [DateTimeOffset]::UtcNow.ToString("O")
  requestedMinutes = $DurationMinutes
  checks = $checks
  contextTurns = $contextTurns
  toolChains = $toolChains
  errors = @($errors)
  latencyMs = @{
    count = $ordered.Count
    min = if ($ordered.Count) { [Math]::Round($ordered[0], 1) } else { 0 }
    p95 = if ($ordered.Count) { [Math]::Round($ordered[$p95Index], 1) } else { 0 }
    max = if ($ordered.Count) { [Math]::Round($ordered[-1], 1) } else { 0 }
  }
  passed = $errors.Count -eq 0
}
$reportJson = $report | ConvertTo-Json -Depth 20
if ($ReportPath) { [IO.File]::WriteAllText($ReportPath, $reportJson, [Text.UTF8Encoding]::new($false)) }
$reportJson
if ($errors.Count -gt 0) { exit 1 }
