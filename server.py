import asyncio
import hmac
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

from aiohttp import WSMsgType, web
from dotenv import load_dotenv
from pywebpush import WebPushException, webpush_async


PROJECT_DIR = Path(__file__).parent
load_dotenv(PROJECT_DIR / ".env")
VOLUME_DIR = Path(os.environ.get("RAILWAY_VOLUME_MOUNT_PATH", PROJECT_DIR))
DATABASE_PATH = VOLUME_DIR / "chat.db"
CHAT_PASSWORD = os.environ.get("CHAT_PASSWORD")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_SUBJECT = os.environ.get(
    "VAPID_SUBJECT",
    "https://chatapp-production-9daf.up.railway.app/",
)

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
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            endpoint TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at TEXT NOT NULL
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


async def manifest(_request):
    return web.FileResponse(
        PROJECT_DIR / "manifest.webmanifest",
        headers={"Content-Type": "application/manifest+json"},
    )


async def service_worker(_request):
    return web.FileResponse(
        PROJECT_DIR / "service-worker.js",
        headers={
            "Cache-Control": "no-cache",
            "Service-Worker-Allowed": "/",
        },
    )


async def push_public_key(_request):
    if not VAPID_PUBLIC_KEY or not VAPID_PRIVATE_KEY:
        return web.json_response(
            {"publicKey": "", "message": "Push notifications are not configured."},
            status=503,
        )

    return web.json_response({"publicKey": VAPID_PUBLIC_KEY})


async def health(_request):
    return web.Response(text="ok")


def save_push_subscription(username, subscription):
    if not isinstance(subscription, dict):
        return False

    endpoint = str(subscription.get("endpoint", "")).strip()
    keys = subscription.get("keys", {})
    p256dh = str(keys.get("p256dh", "")).strip() if isinstance(keys, dict) else ""
    auth = str(keys.get("auth", "")).strip() if isinstance(keys, dict) else ""

    if (
        not endpoint.startswith("https://")
        or len(endpoint) > 2048
        or not p256dh
        or len(p256dh) > 512
        or not auth
        or len(auth) > 512
    ):
        return False

    database.execute(
        """
        INSERT INTO push_subscriptions (endpoint, username, p256dh, auth, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
            username = excluded.username,
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            created_at = excluded.created_at
        """,
        (endpoint, username, p256dh, auth, datetime.now().isoformat()),
    )
    database.commit()
    return True


async def send_push_notifications(sender):
    if not VAPID_PRIVATE_KEY or not VAPID_PUBLIC_KEY:
        return

    subscriptions = database.execute(
        """
        SELECT endpoint, p256dh, auth
        FROM push_subscriptions
        WHERE username != ?
        """,
        (sender,),
    ).fetchall()

    payload = json.dumps(
        {
            "title": "BabaChat 💗",
            "body": f"New message from {sender}",
            "url": "/",
        }
    )
    expired_endpoints = []

    for endpoint, p256dh, auth in subscriptions:
        try:
            await webpush_async(
                subscription_info={
                    "endpoint": endpoint,
                    "keys": {"p256dh": p256dh, "auth": auth},
                },
                data=payload,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={"sub": VAPID_SUBJECT},
                ttl=60 * 60,
            )
        except WebPushException as error:
            response = getattr(error, "response", None)
            status = getattr(response, "status", None)
            if status is None:
                status = getattr(response, "status_code", None)
            if status in {404, 410}:
                expired_endpoints.append(endpoint)
        except Exception as error:
            print(f"Push notification failed: {error}")

    if expired_endpoints:
        database.executemany(
            "DELETE FROM push_subscriptions WHERE endpoint = ?",
            [(endpoint,) for endpoint in expired_endpoints],
        )
        database.commit()


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

            if data.get("type") == "subscribe":
                if save_push_subscription(username, data.get("subscription")):
                    await websocket.send_json({"type": "push_ready"})
                else:
                    await websocket.send_json(
                        {
                            "type": "push_error",
                            "message": "This notification subscription could not be saved.",
                        }
                    )
                continue

            if data.get("type") != "message":
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

            await send_push_notifications(username)
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
app.router.add_get("/manifest.webmanifest", manifest)
app.router.add_get("/service-worker.js", service_worker)
app.router.add_get("/push/public-key", push_public_key)
app.router.add_static("/assets/", PROJECT_DIR / "assets")
app.router.add_get("/health", health)
app.router.add_get("/ws", websocket_handler)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8765))
    print(f"Chat app running on http://0.0.0.0:{port}")
    web.run_app(app, host="0.0.0.0", port=port)
