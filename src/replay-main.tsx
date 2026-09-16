import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/manrope";
import "@fontsource-variable/jetbrains-mono";
import "./style.css";
import ReplayApp, { readBundle } from "./ReplayApp";

const root = ReactDOM.createRoot(document.getElementById("root")!);
try {
  const bundle = readBundle(
    JSON.parse(document.getElementById("walnut-recordings")!.textContent!),
  );
  root.render(
    <React.StrictMode>
      <ReplayApp bundle={bundle} />
    </React.StrictMode>,
  );
} catch (error) {
  root.render(
    <main className="replay-error" role="alert">
      <h1>This recording could not be loaded.</h1>
      <p>
        {error instanceof Error
          ? error.message
          : "The embedded data is unreadable."}
      </p>
      <p>
        Use an intact WALnut replay export or rebuild it with{" "}
        <code>npm run build:demo</code>.
      </p>
    </main>,
  );
}
