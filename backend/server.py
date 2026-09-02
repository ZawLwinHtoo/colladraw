"""CollabDraw's small, event-based distributed whiteboard server."""
import asyncio
import json
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from backend.game import GameService

try:
    import redis.asyncio as redis
except ImportError:
    redis = None

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("collabdraw")
NODE_ID = os.getenv("NODE_ID", f"node-{os.getpid()}")
CHANNEL = "collabdraw:events"
ROOM_RE = re.compile(r"^[A-Z0-9][A-Z0-9-]{1,23}$")
ID_RE = re.compile(r"^[a-zA-Z0-9_-]{6,64}$")
MAX_OBJECTS = 1_500
ROOM_TTL = 60 * 60 * 24
HOST_RECONNECT_GRACE_SECONDS = 3
ALLOWED_TYPES = {"pen", "highlighter", "line", "arrow", "double_arrow", "connector", "rectangle", "ellipse", "triangle", "diamond", "text", "sticky"}


class BoardManager:
    """Local sockets plus Redis-backed board/presence shared by all nodes."""

    def __init__(self) -> None:
        self.clients: dict[str, dict[str, WebSocket]] = {}
        self.boards: dict[str, dict[str, dict[str, Any]]] = {}
        self.presence: dict[str, dict[str, dict[str, str]]] = {}
        self.redis = None
        self.listener: asyncio.Task | None = None
        self.room_ttl = ROOM_TTL
        self.room_configs: dict[str, dict[str, str]] = {}

    def key(self, kind: str, room: str) -> str:
        return f"collabdraw:{kind}:{room}"

    async def start(self) -> None:
        if redis is None:
            logger.warning("Redis package unavailable; using one-node memory mode.")
            return
        try:
            self.redis = redis.from_url(
                f"redis://{os.getenv('REDIS_HOST', 'localhost')}:{os.getenv('REDIS_PORT', '6379')}",
                decode_responses=True,
                socket_connect_timeout=1,
            )
            await self.redis.ping()
            self.listener = asyncio.create_task(self.listen())
            logger.info("%s connected to Redis; multi-node synchronization enabled.", NODE_ID)
        except Exception as exc:
            logger.warning("Redis unavailable (%s); using one-node memory mode.", exc)
            self.redis = None

    async def stop(self) -> None:
        if self.listener:
            self.listener.cancel()
            try:
                await self.listener
            except asyncio.CancelledError:
                pass
        if self.redis:
            await self.redis.aclose()

    async def listen(self) -> None:
        pubsub = self.redis.pubsub()
        await pubsub.subscribe(CHANNEL)
        try:
            async for message in pubsub.listen():
                if message["type"] != "message":
                    continue
                packet = json.loads(message["data"])
                if packet.get("node") == NODE_ID:
                    continue
                if packet.get("direct"):
                    direct = packet["direct"]
                    socket = self.clients.get(packet["room"], {}).get(direct["clientId"])
                    if socket:
                        await socket.send_json(direct["event"])
                else:
                    await self.broadcast(packet["room"], packet["event"])
        finally:
            await pubsub.aclose()

    async def broadcast(self, room: str, event: dict[str, Any]) -> None:
        stale: list[str] = []
        for client_id, socket in self.clients.get(room, {}).items():
            try:
                await socket.send_json(event)
            except Exception:
                stale.append(client_id)
        for client_id in stale:
            self.clients.get(room, {}).pop(client_id, None)

    async def publish(self, room: str, event: dict[str, Any]) -> None:
        await self.broadcast(room, event)
        if self.redis:
            await self.redis.publish(CHANNEL, json.dumps({"node": NODE_ID, "room": room, "event": event}))

    async def publish_direct(self, room: str, client_id: str, event: dict[str, Any]) -> None:
        """Deliver a private event to one client, even if it lives on another node."""
        socket = self.clients.get(room, {}).get(client_id)
        if socket:
            await socket.send_json(event)
        if self.redis:
            await self.redis.publish(CHANNEL, json.dumps({"node": NODE_ID, "room": room, "direct": {"clientId": client_id, "event": event}}))

    def room_meta_key(self, room: str) -> str:
        return f"collabdraw:room:{room}:meta"

    async def find_room(self, room: str) -> dict[str, Any] | None:
        key = self.room_meta_key(room)
        if self.redis:
            raw = await self.redis.get(key)
            if raw:
                return json.loads(raw)
            # One-time compatibility path for rooms created before explicit actions.
            legacy = await self.redis.get(self.key("room", room))
            if legacy:
                old = json.loads(legacy)
                meta = {"roomId": room, "mode": old["mode"], "hostId": old["hostId"], "createdAt": int(time.time() * 1000), "status": "lobby"}
                await self.redis.set(key, json.dumps(meta), nx=True, ex=ROOM_TTL)
                return json.loads(await self.redis.get(key))
            return None
        return self.room_configs.get(room)

    async def create_room(self, room: str, requested_mode: str, host: dict[str, str]) -> dict[str, Any] | None:
        """Atomically create a room. None means its code already exists."""
        mode = requested_mode if requested_mode in {"whiteboard", "game"} else "whiteboard"
        meta = {"roomId": room, "mode": mode, "hostId": host["id"], "createdAt": int(time.time() * 1000), "status": "lobby"}
        key = self.room_meta_key(room)
        if self.redis:
            if await self.redis.exists(self.key("room", room)):
                return None
            if not await self.redis.set(key, json.dumps(meta), nx=True, ex=ROOM_TTL):
                return None
            return meta
        if room in self.room_configs:
            return None
        self.room_configs[room] = meta
        return meta

    async def board_state(self, room: str, namespace: str = "board") -> list[dict[str, Any]]:
        if self.redis:
            raw = await self.redis.hgetall(self.key(namespace, room))
            return [json.loads(value) for value in raw.values()]
        return list(self.boards.get(f"{namespace}:{room}", {}).values())

    async def get_object(self, room: str, object_id: str, namespace: str = "board") -> dict[str, Any] | None:
        if self.redis:
            raw = await self.redis.hget(self.key(namespace, room), object_id)
            return json.loads(raw) if raw else None
        return self.boards.get(f"{namespace}:{room}", {}).get(object_id)

    async def save_object(self, room: str, obj: dict[str, Any], namespace: str = "board") -> None:
        if self.redis:
            pipe = self.redis.pipeline()
            pipe.hset(self.key(namespace, room), obj["id"], json.dumps(obj))
            pipe.expire(self.key(namespace, room), ROOM_TTL)
            await pipe.execute()
        else:
            self.boards.setdefault(f"{namespace}:{room}", {})[obj["id"]] = obj

    async def delete_object(self, room: str, object_id: str, namespace: str = "board") -> None:
        if self.redis:
            await self.redis.hdel(self.key(namespace, room), object_id)
        self.boards.get(f"{namespace}:{room}", {}).pop(object_id, None)

    async def replace_board(self, room: str, objects: list[dict[str, Any]], namespace: str = "board") -> None:
        if self.redis:
            key = self.key(namespace, room)
            pipe = self.redis.pipeline()
            pipe.delete(key)
            if objects:
                pipe.hset(key, mapping={obj["id"]: json.dumps(obj) for obj in objects})
                pipe.expire(key, ROOM_TTL)
            await pipe.execute()
        self.boards[f"{namespace}:{room}"] = {obj["id"]: obj for obj in objects}

    async def participants(self, room: str) -> list[dict[str, str]]:
        if self.redis:
            raw = await self.redis.hgetall(self.key("presence", room))
            return [json.loads(value) for value in raw.values()]
        return list(self.presence.get(room, {}).values())

    async def set_participant(self, room: str, participant: dict[str, str]) -> None:
        if self.redis:
            pipe = self.redis.pipeline()
            pipe.hset(self.key("presence", room), participant["id"], json.dumps(participant))
            pipe.expire(self.key("presence", room), ROOM_TTL)
            await pipe.execute()
        else:
            self.presence.setdefault(room, {})[participant["id"]] = participant

    async def remove_participant(self, room: str, client_id: str) -> None:
        if self.redis:
            await self.redis.hdel(self.key("presence", room), client_id)
        self.presence.get(room, {}).pop(client_id, None)

    async def seen(self, room: str, operation_id: str) -> bool:
        """Return True only once per operation ID to make reconnect retries safe."""
        if self.redis:
            return bool(await self.redis.set(self.key("op", operation_id), "1", nx=True, ex=ROOM_TTL))
        key = self.key("op", operation_id)
        if hasattr(self, "seen_ops") and key in self.seen_ops:
            return False
        self.seen_ops = getattr(self, "seen_ops", set())
        self.seen_ops.add(key)
        return True


