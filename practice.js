const usernameInput = document.getElementById("usernameInput");
const passwordInput = document.getElementById("passwordInput");
const messageInput = document.getElementById("messageInput");
const joinButton = document.getElementById("joinButton");
const sendButton = document.getElementById("sendButton");
const messages = document.getElementById("messages");
const joinArea = document.getElementById("joinArea");
const chatArea = document.getElementById("chatArea");
const statusMessage = document.getElementById("statusMessage");

let socket;
let username = "";
let authenticated = false;

function websocketUrl() {
  const websocketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${websocketProtocol}//${window.location.host}/ws`;
}

function showStatus(message) {
  statusMessage.textContent = message;
}

function connectToChat() {
  username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (username === "" || password === "") {
    showStatus("Enter your name and the shared password.");
    return;
  }

  joinButton.disabled = true;
  showStatus("Connecting…");
  socket = new WebSocket(websocketUrl());

  socket.onopen = () => {
    socket.send(JSON.stringify({ type: "auth", username, password }));
  };

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "auth_ok") {
      authenticated = true;
      passwordInput.value = "";
      joinArea.style.display = "none";
      chatArea.style.display = "block";
      showStatus("");
      messageInput.focus();
      return;
    }

    if (data.type === "auth_error") {
      showStatus(data.message);
      return;
    }

    if (data.type === "message") {
      const newMessage = document.createElement("p");
      newMessage.textContent =
        data.username + ": " + data.message + " - " + data.timestamp;
      messages.appendChild(newMessage);
      messages.scrollTop = messages.scrollHeight;
    }
  };

  socket.onerror = () => {
    showStatus("Could not connect to the chat. Try again in a moment.");
  };

  socket.onclose = () => {
    if (authenticated) {
      showStatus("Disconnected. Refresh the page to reconnect.");
    }
    authenticated = false;
    joinButton.disabled = false;
  };
}

joinButton.addEventListener("click", connectToChat);

passwordInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    connectToChat();
  }
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
  if (event.key === "Enter") {
    sendButton.click();
  }
});
