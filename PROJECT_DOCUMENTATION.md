# CollabDraw — Distributed Programming Documentation

## 1. Overview and problem

CollabDraw helps a small group sketch diagrams and ideas together without passing screenshots or refreshing a page. The project demonstrates how a shared interactive application remains consistent when users connect through different backend processes.

## 2. Features

- Rooms, invite links, participant avatars and live labelled cursors.
- Pen, eraser, line, arrow, rectangle, ellipse, text, sticky notes, selection and movement.
- Pan/zoom, keyboard shortcuts, toast feedback, confirmation dialog, help panel and connection state.
- Per-user undo/redo, shared clear, PNG export and JSON export/import.
- Late-join and reconnect state recovery.

## 3. Stack

| Part | Technology | Reason |
| --- | --- | --- |
| Client | Vanilla JavaScript + HTML Canvas | Small, readable custom drawing surface |
| Server | FastAPI + Uvicorn | Async WebSocket support in a compact Python app |
| Shared infrastructure | Redis | Board objects, presence and Pub/Sub fan-out |
| Gateway | Nginx | Serves static files and distributes WebSockets |
| Deployment | Docker Compose | Reproduces the two-node demo on one computer |

## 4. Architecture

```text
Browser A ── WebSocket ─┐
                         ├── Nginx ── Node 1 (FastAPI) ─┐
Browser B ── WebSocket ─┘              Node 2 (FastAPI) ─┼── Redis
                                                          │   • board hash
                                                          │   • presence hash
                                                          └── • Pub/Sub channel
```

Nginx routes each connection to one FastAPI node. WebSockets themselves remain local to that node. Redis is the shared layer, so a node can notify clients connected to another node and any node can reconstruct a room board.

## 5. Rooms and board object model

A room ID is 2–24 uppercase letters, digits or hyphens, beginning with a letter or digit. Redis retains board data for 24 hours after the latest change. Every room has exactly one shared metadata record at `collabdraw:room:{room}:meta`, containing its ID, mode, host, creation timestamp and status. This record is the authoritative identity of a room: `55555` cannot be both a game and a whiteboard.

The landing page keeps Create and Join as separate flows. Create is the only flow with an experience choice. It atomically writes metadata using Redis `SET NX`; an existing code returns an error and is never silently reused. Join sends no selected mode, requires existing metadata, and renders the `welcome.mode` returned by the server. A missing room returns **Room not found**. Invite links only pre-fill the Join form (`?room=55555`); they never select a mode. Refresh/reconnect always uses Join semantics and therefore cannot create or overwrite a room.

Every visible item is a plain object, for example:

```json
{
  "id": "obj-…", "type": "rectangle", "userId": "user-…",
  "x": 100, "y": 80, "w": 180, "h": 100,
  "style": {"stroke":"#635bff", "fill":"#ffffff", "width":3},
  "updatedAt": 1760000000000
}
```

Pens use a `points` array. Text and sticky notes also have `text`. The server stores current objects in a Redis hash keyed by object ID, making a late join a simple `HGETALL` instead of replaying a huge drawing stream.

## 6. WebSocket protocol and synchronization

The client connects to `/ws/{room}?name=…&client_id=…&action=create|join`. A stable `client_id` in session storage lets a reconnect retain its colour and identity. `create` includes the requested mode and atomically creates metadata; browser Join/reconnect requests do not send a mode. The server still ignores any stale or malicious mode received with `join` and requires existing metadata.

`welcome` includes `clientId`, the accepting `nodeId`, all current objects and all participants. Afterwards, clients receive lightweight `cursor`, `presence`, and `operation` events.

```json
{
  "type": "operation",
  "operationId": "op-…",
  "roomId": "BLUE-MANGO-21",
  "userId": "user-…",
  "eventType": "object:update",
  "timestamp": 1760000000000,
  "payload": {"object": {"id":"obj-…", "type":"sticky", "text":"Idea"}}
}
```

Supported operations are `object:create`, `object:update`, `object:delete`, `board:clear`, and `board:replace` (JSON import). The server validates object type, IDs, point count and ownership before modifying the board hash. It stores a short-lived Redis key for every operation ID using `SET NX`; retrying an already received operation has no effect. The client also remembers received IDs, preventing its optimistic local action from being drawn twice when the server echoes it.

### Drawing flow

1. A user finishes a stroke or shape; the client packages it as one operation.
2. The accepting FastAPI node validates and writes the new board state to Redis.
3. That node sends it to local sockets and publishes the same event on `collabdraw:events`.
4. Other nodes receive the Pub/Sub event and send it to their local sockets.
5. All clients apply the same operation to their local object map.

