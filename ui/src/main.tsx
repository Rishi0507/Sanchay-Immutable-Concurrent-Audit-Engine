import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initTheme } from "./theme";
// Fonts are bundled, not fetched, so the interface works with no network.
// Newsreader sets the headlines: it was drawn for long reading in print, and
// gives the page the voice of an audit report. Geist is the working face for
// the interface, plain and exact. Geist Mono sets every figure and hash, so
// digits hold their columns.
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/newsreader/opsz-italic.css";
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "./index.css";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
