# CollabDraw

CollabDraw is a real-time, distributed collaborative whiteboard built for a fourth-year Distributed Programming course. It is intentionally feature-rich enough for a semester team project while keeping the architecture small enough to explain.

## Architecture

```text
Browser
  ↓
Nginx
 ↙   ↘
FastAPI node 1   FastAPI node 2
        ↘       ↙
          Redis
```

Nginx balances WebSocket connections. Redis provides the shared room board, presence and game state; Redis Pub/Sub forwards accepted live events between backend nodes.

## Requirements

- Docker Desktop (with its engine running) or Docker Engine
- Docker Compose
- A current desktop browser such as Chrome, Edge, Firefox or Safari

No environment file, local Python installation, local Redis installation, or manual Nginx setup is required for the Docker workflow.

## Installation

```powershell
git clone https://github.com/ZawLwinHtoo/colladraw.git
cd colladraw
docker compose up -d --build
```

Open [http://localhost:8090](http://localhost:8090). The health checks start Nginx only after Redis and both FastAPI nodes are ready.

## Stopping and resetting

```powershell
docker compose down
```

To remove all Redis room data used during development or testing:

```powershell
docker compose down -v
```

`-v` deletes the local Redis container data; it does not delete source code.

## Local development without Docker

For a one-node development run, install the Python requirements and start FastAPI directly. The distributed demonstration still requires Docker Compose.

The first page presents two equal choices:

- **Create a Room**: enter a name, optionally enter a code, then choose Whiteboard or Draw & Guess. A blank code generates a readable code.
- **Join a Room**: enter a name and an existing code. There is intentionally no mode selector; the server detects the room type.

Room IDs are normalized to uppercase letters, numbers and simple hyphens. Creating an existing code is rejected; joining a missing code returns **Room not found**. An invite link such as `http://localhost:8090/?room=BLUE-MANGO` opens the Join screen with the code filled in.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn backend.server:app --reload --port 8000
```

Redis is optional for a one-node local run, but required for the distributed demonstration.

## What it can do

- Create or join human-readable rooms and share an invite link.
- Draw with pen, translucent highlighter, line, arrow, double arrow, connector, rectangle, ellipse, triangle and diamond tools.
- Add editable text and sticky notes; select, move, resize suitable objects, change layer order, duplicate, delete and erase your own objects.
- Use a local-only grid while live cursors show real-time collaborator awareness.
- Pan, zoom, export PNG, export/import JSON, clear the shared board, and undo/redo your own actions.
- Show participants, live labelled cursors, join/leave toasts, and connection status.
- Restore the complete object board when a user joins or reconnects.
- Create a server-authoritative Draw & Guess game room with lobby, host controls, private word choices, turn rotation, guessing, scoring and a final ranking.

Text and sticky notes use a focused inline editor over the canvas. A new item is not synchronized until its editor is committed by clicking away, pressing Enter for text, or pressing Ctrl+Enter for a sticky note. Double-clicking an existing item edits its existing object ID. This avoids sending one WebSocket message for every keystroke.

The selection toolbar exposes duplicate, forward/backward and front/back layer actions without crowding the main toolbar. `Ctrl+C`, `Ctrl+V` and `Ctrl+D` use an internal CollabDraw clipboard and create a new object with a small offset. `G` toggles the visual grid; `H` selects highlighter; `B` selects double arrow; `C` selects connector. Image insertion was intentionally deferred: sending arbitrary image blobs through the shared Redis board hash would create avoidable payload and persistence problems for this course-sized project.

## Draw & Guess demo

Choose **Draw & Guess Game** only when creating a room. Joining needs just a name and room code: the server reads the room’s stored Redis metadata, so a room code can never split into a game and a whiteboard. Atomic Redis `SET NX` creation means two backend nodes cannot create different modes for the same code. The first player is the host. Invite two or more players, set 1–5 round cycles and a 30/45/60/90-second timer, then start. The current drawer privately receives three server-selected choices; everyone else sees only a masked word and can submit guesses in the right-hand panel.

The server, not the browser, validates the drawer, selected word, guesses, timer cutoff and score. A correct guess earns `max(100, round(500 × remainingSeconds / roundDuration))`; the drawer earns 50 points for each correct guess. Joining after the game begins is spectator-only until the next game.

## Distributed demo

The Compose setup launches `backend-1`, `backend-2`, Redis and Nginx. Nginx distributes new WebSocket connections across both backend nodes. To prove it during a presentation:

```powershell
docker compose logs -f backend-1 backend-2
```

Join a room from two separate browser windows. The logs identify the node that accepted each client. Draw in one window; the other receives the change through Redis Pub/Sub even if it is attached to the other node.

To simulate one node failing:

```powershell
docker compose restart backend-1
```

Clients reconnect automatically and receive the authoritative Redis board state. The other node continues serving clients. Nginx re-resolves Docker service names, so a recreated backend receives a new container IP without leaving the proxy on a stale address.

## Project layout

```text
backend/server.py       FastAPI WebSocket server, shared board and presence logic
backend/game.py         Redis-backed Draw & Guess state machine and word list
frontend/index.html     Application structure and controls
frontend/app.js         Canvas editor, client state and WebSocket client
frontend/style.css      Responsive CollabDraw visual system
nginx/nginx.conf        Static frontend and WebSocket reverse proxy
docker-compose.yml      Two nodes + Redis + Nginx
```

See [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) for the protocol, architecture, limitations and presentation notes.

## Regression checks

```sh
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

These checks exercise real WebSocket room creation, board replay, object ownership, malformed messages, invalid coordinates, host controls, private word selection, and game scoring in isolated one-node mode. The two-node presentation still needs the Redis/Docker setup above.

## Known limitations

- The collaborative editor is eventually consistent; simultaneous edits of the same object use last-write-wins rather than CRDT/OT conflict resolution.
- Rooms are stored in Redis with a TTL and are not permanent database records.
- There are no user accounts, authentication, offline editing, image uploads or mobile-first touch optimisation.
- A drawer disconnect during an active Draw & Guess round skips that turn to keep the game progressing.

## Academic purpose

CollabDraw is a fourth-year university Distributed Programming project. It intentionally prioritises observable WebSocket, Redis, Pub/Sub, load-balancing and recovery concepts over production-SaaS complexity.
