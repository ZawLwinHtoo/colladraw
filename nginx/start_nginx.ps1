# Helper script to launch Nginx with the project configuration on Windows

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ConfigFile = Join-Path $ScriptDir "nginx.conf"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  CollabDraw Nginx API Gateway Launcher  " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Config Path: $ConfigFile" -ForegroundColor Yellow

# Check if nginx command is available
$NginxCmd = Get-Command nginx -ErrorAction SilentlyContinue

if ($NginxCmd) {
    Write-Host "Found nginx in PATH. Starting server..." -ForegroundColor Green
    nginx -c "$ConfigFile"
    Write-Host "Nginx running on http://localhost (Port 80)" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "[!] Nginx executable not found in PATH." -ForegroundColor Yellow
    Write-Host "Option 1 (via Winget):" -ForegroundColor White
    Write-Host "    winget install NGINX.NGINX" -ForegroundColor LightGray
    Write-Host "Option 2 (via Chocolatey):" -ForegroundColor White
    Write-Host "    choco install nginx" -ForegroundColor LightGray
    Write-Host "Option 3 (Direct Download):" -ForegroundColor White
    Write-Host "    Download Nginx for Windows from https://nginx.org/en/download.html" -ForegroundColor LightGray
    Write-Host "    Extract and run: .\nginx.exe -c `"$ConfigFile`"" -ForegroundColor LightGray
    Write-Host ""
}