manager = BoardManager()
games = GameService(manager)


def valid_object(raw: Any, user_id: str) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or raw.get("type") not in ALLOWED_TYPES:
        return None
    object_id = str(raw.get("id", ""))
    if not ID_RE.fullmatch(object_id):
        return None
    clean = {key: value for key, value in raw.items() if key in {"id", "type", "x", "y", "w", "h", "points", "text", "style", "z"}}
    clean["id"] = object_id
    clean["userId"] = user_id
    clean["updatedAt"] = int(time.time() * 1000)
    if clean["type"] in {"pen", "highlighter"}:
        points = clean.get("points")
        if not isinstance(points, list) or not 1 <= len(points) <= 700:
            return None
    elif not all(isinstance(clean.get(key), (int, float)) for key in ("x", "y", "w", "h")):
        return None
    if isinstance(clean.get("text"), str):
        clean["text"] = clean["text"][:240]
    return clean


async def send_game_state(socket: WebSocket, room: str, client_id: str, state: dict[str, Any]) -> None:
    await socket.send_json({"type": "game:state", "state": games.public(state, client_id)})
    if client_id == state.get("drawerId"):
        private: dict[str, Any] = {"type": "game:private"}
        if state["status"] == "word_selection":
            private["choices"] = state["wordOptions"]
        elif state["status"] == "drawing":
            private["word"] = state["secretWord"]
        await socket.send_json(private)