Live cursor messages skip persistent storage and are throttled to one every 40 ms. This makes awareness feel immediate without growing board history.

## 7. Presence and reconnection

Each connection writes `{id,name,color}` to a Redis presence hash. Join/leave events carry the current participant list, so avatars are global rather than merely local to one backend process. A disconnected browser displays “Reconnecting”, retries automatically, and receives a fresh `welcome` state. A reconnect replacing an older socket is protected so the old socket cannot remove the new session’s presence. A game host gets a three-second reconnect grace period: refreshing the browser preserves host control, while a host who remains absent is transferred to a connected participant.

## 8. Undo, redo and imports

Undo is intentionally per user: it reverses the current user’s most recent create, update or delete using a normal shared operation. It never silently undoes another person’s work. Redo reapplies that user action. Clear is not undoable because it deliberately affects everyone. JSON import replaces the board with newly assigned objects owned by the importing user and synchronizes the result as one operation. PNG export captures the current visible view.

### Inline text and sticky-note editing

Canvas pixels cannot receive normal keyboard input, so text and sticky notes use one HTML textarea positioned above the canvas. Its position is calculated from the board object with the same pan/zoom transform used by rendering: `screen = boardCoordinate × scale + viewOffset`. A text editor starts empty at the clicked position; a sticky editor starts empty with a visual-only “Type your note…” placeholder. Empty new items are discarded, so placeholders never become saved content.

Text commits with Enter or click-away; sticky notes support new lines and commit with click-away or Ctrl+Enter. Escape cancels an edit. Select-tool double-click reopens the same object ID, and committing sends one normal `object:create` or `object:update` operation. Global tool shortcuts are disabled while the textarea is active, so typing `P`, `S`, Delete, or Ctrl+Z behaves normally inside the editor.

Text is deliberately **commit-synchronized**, not character-synchronized: other users see the final text after an edit is committed. If two users edit the same text or sticky note at once, the latest accepted object update wins. This is a documented last-write-wins choice rather than a CRDT implementation.

## 9. Distributed concepts demonstrated

- Long-lived asynchronous WebSocket connections.
- Load distribution across equivalent backend nodes.
- Redis as externally shared state rather than process-local memory.
- Redis Pub/Sub for cross-node event fan-out.
- Event IDs and idempotency for reconnect/retry safety.
- Eventual convergence: clients reach the same object state after receiving operations.
- Graceful degradation: without Redis, one backend still works with in-memory state; multi-node behavior is disabled.

### Persistent objects and ephemeral signals

The whiteboard object model supports `pen`, `highlighter`, `line`, `arrow`, `double_arrow`, `connector`, `rectangle`, `ellipse`, `triangle`, `diamond`, `text` and `sticky`. Persistent objects carry an ID, owner, geometry, style and a numeric layer value. Create, update (including move, resize and layer changes), delete, clear and import all use normal idempotent operations, are stored in the Redis room board hash, and are published to both backend nodes.

The grid is deliberately a local visual preference, not a shared object. Live cursors are throttled WebSocket messages forwarded through Redis Pub/Sub and fade in the client without entering Redis board state, undo/redo or exports. This gives the presentation a clear example of **ephemeral distributed events** alongside durable shared state.

Selection has a compact contextual toolbar for duplicate and layer actions. Copy/paste is an internal browser clipboard: pasting creates a new ID and a small coordinate offset, so it is a safe ordinary create event. Layer ordering uses the persistent `z` value and is last-write-wins if collaborators reorder the exact same object concurrently. Image insertion is intentionally not implemented; arbitrary base64 images would make Redis state and Pub/Sub messages disproportionately large without a separate file store.

## 10. Failure scenarios and limitations

| Scenario | Behaviour |
| --- | --- |
| One backend restarts or is recreated | Its clients reconnect and rehydrate from Redis; the other node stays available. Nginx refreshes Docker service DNS so it does not retain an old container IP. |
| Redis unavailable | A single node uses memory; nodes cannot synchronize |
| Duplicate operation | Redis `SET NX` rejects it and clients ignore it by ID |
| Simultaneous edits to one object | Last accepted update wins; there is no CRDT/OT conflict algorithm |
| Malicious/public use | Not supported: there is no authentication or authorization beyond object ownership |

The project does not include accounts, databases, CRDT frameworks, queues, Kubernetes, or other enterprise infrastructure. That is deliberate: the core concepts remain observable and explainable.

## 11. Demo procedure

