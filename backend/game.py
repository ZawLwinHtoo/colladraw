"""Server-authoritative Draw & Guess state kept in Redis.

This intentionally uses one small JSON document per room.  Redis locks make
state transitions safe when two FastAPI nodes receive events at the same time.
"""
from __future__ import annotations

import asyncio
import random
import time
import uuid
from typing import Any

WORDS = [
    "cat", "dog", "elephant", "giraffe", "dolphin", "penguin", "tiger", "butterfly",
    "pizza", "banana", "coffee", "sandwich", "ice cream", "watermelon", "hamburger", "cake",
    "computer", "keyboard", "robot", "camera", "telephone", "airplane", "bicycle", "backpack",
    "mountain", "rainbow", "volcano", "beach", "forest", "moon", "river", "cloud",
    "football", "tennis", "guitar", "book", "teacher", "school", "library", "castle",
    "laptop", "headphones", "satellite", "rocket", "bridge", "traffic light", "umbrella", "clock",
    "doctor", "firefighter", "astronaut", "pirate", "wizard", "superhero", "train", "bus",
    "flower", "tree", "sun", "snowman", "dragon", "unicorn", "fish", "turtle",
    "pencil", "scissors", "glasses", "shoe", "hat", "watch", "chair", "lamp",
    "planet", "star", "ocean", "desert", "island", "jungle", "waterfall", "cave",
    "chocolate", "strawberry", "noodles", "cookies", "lemon", "orange", "mango", "bread",
    "tablet", "mouse", "printer", "wifi", "battery", "drone", "gamepad", "microphone",
    "basketball", "swimming", "skateboard", "medal", "stadium", "snowboard", "baseball", "boxing",
]
ALLOWED_DURATIONS = {30, 45, 60, 90}


class GameService:
    def __init__(self, manager: Any) -> None:
        self.manager = manager
        self.memory: dict[str, dict[str, Any]] = {}
        self.local_locks: dict[str, asyncio.Lock] = {}

    def key(self, room: str) -> str:
        return self.manager.key("game", room)

    async def get(self, room: str) -> dict[str, Any] | None:
        if self.manager.redis:
            raw = await self.manager.redis.get(self.key(room))
            return __import__("json").loads(raw) if raw else None
        return self.memory.get(room)

    async def save(self, room: str, state: dict[str, Any]) -> None:
        state["updatedAt"] = int(time.time() * 1000)
        if self.manager.redis:
            await self.manager.redis.set(self.key(room), __import__("json").dumps(state), ex=self.manager.room_ttl)
        else:
            self.memory[room] = state

    async def acquire(self, room: str) -> bool:
        if self.manager.redis:
            return bool(await self.manager.redis.set(self.manager.key("game-lock", room), uuid.uuid4().hex, nx=True, ex=3))
        lock = self.local_locks.setdefault(room, asyncio.Lock())
        if lock.locked():
            return False
        await lock.acquire()
        return True

    async def release(self, room: str) -> None:
        if self.manager.redis:
            await self.manager.redis.delete(self.manager.key("game-lock", room))
        else:
            lock = self.local_locks.get(room)
            if lock and lock.locked():
                lock.release()

    def lobby(self, host: dict[str, str]) -> dict[str, Any]:
        return {
            "mode": "game", "status": "lobby", "hostId": host["id"], "players": [],
            "rounds": 2, "duration": 60, "turnOrder": [], "turnNumber": 0,
            "drawerId": "", "wordOptions": [], "secretWord": "", "roundStartedAt": 0,
            "wordChoiceDeadline": 0, "guessedIds": [], "scores": {}, "chat": [],
            "results": [], "resultEndsAt": 0,
        }

    def public(self, state: dict[str, Any], viewer_id: str) -> dict[str, Any]:
        """Never include secretWord/options in a room-wide payload."""
        word = state.get("secretWord", "")
        drawer = viewer_id == state.get("drawerId")
        hint = self.hint(word, state) if word else ""
        return {
            "mode": "game", "status": state["status"], "hostId": state["hostId"],
            "players": state["players"], "rounds": state["rounds"], "duration": state["duration"],
            "turnNumber": state["turnNumber"], "turnTotal": len(state["turnOrder"]) * state["rounds"],
            "turnOrder": state["turnOrder"],
            "drawerId": state["drawerId"], "roundStartedAt": state["roundStartedAt"],
            "wordChoiceDeadline": state["wordChoiceDeadline"], "guessedIds": state["guessedIds"],
            "scores": state["scores"], "chat": state["chat"][-40:], "results": state["results"],
            "resultEndsAt": state["resultEndsAt"], "wordHint": word if drawer else hint,
            "wordLength": len(word),
        }

    def hint(self, word: str, state: dict[str, Any]) -> str:
        if not word:
            return ""
        remaining = max(0, state["duration"] - (time.time() * 1000 - state["roundStartedAt"]) / 1000)
        reveal = 0 if remaining > state["duration"] / 2 else 1 if remaining > 15 else 2
        letters = [i for i, char in enumerate(word) if char.isalpha()]
        shown = set(letters[:reveal])
        return " ".join(char.upper() if i in shown else "_" if char.isalpha() else char for i, char in enumerate(word))

    def choose_words(self) -> list[str]:
        return random.sample(WORDS, 3)

    def player(self, state: dict[str, Any], client_id: str) -> dict[str, Any] | None:
        return next((p for p in state["players"] if p["id"] == client_id), None)

    def next_turn(self, state: dict[str, Any]) -> bool:
        if state["turnNumber"] >= len(state["turnOrder"]) * state["rounds"]:
            state["status"] = "game_results"
            state["drawerId"] = ""
            state["secretWord"] = ""
            return False
        state["drawerId"] = state["turnOrder"][state["turnNumber"] % len(state["turnOrder"])]
        state["status"] = "word_selection"
        state["secretWord"] = ""
        state["wordOptions"] = self.choose_words()
        state["guessedIds"] = []
        state["roundStartedAt"] = 0
        state["wordChoiceDeadline"] = int(time.time() * 1000) + 10_000
        state["results"] = []
        state["resultEndsAt"] = 0
        return True

    def finish_round(self, state: dict[str, Any]) -> None:
        answer = state["secretWord"]
        state["results"] = state.get("roundPoints", [])
        state["results"].append({"id": state["drawerId"], "points": 50 * len(state["guessedIds"]), "drawer": True})
        state["scores"][state["drawerId"]] = state["scores"].get(state["drawerId"], 0) + 50 * len(state["guessedIds"])
        state["chat"].append({"system": True, "text": f"Round over — the word was {answer.upper()}."})
        state["status"] = "round_results"
        state["resultEndsAt"] = int(time.time() * 1000) + 5_000
        state["turnNumber"] += 1
        state["secretWord"] = ""
        state["wordOptions"] = []