async def publish_game(room: str, state: dict[str, Any]) -> None:
    """Publish a secret-free state. Drawer-only data goes over its own socket."""
    await manager.publish(room, {"type": "game:state", "state": games.public(state, "")})
    drawer = state.get("drawerId")
    if drawer:
        private: dict[str, Any] = {"type": "game:private"}
        if state["status"] == "word_selection":
            private["choices"] = state["wordOptions"]
        elif state["status"] == "drawing":
            private["word"] = state["secretWord"]
        await manager.publish_direct(room, drawer, private)


async def game_transition(room: str, client_id: str, message: dict[str, Any]) -> tuple[dict[str, Any] | None, bool]:
    """Apply one trusted game action. Returns (state, reset_game_canvas)."""
    if not await games.acquire(room):
        return None, False
    try:
        state = await games.get(room)
        if not state:
            return None, False
        now = int(time.time() * 1000)
        kind = message.get("type")
        payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
        reset = False
        if kind == "game:guess" and manager.redis:
            # A tiny shared rate limit prevents a rapid guess flood across nodes.
            if not await manager.redis.set(manager.key("guess", f"{room}:{client_id}"), "1", nx=True, ex=1):
                return state, False
        if kind == "game:settings" and state["status"] == "lobby" and client_id == state["hostId"]:
            rounds, duration = payload.get("rounds"), payload.get("duration")
            if isinstance(rounds, int) and 1 <= rounds <= 5:
                state["rounds"] = rounds
            if duration in {30, 45, 60, 90}:
                state["duration"] = duration
        elif kind == "game:start" and state["status"] == "lobby" and client_id == state["hostId"]:
            present = {p["id"]: p for p in await manager.participants(room)}
            # Redis hashes do not promise a useful display order. Start with the
            # host, then use a stable order so the first drawer is predictable.
            host = present.get(state["hostId"])
            others = sorted((p for pid, p in present.items() if pid != state["hostId"]), key=lambda p: (p["name"].casefold(), p["id"]))
            players = ([host] if host else []) + others
            if len(players) < 2:
                return state, False
            state["players"] = players
            state["turnOrder"] = [p["id"] for p in players]
            state["scores"] = {p["id"]: 0 for p in players}
            state["turnNumber"] = 0
            state["chat"] = [{"system": True, "text": "Game started. The first drawer is choosing a word."}]
            games.next_turn(state)
            reset = True
        elif kind == "game:word" and state["status"] == "word_selection" and client_id == state["drawerId"]:
            choice = str(payload.get("word", "")).lower()
            if choice not in state["wordOptions"]:
                return state, False
            state["secretWord"] = choice
            state["status"] = "drawing"
            state["roundStartedAt"] = now
            state["roundPoints"] = []
            state["chat"].append({"system": True, "text": "The drawing round has started."})
        elif kind == "game:guess" and state["status"] == "drawing":
            text = re.sub(r"\s+", " ", str(payload.get("text", "")).strip())[:80]
            if not text or client_id == state["drawerId"] or client_id not in state["turnOrder"] or client_id in state["guessedIds"]:
                return state, False
            player = games.player(state, client_id)
            if not player:
                return state, False
            if text.casefold() == state["secretWord"].casefold():
                remaining = max(0, state["duration"] - (now - state["roundStartedAt"]) / 1000)
                points = max(100, round(500 * remaining / state["duration"]))
                state["scores"][client_id] = state["scores"].get(client_id, 0) + points
                state["guessedIds"].append(client_id)
                state["roundPoints"].append({"id": client_id, "points": points})
                state["chat"].append({"system": True, "text": f"✓ {player['name']} guessed the word!"})
                eligible = [p for p in state["turnOrder"] if p != state["drawerId"]]
                if all(pid in state["guessedIds"] for pid in eligible):
                    games.finish_round(state)
            else:
                state["chat"].append({"name": player["name"], "text": text})
        elif kind == "game:tick":
            if state["status"] == "word_selection" and now >= state["wordChoiceDeadline"]:
                state["secretWord"] = state["wordOptions"][0]
                state["status"] = "drawing"
                state["roundStartedAt"] = now
                state["roundPoints"] = []
            elif state["status"] == "drawing" and now >= state["roundStartedAt"] + state["duration"] * 1000:
                games.finish_round(state)
            elif state["status"] == "round_results" and now >= state["resultEndsAt"]:
                games.next_turn(state)
                reset = state["status"] == "word_selection"
        elif kind == "game:again" and state["status"] == "game_results" and client_id == state["hostId"]:
            state = games.lobby(next(p for p in state["players"] if p["id"] == client_id))
            reset = True
        else:
            return state, False
        await games.save(room, state)
        return state, reset
    finally:
        await games.release(room)


