import asyncio
import hmac
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

from aiohttp import WSMsgType, web
from dotenv import load_dotenv


PROJECT_DIR = Path(__file__).parent
load_dotenv(PROJECT_DIR / ".env")
VOLUME_DIR = Path(os.environ.get("RAILWAY_VOLUME_MOUNT_PATH", PROJECT_DIR))
DATABASE_PATH = VOLUME_DIR / "chat.db"
CHAT_PASSWORD = os.environ.get("CHAT_PASSWORD")

if not CHAT_PASSWORD:
    raise RuntimeError("CHAT_PASSWORD is not set. Add it to .env locally or Railway Variables.")

connected_clients = set()


def open_database():
    VOLUME_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH)
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            message TEXT NOT NULL,
            timestamp TEXT NOT NULL
        )
        """
    )
    connection.commit()
    return connection


database = open_database()


async def index(_request):
    return web.FileResponse(PROJECT_DIR / "index.htm")


async def javascript(_request):
    return web.FileResponse(PROJECT_DIR / "practice.js")


async def stylesheet(_request):
    return web.FileResponse(PROJECT_DIR / "styles.css")


async def health(_request):
    return web.Response(text="ok")


async def websocket_handler(request):
    websocket = web.WebSocketResponse()
    await websocket.prepare(request)

    try:
        auth_message = await websocket.receive(timeout=15)

        if auth_message.type != WSMsgType.TEXT:
            await websocket.close(code=4001, message=b"Authentication required")
            return websocket

        try:
            auth_data = json.loads(auth_message.data)
        except json.JSONDecodeError:
            await websocket.send_json({"type": "auth_error", "message": "Invalid request"})
            await websocket.close(code=4001)
            return websocket

        username = str(auth_data.get("username", "")).strip()[:40]
        password = str(auth_data.get("password", ""))

        if not username or not hmac.compare_digest(password, CHAT_PASSWORD):
            await websocket.send_json({"type": "auth_error", "message": "Wrong name or password"})
            await websocket.close(code=4001)
            return websocket

        connected_clients.add(websocket)
        await websocket.send_json({"type": "auth_ok"})

        saved_messages = database.execute(
            "SELECT username, message, timestamp FROM messages ORDER BY id"
        ).fetchall()

        for saved_username, text, timestamp in saved_messages:
            await websocket.send_json(
                {
                    "type": "message",
                    "username": saved_username,
                    "message": text,
                    "timestamp": timestamp,
                }
            )

        async for incoming in websocket:
            if incoming.type != WSMsgType.TEXT:
                continue

            try:
                data = json.loads(incoming.data)
            except json.JSONDecodeError:
                continue

            text = str(data.get("message", "")).strip()[:2000]
            if not text:
                continue

            timestamp = datetime.now().strftime("%I:%M %p")
            database.execute(
                "INSERT INTO messages (username, message, timestamp) VALUES (?, ?, ?)",
                (username, text, timestamp),
            )
            database.commit()

            outgoing_message = {
                "type": "message",
                "username": username,
                "message": text,
                "timestamp": timestamp,
            }

            disconnected = []
            for client in connected_clients:
                try:
                    await client.send_json(outgoing_message)
                except ConnectionError:
                    disconnected.append(client)

            for client in disconnected:
                connected_clients.discard(client)
    except asyncio.TimeoutError:
        await websocket.close(code=4001, message=b"Authentication timed out")
    finally:
        connected_clients.discard(websocket)

    return websocket


app = web.Application()
app.router.add_get("/", index)
app.router.add_get("/index.htm", index)
app.router.add_get("/practice.js", javascript)
app.router.add_get("/styles.css", stylesheet)
app.router.add_get("/health", health)
app.router.add_get("/ws", websocket_handler)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8765))
    print(f"Chat app running on http://0.0.0.0:{port}")
    web.run_app(app, host="0.0.0.0", port=port)
