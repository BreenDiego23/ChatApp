self.addEventListener("push", (event) => {
  let message = {};

  try {
    message = event.data?.json() || {};
  } catch (_error) {
    message = {};
  }

  event.waitUntil(
    self.registration.showNotification(message.title || "BabaChat 💗", {
      body: message.body || "You have a new message.",
      icon: "/assets/icon-192.png",
      badge: "/assets/icon-192.png",
      tag: "babachat-message",
      renotify: true,
      data: {
        url: message.url || "/",
      },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || "/", self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      for (const windowClient of windows) {
        if (new URL(windowClient.url).origin === self.location.origin) {
          await windowClient.navigate(destination);
          return windowClient.focus();
        }
      }

      return clients.openWindow(destination);
    }),
  );
});