async def save_game_host(room: str, state: dict[str, Any], host_id: str) -> None:
    """Keep the game state and shared room metadata in agreement about its host."""
    state["hostId"] = host_id
    config = await manager.find_room(room)
    if not config:
        return
    config["hostId"] = host_id
    if manager.redis:
        await manager.redis.set(manager.room_meta_key(room), json.dumps(config), ex=ROOM_TTL)
    else:
        manager.room_configs[room] = config


async def reassign_host_after_grace(room: str, departed_id: str) -> None:
    """Avoid treating a browser refresh as a permanent host departure.

    Presence is stored in Redis, so this works even if the reconnect lands on
    the other FastAPI node.  The game lock makes simultaneous leave events safe.
    """
    await asyncio.sleep(HOST_RECONNECT_GRACE_SECONDS)
    if any(player["id"] == departed_id for player in await manager.participants(room)):
        return
    if not await games.acquire(room):
        return
    try:
        state = await games.get(room)
        participants = await manager.participants(room)
        if not state or state.get("hostId") != departed_id or not participants:
            return
        await save_game_host(room, state, participants[0]["id"])
        await games.save(room, state)
        await publish_game(room, state)
        logger.info("%s transferred host of %s after reconnect grace", NODE_ID, room)
    finally:
        await games.release(room)


