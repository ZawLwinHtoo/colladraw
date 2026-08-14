# Nginx API Gateway & Load Balancer Setup

This directory contains the Nginx reverse proxy configuration for CollabDraw.

## Features

1. **Port 80 Unified Entry Point**: Routes requests from `http://localhost:80` to backend instances on ports `8000` and `8001`.
2. **Sticky Sessions (`ip_hash`)**: Ensures a client stays attached to their designated backend node while keeping Redis Pub/Sub cross-node sync active.
3. **WebSocket Upgrade Tunnels**: Explicitly forwards `Upgrade` and `Connection` headers for WebSockets (`WS /ws/{room_id}`).
4. **Resilient Long-lived Connections**: 24-hour proxy timeout (`proxy_read_timeout 86400s`) to prevent socket disconnects.

---

## How to Run Nginx on Windows

### Quick PowerShell Launcher
```powershell
.\nginx\start_nginx.ps1
```

### Manual Command
If Nginx is downloaded or installed in PATH:
```cmd
nginx -c "%CD%\nginx\nginx.conf"
```

To stop or reload Nginx:
```cmd
nginx -s stop
nginx -s reload -c "%CD%\nginx\nginx.conf"
```

---

## Installing Nginx on Windows (If not installed)

- **Via Winget**:
  ```powershell
  winget install NGINX.NGINX
  ```
- **Via Chocolatey**:
  ```powershell
  choco install nginx
  ```
- **Manual Zip**: Download from [nginx.org/en/download.html](https://nginx.org/en/download.html), extract, and pass the absolute path to `nginx.conf`.
