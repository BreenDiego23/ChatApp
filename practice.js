const usernameInput = document.getElementById("usernameInput");
const passwordInput = document.getElementById("passwordInput");
const messageInput = document.getElementById("messageInput");
const joinButton = document.getElementById("joinButton");
const sendButton = document.getElementById("sendButton");
const messages = document.getElementById("messages");
const joinArea = document.getElementById("joinArea");
const chatArea = document.getElementById("chatArea");
const statusMessage = document.getElementById("statusMessage");
const chatNotice = document.getElementById("chatNotice");
const connectionStatus = document.getElementById("connectionStatus");
const activeUser = document.getElementById("activeUser");
const emptyState = document.getElementById("emptyState");
const notificationButton = document.getElementById("notificationButton");
const notificationButtonLabel = document.getElementById("notificationButtonLabel");
const notificationNotice = document.getElementById("notificationNotice");

let socket;
let username = "";
let authenticated = false;
let serviceWorkerRegistration;

function websocketUrl() {
  const websocketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${websocketProtocol}//${window.location.host}/ws`;
}

function showJoinStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("is-error", isError);
}

function setConnected(isConnected) {
  connectionStatus.textContent = isConnected ? "Connected" : "Disconnected";
  document.querySelector(".presence").classList.toggle("is-offline", !isConnected);
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isRunningAsApp() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function showNotificationNotice(message = "") {
  notificationNotice.textContent = message;
  notificationNotice.hidden = message === "";
}

function setNotificationButton(label, { enabled = false, disabled = false } = {}) {
  notificationButtonLabel.textContent = label;
  notificationButton.disabled = disabled;
  notificationButton.classList.toggle("is-enabled", enabled);
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

async function getServiceWorkerRegistration() {
  if (!serviceWorkerRegistration) {
    serviceWorkerRegistration = await navigator.serviceWorker.register("/service-worker.js");
  }

  await navigator.serviceWorker.ready;
  return serviceWorkerRegistration;
}

function sendPushSubscription(subscription) {
  if (!authenticated || socket?.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({
    type: "subscribe",
    subscription: subscription.toJSON(),
  }));
}

async function prepareNotifications() {
  if (isIosDevice() && !isRunningAsApp()) {
    setNotificationButton("How to add alerts");
    return;
  }

  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    setNotificationButton("Alerts unavailable", { disabled: true });
    return;
  }

  if (Notification.permission === "denied") {
    setNotificationButton("Alerts blocked", { disabled: true });
    showNotificationNotice("Notifications are blocked in this device's settings.");
    return;
  }

  if (Notification.permission !== "granted") {
    setNotificationButton("Turn on alerts");
    return;
  }

  try {
    const registration = await getServiceWorkerRegistration();
    const subscription = await registration.pushManager.getSubscription();

    if (subscription) {
      sendPushSubscription(subscription);
      setNotificationButton("Alerts on", { enabled: true });
    } else {
      setNotificationButton("Turn on alerts");
    }
  } catch (_error) {
    setNotificationButton("Try alerts again");
  }
}

async function enableNotifications() {
  showNotificationNotice();

  if (isIosDevice() && !isRunningAsApp()) {
    showNotificationNotice("On iPhone: tap Share, choose Add to Home Screen, then open BabaChat from its new icon.");
    return;
  }

  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    showNotificationNotice("This browser cannot receive BabaChat alerts.");
    return;
  }

  setNotificationButton("Turning on…", { disabled: true });

  try {
    const permission = await Notification.requestPermission();

    if (permission !== "granted") {
      setNotificationButton(permission === "denied" ? "Alerts blocked" : "Turn on alerts", {
        disabled: permission === "denied",
      });
      showNotificationNotice("BabaChat needs notification permission to alert this iPhone.");
      return;
    }

    const [registration, keyResponse] = await Promise.all([
      getServiceWorkerRegistration(),
      fetch("/push/public-key", { cache: "no-store" }),
    ]);
    const { publicKey } = await keyResponse.json();

    if (!keyResponse.ok || !publicKey) {
      throw new Error("Push notifications are not configured.");
    }

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    sendPushSubscription(subscription);
    setNotificationButton("Alerts on", { enabled: true });
    showNotificationNotice("This iPhone will now receive BabaChat alerts 💗");
  } catch (_error) {
    setNotificationButton("Try alerts again");
    showNotificationNotice("Alerts could not be turned on. Please try once more.");
  }
}

function addMessage(data) {
  emptyState?.remove();

  const isMine = data.username === username;
  const messageRow = document.createElement("article");
  messageRow.className = `message ${isMine ? "message--mine" : "message--theirs"}`;

  const meta = document.createElement("div");
  meta.className = "message-meta";

  const author = document.createElement("strong");
  author.textContent = isMine ? "You" : data.username;

  const time = document.createElement("time");
  time.textContent = data.timestamp;

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = data.message;

  meta.append(author, time);
  messageRow.append(meta, bubble);
  messages.appendChild(messageRow);
  messages.scrollTop = messages.scrollHeight;
}

function connectToChat() {
  username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (username === "" || password === "") {
    showJoinStatus("Enter your name and the shared password.", true);
    return;
  }

  joinButton.disabled = true;
  showJoinStatus("Opening your room…");
  socket = new WebSocket(websocketUrl());

  socket.onopen = () => {
    socket.send(JSON.stringify({ type: "auth", username, password }));
  };

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "auth_ok") {
      authenticated = true;
      passwordInput.value = "";
      joinArea.hidden = true;
      chatArea.hidden = false;
      activeUser.textContent = username;
      chatNotice.textContent = "";
      setConnected(true);
      messageInput.focus();
      prepareNotifications();
      return;
    }

    if (data.type === "auth_error") {
      showJoinStatus(data.message, true);
      return;
    }

    if (data.type === "push_ready") {
      setNotificationButton("Alerts on", { enabled: true });
      return;
    }

    if (data.type === "push_error") {
      setNotificationButton("Try alerts again");
      showNotificationNotice(data.message);
      return;
    }

    if (data.type === "message") {
      addMessage(data);
    }
  };

  socket.onerror = () => {
    showJoinStatus("Could not connect. Try again in a moment.", true);
  };

  socket.onclose = () => {
    if (authenticated) {
      setConnected(false);
      chatNotice.textContent = "Connection lost. Refresh the page to reconnect.";
    }
    authenticated = false;
    joinButton.disabled = false;
  };
}

joinButton.addEventListener("click", connectToChat);
notificationButton.addEventListener("click", enableNotifications);

[usernameInput, passwordInput].forEach((input) => {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      connectToChat();
    }
  });
});

sendButton.addEventListener("click", () => {
  const message = messageInput.value.trim();

  if (message === "" || !authenticated || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({ type: "message", message }));
  messageInput.value = "";
  messageInput.focus();
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendButton.click();
  }
});
