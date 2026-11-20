param(
    [Parameter(Mandatory)][ValidateSet('key', 'use', 'save')][string]$Mode,
    [string]$TargetDirectory = 'src-tauri/target'
)

$ErrorActionPreference = 'Stop'
$target = 'aarch64-pc-windows-msvc'
if ($env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ARCH -ne 'ARM64' -or !$env:RUNNER_TEMP) {
    throw 'The OpenSSL cache is for the Windows ARM64 release runner.'
}
$cache = Join-Path $env:RUNNER_TEMP 'zhandu-openssl-arm64'
$lock = Get-Content -LiteralPath 'src-tauri/Cargo.lock' -Raw
$selected = [regex]::Matches($lock, '(?ms)^\[\[package\]\]\r?\nname = "openssl-(?:src|sys)"\r?\n.*?(?=^\[\[package\]\]|\z)')
$source = $selected | Where-Object { $_.Value -match 'name = "openssl-src"' }
$version = [regex]::Match($source.Value, '(?m)^version = "[^"]+\+([^"]+)"').Groups[1].Value
if ($selected.Count -ne 2 -or !$version -or ($selected | Where-Object { $_.Value -notmatch '(?m)^checksum = "[0-9a-f]{64}"' })) {
    throw 'Cannot uniquely identify the locked OpenSSL sources.'
}

if ($Mode -eq 'key') {
    $compiler = rustc -vV
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    $format = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
    $identity = @($target, $env:ImageOS, $env:ImageVersion, $format) + $compiler + @($selected | ForEach-Object Value)
    $hash = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($identity -join "`n").Replace("`r", '')))
    "key=vendored-openssl-arm64-$([Convert]::ToHexString($hash))" >> $env:GITHUB_OUTPUT
    "path=$cache" >> $env:GITHUB_OUTPUT
    return
}

function Test-OpenSslLayout([string]$Path) {
    foreach ($entry in @('include/openssl/ssl.h','include/openssl/opensslv.h','lib/libssl.lib','lib/libcrypto.lib')) {
        $file = Get-Item -LiteralPath (Join-Path $Path $entry) -ErrorAction SilentlyContinue
        if (!$file -or $file.PSIsContainer -or !$file.Length) { return $false }
    }
    $header = Get-Content -LiteralPath (Join-Path $Path 'include/openssl/opensslv.h') -Raw
    return [regex]::IsMatch($header, '(?m)^\s*#\s*define\s+OPENSSL_VERSION_STR\s+"' + [regex]::Escape($version) + '"')
}

$build = Join-Path $TargetDirectory "$target/release/build"
# Cargo 1.100 stores build scripts in build/<package>/<unit-id>.
$packages = @(
    Get-ChildItem -LiteralPath (Join-Path $build 'openssl-sys') -Directory -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath $build -Directory -Filter 'openssl-sys-*' -ErrorAction SilentlyContinue
)
$install = $packages |
    ForEach-Object { Join-Path $_.FullName 'out/openssl-build/install' } |
    Where-Object { Test-OpenSslLayout $_ } |
    Select-Object -First 1

if ($Mode -eq 'use') {
    if ($install) {
        Write-Output 'OpenSSL libraries are already present in the Cargo target cache.'
    } elseif (Test-OpenSslLayout $cache) {
        "AARCH64_PC_WINDOWS_MSVC_OPENSSL_DIR=$cache" >> $env:GITHUB_ENV
        'AARCH64_PC_WINDOWS_MSVC_OPENSSL_NO_VENDOR=1' >> $env:GITHUB_ENV
        'AARCH64_PC_WINDOWS_MSVC_OPENSSL_STATIC=1' >> $env:GITHUB_ENV
        Write-Output 'Using cached vendored OpenSSL headers and static libraries.'
    } else {
        Write-Output 'OpenSSL library cache is empty. Cargo will build the locked vendored source.'
    }
    return
}

if (!(Test-OpenSslLayout $cache) -and $install) {
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $install 'include'), (Join-Path $install 'lib') -Destination $cache -Recurse -Force
}
if (Test-OpenSslLayout $cache) { 'saved=true' >> $env:GITHUB_OUTPUT }
