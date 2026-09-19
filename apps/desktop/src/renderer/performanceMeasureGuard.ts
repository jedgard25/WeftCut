// Dev-only guard against a React 19 development-build renderer crash.
//
// React's dev build logs every committed component render to the User Timing
// API (`logComponentRender`): it deep-diffs the component's changed props and
// passes the diff as `measure`'s `detail`. Chromium structured-clones that
// `detail` into the performance timeline, and when the changed props include a
// large structure the clone throws:
//
//   DataCloneError: Failed to execute 'measure' on 'Performance':
//   Data cannot be cloned, out of memory.
//
// The throw happens INSIDE React's commit phase, so its `executionContext` is
// never reset; the very next render throws `Should not already be working`, and
// the renderer process dies (`render-process-gone: reason=crashed`). This is
// NOT a memory OOM — the process RSS is small.
//
// This wraps `performance.measure` to retry WITHOUT the detail when the clone
// fails, keeping the timing entry and React's commit intact, and logs the
// component name once so the real cause (a large, referentially-unstable prop)
// can be fixed at its source. Production React never calls this path; the guard
// is installed only under `import.meta.env.DEV`.

const warned = new Set<string>();

/// React prefixes the component name with a zero-width space (U+200B).
function componentNameOf(measureName: string): string {
  return measureName.replace(/^\u200b/, "");
}

interface DevToolsDetail {
  devtools?: { properties?: unknown[] | null };
}

export function installPerformanceMeasureGuard(): void {
  if (typeof performance === "undefined" || typeof performance.measure !== "function") {
    return;
  }
  const original = performance.measure.bind(performance);

  const patched = (
    name: string,
    startOrOptions?: string | PerformanceMeasureOptions,
    endMark?: string,
  ): PerformanceMeasure | undefined => {
    try {
      return original(name, startOrOptions, endMark);
    } catch (err) {
      const isCloneFailure =
        typeof DOMException !== "undefined" &&
        err instanceof DOMException &&
        err.name === "DataCloneError";
      if (isCloneFailure && startOrOptions && typeof startOrOptions === "object") {
        const component = componentNameOf(String(name));
        if (!warned.has(component)) {
          warned.add(component);
          const props =
            ((startOrOptions as { detail?: DevToolsDetail }).detail?.devtools?.properties?.length) ??
            "?";
          console.warn(
            `[weftcut/dev] performance.measure detail too large to clone for <${component}> ` +
              `(${props} changed-prop entries); dropped the DevTools prop diff to avoid a ` +
              `renderer crash. This component likely has a large, referentially-unstable prop.`,
          );
        }
        const { detail: _detail, ...rest } = startOrOptions as PerformanceMeasureOptions;
        try {
          return original(name, rest, endMark);
        } catch {
          return undefined;
        }
      }
      // Any other measure failure is a dev-timing concern only; never let it
      // take down the renderer.
      return undefined;
    }
  };

  (performance as unknown as { measure: typeof patched }).measure = patched;
}
