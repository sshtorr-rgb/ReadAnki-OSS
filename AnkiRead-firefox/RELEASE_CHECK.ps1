$ErrorActionPreference = 'Stop'
$rootPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $rootPath

node -e "JSON.parse(require('fs').readFileSync('manifest.json', 'utf8'))"
Get-ChildItem -LiteralPath . -Filter '*.js' -File | ForEach-Object { node --check $_.FullName }

$requiredFiles = @('manifest.json', 'privacy.html', 'STORE_SUBMISSION.md', 'README.md')
foreach ($file in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing required release file: $file" }
}

# 公開用ポリシー（GitHub Pages の正本）と同梱版が一致していること
$publishedPolicy = Join-Path (Split-Path -Parent $rootPath) 'docs/privacy.html'
if (-not (Test-Path -LiteralPath $publishedPolicy -PathType Leaf)) { throw "Missing published policy: $publishedPolicy" }
if ((Get-FileHash -LiteralPath 'privacy.html').Hash -ne (Get-FileHash -LiteralPath $publishedPolicy).Hash) {
  throw 'privacy.html and docs/privacy.html differ. Copy the updated policy to docs/.'
}

# 最小権限の維持: 全サイトへの常時アクセスや不要な権限を再追加していないこと
$manifest = Get-Content -LiteralPath 'manifest.json' -Raw | ConvertFrom-Json
$broadPatterns = @('<all_urls>', 'http://*/*', 'https://*/*', '*://*/*')
foreach ($pattern in @($manifest.host_permissions)) {
  if ($broadPatterns -contains $pattern) { throw "Broad host permission is not allowed: $pattern" }
}
if ($manifest.content_scripts) { throw 'Static content_scripts are not allowed. Inject on demand via activeTab.' }
if (@($manifest.permissions) -contains 'clipboardRead') { throw 'clipboardRead is not required.' }

$forbiddenExtensions = @('.pem', '.key', '.pfx', '.p12')
$forbiddenFiles = Get-ChildItem -LiteralPath . -Recurse -File | Where-Object {
  $_.Name -eq '.env' -or $forbiddenExtensions -contains $_.Extension.ToLowerInvariant()
}
if ($forbiddenFiles) { throw "Sensitive file found: $($forbiddenFiles.FullName -join ', ')" }

$secretHits = rg -n --glob '!RELEASE_CHECK.ps1' --glob '!STORE_SUBMISSION.md' '(sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,})' .
if ($LASTEXITCODE -eq 0) { throw "Possible API key found:`n$secretHits" }
if ($LASTEXITCODE -gt 1) { throw 'Secret scan failed.' }

Write-Host 'Release static checks passed. Add store PNG icons and listing screenshots before submission.'
