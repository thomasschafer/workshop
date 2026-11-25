import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A page with a service worker, whose visibility and clock the test moves. */
function stubPage({ controlled }: { controlled: boolean }) {
  const sw = Object.assign(new EventTarget(), {
    controller: controlled ? {} : null,
    getRegistration: vi.fn(async () => ({ update: vi.fn(async () => {}) })),
  });
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const reload = vi.fn();
  vi.stubGlobal("navigator", { serviceWorker: sw });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", { reload });
  const show = (state: "hidden" | "visible") => {
    doc.visibilityState = state;
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  const takeOver = () => sw.dispatchEvent(new Event("controllerchange"));
  return { sw, reload, show, takeOver };
}

/** A fresh copy of the module, as its state lasts as long as the page. */
const load = async () => {
  vi.resetModules();
  return import("./update");
};

describe("picking up a new release", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reloads on coming back after a while, where the screen says it's safe", async () => {
    const page = stubPage({ controlled: true });
    const update = await load();
    update.watchForUpdates();
    update.setReloadSafety(true);
    page.takeOver();
    page.show("hidden");
    vi.advanceTimersByTime(31_000);
    page.show("visible");
    expect(page.reload).toHaveBeenCalledOnce();
  });

  it("doesn't reload after only a glance away", async () => {
    const page = stubPage({ controlled: true });
    const update = await load();
    update.watchForUpdates();
    update.setReloadSafety(true);
    page.takeOver();
    page.show("hidden");
    vi.advanceTimersByTime(5_000);
    page.show("visible");
    expect(page.reload).not.toHaveBeenCalled();
  });

  it("doesn't reload a screen that's busy, or that hasn't said", async () => {
    for (const safety of [false, null]) {
      const page = stubPage({ controlled: true });
      const update = await load();
      update.watchForUpdates();
      update.setReloadSafety(safety);
      page.takeOver();
      page.show("hidden");
      vi.advanceTimersByTime(60_000);
      page.show("visible");
      expect(page.reload).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it("doesn't count the service worker's first install as a new release", async () => {
    const page = stubPage({ controlled: false });
    const update = await load();
    update.watchForUpdates();
    update.setReloadSafety(true);
    page.takeOver();
    page.show("hidden");
    vi.advanceTimersByTime(60_000);
    page.show("visible");
    expect(page.reload).not.toHaveBeenCalled();
  });

  it("looks for a new release on coming back, with none ready yet", async () => {
    const page = stubPage({ controlled: true });
    const update = await load();
    update.watchForUpdates();
    page.show("hidden");
    page.show("visible");
    expect(page.sw.getRegistration).toHaveBeenCalledOnce();
    expect(page.reload).not.toHaveBeenCalled();
  });
});
