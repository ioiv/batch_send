import { describe, expect, it } from "vitest";
import { getFormatOutputGate } from "./FormatGeneratorPage";

describe("getFormatOutputGate", () => {
  it("allows a clean generated result", () => {
    expect(getFormatOutputGate({ duplicates: 0, invalid: 0, output: "address,1" })).toEqual({
      blocked: false,
      canUseOutput: true,
      message: ""
    });
  });

  it("blocks copying and distribution when invalid rows were omitted", () => {
    const gate = getFormatOutputGate({ duplicates: 0, invalid: 2, output: "valid-address,1" });

    expect(gate.blocked).toBe(true);
    expect(gate.canUseOutput).toBe(false);
    expect(gate.message).toContain("2 条输入需要修正");
    expect(gate.message).toContain("不能复制或进入分发");
  });

  it("blocks copying and distribution until duplicate addresses are removed", () => {
    const gate = getFormatOutputGate({ duplicates: 3, invalid: 0, output: "address,1" });

    expect(gate.blocked).toBe(true);
    expect(gate.canUseOutput).toBe(false);
    expect(gate.message).toContain("3 个重复地址需要去重");
  });

  it("reports both blocking conditions together", () => {
    const gate = getFormatOutputGate({ duplicates: 1, invalid: 1, output: "address,1" });

    expect(gate.canUseOutput).toBe(false);
    expect(gate.message).toContain("1 条输入需要修正，1 个重复地址需要去重");
  });

  it("does not enable actions for an empty result", () => {
    expect(getFormatOutputGate({ duplicates: 0, invalid: 0, output: "" }).canUseOutput).toBe(false);
  });
});
