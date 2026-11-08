import pytest
from fastapi.testclient import TestClient
from backend import server
from backend.game import GameService


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(server, "redis", None)
    manager = server.BoardManager()
    monkeypatch.setattr(server, "manager", manager)
    monkeypatch.setattr(server, "games", GameService(manager))
    with TestClient(server.app) as client:
        yield client


def until(socket, kind):
    for _ in range(12):
        event = socket.receive_json()
        if event["type"] == kind:
            return event
    raise AssertionError(f"Missing {kind} event")


def operation(identifier="create-001", **overrides):
    result = {"type": "operation", "operationId": identifier, "eventType": "object:create",
              "payload": {"object": {"id": "object-001", "type": "pen", "points": [{"x": 5, "y": 8}]}}}
    result.update(overrides)
    return result


def test_join_replays_board_and_only_owner_can_edit(client):
    with client.websocket_connect("/ws/TEST-ROOM?action=create&client_id=player-one&name=One") as first:
        until(first, "welcome")
        first.send_json(operation())
        until(first, "operation")
        with client.websocket_connect("/ws/TEST-ROOM?client_id=player-two&name=Two") as second:
            welcome = until(second, "welcome")
            assert welcome["objects"][0]["userId"] == "player-one"
            second.send_json(operation("update-002", eventType="object:update",
                                       payload={"object": {"id": "object-001", "type": "pen", "points": [{"x": 99, "y": 99}]}}))
            second.send_json({"type": "cursor", "x": 1, "y": 2})
            until(second, "cursor")
            assert server.manager.boards["board:TEST-ROOM"]["object-001"]["points"] == [{"x": 5, "y": 8}]


def test_malformed_packets_do_not_disconnect_or_poison_board(client):
    with client.websocket_connect("/ws/TEST-BAD?action=create&client_id=player-one&name=One") as socket:
        until(socket, "welcome")
        socket.send_text("{")
        socket.send_json([])
        socket.send_json(operation("null-001", payload=None))
        socket.send_json(operation("bad-0001", payload={"object": {"id": "poison-01", "type": "pen", "points": ["broken"]}}))
        socket.send_json(operation())
        event = until(socket, "operation")
        assert event["payload"]["object"]["id"] == "object-001"
        assert len(server.manager.boards["board:TEST-BAD"]) == 1


def test_unknown_room_is_not_silently_created(client):
    with client.websocket_connect("/ws/MISSING?client_id=player-one&name=One") as socket:
        assert socket.receive_json()["message"] == "Room not found."


def test_game_host_control_private_word_and_scoring(client):
    with client.websocket_connect("/ws/TEST-GAME?action=create&mode=game&client_id=player-one&name=One") as host:
        until(host, "welcome")
        until(host, "game:state")
        with client.websocket_connect("/ws/TEST-GAME?client_id=player-two&name=Two") as guest:
            until(guest, "welcome")
            until(guest, "game:state")
            guest.send_json({"type": "game:start"})
            assert until(guest, "game:state")["state"]["status"] == "lobby"
            until(host, "game:state")
            host.send_json({"type": "game:start"})
            state = until(host, "game:state")["state"]
            assert state["drawerId"] == "player-one"
            assert "secretWord" not in state and "wordOptions" not in state
            private = until(host, "game:private")
            word = private["choices"][0]
            host.send_json({"type": "game:word", "payload": {"word": word}})
            assert until(host, "game:state")["state"]["status"] == "drawing"
            guest.send_json({"type": "game:guess", "payload": {"text": word}})
            while True:
                result = until(guest, "game:state")["state"]
                if result["status"] == "round_results":
                    break
            assert result["scores"]["player-two"] >= 100
            assert result["scores"]["player-one"] == 50


@pytest.mark.parametrize("points", [[{"x": float("nan"), "y": 0}], [{"x": 1, "y": True}], [None]])
def test_rejects_invalid_coordinates(points):
    assert server.valid_object({"id": "object-001", "type": "pen", "points": points}, "player-one") is None
