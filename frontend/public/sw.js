// Workshop's service worker: it shows notifications when puzzles unlock, and opens the puzzle a
// notification is about when it's tapped. It caches nothing.

self.addEventListener("push", (event) => {
  const message = event.data ? event.data.json() : { title: "Workshop", body: "", url: "/" };
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      icon: "/icon-192.png",
      data: { url: message.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // An open Workshop is brought forward and asked to open the puzzle, rather than a new one
      // opened beside it.
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        open.postMessage({ open: url });
        return open.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
