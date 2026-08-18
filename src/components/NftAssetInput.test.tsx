import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NftAssetInput } from "./NftAssetInput";

describe("NftAssetInput", () => {
  const renderInput = (props: Partial<Parameters<typeof NftAssetInput>[0]> = {}) => renderToStaticMarkup(
    <NftAssetInput
      contractAddress=""
      onChange={() => undefined}
      onContractAddressChange={() => undefined}
      value=""
      {...props}
    />
  );

  it("defaults to the manual mode and exposes one controlled panel", () => {
    const markup = renderInput();

    expect(markup.match(/role="tab"/g)).toHaveLength(3);
    expect(markup).toContain("添加方式");
    expect(markup).toContain("手动添加");
    expect(markup).toMatch(/<button(?=[^>]*aria-controls="[^"]+-manual-panel")(?=[^>]*aria-selected="true")[^>]*>手动添加<\/button>/);
    expect(markup).toContain('id="nft-quick-contract"');
    expect(markup).not.toContain('id="nft-asset-raw-input"');
    expect(markup).not.toContain("选择 TXT/CSV 文件");
  });

  it("keeps the native file control hidden and only reveals file import in file mode", () => {
    const markup = renderToStaticMarkup(
      <NftAssetInput
        contractAddress=""
        defaultMode="file"
        onChange={() => undefined}
        onContractAddressChange={() => undefined}
        value=""
      />
    );

    expect(markup).toContain('type="file"');
    expect(markup).toContain("hidden=\"\"");
    expect(markup).toContain("选择 TXT/CSV 文件");
    expect(markup).toContain("文件仅在当前页面本地解析");
    expect(markup).toContain('id="nft-quick-contract"');
    expect(markup).not.toContain('id="nft-asset-raw-input"');
  });

  it("preserves the current serialized value in advanced editing mode", () => {
    const markup = renderInput({
      defaultMode: "advanced",
      value: "0x0000000000000000000000000000000000000001,42"
    });

    expect(markup).toContain('id="nft-asset-raw-input"');
    expect(markup).toContain("0x0000000000000000000000000000000000000001,42");
    expect(markup).toContain("合约地址,Token ID");
    expect(markup).toContain('id="nft-quick-contract"');
    expect(markup).not.toContain("选择 TXT/CSV 文件");
  });

  it("adds automatic discovery as the default controlled panel when supplied", () => {
    const markup = renderInput({
      autoDiscovery: <div data-testid="auto-discovery">自动发现内容</div>,
      defaultMode: "auto"
    });

    expect(markup.match(/role="tab"/g)).toHaveLength(4);
    expect(markup).toMatch(/<button(?=[^>]*aria-controls="[^"]+-auto-panel")(?=[^>]*aria-selected="true")[^>]*>自动识别<\/button>/);
    expect(markup).toContain("自动发现内容");
    expect(markup).toContain('id="nft-quick-contract"');
    expect(markup).not.toContain('id="nft-asset-raw-input"');
  });

  it("keeps the controlled contract visible and unchanged across mode switches", () => {
    const contractAddress = "0x0000000000000000000000000000000000000042";
    const modes = ["auto", "manual", "file", "advanced"] as const;

    for (const defaultMode of modes) {
      const markup = renderInput({
        autoDiscovery: <div>自动发现内容</div>,
        contractAddress,
        defaultMode
      });

      expect(markup.match(/id="nft-quick-contract"/g)).toHaveLength(1);
      expect(markup).toMatch(new RegExp(`<input(?=[^>]*id="nft-quick-contract")(?=[^>]*value="${contractAddress}")[^>]*>`));
    }
  });

  it("disables the mode choices and active controls with the component", () => {
    const markup = renderInput({ defaultMode: "file", disabled: true });

    expect(markup.match(/<button(?=[^>]*role="tab")(?=[^>]*disabled="")[^>]*>/g)).toHaveLength(3);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>选择 TXT\/CSV 文件<\/button>/);
  });

  it("announces contract validity next to the shared contract field", () => {
    const markup = renderInput({
      contractAddress: "not-an-address",
      contractStatus: "invalid"
    });

    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain("地址格式不正确");
  });
});