async def repair_missing_game_host(room: str, state: dict[str, Any] | None) -> dict[str, Any] | None:
    """Promote an available player if everyone left before the grace timer fired."""
    if not state:
        return state
    participants = await manager.participants(room)
    present_ids = {player["id"] for player in participants}
    if state.get("hostId") in present_ids or not participants:
        return state
    if not await games.acquire(room):
        return await games.get(room)
    try:
        state = await games.get(room)
        participants = await manager.participants(room)
        present_ids = {player["id"] for player in participants}
        if state and state.get("hostId") not in present_ids and participants:
            await save_game_host(room, state, participants[0]["id"])
            await games.save(room, state)
            await publish_game(room, state)
        return state
    finally:
        await games.release(room)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await manager.start()
    yield
    await manager.stop()


app = FastAPI(title="CollabDraw", lifespan=lifespan)
ROOT = Path(__file__).resolve().parent.parent


@app.get("/health")
async def health():
    return {"status": "ok", "node": NODE_ID, "redis": manager.redis is not None}


@app.websocket("/ws/{room}")
async def board_socket(websocket: WebSocket, room: str, name: str = "Guest", client_id: str = "", mode: str = "whiteboard", action: str = "join"):
    room = room.upper().strip()
    name = re.sub(r"\s+", " ", name.strip())[:24]
    client_id = client_id if ID_RE.fullmatch(client_id) else uuid.uuid4().hex
    color = ["#635bff", "#0ea5e9", "#10b981", "#f97316", "#ec4899", "#8b5cf6"][sum(map(ord, client_id)) % 6]
    if not ROOM_RE.fullmatch(room) or not name:
        await websocket.close(code=1008)
        return
    participant = {"id": client_id, "name": name, "color": color}
    if action == "create":
        config = await manager.create_room(room, mode, participant)
        if not config:
            await websocket.accept()
            await websocket.send_json({"type": "room:error", "message": f"Room {room} already exists. Join it instead or choose another code."})
            await websocket.close(code=1008)
            return
    elif action == "join":
        config = await manager.find_room(room)
        if not config:
            await websocket.accept()
            await websocket.send_json({"type": "room:error", "message": "Room not found."})
            await websocket.close(code=1008)
            return
    else:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    manager.clients.setdefault(room, {})[client_id] = websocket
    await manager.set_participant(room, participant)
    game_state = None
    if config["mode"] == "game":
        game_state = await games.get(room)
        game_state = await repair_missing_game_host(room, game_state)
        if not game_state:
            if await games.acquire(room):
                try:
                    game_state = await games.get(room)
                    if not game_state:
                        game_state = games.lobby({"id": config["hostId"], "name": name, "color": color})
                        await games.save(room, game_state)
                finally:
                    await games.release(room)
        game_state = await games.get(room)
    namespace = "game-board" if config["mode"] == "game" else "board"
    await websocket.send_json({
        "type": "welcome", "clientId": client_id, "nodeId": NODE_ID,
        "mode": config["mode"], "hostId": config["hostId"],
        "objects": await manager.board_state(room, namespace), "participants": await manager.participants(room),
    })
    if game_state:
        await send_game_state(websocket, room, client_id, game_state)
    await manager.publish(room, {"type": "presence", "action": "joined", "participant": participant, "participants": await manager.participants(room)})
    logger.info("%s accepted %s in room %s", NODE_ID, client_id, room)
    try:
        while True:
            message = await websocket.receive_json()
            kind = message.get("type")
            if config["mode"] == "game" and isinstance(kind, str) and kind.startswith("game:"):
                game_state, reset = await game_transition(room, client_id, message)
                if game_state:
                    if reset:
                        await manager.replace_board(room, [], "game-board")
                        await manager.publish(room, {"type": "operation", "operationId": f"game-reset-{uuid.uuid4().hex}", "eventType": "board:clear", "payload": {}})
                    await publish_game(room, game_state)
                continue
            if kind == "cursor":
                x, y = message.get("x"), message.get("y")
                if isinstance(x, (int, float)) and isinstance(y, (int, float)):
                    await manager.publish(room, {"type": "cursor", "clientId": client_id, "name": name, "color": color, "x": x, "y": y})
                continue
            if kind != "operation" or not ID_RE.fullmatch(str(message.get("operationId", ""))):
                continue
            operation_id = message["operationId"]
            if not await manager.seen(room, operation_id):
                continue
            event_type = message.get("eventType")
            payload = message.get("payload", {})
            event = {"type": "operation", "operationId": operation_id, "eventType": event_type,
                     "roomId": room, "userId": client_id, "timestamp": int(time.time() * 1000), "payload": payload}
            namespace = "board"
            if config["mode"] == "game":
                game_state = await games.get(room)
                if not game_state or game_state.get("status") != "drawing" or game_state.get("drawerId") != client_id:
                    continue
                namespace = "game-board"
            if event_type == "object:create":
                obj = valid_object(payload.get("object"), client_id)
                if config["mode"] == "game" and (not obj or obj.get("type") != "pen"):
                    continue
                if not obj or len(await manager.board_state(room, namespace)) >= MAX_OBJECTS:
                    continue
                await manager.save_object(room, obj, namespace)
                event["payload"] = {"object": obj}
            elif event_type == "object:update":
                obj = valid_object(payload.get("object"), client_id)
                current = await manager.get_object(room, obj["id"] if obj else "", namespace)
                if not obj or not current or current.get("userId") != client_id:
                    continue
                obj["userId"] = client_id
                await manager.save_object(room, obj, namespace)
                event["payload"] = {"object": obj}
            elif event_type == "object:delete":
                object_id = str(payload.get("id", ""))
                current = await manager.get_object(room, object_id, namespace)
                if not ID_RE.fullmatch(object_id) or not current or current.get("userId") != client_id:
                    continue
                await manager.delete_object(room, object_id, namespace)
                event["payload"] = {"id": object_id}
            elif event_type == "board:clear":
                await manager.replace_board(room, [], namespace)
                event["payload"] = {}
            elif event_type == "board:replace":
                if config["mode"] == "game":
                    continue
                raw_objects = payload.get("objects")
                if not isinstance(raw_objects, list) or len(raw_objects) > MAX_OBJECTS:
                    continue
                objects = [valid_object(obj, client_id) for obj in raw_objects]
                if any(obj is None for obj in objects):
                    continue
                await manager.replace_board(room, objects, namespace)
                event["payload"] = {"objects": objects}
            else:
                continue
            await manager.publish(room, event)
    except WebSocketDisconnect:
        pass
    finally:
        # A reconnect can replace this socket for the same stable client ID.
        # Do not remove the newer socket's presence when this older one closes.
        if manager.clients.get(room, {}).get(client_id) is not websocket:
            return
        manager.clients.get(room, {}).pop(client_id, None)
        await manager.remove_participant(room, client_id)
        participants = await manager.participants(room)
        if config["mode"] == "game" and await games.acquire(room):
            try:
                game_state = await games.get(room)
                if game_state:
                    if game_state.get("drawerId") == client_id and game_state.get("status") in {"word_selection", "drawing"}:
                        game_state["chat"].append({"system": True, "text": f"{name} disconnected; the turn was skipped."})
                        game_state["turnNumber"] += 1
                        games.next_turn(game_state)
                        await manager.replace_board(room, [], "game-board")
                    await games.save(room, game_state)
                    await publish_game(room, game_state)
            finally:
                await games.release(room)
        if config["mode"] == "game" and game_state and game_state.get("hostId") == client_id:
            asyncio.create_task(reassign_host_after_grace(room, client_id))
        await manager.publish(room, {"type": "presence", "action": "left", "participant": participant, "participants": participants})
        logger.info("%s disconnected %s from room %s", NODE_ID, client_id, room)


@app.get("/")
async def index():
    return FileResponse(ROOT / "frontend" / "index.html")


@app.get("/{asset_name}")
async def asset(asset_name: str):
    if asset_name in {"app.js", "style.css", "fixes.css"}:
        return FileResponse(ROOT / "frontend" / asset_name)
    return FileResponse(ROOT / "frontend" / "index.html")
