import type React from "react";
import { createRoot, type Root } from "react-dom/client";
import "../app.css";
import "../../warm-ivory.css";
import "../tool-workbench.css";
import "../collection-workbench.css";

declare global {
  interface Window {
    __chainKitSensitiveRoot?: Root;
  }
}

/** Render a page that handles signing material without loading analytics code. */
export function renderSensitivePage(page: React.ReactElement) {
  const rootElement = document.getElementById("root")!;
  const root = window.__chainKitSensitiveRoot || createRoot(rootElement);
  window.__chainKitSensitiveRoot = root;
  root.render(page);
}
