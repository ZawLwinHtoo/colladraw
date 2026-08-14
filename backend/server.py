import asyncio
import json
import logging
import os
import random
import string
from contextlib import asynccontextmanager
from typing import Dict, List, Optional, Set

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


try:
    import redis.asyncio as aioredis
    HAS_REDIS = True
except ImportError:
    aioredis = None
    HAS_REDIS = False

# Logging Configuration
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("whiteboard-server")

# Environment & Server Config
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
NODE_ID = os.getenv("NODE_ID", f"node-{os.getpid()}")
REDIS_CHANNEL = "whiteboard_events"


class ConnectionManager:
    """Manages local WebSockets and Redis Pub/Sub multi-node broadcasting."""

    def __init__(self):
        # room_id -> { client_id -> { "ws": WebSocket, "name": str, "color": str } }
        self.local_rooms: Dict[str, Dict[str, dict]] = {}
        # Standalone in-memory fallback for drawing history when Redis is unavailable
        self.local_history: Dict[str, List[dict]] = {}
        # Game mode session state: room_id -> game_session_dict
        self.game_sessions: Dict[str, dict] = {}
        # Real-time multi-node cluster user roster: room_id -> { client_id -> user_dict }
        self.cluster_user_rosters: Dict[str, Dict[str, dict]] = {}
        # Room session status tracking: room_id -> 'lobby' | 'in_progress'
        self.room_sessions: Dict[str, str] = {}
        self.embedded_broker = None

        # Party Game Prompts Pool
        self.game_prompts = [
            "An Astronaut Riding a Bicycle on Mars",
            "A Dragon Eating a Pepperoni Pizza",
            "A Robot Dancing in the Rain with an Umbrella",
            "A Cat Driving a Sports Car on the Highway",
            "A Superhero Flying over a City of Ice Cream",
            "A Pirate Ship Sailing through a Rainbow",
            "A Penguin Surfing on a Volcanic Lava Wave",
            "A Giant Hamster Building a Futuristic Skyscraper"
        ]

    async def init_redis(self):
        """Initializes async Redis client and starts Pub/Sub subscriber listener loop."""
        if not HAS_REDIS:
            logger.warning(
                f"[{NODE_ID}] 'redis' library not installed. Running in standalone in-memory mode."
            )
            self.redis = None
            return

        # Attempt 1: Try connecting to an already running Redis server
        try:
            self.redis = aioredis.from_url(
                f"redis://{REDIS_HOST}:{REDIS_PORT}",
                protocol=2,
                socket_connect_timeout=1.0,
                socket_timeout=2.0,
                decode_responses=True,
            )
            await self.redis.ping()
            logger.info(
                f"[{NODE_ID}] Successfully connected to Redis at {REDIS_HOST}:{REDIS_PORT}"
            )
            self.pubsub_task = asyncio.create_task(self.listen_redis_pubsub())
            return
        except Exception:
            pass

        # Attempt 2: Auto-start embedded pure-Python Redis Broker if port 6379 is free
        try:
            from backend.redis_broker import MinimalRedisBroker
            self.embedded_broker = MinimalRedisBroker(host=REDIS_HOST, port=REDIS_PORT)
            started = await self.embedded_broker.start()
            if started:
                logger.info(
                    f"[{NODE_ID}] Started embedded Python Redis Broker on {REDIS_HOST}:{REDIS_PORT}"
                )
                await asyncio.sleep(0.1)

            self.redis = aioredis.from_url(
                f"redis://{REDIS_HOST}:{REDIS_PORT}",
                protocol=2,
                socket_connect_timeout=2.0,
                socket_timeout=2.0,
                decode_responses=True,
            )
            await self.redis.ping()
            logger.info(
                f"[{NODE_ID}] Connected to Redis broker at {REDIS_HOST}:{REDIS_PORT}"
            )
            self.pubsub_task = asyncio.create_task(self.listen_redis_pubsub())
        except Exception as e:
            logger.warning(
                f"[{NODE_ID}] Could not connect to Redis ({e}). Running in standalone mode."
            )
            self.redis = None

    async def close_redis(self):
        """Cleanly cancels Pub/Sub background listener and closes Redis client."""
        if self.pubsub_task:
            self.pubsub_task.cancel()
            try:
                await self.pubsub_task
            except (asyncio.CancelledError, Exception):
                pass
            self.pubsub_task = None

        if self.redis:
            try:
                await self.redis.close()
            except Exception:
                pass
            self.redis = None
            logger.info(f"[{NODE_ID}] Redis connection closed.")

        if self.embedded_broker:
            try:
                await self.embedded_broker.stop()
            except Exception:
                pass
            self.embedded_broker = None

    async def publish_event(
        self, room_id: str, data: dict, exclude_client_id: Optional[str] = None
    ):
        """Publishes action event to local clients and Redis Pub/Sub for multi-node distribution."""
        payload = {
            "room_id": room_id,
            "sender_node": NODE_ID,
            "exclude_client_id": exclude_client_id,
            "data": data,
        }

        # Deliver to local clients connected on THIS server node immediately
        await self.broadcast_local(room_id, data, exclude_client_id)

        # Publish to Redis Pub/Sub for other cluster nodes
        if self.redis:
            try:
                receivers = await self.redis.publish(REDIS_CHANNEL, json.dumps(payload))
                logger.info(f"[{NODE_ID}] Published '{data.get('type')}' for room '{room_id}' to Redis channel. Receivers: {receivers}")
            except Exception as e:
                logger.error(f"[{NODE_ID}] Error publishing to Redis: {e}")

    async def listen_redis_pubsub(self):
        """Background task subscribing to Redis Pub/Sub channel to handle cross-node events."""
        if not self.redis:
            return

        pubsub = self.redis.pubsub()
        try:
            await pubsub.subscribe(REDIS_CHANNEL)
            logger.info(f"[{NODE_ID}] Subscribed to Redis channel '{REDIS_CHANNEL}'")

            async for message in pubsub.listen():
                if message["type"] == "message":
                    try:
                        raw_data = message["data"]
                        event = json.loads(raw_data)

                        # Avoid duplicate delivery for messages published by this exact node
                        if event.get("sender_node") == NODE_ID:
                            continue

                        room_id = event.get("room_id")
                        exclude_client_id = event.get("exclude_client_id")
                        data = event.get("data")

                        logger.info(f"[{NODE_ID}] Received Redis Pub/Sub event '{data.get('type') if isinstance(data, dict) else 'raw'}' from {event.get('sender_node')} for room '{room_id}'")

                        # Deliver to local clients connected on this node
                        if data and isinstance(data, dict):
                            if data.get("type") == "user_presence_join":
                                u_info = data.get("user")
                                if u_info and room_id:
                                    if room_id not in self.cluster_user_rosters:
                                        self.cluster_user_rosters[room_id] = {}
                                    self.cluster_user_rosters[room_id][u_info["client_id"]] = u_info
                            elif data.get("type") in ["turn_start", "game_reveal", "voting_start", "voting_results", "sync_game_session"] or "game_session" in data:
                                session_data = data.get("game_session")
                                if session_data and isinstance(session_data, dict) and room_id:
                                    clean_data = {k: v for k, v in session_data.items() if k != "timer_task"}
                                    if room_id in self.game_sessions and "timer_task" in self.game_sessions[room_id]:
                                        clean_data["timer_task"] = self.game_sessions[room_id]["timer_task"]
                                    self.game_sessions[room_id] = clean_data

                        await self.broadcast_local(
                            room_id, data, exclude_client_id=exclude_client_id
                        )
                    except Exception as e:
                        logger.error(f"[{NODE_ID}] Error processing Redis message: {e}")
        except asyncio.CancelledError:
            logger.info(f"[{NODE_ID}] Redis Pub/Sub listener task cancelled.")
        except Exception as e:
            logger.error(f"[{NODE_ID}] Redis Pub/Sub loop error: {e}")
        finally:
            try:
                await pubsub.unsubscribe(REDIS_CHANNEL)
                await pubsub.close()
            except Exception:
                pass

    async def broadcast_local(
        self, room_id: str, data: dict, exclude_client_id: Optional[str] = None
    ):
        """Delivers WebSocket JSON message to local clients connected to this server node."""
        if not room_id:
            return

        target_room_key = None
        for k in self.local_rooms.keys():
            if k.upper() == room_id.upper():
                target_room_key = k
                break

        if not target_room_key:
            logger.info(f"[{NODE_ID}] broadcast_local: room '{room_id}' not in local_rooms (active rooms: {list(self.local_rooms.keys())})")
            return

        message = json.dumps(data)
        disconnected = []

        for cid, client in list(self.local_rooms[target_room_key].items()):
            if exclude_client_id and cid == exclude_client_id:
                continue

            try:
                await client["ws"].send_text(message)
                logger.info(f"[{NODE_ID}] Delivered '{data.get('type')}' to local client '{cid}' ({client.get('name')}) in room '{target_room_key}'")
            except Exception as e:
                logger.error(f"[{NODE_ID}] Error sending to local client {cid}: {e}")
                disconnected.append(cid)

        for cid in disconnected:
            await self.disconnect(target_room_key, cid)

    async def set_room_session_status(self, room_id: str, status: str):
        """Sets room session status ('lobby' vs 'in_progress') in local memory and Redis."""
        self.room_sessions[room_id] = status
        if self.redis:
            try:
                await self.redis.set(f"session_status:{room_id}", status)
            except Exception as e:
                logger.warning(f"[{NODE_ID}] Error setting session status in Redis: {e}")

    async def is_room_in_progress(self, room_id: str) -> bool:
        """Checks if room session is already in progress across cluster."""
        if self.room_sessions.get(room_id) == "in_progress":
            return True
        if self.redis:
            try:
                val = await self.redis.get(f"session_status:{room_id}")
                if val == "in_progress":
                    self.room_sessions[room_id] = "in_progress"
                    return True
            except Exception as e:
                logger.warning(f"[{NODE_ID}] Error reading session status from Redis: {e}")
        return False

    async def get_room_history(self, room_id: str) -> List[dict]:
        """Fetches room drawing action history from Redis (or local memory)."""
        if self.redis:
            try:
                raw_history = await self.redis.lrange(f"history:{room_id}", 0, -1)
                return [json.loads(item) for item in raw_history]
            except Exception as e:
                logger.error(f"[{NODE_ID}] Error fetching history from Redis: {e}")
        
    async def get_active_users(self, room_id: str) -> List[dict]:
        """Fetches active cluster users by merging local memory, cluster roster, and Redis hash."""
        users_by_id = {}

        # 1. Local rooms on this node
        if room_id in self.local_rooms:
            for cid, info in self.local_rooms[room_id].items():
                users_by_id[cid] = {"client_id": cid, "name": info["name"], "color": info["color"]}

        # 2. Cluster user roster cache
        if room_id in self.cluster_user_rosters:
            for cid, u in self.cluster_user_rosters[room_id].items():
                users_by_id[cid] = u

        # 3. Redis hash lookup (authoritative source across all nodes)
        if self.redis:
            try:
                raw_dict = await asyncio.wait_for(self.redis.hgetall(f"users:{room_id}"), timeout=0.5)
                if raw_dict:
                    for cid, raw_val in raw_dict.items():
                        cid_str = cid.decode() if isinstance(cid, bytes) else str(cid)
                        val_str = raw_val.decode() if isinstance(raw_val, bytes) else str(raw_val)
                        u_obj = json.loads(val_str)
                        users_by_id[cid_str] = u_obj
            except Exception as e:
                logger.warning(f"[{NODE_ID}] Non-critical Redis user fetch timeout: {e}")

        return list(users_by_id.values())

    async def add_history_action(self, room_id: str, action: dict):
        """Appends drawing action to shared Redis room history (or local memory)."""
        if self.redis:
            try:
                await self.redis.rpush(f"history:{room_id}", json.dumps(action))
            except Exception as e:
                logger.error(f"[{NODE_ID}] Error saving history to Redis: {e}")
        
        if room_id not in self.local_history:
            self.local_history[room_id] = []
        self.local_history[room_id].append(action)

    async def clear_room_history(self, room_id: str):
        """Clears drawing history for specified room in Redis and local memory."""
        if self.redis:
            try:
                await self.redis.delete(f"history:{room_id}")
            except Exception as e:
                logger.error(f"[{NODE_ID}] Error clearing history in Redis: {e}")
        
        self.local_history[room_id] = []

    async def undo_last_action(self, room_id: str, client_id: str) -> bool:
        """Removes the last action by client from Redis history and local memory."""
        undone = False
        if self.redis:
            try:
                raw_history = await self.redis.lrange(f"history:{room_id}", 0, -1)
                history = [json.loads(item) for item in raw_history]

                # Find last action by client
                for i in range(len(history) - 1, -1, -1):
                    if history[i].get("client_id") == client_id:
                        history.pop(i)
                        undone = True
                        # Re-save updated history
                        await self.redis.delete(f"history:{room_id}")
                        if history:
                            await self.redis.rpush(
                                f"history:{room_id}",
                                *[json.dumps(a) for a in history],
                            )
                        break
            except Exception as e:
                logger.error(f"[{NODE_ID}] Error performing undo in Redis: {e}")

        if room_id in self.local_history and self.local_history[room_id]:
            for i in range(len(self.local_history[room_id]) - 1, -1, -1):
                if self.local_history[room_id][i].get("client_id") == client_id:
                    self.local_history[room_id].pop(i)
                    undone = True
                    break

        return undone

    def generate_room_code(self) -> str:
        """Generates a random 6-character uppercase alphanumeric code like X7K9P2."""
        chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        return "".join(random.choices(chars, k=6))

    async def save_game_session(self, room_id: str, session: dict):
        """Saves game session to local memory instantly and syncs with Redis without blocking."""
        session_to_save = {k: v for k, v in session.items() if k != "timer_task"}
        self.game_sessions[room_id] = session
        if self.redis:
            try:
                await asyncio.wait_for(
                    self.redis.set(f"game_session:{room_id}", json.dumps(session_to_save)),
                    timeout=0.5
                )
            except Exception as e:
                logger.warning(f"[{NODE_ID}] Non-critical Redis session save timeout: {e}")

    async def get_game_session(self, room_id: str) -> Optional[dict]:
        """Retrieves game session from local memory first, or Redis with strict timeout."""
        if room_id in self.game_sessions and self.game_sessions[room_id]:
            return self.game_sessions[room_id]

        if self.redis:
            try:
                raw = await asyncio.wait_for(self.redis.get(f"game_session:{room_id}"), timeout=0.5)
                if raw:
                    session = json.loads(raw)
                    self.game_sessions[room_id] = session
                    return session
            except Exception as e:
                logger.warning(f"[{NODE_ID}] Non-critical Redis session fetch timeout: {e}")
        return self.game_sessions.get(room_id)

    async def update_lobby_settings(self, room_id: str, client_id: str, timer: int, mode: str):
        """Updates lobby round timer and visibility mode, saving to Redis and broadcasting across cluster."""
        session = await self.get_game_session(room_id)
        if not session:
            session = {
                "room_code": room_id,
                "status": "lobby",
                "host_client_id": client_id,
                "players": [],
                "prompt": "",
                "current_turn_index": 0,
                "total_turns": 1,
                "turn_timer": timer,
                "visibility_mode": mode,
                "timer_task": None,
                "layers": {}
            }

        session["turn_timer"] = timer
        session["visibility_mode"] = mode
        await self.save_game_session(room_id, session)

        session_to_save = {k: v for k, v in session.items() if k != "timer_task"}
        payload = {
            "type": "lobby_settings_updated",
            "room_code": room_id,
            "turn_timer": timer,
            "visibility_mode": mode,
            "game_session": session_to_save
        }
        await self.publish_event(room_id, payload, exclude_client_id=None)

    async def start_game_loop(self, room_id: str, host_client_id: str, turn_timer: int = 45, visibility_mode: str = "blur"):
        """Starts Blind Chain Draw party game loop for the specified room."""
        cluster_users = await self.get_active_users(room_id)
        if cluster_users:
            players = cluster_users
        elif room_id in self.local_rooms and self.local_rooms[room_id]:
            players = [
                {
                    "client_id": cid,
                    "name": info["name"],
                    "color": info["color"],
                    "role": info.get("role", "Editor"),
                    "is_host": info.get("is_host", False)
                }
                for cid, info in self.local_rooms[room_id].items()
            ]

        if not players:
            return

        prompt = random.choice(self.game_prompts)
        
        session = {
            "room_code": room_id,
            "status": "playing",
            "host_client_id": host_client_id,
            "players": players,
            "prompt": prompt,
            "current_turn_index": 0,
            "total_turns": len(players),
            "turn_timer": turn_timer,
            "visibility_mode": visibility_mode,
            "timer_task": None,
            "layers": {str(i): [] for i in range(len(players))}
        }
        await self.save_game_session(room_id, session)

        # Notify clients and start first turn
        await self.advance_turn(room_id, turn_index=0)

    async def advance_turn(self, room_id: str, turn_index: int):
        """Advances turn to turn_index or triggers reveal if all turns complete."""
        session = await self.get_game_session(room_id)
        if not session:
            return

        if session.get("timer_task"):
            try:
                session["timer_task"].cancel()
            except Exception:
                pass

        total = session["total_turns"]
        session_to_save = {k: v for k, v in session.items() if k != "timer_task"}
        if turn_index >= total:
            # Game Over / Reveal Phase
            session["status"] = "reveal"
            await self.save_game_session(room_id, session)

            reveal_payload = {
                "type": "game_reveal",
                "room_code": room_id,
                "prompt": session["prompt"],
                "players": session["players"],
                "all_layers": session["layers"],
                "game_session": session_to_save
            }
            await self.publish_event(room_id, reveal_payload, exclude_client_id=None)
            return

        session["current_turn_index"] = turn_index
        await self.save_game_session(room_id, session)

        active_player = session["players"][turn_index]

        session_to_save = {k: v for k, v in session.items() if k != "timer_task"}
        turn_payload = {
            "type": "turn_start",
            "room_code": room_id,
            "turn_index": turn_index,
            "total_turns": total,
            "active_player": active_player,
            "prompt": session["prompt"],
            "time_left": session["turn_timer"],
            "game_session": session_to_save,
            "previous_layers": {
                str(k): v for k, v in session["layers"].items() if int(k) < turn_index
            }
        }

        await self.publish_event(room_id, turn_payload, exclude_client_id=None)

        # Start countdown timer task
        session["timer_task"] = asyncio.create_task(
            self.run_turn_timer(room_id, turn_index, session["turn_timer"])
        )
        self.game_sessions[room_id] = session

    async def run_turn_timer(self, room_id: str, turn_index: int, seconds: int):
        """Background countdown task broadcasting timer ticks per second."""
        try:
            for remaining in range(seconds, -1, -1):
                await asyncio.sleep(1)
                session = await self.get_game_session(room_id)
                if not session or session.get("current_turn_index") != turn_index or session.get("status") != "playing":
                    return

                timer_payload = {
                    "type": "timer_tick",
                    "time_left": remaining,
                    "turn_index": turn_index
                }
                await self.publish_event(room_id, timer_payload, exclude_client_id=None)

            # Timer expired -> Auto-advance turn!
            await self.advance_turn(room_id, turn_index + 1)
        except asyncio.CancelledError:
            pass

    async def start_voting_phase(self, room_id: str):
        """Starts 15-second voting phase for category awards."""
        session = await self.get_game_session(room_id)
        if not session:
            return

        if session.get("timer_task"):
            try:
                session["timer_task"].cancel()
            except Exception:
                pass

        session["status"] = "voting"
        session["votes"] = {}
        await self.save_game_session(room_id, session)

        if self.redis:
            try:
                await self.redis.delete(f"game:votes:{room_id}")
            except Exception:
                pass

        session_to_save = {k: v for k, v in session.items() if k != "timer_task"}
        voting_payload = {
            "type": "voting_start",
            "room_code": room_id,
            "prompt": session["prompt"],
            "players": session["players"],
            "time_left": 15,
            "game_session": session_to_save
        }

        await self.publish_event(room_id, voting_payload, exclude_client_id=None)

        # Start 15-second countdown task for voting
        session["timer_task"] = asyncio.create_task(
            self.run_voting_timer(room_id, 15)
        )
        self.game_sessions[room_id] = session

    async def run_voting_timer(self, room_id: str, seconds: int):
        """Countdown task for voting phase."""
        try:
            for remaining in range(seconds, -1, -1):
                await asyncio.sleep(1)
                session = await self.get_game_session(room_id)
                if not session or session.get("status") != "voting":
                    return

                tick_payload = {
                    "type": "voting_timer_tick",
                    "time_left": remaining
                }
                await self.publish_event(room_id, tick_payload, exclude_client_id=None)

            # Voting timer expired -> Aggregate results automatically!
            await self.aggregate_voting_results(room_id)
        except asyncio.CancelledError:
            pass

    async def process_vote(self, room_id: str, voter_cid: str, vote_data: dict):
        """Processes incoming player vote for award categories."""
        session = await self.get_game_session(room_id)
        if not session or session.get("status") != "voting":
            return

        # Prevent self-voting
        best_creative = vote_data.get("best_creative")
        most_chaotic = vote_data.get("most_chaotic")

        if best_creative == voter_cid:
            best_creative = None
        if most_chaotic == voter_cid:
            most_chaotic = None

        voter_record = {
            "best_creative": best_creative,
            "most_chaotic": most_chaotic
        }

        if "votes" not in session:
            session["votes"] = {}
        session["votes"][voter_cid] = voter_record

        if self.redis:
            try:
                await asyncio.wait_for(
                    self.redis.hset(f"game:votes:{room_id}", voter_cid, json.dumps(voter_record)),
                    timeout=0.5
                )
            except Exception as e:
                logger.warning(f"[{NODE_ID}] Non-critical Redis vote write timeout: {e}")

        await self.save_game_session(room_id, session)

        active_users = await self.get_active_users(room_id)
        voted_count = len(session["votes"])
        total_players = len(active_users)

        progress_payload = {
            "type": "vote_progress",
            "voted_count": voted_count,
            "total_players": total_players
        }
        await self.publish_event(room_id, progress_payload, exclude_client_id=None)

        # If all active players submitted their votes, aggregate immediately!
        if voted_count >= total_players and total_players > 0:
            await self.aggregate_voting_results(room_id)

    async def aggregate_voting_results(self, room_id: str):
        """Aggregates votes and determines category winners."""
        session = await self.get_game_session(room_id)
        if not session or session.get("status") != "voting":
            return

        if session.get("timer_task"):
            try:
                session["timer_task"].cancel()
            except Exception:
                pass

        session["status"] = "ceremony"

        votes = session.get("votes", {})
        if self.redis:
            try:
                raw_dict = await asyncio.wait_for(self.redis.hgetall(f"game:votes:{room_id}"), timeout=0.5)
                if raw_dict:
                    for cid_bytes, raw_val in raw_dict.items():
                        cid_str = cid_bytes.decode() if isinstance(cid_bytes, bytes) else str(cid_bytes)
                        val_str = raw_val.decode() if isinstance(raw_val, bytes) else str(raw_val)
                        votes[cid_str] = json.loads(val_str)
            except Exception as e:
                logger.warning(f"[{NODE_ID}] Non-critical Redis votes fetch timeout: {e}")

        # Calculate vote totals per category
        creative_tally: Dict[str, int] = {}
        chaotic_tally: Dict[str, int] = {}

        players = session.get("players", [])
        for p in players:
            cid = p.get("client_id")
            creative_tally[cid] = 0
            chaotic_tally[cid] = 0

        for voter_cid, vote_rec in votes.items():
            b_c = vote_rec.get("best_creative")
            m_c = vote_rec.get("most_chaotic")
            if b_c and b_c in creative_tally:
                creative_tally[b_c] += 1
            if m_c and m_c in chaotic_tally:
                chaotic_tally[m_c] += 1

        # Determine winners
        best_creative_winner = None
        best_creative_votes = -1
        for p in players:
            cid = p.get("client_id")
            count = creative_tally.get(cid, 0)
            if count > best_creative_votes:
                best_creative_votes = count
                best_creative_winner = p

        most_chaotic_winner = None
        most_chaotic_votes = -1
        for p in players:
            cid = p.get("client_id")
            count = chaotic_tally.get(cid, 0)
            if count > most_chaotic_votes:
                most_chaotic_votes = count
                most_chaotic_winner = p

        # Fallbacks if no votes cast
        if not best_creative_winner and players:
            best_creative_winner = players[0]
            best_creative_votes = 0
        if not most_chaotic_winner and players:
            most_chaotic_winner = players[-1] if len(players) > 1 else players[0]
            most_chaotic_votes = 0

        winners_summary = {
            "best_creative": {
                "player": best_creative_winner,
                "votes": max(0, best_creative_votes)
            },
            "most_chaotic": {
                "player": most_chaotic_winner,
                "votes": max(0, most_chaotic_votes)
            }
        }

        session["winners"] = winners_summary
        await self.save_game_session(room_id, session)

        session_to_save = {k: v for k, v in session.items() if k != "timer_task"}
        results_payload = {
            "type": "voting_results",
            "room_code": room_id,
            "prompt": session["prompt"],
            "players": session["players"],
            "all_layers": session["layers"],
            "winners": winners_summary,
            "game_session": session_to_save
        }

        await self.publish_event(room_id, results_payload, exclude_client_id=None)

    async def connect(
        self, websocket: WebSocket, room_id: str, client_id: str, name: str, color: str
    ):
        """Accepts local WebSocket connection and registers client in cluster."""
        await websocket.accept()

        existing_users = await self.get_active_users(room_id)
        is_existing_user = any(u.get("client_id") == client_id for u in existing_users)
        in_progress = await self.is_room_in_progress(room_id)

        if in_progress and not is_existing_user:
            logger.info(f"[{NODE_ID}] Rejecting late joiner '{name}' ({client_id}) - session for room '{room_id}' is already in progress.")
            reject_payload = {
                "type": "session_in_progress",
                "room_id": room_id,
                "error": "Room session is already in progress. New participants cannot join an active session."
            }
            await websocket.send_text(json.dumps(reject_payload))
            await websocket.close(code=4001, reason="Session already in progress")
            return

        if room_id not in self.local_rooms:
            self.local_rooms[room_id] = {}

        # Determine participant role based on existing cluster user roster
        existing_users = await self.get_active_users(room_id)
        has_host = any(u.get("is_host") or u.get("role") == "Host" for u in existing_users)

        role = "Host" if not has_host else "Editor"
        is_host = (role == "Host")
        can_draw = True

        self.local_rooms[room_id][client_id] = {
            "ws": websocket,
            "name": name,
            "color": color,
            "role": role,
            "is_host": is_host,
            "can_draw": can_draw,
        }

        user_info = {
            "client_id": client_id,
            "name": name,
            "color": color,
            "role": role,
            "is_host": is_host,
            "can_draw": can_draw,
        }

        if room_id not in self.cluster_user_rosters:
            self.cluster_user_rosters[room_id] = {}
        self.cluster_user_rosters[room_id][client_id] = user_info

        # Update cluster user roster in Redis
        if self.redis:
            try:
                await asyncio.wait_for(
                    self.redis.hset(f"users:{room_id}", client_id, json.dumps(user_info)),
                    timeout=0.5
                )
            except Exception as e:
                logger.warning(f"[{NODE_ID}] Non-critical Redis user register timeout: {e}")

        # Broadcast user presence join across cluster
        await self.publish_event(room_id, {
            "type": "user_presence_join",
            "room_id": room_id,
            "user": user_info
        }, exclude_client_id=client_id)

        logger.info(
            f"[{NODE_ID}] Client '{name}' ({client_id}, role={role}) connected to room '{room_id}'"
        )

        # Send initial state (history + user roster) to newly connected client
        history = await self.get_room_history(room_id)
        user_list = await self.get_active_users(room_id)

        init_payload = {
            "type": "init",
            "client_id": client_id,
            "room_id": room_id,
            "history": history,
            "users": user_list,
            "role": role,
            "is_host": is_host,
        }
        await websocket.send_text(json.dumps(init_payload))

        # Broadcast 'user_joined' across all cluster nodes via Redis
        user_joined_payload = {
            "type": "user_joined",
            "client_id": client_id,
            "name": name,
            "color": color,
            "role": role,
            "is_host": is_host,
            "users": user_list,
        }
        await self.publish_event(
            room_id, user_joined_payload, exclude_client_id=client_id
        )

    async def disconnect(self, room_id: str, client_id: str):
        """Handles client disconnection and updates cluster roster with host auto-promotion."""
        if room_id in self.local_rooms and client_id in self.local_rooms[room_id]:
            user_info = self.local_rooms[room_id].pop(client_id)
            if not self.local_rooms[room_id]:
                del self.local_rooms[room_id]

            if room_id in self.cluster_user_rosters and client_id in self.cluster_user_rosters[room_id]:
                del self.cluster_user_rosters[room_id][client_id]

            logger.info(
                f"[{NODE_ID}] Client '{user_info['name']}' ({client_id}) disconnected from room '{room_id}'"
            )

            # Remove from Redis user roster
            if self.redis:
                try:
                    await self.redis.hdel(f"users:{room_id}", client_id)
                except Exception as e:
                    logger.error(f"[{NODE_ID}] Error removing user from Redis: {e}")

            user_list = await self.get_active_users(room_id)
            if not user_list:
                await self.set_room_session_status(room_id, "lobby")

            # Host disconnect check & auto-promotion
            if user_info.get("is_host") or user_info.get("role") == "Host":
                has_host = any(u.get("is_host") or u.get("role") == "Host" for u in user_list)
                if not has_host and user_list:
                    new_host = user_list[0]
                    new_host["role"] = "Host"
                    new_host["is_host"] = True
                    new_host["can_draw"] = True
                    if room_id in self.cluster_user_rosters and new_host["client_id"] in self.cluster_user_rosters[room_id]:
                        self.cluster_user_rosters[room_id][new_host["client_id"]] = new_host
                    if self.redis:
                        try:
                            await self.redis.hset(f"users:{room_id}", new_host["client_id"], json.dumps(new_host))
                        except Exception as e:
                            logger.error(f"[{NODE_ID}] Error updating promoted host in Redis: {e}")
                    user_list = await self.get_active_users(room_id)
                    await self.publish_event(room_id, {
                        "type": "role_changed",
                        "host_client_id": new_host["client_id"],
                        "users": user_list
                    })

            user_left_payload = {
                "type": "user_left",
                "client_id": client_id,
                "name": user_info["name"],
                "users": user_list,
            }
            await self.publish_event(room_id, user_left_payload)


