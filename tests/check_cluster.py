"""Verify actual Docker nodes share Redis history and events."""
import asyncio
import json
import uuid
from urllib.request import urlopen
from websockets.asyncio.client import connect

async def event(socket, kind):
    for _ in range(30):
        packet=json.loads(await asyncio.wait_for(socket.recv(),5))
        if packet['type']==kind:
            return packet
    raise AssertionError(f'Missing {kind}')

async def main():
    for port in [8000,8001]:
        with urlopen(f'http://127.0.0.1:{port}/health') as response:
            status=json.load(response)
            assert status['redis'],status
    room='CHECK-'+uuid.uuid4().hex[:6].upper()
    async with connect(f'ws://127.0.0.1:8000/ws/{room}?action=create&client_id=host-client&name=Host') as first:
        await event(first,'welcome')
        async with connect(f'ws://127.0.0.1:8001/ws/{room}?client_id=guest-client&name=Guest') as second:
            await event(second,'welcome')
            await first.send(json.dumps({'type': 'operation', 'operationId': 'operation-check', 'eventType': 'object:create', 'payload': {'object': {'id': 'object-check', 'type': 'pen', 'points': [{'x': 0.1, 'y': 0.2}]}}}))
            assert (await event(second,'operation'))
            async with connect(f'ws://127.0.0.1:8001/ws/{room}?client_id=replay-client&name=Replay') as replay:
                initial=await event(replay,'welcome')
                assert len(initial['objects'])==1,initial
    with urlopen('http://127.0.0.1:8090/') as page:
        assert b'<!doctype html' in page.read().lower()
    print('PASS: Redis connected on both nodes; cross-node draw and history replay; gateway serves frontend.')

asyncio.run(main())