1. Run `docker compose up --build`; open two windows at `localhost:8090`.
2. Join the same room with two names. Point out participants and the accepted node in the connection toast/logs.
3. Draw a pen stroke and create a rectangle, text and sticky note in window A; move/delete an object. Show them in B.
4. Open a third window; show its immediate board state.
5. Use Ctrl+Z/Ctrl+Y in A; explain that only A’s own action is reversed.
6. Export JSON, clear after confirmation, then import JSON to restore it.
7. Restart `backend-1` and show reconnect plus restored state.

## 12. Lecturer questions and short answers

**Why Redis when FastAPI can keep a dictionary?** A dictionary belongs to one process. Browser A and B may land on different processes; Redis is their common source of truth.

**Why Pub/Sub and a Redis board hash?** Pub/Sub distributes a live change. The hash supplies complete current state to a late joiner or reconnecting client.

**Is this strongly consistent?** No. It is a student-level eventually consistent editor with server-accepted ordering and last-write-wins object updates.

**Why operation IDs?** A WebSocket reconnect can resend an operation. IDs make the server and clients idempotent, so a retry does not create a duplicate shape.

**Why is undo per user?** Global undo surprises collaborators. Per-user undo is predictable without needing research-grade operational transform or CRDT logic.

## 13. Future improvements

Add room tokens, rate limits, durable database snapshots, server-authoritative resize handles, object locking, and CRDT/OT only if a later course explicitly requires conflict-free concurrent edits.

## 14. Draw & Guess game mode

Rooms have one authoritative metadata record at `collabdraw:room:{room}:meta`, for example `{"roomId":"55555","mode":"game","hostId":"user-…","createdAt":…,"status":"lobby"}`. Only an explicit `create` action can write it, using Redis `SET NX`; a duplicate create fails and a missing-room join returns “Room not found.” A join never creates a room and ignores its supplied mode. Game state lives at `collabdraw:game:{room}` and game strokes live in `collabdraw:game-board:{room}`; normal whiteboard objects remain at `collabdraw:board:{room}`. Therefore clearing a game turn never deletes collaborative-whiteboard work.

```text
LOBBY → WORD_SELECTION → DRAWING → ROUND_RESULTS → NEXT_TURN → GAME_RESULTS
```

The first player in a game room is host. Before start, the host chooses 1–5 round cycles and a 30/45/60/90 second duration. At start the server snapshots the currently present players into deterministic turn order. Each player draws once per cycle. Late joiners can watch, see chat and scores, but are spectators until the next game.

### Server authority and secret words

`backend/game.py` owns game transitions. It selects three words from its server-only list, stores the selected answer in Redis, and sends choices/answer only through a direct WebSocket delivery for the current drawer. The broadcast `game:state` is deliberately sanitised: guessers receive a masked hint, length, timer timestamps, players, scores and chat but never `secretWord` or `wordOptions`.

The server accepts `game:start`, `game:settings`, `game:word`, `game:guess`, `game:tick`, and `game:again`. It rejects a start from non-hosts, a word not offered to the drawer, guesses from drawers/spectators/already-correct players, and board operations from anyone except the active drawer. Game drawing is limited to pen and eraser/clear controls to prevent text cheating.

Wrong guesses appear as chat; a correct one is represented only as “player guessed the word”, and each player has a one-second Redis-backed guess-rate limit.

### Timer, scoring and races

`roundStartedAt` and `duration` are server state. Browsers only display the remaining time; their one-second `game:tick` requests let any node ask the server to advance an expired phase. A short Redis `SET NX` transition lock ensures that simultaneous guesses, timeouts or ticks do not advance a turn twice. Correct guesses score `max(100, round(500 × remaining / duration))`; the drawer receives 50 points per correct guess. A turn ends on timeout or when every eligible guesser is correct.

### Multi-node and recovery

Game changes publish a secret-free state through `collabdraw:events`; each FastAPI node forwards it to its local WebSockets. Drawer-only packets use a targeted Redis Pub/Sub delivery, so a secret is not sent to sockets on another node. Reconnecting clients receive the current game state and current game canvas; if the reconnecting client is drawer it also receives its private word/choices. A host has a short three-second reconnect grace period, preventing a normal refresh from unexpectedly transferring host controls; after that period the server selects the next connected participant. If a drawer disconnects during a turn, the server skips to the next turn instead of leaving the room stuck.

### Presentation procedure

1. Create a Draw & Guess room in browser A, then join it from B and C.
2. Show Nginx logs accepting clients on different backend nodes.
3. Start the game from A. Show that only A gets three choices and only A can draw.
4. Draw; show B and C receive strokes. Submit a wrong guess, then a correct guess; explain server-side scoring and hidden answer.
5. Wait for the result card and show the next drawer/canvas reset.
6. Restart one backend node. Refresh/reconnect a client and show the Redis game state and game canvas return.
