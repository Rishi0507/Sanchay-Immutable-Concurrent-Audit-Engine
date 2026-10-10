import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initTheme } from "./theme";
// Fonts are bundled, not fetched, so the interface works with no network.
// Anek Latin, from the Indian foundry Ek Type, sets everything: its width axis
// gives the narrow, heavy ledger totals and the plain working text from one
// family. Geist Mono is kept for hashes, which must hold their columns.
import "@fontsource-variable/anek-latin/standard.css";
import "@fontsource-variable/geist-mono/wght.css";
import "./index.css";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
