import { Buffer } from "buffer";
import { renderPage } from "./render";

globalThis.Buffer = globalThis.Buffer || Buffer;

void import("../pages/BatchDistributorPage").then(({ BatchDistributorPage }) => {
  renderPage(<BatchDistributorPage />);
});