manager = ConnectionManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan context manager for Redis connection management."""
    await manager.init_redis()
    yield
    await manager.close_redis()


app = FastAPI(
    title="Distributed Collaborative Whiteboard API", lifespan=lifespan
)

# Enable CORS for cross-origin frontend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check():
    redis_online = False
    if manager.redis:
        try:
            redis_online = await manager.redis.ping()
        except Exception:
            redis_online = False

    return {
        "status": "online",
        "node_id": NODE_ID,
        "redis_connected": redis_online,
        "local_rooms": len(manager.local_rooms),
        "local_connections": sum(
            len(users) for users in manager.local_rooms.values()
        ),
    }


@app.get("/api/rooms")
async def list_rooms():
    """Returns active rooms and their participant counts across cluster."""
    rooms_data = []
    if manager.redis:
        try:
            keys = await manager.redis.keys("users:*")
            for k in keys:
                r_id = k.replace("users:", "")
                count = await manager.redis.hlen(k)
                rooms_data.append({"room_id": r_id, "user_count": count})
        except Exception as e:
            logger.error(f"Error fetching rooms from Redis: {e}")

    if not rooms_data:
        rooms_data = [
            {"room_id": r_id, "user_count": len(users)}
            for r_id, users in manager.local_rooms.items()
        ]

    return {"node_id": NODE_ID, "rooms": rooms_data}


@app.websocket("/ws/{room_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    room_id: str,
    client_id: str = Query(...),
    name: str = Query("Anonymous"),
    color: str = Query("#6366f1"),
):
    """WebSocket endpoint supporting real-time cross-node Pub/Sub collaboration."""
    await manager.connect(websocket, room_id, client_id, name, color)

    try:
        while True:
            raw_data = await websocket.receive_text()
            data = json.loads(raw_data)
            action_type = data.get("type")

            # Enrich message with client provenance
            data["client_id"] = client_id

            if action_type == "draw":
                # Persist to Redis history & publish event to all nodes
                await manager.add_history_action(room_id, data)
                await manager.publish_event(
                    room_id, data, exclude_client_id=client_id
                )

            elif action_type == "cursor":
                # Cursors are broadcast in real-time without history persistence
                await manager.publish_event(
                    room_id, data, exclude_client_id=client_id
                )

            elif action_type == "clear":
                # Clear shared history & notify all clients on all nodes
                await manager.clear_room_history(room_id)
                await manager.publish_event(
                    room_id, data, exclude_client_id=None
                )

            elif action_type == "undo":
                # Remove last action from Redis & broadcast updated history
                if await manager.undo_last_action(room_id, client_id):
                    new_history = await manager.get_room_history(room_id)
                    sync_payload = {
                        "type": "sync_history",
                        "history": new_history,
                    }
                    await manager.publish_event(
                        room_id, sync_payload, exclude_client_id=None
                    )

            elif action_type == "chat":
                # Real-time text chat message broadcast to all room participants across cluster
                await manager.publish_event(
                    room_id, data, exclude_client_id=None
                )

            elif action_type in ("sticky_create", "sticky_update", "sticky_delete"):
                # Sticky note operations persist in history and broadcast across nodes
                await manager.add_history_action(room_id, data)
                await manager.publish_event(
                    room_id, data, exclude_client_id=client_id
                )

            elif action_type == "voice_status":
                # WebRTC voice speaking indicator broadcast without history persistence
                await manager.publish_event(
                    room_id, data, exclude_client_id=client_id
                )

            elif action_type == "ai_diagram":
                # AI generated diagram shape batch broadcast & persistence
                shapes = data.get("shapes", [])
                for shape in shapes:
                    shape["client_id"] = client_id
                    await manager.add_history_action(room_id, shape)
                await manager.publish_event(
                    room_id, data, exclude_client_id=None
                )

            elif action_type == "create_game":
                new_code = manager.generate_room_code()
                session = {
                    "room_code": new_code,
                    "status": "lobby",
                    "host_client_id": client_id,
                    "players": [
                        {"client_id": client_id, "name": name, "color": color}
                    ],
                    "prompt": "",
                    "current_turn_index": 0,
                    "total_turns": 1,
                    "turn_timer": 45,
                    "timer_task": None,
                    "layers": {}
                }
                manager.game_sessions[new_code] = session
                await websocket.send_text(json.dumps({
                    "type": "game_created",
                    "room_code": new_code,
                    "is_host": True
                }))

            elif action_type == "start_session":
                mode = data.get("mode", "whiteboard")
                await manager.set_room_session_status(room_id, "in_progress")
                logger.info(f"[{NODE_ID}] Received start_session for room '{room_id}' from client '{client_id}', mode={mode}")
                payload = {
                    "type": "start_session",
                    "room_id": room_id,
                    "started_by": client_id,
                    "mode": mode
                }
                await manager.publish_event(room_id, payload, exclude_client_id=None)

            elif action_type == "update_room_permissions":
                drawing_locked = data.get("drawing_locked", False)
                user_roles = data.get("user_roles", {})  # { cid: "Editor" | "Viewer" }
                logger.info(f"[{NODE_ID}] Received update_room_permissions for room '{room_id}': locked={drawing_locked}")
                users = await manager.get_active_users(room_id)
                for u in users:
                    cid = u["client_id"]
                    if not (u.get("is_host") or u.get("role") == "Host"):
                        if cid in user_roles:
                            u["role"] = user_roles[cid]
                            u["can_draw"] = (user_roles[cid] == "Editor")
                        else:
                            u["can_draw"] = not drawing_locked
                            u["role"] = "Viewer" if drawing_locked else "Editor"
                    if manager.redis:
                        try:
                            await manager.redis.hset(f"users:{room_id}", cid, json.dumps(u))
                        except Exception as e:
                            logger.error(f"[{NODE_ID}] Error updating permissions in Redis: {e}")

                updated_users = await manager.get_active_users(room_id)
                payload = {
                    "type": "permissions_updated",
                    "room_id": room_id,
                    "drawing_locked": drawing_locked,
                    "users": updated_users
                }
                await manager.publish_event(room_id, payload, exclude_client_id=None)

            elif action_type == "update_lobby_settings":
                timer = data.get("turn_timer", 45)
                mode = data.get("visibility_mode", "blur")
                logger.info(f"[{NODE_ID}] Received update_lobby_settings for room '{room_id}': timer={timer}, mode={mode}")
                await manager.update_lobby_settings(room_id, client_id, timer, mode)

            elif action_type == "start_game":
                await manager.set_room_session_status(room_id, "in_progress")
                logger.info(f"[{NODE_ID}] Received start_game for room '{room_id}' from client '{client_id}'")
                session = await manager.get_game_session(room_id)
                if session and session.get("status") == "playing":
                    if session.get("host_client_id") and session.get("host_client_id") != client_id:
                        logger.warning(f"[{NODE_ID}] Non-host '{client_id}' attempted to restart active game in room '{room_id}' - Rejected.")
                        continue

                timer = data.get("turn_timer", session.get("turn_timer", 45) if session else 45)
                mode = data.get("visibility_mode", session.get("visibility_mode", "blur") if session else "blur")
                await manager.start_game_loop(room_id, host_client_id=client_id, turn_timer=timer, visibility_mode=mode)

            elif action_type == "start_voting":
                logger.info(f"[{NODE_ID}] Received start_voting for room '{room_id}' from client '{client_id}'")
                session = await manager.get_game_session(room_id)
                if session and session.get("host_client_id") and session.get("host_client_id") != client_id:
                    logger.warning(f"[{NODE_ID}] Non-host '{client_id}' attempted to start voting in room '{room_id}' - Rejected.")
                    continue
                await manager.start_voting_phase(room_id)

            elif action_type == "submit_vote":
                logger.info(f"[{NODE_ID}] Received submit_vote for room '{room_id}' from client '{client_id}'")
                await manager.process_vote(room_id, client_id, data)

            elif action_type == "request_next_round":
                user_name = data.get("name", client_id)
                request_kind = data.get("request_kind", "next_round")
                logger.info(f"[{NODE_ID}] Received request_next_round ({request_kind}) from '{user_name}' ({client_id}) for room '{room_id}'")
                payload = {
                    "type": "request_next_round",
                    "room_id": room_id,
                    "client_id": client_id,
                    "name": user_name,
                    "request_kind": request_kind
                }
                await manager.publish_event(room_id, payload, exclude_client_id=None)

            elif action_type == "finish_turn":
                logger.info(f"[{NODE_ID}] Received finish_turn for room '{room_id}' from client '{client_id}'")
                session = await manager.get_game_session(room_id)
                if session and session.get("status") == "playing":
                    curr_idx = session.get("current_turn_index", 0)
                    await manager.advance_turn(room_id, curr_idx + 1)

            elif action_type == "game_undo":
                session = await manager.get_game_session(room_id)
                if session and session.get("status") == "playing":
                    curr_idx = session.get("current_turn_index", 0)
                    str_idx = str(curr_idx)
                    layers = session.get("layers", {})
                    if layers.get(str_idx):
                        layers[str_idx].pop()
                        session["layers"] = layers
                        await manager.save_game_session(room_id, session)
                        await manager.publish_event(room_id, {"type": "game_undo", "turn_index": curr_idx})

            elif action_type == "game_clear":
                session = await manager.get_game_session(room_id)
                if session and session.get("status") == "playing":
                    curr_idx = session.get("current_turn_index", 0)
                    str_idx = str(curr_idx)
                    layers = session.get("layers", {})
                    layers[str_idx] = []
                    session["layers"] = layers
                    await manager.save_game_session(room_id, session)
                    await manager.publish_event(room_id, {"type": "game_clear", "turn_index": curr_idx})

            # Record drawing action strictly into active game layer if game_draw is sent
            if action_type == "game_draw":
                session = await manager.get_game_session(room_id)
                if session and session.get("status") == "playing":
                    curr_idx = session.get("current_turn_index", 0)
                    str_idx = str(curr_idx)
                    layers = session.get("layers", {})
                    if str_idx not in layers:
                        layers[str_idx] = []
                    layers[str_idx].append(data)
                    session["layers"] = layers
                    await manager.save_game_session(room_id, session)


    except WebSocketDisconnect:
        await manager.disconnect(room_id, client_id)
    except Exception as e:
        logger.error(f"[{NODE_ID}] WebSocket error for client {client_id}: {e}")
        await manager.disconnect(room_id, client_id)


# Serve static frontend files
frontend_dir = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "frontend")
)

@app.get("/")
async def serve_index():
    index_path = os.path.join(frontend_dir, "index.html")
    return FileResponse(
        index_path,
        media_type="text/html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"}
    )

@app.get("/style.css")
async def serve_css():
    css_path = os.path.join(frontend_dir, "style.css")
    return FileResponse(
        css_path,
        media_type="text/css",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"}
    )

@app.get("/app.js")
async def serve_js():
    js_path = os.path.join(frontend_dir, "app.js")
    return FileResponse(
        js_path,
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"}
    )

if os.path.exists(frontend_dir):
    app.mount("/static", StaticFiles(directory=frontend_dir), name="static")

