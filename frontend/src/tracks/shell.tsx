import { useEffect, useRef, useState } from "preact/hooks";
import { api, type Bootstrap } from "../api";
import { App } from "../app";
import { errorMessage } from "../errors";
import { Practice } from "../learning/practice";
import { onNotificationOpen } from "../notifications";
import { Home } from "./home";
import { pathOf, type Route, routeFor, routeOf } from "./routes";
import type { Destination } from "./types";

/**
 * The screens the app moves between: the home screen, and each track's own. The address says
 * which is shown, so reloading, and the browser's back and forward, keep to it.
 */
export function Shell({ boot: initialBoot }: { boot: Bootstrap }) {
  // What Advent of Code starts with, read again on leaving it, as its settings may have changed.
  const [boot, setBoot] = useState(initialBoot);
  const rebooting = useRef<Promise<void> | null>(null);
  const [route, setRoute] = useState<Route>(() => routeOf(location.pathname, location.search));
  const routeRef = useRef(route);
  routeRef.current = route;
  // Where Advent of Code opens: at a step or track chosen at home, or where it was left when
  // going back to it; null until either, when it opens as the server saved it.
  const [entry, setEntry] = useState<Destination | null>(null);

  useEffect(() => {
    // An old address for a screen, such as a notification's, becomes the screen's own, keeping
    // what it asks to open for that screen to read.
    const path = pathOf(route);
    if (location.pathname !== path) {
      history.replaceState(history.state, "", `${path}${location.search}`);
    }
    // Dialogs close with the back button too, which leaves the screen as it is.
    const onPop = () => {
      const next = routeOf(location.pathname, location.search);
      setRoute((shown) => (pathOf(shown) === pathOf(next) ? shown : next));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = async (destination: Destination) => {
    await rebooting.current;
    const next = routeFor(destination);
    history.pushState(null, "", pathOf(next));
    if (next.screen === "advent-of-code") setEntry(destination);
    setRoute(next);
  };

  // Back at home, by the button or the browser's back.
  const shownBefore = useRef(route.screen);
  useEffect(() => {
    const left = shownBefore.current !== route.screen && route.screen === "home";
    shownBefore.current = route.screen;
    if (!left) return;
    rebooting.current = api.bootstrap().then(
      // Only taken at home: Advent of Code would start over with it.
      (fresh) => {
        if (routeRef.current.screen === "home") setBoot(fresh);
      },
      (e: unknown) => {
        // What it started with still works; only changes made since are missed.
        api.log("error", `couldn't reload the app's state: ${errorMessage(e)}`);
      },
    );
  }, [route.screen]);

  // Advent of Code opens the puzzle a notification is about itself, once it's showing.
  useEffect(() => {
    if (route.screen !== "home") return;
    return onNotificationOpen((year, day) => void go({ kind: "puzzle", puzzle: { year, day } }));
  }, [route.screen]);

  const goHome = () => {
    history.pushState(null, "", pathOf({ screen: "home" }));
    setRoute({ screen: "home" });
  };

  switch (route.screen) {
    case "home":
      return <Home onGo={(destination) => void go(destination)} />;
    case "practice":
      return <Practice key={route.track} track={route.track} onHome={goHome} />;
    case "advent-of-code":
      return (
        <App
          boot={boot}
          entry={entry}
          onHome={(left) => {
            history.pushState(null, "", pathOf({ screen: "home" }));
            setEntry(left);
            setRoute({ screen: "home" });
          }}
        />
      );
  }
}
