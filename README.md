# CollabDraw 🎨

> **Distributed Real-Time Whiteboard & Blind Chain Draw Party Game**  
> Built with **FastAPI + Redis Pub/Sub**, **Nginx API Gateway**, **HTML5 Canvas**, and modern **Vanilla JavaScript**.

![Python](https://img.shields.io/badge/Python-3.9+-blue.svg) 
![FastAPI](https://img.shields.io/badge/FastAPI-WebSockets-green.svg) 
![Redis](https://img.shields.io/badge/Redis-Pub%2FSub-red.svg) 
![Nginx](https://img.shields.io/badge/Nginx-API%20Gateway-green.svg) 
![License](https://img.shields.io/badge/License-MIT-purple.svg)

---

## ✨ Features Overview

### 🏰 Enterprise User Onboarding & Room Lobby Flow
- **Display Name & Avatar Badge Color**: Customize identity upon entry with responsive color swatches and auto-initial avatar previews.
- **Random 6-Character Room Codes**: Click **Create Room** to generate clean, memorable 6-character room keys (e.g. `WORK01`, `GAME42`) or enter a code to join.
- **Participant Roles & Host Controls**: Roles tracked dynamically in Redis (`Host`, `Editor`, `Viewer`).
  - **Lock/Unlock Drawing Permissions**: Toggle view-only vs. interactive edit modes across all connected participants.
  - **Session Mode Selector**: Toggle between **Collaborative Canvas** and **Blind Chain Draw Party Game**.
  - **Synchronized Session Launch**: Host clicks **🚀 Launch Session** to simultaneously transition all connected lobby clients to the session view.
- **Session-in-Progress Late-Join Protection**: Prevents late joiners from disrupting active sessions while displaying a clean **🔒 Session In Progress** alert card.

---

### 🎨 Multi-Tool Whiteboard Canvas Engine
- **Full Drawing Toolset**: Freehand Pen, Straight Line, Perfect Rectangle, Elliptical Circle, Variable Eraser, and Resizable Sticky Notes.
- **Real-Time Remote Cursor Overlay**: ~30 FPS throttled cursor position streaming displaying peer display names and avatar colors.
- **AI Shape Snapping**: Automatically cleans hand-drawn rough shapes into vector geometries upon stroke release.
- **Multi-Format Export**:
  - **PNG Image Export**
  - **Vector SVG Export**
  - **Multi-Page High-DPI PDF Export** (via `jsPDF`)
- **HiDPI Retina Canvas Engine**: Scaled dynamic canvas matrix matching physical screen pixel ratios without stroke distortion or positioning drift.

---

### 🎮 Blind Chain Draw Party Game Mode
- **Layer-Based Blind Chain Drawing**: Each participant draws their layer without seeing other active layers, building a collaborative mystery artwork.
- **Masterpiece Reveal & Award Ceremony**:
  - Combined sharp layer reveal with high-resolution particle confetti physics.
  - **Category Voting**: Anonymous voting for *Most Creative / Best Drawing* and *Most Chaotic / Hilarious Disaster*.
  - **Strict Host Controls & Participant Requests**:
    - **Host**: Exclusive authority to proceed to voting and trigger the next game round.
    - **Participants**: Interactive **`📩 Request Host to Start Voting`** and **`📩 Request Host for Next Round`** buttons that send real-time notification alerts and glowing button badges to the Host.
  - **Lobby Re-Routing**: Returning from game screens automatically re-routes participants and host back to the **Room Lobby**, preserving host status and participant rosters.

---

## 🏛️ Horizontally Scalable Architecture

```text
                       ┌─────────────────────────┐
                       │   Client Browser Tabs   │
                       └────────────┬────────────┘
                                    │ HTTP / WebSockets (Port 80)
                       ┌────────────▼────────────┐
                       │    Nginx API Gateway    │
                       │   (ip_hash Load Balancer)│
                       └──────┬────────────┬─────┘
                              │            │
               ┌──────────────▼───┐    ┌───▼──────────────┐
               │ FastAPI Backend  │    │ FastAPI Backend  │
               │   Node 1 (8000)  │    │   Node 2 (8001)  │
               └──────┬───────────┘    └───┬──────────────┘
                      │                    │
                      └─────────┬──────────┘
                                │ Redis Pub/Sub & Shared Cache
                       ┌────────▼────────┐
                       │   Redis Server  │
                       │   (Port 6379)   │
                       └─────────────────┘
```

---

## 📁 Repository Structure

```text
distributed-whiteboard/
├── backend/
│   ├── __init__.py
│   ├── server.py              # FastAPI server, WebSocket ConnectionManager & Redis Pub/Sub
│   ├── redis_broker.py        # Fallback embedded Python Redis Broker
│   ├── requirements.txt        # Backend dependencies
│   └── Dockerfile             # Container definition for backend nodes
├── frontend/
│   ├── index.html             # UI views (Landing, Lobby, Canvas, Party Game Overlays)
│   ├── style.css              # Glassmorphic UI token design system & CSS variables
│   └── app.js                 # HiDPI canvas rendering engine & WebSocket client state
├── nginx/
│   ├── nginx.conf             # Nginx reverse proxy, ip_hash & WebSocket upgrade headers
│   └── start_nginx.ps1        # Helper PowerShell script for Nginx launch
├── docker-compose.yml         # One-command multi-node Docker deployment
├── PROJECT_DOCUMENTATION.md   # Full architecture & WebSocket API specifications
├── README.md                  # Project overview & quickstart guide
└── LICENSE                    # MIT License
```

---

## 🚀 Quickstart Guide

### Option 1: One-Command Deployment with Docker Compose (Recommended)

Ensure Docker and Docker Compose are installed, then run:

```bash
docker compose up --build
```

Access the application unified gateway at **[http://localhost](http://localhost)**.

---

### Option 2: Manual Local Setup

#### Step 1: Clone Repository & Setup Virtual Environment
```bash
git clone https://github.com/your-username/distributed-whiteboard.git
cd distributed-whiteboard
python -m venv .venv
# On Windows:
.venv\Scripts\activate
# On Linux/macOS:
source .venv/bin/activate
```

#### Step 2: Install Dependencies
```bash
pip install -r requirements.txt
```

#### Step 3: Run Backend Server Node 1
```bash
python -m uvicorn backend.server:app --port 8000 --host 127.0.0.1
```
*(Node 1 automatically launches an embedded Redis Broker if an external Redis server is not running).*

#### Step 4: Run Backend Server Node 2 (Optional Multi-Node Test)
In a separate terminal window:
```bash
python -m uvicorn backend.server:app --port 8001 --host 127.0.0.1
```

#### Step 5: Launch Nginx API Gateway Proxy
In a third terminal window:
```powershell
.\nginx\start_nginx.ps1
```
Or directly via Nginx CLI:
```bash
nginx -c "%CD%\nginx\nginx.conf"
```

Open **[http://localhost](http://localhost)** in your browser!

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Tool / Action |
| --- | --- |
| `P` | Pen Tool |
| `L` | Straight Line Tool |
| `R` | Rectangle Tool |
| `C` | Circle Tool |
| `S` | Sticky Note Tool |
| `E` | Eraser Tool |
| `Ctrl + Z` | Undo Last Action |

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for details.
