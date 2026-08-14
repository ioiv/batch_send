import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SecretKeyInput } from "./SecretKeyInput";

describe("SecretKeyInput", () => {
  it("renders a locally-scoped file picker without weakening secret-field protections", () => {
    const markup = renderToStaticMarkup(<SecretKeyInput mode="evm" />);

    expect(markup).toContain('type="file"');
    expect(markup).toContain('accept=".txt,.csv,.json,text/plain,text/csv,application/json"');
    expect(markup).toContain('autoComplete="off"');
    expect(markup).toContain('data-1p-ignore="true"');
    expect(markup).toContain('data-bwignore="true"');
    expect(markup).toContain('maxLength="524288"');
    expect(markup).toContain("文件控件读取后会立即清空");
  });

  it("disables both input paths while a collection is running", () => {
    const markup = renderToStaticMarkup(<SecretKeyInput disabled mode="solana" />);

    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).toContain("secret-file-button is-disabled");
  });
});
