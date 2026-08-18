import type React from "react";
import { Analytics } from "@vercel/analytics/react";
import { createRoot, type Root } from "react-dom/client";
import "../app.css";
import "../../warm-ivory.css";
import "../tool-workbench.css";

declare global {
  interface Window {
    __solBatchSendRoot?: Root;
  }
}

export function renderPage(page: React.ReactElement) {
  const rootElement = document.getElementById("root")!;
  const root = window.__solBatchSendRoot || createRoot(rootElement);
  window.__solBatchSendRoot = root;
  root.render(
    <>
      {page}
      <Analytics />
    </>
  );
}
