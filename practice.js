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

let socket;
let username = "";
let authenticated = false;

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
      return;
    }

    if (data.type === "auth_error") {
      showJoinStatus(data.message, true);
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
