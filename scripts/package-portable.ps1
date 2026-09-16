$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $workspace 'src-tauri\target\release\frameflow-studio.exe'
$output = Join-Path $workspace 'release\FrameFlow-Studio-Portable-Windows'
$zip = Join-Path $workspace 'release\FrameFlow-Studio-Portable-Windows.zip'

if (-not (Test-Path -LiteralPath $exe)) { throw "Portable executable not found: $exe" }
New-Item -ItemType Directory -Path $output -Force | Out-Null
Copy-Item -LiteralPath $exe -Destination (Join-Path $output 'FrameFlow Studio.exe') -Force
Copy-Item -LiteralPath (Join-Path $workspace 'README.md') -Destination $output -Force
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip }
Compress-Archive -LiteralPath $output -DestinationPath $zip -CompressionLevel Optimal
Get-Item -LiteralPath $zip | Select-Object FullName, Length, LastWriteTime
