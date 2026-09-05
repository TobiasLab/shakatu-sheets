$ErrorActionPreference = 'Stop'
$roots = @("${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application", "$env:LOCALAPPDATA\Microsoft\EdgeWebView\Application")
$runtime = $roots | Where-Object { Test-Path $_ } | ForEach-Object {
    Get-ChildItem $_ -Filter msedgewebview2.exe -Recurse
} | Sort-Object { [version]$_.VersionInfo.ProductVersion } -Descending | Select-Object -First 1
if (-not $runtime) { throw 'Install the Evergreen WebView2 runtime before running desktop tests.' }
$version = $runtime.VersionInfo.ProductVersion
$directory = Join-Path ([IO.Path]::GetTempPath()) 'shakatu-edgedriver'
New-Item -ItemType Directory -Force $directory | Out-Null
$archive = Join-Path $directory 'driver.zip'
Invoke-WebRequest "https://msedgedriver.microsoft.com/$version/edgedriver_win64.zip" -OutFile $archive
Expand-Archive $archive -DestinationPath $directory -Force
$env:PATH = "$directory;$env:PATH"
Write-Host "Using EdgeDriver $version to match WebView2."
