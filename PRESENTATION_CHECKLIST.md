# CollabDraw Presentation Checklist

## 1. Start the project

Open PowerShell in the project folder and run:

```powershell
docker compose down
docker compose up -d --build
```

Wait a few seconds, then verify the four services:

```powershell
docker compose ps
curl.exe http://localhost:8090/health
```

`docker compose ps` should show `redis`, `backend-1`, `backend-2`, and `nginx` as **Up**. The health response must include `"redis":true` and a node name.

## 2. URLs and browser windows

Open three separate browser windows or profiles at:

```text
http://localhost:8090
```

Separate windows make the participant list and cross-client updates easier to show. Use different names in each window.

## 3. Three-browser Draw & Guess demonstration

1. In Browser A enter your name, room `DEMO1`, choose **Draw & Guess Game**, then click **Create new room**.
2. In Browsers B and C enter different names and room `DEMO1`, then click **Join existing room**.
3. In A, point out the three avatars, participant count, green connection status, game lobby, and host controls.
4. Click **Start game**. The current drawer sees three private word choices; B and C only see a masked word.
5. The drawer selects a word and makes a quick pen drawing. B submits one wrong guess; C submits the correct guess. Explain the score and protected word.
6. Let the other guesser submit the correct word to finish the round quickly. Point out the synchronized result and next drawer.
7. For the refresh demonstration, refresh a **guesser**, not the active drawer. The guesser reconnects and restores the current game state. Then click **Leave** before starting the whiteboard demo. This returns that browser to the join screen. Do not claim that the game has a separate “return to lobby” control.

## 4. Show which backend node handled a client

Each successful connection displays a short toast such as `Connected through node-1.` Use it after joining or refreshing a window. In another terminal, run:

```powershell
docker compose logs -f backend-1 backend-2
```

The accepted WebSocket lines identify `node-1` or `node-2`. It is normal for a browser refresh to land on either node because Nginx balances new WebSocket connections.

## 5. Demonstrate Redis Pub/Sub

Say this while Browser A and B are connected to the same room:

> “Nginx may send these browsers to different FastAPI nodes. Each node validates the operation, Redis stores the current board and presence, and Redis Pub/Sub forwards the live event to the other node. That is why a shape drawn through one node appears immediately in a browser connected to the other.”

For a visible proof, create a rectangle or sticky note in A and show it appearing in B. Open a third browser afterwards to show that its initial state contains the existing board.

## 6. Safe backend restart during the demo

Keep the browser windows open, then run:

```powershell
docker compose restart backend-1
```

One or more clients may briefly show **Reconnecting**, then return to **Connected** and reload the room state from Redis. Give the browser a few seconds before continuing. Do not restart Redis during the live demo.

## 7. Whiteboard demonstration

1. In Browser A create room `BOARD1` using **Collaborative Whiteboard**.
2. In Browser B join `BOARD1`.
3. Draw a pen stroke and rectangle in A; create text and a sticky note; select and move an object.
4. Use undo/redo in A. Explain that undo is intentionally per-user.
5. Refresh B. Existing objects should return through the welcome state from Redis.
6. Optionally use Share to copy an invite link, and Export to show JSON/PNG export.

## 8. Browser-disconnect fallback

- Wait for automatic reconnection first; the indicator changes from **Reconnecting** to **Connected**.
- If it does not reconnect after several seconds, refresh the page. The room code and stored name restore the session.
- If a game host refreshes, wait up to three seconds; the reconnect grace period preserves host control.
- If a game drawer disconnects during a round, explain that the server safely skips that turn rather than leaving the room stuck. Do not use the active drawer for the normal refresh demonstration.

## 9. Docker fallback

If the page does not open, run:

```powershell
docker compose ps
docker compose logs --tail=80 backend-1 backend-2 nginx redis
docker compose down
docker compose up -d --build
```

Then recheck `http://localhost:8090/health`. Docker Desktop must show **Engine running**. If port 8090 is already occupied, close the application using it or change the host port in `docker-compose.yml` and reopen the matching URL.

## 10. Likely lecturer questions

1. **Why two FastAPI nodes?** To demonstrate that room communication cannot rely on one process’s memory.
2. **Why Redis?** It provides shared board/presence state and a Pub/Sub channel usable by both nodes.
3. **What does Pub/Sub do?** It broadcasts an accepted live operation from one node to clients connected to the other node.
4. **How do late joiners work?** The server reads the current Redis board hash and sends it in `welcome`, then streams live events.
5. **How do you prevent duplicate operations?** Every operation has an ID; Redis `SET NX` and the client’s seen-ID set make retries idempotent.
6. **How is Draw & Guess authoritative?** FastAPI validates host actions, drawer identity, words, guesses, timers and scoring.
7. **Can guessers see the answer?** No. The secret word is delivered only to the drawer through a targeted event.
8. **What happens when a backend restarts?** Clients reconnect through Nginx and receive shared state from Redis.
9. **Why not use a CRDT?** It would add research-level complexity; this project uses server-accepted operations and last-write-wins for a clear semester-project design.
10. **How does undo work with collaborators?** It only undoes the requesting user’s latest eligible action, avoiding surprise global undo.

## 11. Limitations to state openly

- This is eventually consistent, not a CRDT or operational-transform editor.
- Concurrent edits to the same object are last-write-wins.
- Redis Pub/Sub is live fan-out, not a durable event log.
- A drawer disconnect during an active game safely skips the turn.
- Rooms use a 24-hour Redis TTL and there are no accounts or permanent database records.

## 12. Do not claim these features

- User accounts, authentication, permissions, or permanent user profiles.
- Offline editing or conflict-free merging.
- Persistent database storage beyond the room TTL.
- Guaranteed zero interruption during a node restart.
- Mobile-first touch optimization, production monitoring, Kubernetes, Kafka, or enterprise-grade fault tolerance.
