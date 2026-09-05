# Builds signed artifacts locally; does not publish or upload anything.
$ErrorActionPreference = 'Stop'
$thumbprint = $env:SHAKATU_CERTIFICATE_THUMBPRINT
if (-not $thumbprint) { throw 'Set SHAKATU_CERTIFICATE_THUMBPRINT to a code-signing certificate in the current-user certificate store.' }
$certificate = Get-Item "Cert:\CurrentUser\My\$thumbprint"
if (-not $certificate.HasPrivateKey) { throw 'The signing certificate has no accessible private key.' }
$config = Join-Path ([IO.Path]::GetTempPath()) ("shakatu-signing-" + [guid]::NewGuid().ToString() + '.json')
try {
    @{
        bundle = @{ windows = @{
            certificateThumbprint = $thumbprint
            digestAlgorithm = 'sha256'
            timestampUrl = 'http://timestamp.digicert.com'
            tsp = $true
        } }
    } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $config
    npm run bundle:windows -- --config $config -- --locked
    if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed with exit code $LASTEXITCODE" }
    $files = @(Get-Item src-tauri/target/release/shakatu-sheets.exe) + @(Get-ChildItem src-tauri/target/release/bundle/nsis/*-setup.exe)
    foreach ($file in $files) {
        $signature = Get-AuthenticodeSignature $file.FullName
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $thumbprint -or -not $signature.TimeStamperCertificate) {
            throw "Signature or timestamp verification failed: $($file.FullName)"
        }
    }
} finally {
    Remove-Item $config -ErrorAction SilentlyContinue
}
