import { api } from "./api";

/**
 * Why this browser can't show Workshop's notifications, or null if it can. iPhones only allow
 * them for a web app added to the home screen.
 */
export function notificationsUnavailable(): string | null {
  const supported =
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  if (supported) return null;
  const iPhone = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return iPhone
    ? "On an iPhone, add Workshop to the home screen and open it from there to turn these on."
    : "This browser can't show notifications from Workshop.";
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js");
  return navigator.serviceWorker.ready;
}

/** Whether this device gets notifications: the browser has a subscription the server knows. */
export async function notificationsOn(): Promise<boolean> {
  if (notificationsUnavailable() !== null || Notification.permission !== "granted") return false;
  const subscription = await (await registration()).pushManager.getSubscription();
  return subscription !== null && (await api.notificationsSubscribed(subscription.endpoint));
}

/** Asks for permission, then subscribes this device. Must be called from a tap. */
export async function turnNotificationsOn(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      "Notifications aren't allowed for Workshop. Allow them in your browser's site settings, then try again.",
    );
  }
  const { public_key } = await api.notifications();
  const pushManager = (await registration()).pushManager;
  const subscription =
    (await pushManager.getSubscription()) ??
    (await pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: fromBase64Url(public_key),
    }));
  await api.subscribeNotifications(subscription.toJSON());
}

export async function turnNotificationsOff(): Promise<void> {
  const subscription = await (await registration()).pushManager.getSubscription();
  if (!subscription) return;
  await api.unsubscribeNotifications(subscription.endpoint);
  await subscription.unsubscribe();
}

/** Has the server send a notification to this device now. */
export async function testNotification(): Promise<void> {
  const subscription = await (await registration()).pushManager.getSubscription();
  if (!subscription) throw new Error("Notifications aren't on for this device.");
  await api.testNotification(subscription.toJSON());
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Calls `open` with a puzzle a tapped notification asks to open, `year-day`. */
export function onNotificationOpen(open: (year: number, day: number) => void): () => void {
  if (!("serviceWorker" in navigator)) return () => {};
  const listener = (event: MessageEvent<{ open?: string }>) => {
    const url = event.data?.open;
    if (!url) return;
    const puzzle = puzzleToOpen(new URL(url).search);
    if (puzzle) open(puzzle.year, puzzle.day);
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}

/** The puzzle in an address's `open` parameter, as a notification's address gives it. */
export function puzzleToOpen(search: string): { year: number; day: number } | null {
  const match = new URLSearchParams(search).get("open")?.match(/^(\d{4})-(\d{1,2})$/);
  if (!match?.[1] || !match[2]) return null;
  return { year: Number(match[1]), day: Number(match[2]) };
}
