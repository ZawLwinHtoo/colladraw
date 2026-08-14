import asyncio
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("whiteboard-redis-broker")

class MinimalRedisBroker:
    """Pure-Python, zero-dependency async Redis server broker for Pub/Sub, Lists, and Hashes."""

    def __init__(self, host="127.0.0.1", port=6379):
        self.host = host
        self.port = port
        self.channels = {}  # channel_name -> set(writer)
        self.storage = {}   # key -> list or dict
        self.server = None

    async def start(self):
        try:
            self.server = await asyncio.start_server(self.handle_client, self.host, self.port)
            logger.info(f"Embedded Python Redis Broker active on {self.host}:{self.port}")
            return True
        except Exception as e:
            logger.debug(f"Redis Broker port {self.port} already in use or unavailable: {e}")
            return False

    async def stop(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.server = None

    async def handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        subscribed_channels = set()

        try:
            while not reader.at_eof():
                command_parts = await self.read_resp_command(reader)
                if not command_parts:
                    break

                cmd = command_parts[0].upper()
                args = command_parts[1:]

                if cmd == "PING":
                    writer.write(b"+PONG\r\n")
                    await writer.drain()

                elif cmd == "CLIENT":
                    writer.write(b"+OK\r\n")
                    await writer.drain()

                elif cmd == "SUBSCRIBE":
                    for channel in args:
                        if channel not in self.channels:
                            self.channels[channel] = set()
                        self.channels[channel].add(writer)
                        subscribed_channels.add(channel)
                        
                        resp_msg = f"*3\r\n$9\r\nsubscribe\r\n${len(channel)}\r\n{channel}\r\n:1\r\n".encode("utf-8")
                        writer.write(resp_msg)
                    await writer.drain()

                elif cmd == "PUBLISH":
                    channel = args[0]
                    message = args[1]
                    recipients = self.channels.get(channel, set())
                    count = 0
                    
                    pubsub_msg = f"*3\r\n$7\r\nmessage\r\n${len(channel)}\r\n{channel}\r\n${len(message.encode('utf-8'))}\r\n{message}\r\n".encode("utf-8")
                    
                    dead_writers = set()
                    for w in recipients:
                        try:
                            w.write(pubsub_msg)
                            await w.drain()
                            count += 1
                        except Exception:
                            dead_writers.add(w)
                    
                    for w in dead_writers:
                        recipients.discard(w)

                    writer.write(f":{count}\r\n".encode("utf-8"))
                    await writer.drain()

                elif cmd == "RPUSH":
                    key = args[0]
                    if key not in self.storage or not isinstance(self.storage[key], list):
                        self.storage[key] = []
                    for val in args[1:]:
                        self.storage[key].append(val)
                    writer.write(f":{len(self.storage[key])}\r\n".encode("utf-8"))
                    await writer.drain()

                elif cmd == "LRANGE":
                    key = args[0]
                    start = int(args[1])
                    stop = int(args[2])
                    items = self.storage.get(key, [])
                    if isinstance(items, list):
                        if stop == -1 or stop >= len(items):
                            sub_list = items[start:]
                        else:
                            sub_list = items[start:stop + 1]
                    else:
                        sub_list = []

                    resp = [f"*{len(sub_list)}\r\n"]
                    for item in sub_list:
                        item_bytes = item.encode("utf-8")
                        resp.append(f"${len(item_bytes)}\r\n{item}\r\n")
                    writer.write("".join(resp).encode("utf-8"))
                    await writer.drain()

                elif cmd in ("DEL", "DELETE"):
                    count = 0
                    for key in args:
                        if key in self.storage:
                            del self.storage[key]
                            count += 1
                    writer.write(f":{count}\r\n".encode("utf-8"))
                    await writer.drain()

                elif cmd == "HSET":
                    key = args[0]
                    field = args[1]
                    val = args[2]
                    if key not in self.storage or not isinstance(self.storage[key], dict):
                        self.storage[key] = {}
                    self.storage[key][field] = val
                    writer.write(b":1\r\n")
                    await writer.drain()

                elif cmd == "HGETALL":
                    key = args[0]
                    hdict = self.storage.get(key, {})
                    if not isinstance(hdict, dict):
                        hdict = {}
                    
                    pairs = []
                    for k, v in hdict.items():
                        pairs.append(k)
                        pairs.append(v)

                    resp = [f"*{len(pairs)}\r\n"]
                    for p in pairs:
                        p_bytes = p.encode("utf-8")
                        resp.append(f"${len(p_bytes)}\r\n{p}\r\n")
                    writer.write("".join(resp).encode("utf-8"))
                    await writer.drain()

                elif cmd == "HDEL":
                    key = args[0]
                    field = args[1]
                    count = 0
                    if key in self.storage and isinstance(self.storage[key], dict):
                        if field in self.storage[key]:
                            del self.storage[key][field]
                            count = 1
                    writer.write(f":{count}\r\n".encode("utf-8"))
                    await writer.drain()

                elif cmd == "HLEN":
                    key = args[0]
                    count = 0
                    if key in self.storage and isinstance(self.storage[key], dict):
                        count = len(self.storage[key])
                    writer.write(f":{count}\r\n".encode("utf-8"))
                    await writer.drain()

                elif cmd == "KEYS":
                    pattern = args[0].replace("*", "")
                    matched = [k for k in self.storage.keys() if pattern in k]
                    resp = [f"*{len(matched)}\r\n"]
                    for k in matched:
                        k_bytes = k.encode("utf-8")
                        resp.append(f"${len(k_bytes)}\r\n{k}\r\n")
                    writer.write("".join(resp).encode("utf-8"))
                    await writer.drain()

                elif cmd == "QUIT":
                    writer.write(b"+OK\r\n")
                    await writer.drain()
                    break

        except (asyncio.CancelledError, ConnectionResetError):
            pass
        finally:
            for ch in subscribed_channels:
                if ch in self.channels:
                    self.channels[ch].discard(writer)
            writer.close()

    async def read_resp_command(self, reader: asyncio.StreamReader):
        line = await reader.readline()
        if not line:
            return None
        
        if line.startswith(b"*"):
            num_args = int(line[1:].strip())
            args = []
            for _ in range(num_args):
                len_line = await reader.readline()
                arg_len = int(len_line[1:].strip())
                arg_data = await reader.readexactly(arg_len + 2)
                args.append(arg_data[:-2].decode("utf-8", errors="replace"))
            return args
        else:
            parts = line.decode("utf-8", errors="replace").strip().split()
            return parts


if __name__ == "__main__":
    broker = MinimalRedisBroker()
    asyncio.run(broker.start())
    print("Standalone Python Redis Broker listening on 127.0.0.1:6379 (Press Ctrl+C to quit)...")
    try:
        asyncio.get_event_loop().run_forever()
    except KeyboardInterrupt:
        print("Stopping Redis Broker.")
