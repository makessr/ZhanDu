[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Ssh2Module,
    [string]$Node = 'node.exe',
    [string]$Bun = 'bun.exe',
    [string]$Cargo = 'cargo.exe',
    [string]$TargetDirectory
)

$ErrorActionPreference = 'Stop'
$Repository = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$Ssh2Module = (Resolve-Path -LiteralPath $Ssh2Module).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ('fineshell-sync-smoke-' + [guid]::NewGuid().ToString('N'))
$src = Join-Path $root 'src-tauri'
New-Item -ItemType Directory -Path $src | Out-Null
Get-ChildItem -LiteralPath (Join-Path $Repository 'src-tauri') -Force |
    Where-Object Name -NotIn @('target','gen') |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $src -Recurse }
Copy-Item -LiteralPath (Join-Path $Repository 'protocol') -Destination $root -Recurse
New-Item -ItemType Directory -Path (Join-Path $root 'src') | Out-Null
Copy-Item -LiteralPath (Join-Path $Repository 'src/ai-tool-catalog.json') -Destination (Join-Path $root 'src')
$libPath = Join-Path $src 'src/lib.rs'
$lib = Get-Content -LiteralPath $libPath -Raw
if (!$lib.Contains('.build(tauri::generate_context!())')) { throw 'Build entry has changed' }

$lib = $lib.Replace('.build(tauri::generate_context!())', '.build(smoke_context())')
$lib += @'

fn smoke_profile() -> String {
    let name = std::env::var("FINESHELL_SMOKE_PROFILE").expect("explicit smoke profile required");
    assert!(name.starts_with("smoke-") && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'));
    name
}

fn smoke_service(service: &str) -> String {
    format!("{service}.{}", smoke_profile())
}

fn smoke_context() -> tauri::Context<tauri::Wry> {
    let mut context = tauri::generate_context!();
    let id = format!("com.fineshell.app.{}", smoke_profile());
    context.config_mut().identifier = id;
    context
}
'@
Set-Content -LiteralPath $libPath -Value $lib -NoNewline -Encoding utf8
foreach ($name in @('credentials.rs','host_sync.rs')) {
    $path = Join-Path $src "src/$name"
    $contents = Get-Content -LiteralPath $path -Raw
    $isolated = $contents -replace 'keyring::Entry::new\(([A-Z_]+),', 'keyring::Entry::new(&crate::smoke_service($1),'
    if ($isolated -eq $contents) { throw "FineShell credential entry changed in $name" }
    Set-Content -LiteralPath $path -Value $isolated -NoNewline -Encoding utf8
}

Push-Location $Repository
try {
    & $Bun run build
    if ($LASTEXITCODE) { throw 'FineShell frontend build failed' }
    Copy-Item -LiteralPath (Join-Path $Repository 'dist') -Destination $root -Recurse
    $target = if ($TargetDirectory) { [IO.Path]::GetFullPath($TargetDirectory) } else { Join-Path $root 'target' }
    & $Cargo build --manifest-path (Join-Path $src 'Cargo.toml') --target-dir $target --locked --features tauri/custom-protocol
    if ($LASTEXITCODE) { throw 'FineShell native build failed' }
} finally {
    Pop-Location
}

$binary = Join-Path $root 'fineshell.exe'
Copy-Item -LiteralPath (Join-Path $target 'debug/fineshell.exe') -Destination $binary
$oldProfile = $env:FINESHELL_SMOKE_PROFILE
$oldWebView = $env:WEBVIEW2_USER_DATA_FOLDER
$oldFlags = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$oldDevice = $env:ZHANDU_SMOKE_DEVICE_B_PID
$apps = @()
$ports = @()
try {
    foreach ($device in @('a', 'b')) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
        $listener.Stop()
        $ports += $port
        $env:FINESHELL_SMOKE_PROFILE = "smoke-$([guid]::NewGuid().ToString('N'))-$device"
        $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $root $device
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port --remote-debugging-address=127.0.0.1"
        $apps += Start-Process -FilePath $binary -WindowStyle Hidden -PassThru
    }

    $env:ZHANDU_SMOKE_DEVICE_B_PID = [string]$apps[1].Id
    & $Node (Join-Path $PSScriptRoot 'sync.mjs') $ports[0] $ports[1] $Ssh2Module
    if ($LASTEXITCODE) { throw 'FineShell desktop synchronization smoke test failed' }
} finally {
    foreach ($app in $apps) {
        if (!$app.HasExited -and (!$app.CloseMainWindow() -or !$app.WaitForExit(3500))) {
            Stop-Process -Id $app.Id -ErrorAction SilentlyContinue
        }
    }
    $env:FINESHELL_SMOKE_PROFILE = $oldProfile
    $env:WEBVIEW2_USER_DATA_FOLDER = $oldWebView
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $oldFlags
    $env:ZHANDU_SMOKE_DEVICE_B_PID = $oldDevice
    Write-Output "Test workspace: $root"
}
