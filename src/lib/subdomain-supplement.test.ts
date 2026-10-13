import { describe, expect, it } from "vitest";
import { MAX_SUBDOMAIN_SUPPLEMENT_CHARACTERS, parseSubdomainSupplement } from "./subdomain-supplement";

describe("pasted subdomain supplement", () => {
  it("extracts concrete names from domain lists, URLs and CSV columns and deduplicates them", () => {
    const input = [
      "\uFEFFhostname,url,ip",
      '"API.EXAMPLE.COM","https://api.example.com/users?q=1",93.184.216.34',
      '"docs.example.com","https://portal.deep.example.com/team",93.184.216.34',
      "见 https://status.example.com/ 以及 cdn.example.com。",
      "//media.example.com/image.png",
      "api.example.com."
    ].join("\r\n");
    const result = parseSubdomainSupplement(input, "https://example.com/");
    expect(result.domains).toEqual(["api.example.com", "docs.example.com", "portal.deep.example.com", "status.example.com", "cdn.example.com", "media.example.com"]);
    expect(result.duplicates).toBe(2);
    expect(result.issues).toEqual([]);
  });

  it("excludes roots, wildcard patterns, sibling suffixes, invalid names and out-of-scope URLs", () => {
    const result = parseSubdomainSupplement([
      "example.com", "*.example.com", "https://*.example.com/path", "evil-example.com",
      "api.example.com.evil.org", "bad_name.example.com", "https://outside.example.org/path/api.example.com?next=api.example.com",
      "https://user:secret@private.example.com/", "ftp://files.example.com/", "api..example.com", "valid.example.com"
    ].join("\n"), "example.com");
    expect(result.domains).toEqual(["valid.example.com"]);
    expect(result.issueCount).toBe(10);
    expect(result.issues.map(issue => issue.line)).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("handles multiple names per CSV/TSV row and fully scoped internationalized names", () => {
    const result = parseSubdomainSupplement("名称\t域名\t网址\n运营\tAPI.例子.公司\thttps://文档.例子.公司/\napi.例子.公司", "例子.公司");
    expect(result.domains).toEqual(["api.xn--fsqu00a.xn--55qx5d", "xn--7dvp7d.xn--fsqu00a.xn--55qx5d"]);
    expect(result.duplicates).toBe(1);
    expect(result.issues).toEqual([]);
  });

  it("does not salvage a valid suffix from malformed or email tokens", () => {
    const result = parseSubdomainSupplement("..api.example.com\nfoo@api.example.com\n-api.example.com\napi.example.com@elsewhere.com\napi.example.com", "example.com");
    expect(result.domains).toEqual(["api.example.com"]);
    expect(result.issueCount).toBe(4);
  });

  it("uses only the hostname of URLs without a scheme, excluding query and path names", () => {
    const result = parseSubdomainSupplement("outside.org?next=hidden.example.com\nvalid.example.com/page/other.example.com?next=hidden.example.com", "example.com");
    expect(result.domains).toEqual(["valid.example.com"]);
    expect(result.issueCount).toBe(1);
  });

  it("limits unique names to 5000 without letting duplicates consume the cap", () => {
    const names = Array.from({ length: 5001 }, (_, index) => `host${index}.example.com`);
    const result = parseSubdomainSupplement([names[0], ...names, names[5000]].join("\n"), "example.com");
    expect(result.domains).toEqual(names.slice(0, 5000));
    expect(result.duplicates).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.issueCount).toBe(1);
    expect(result.issues[0].message).toContain("5,000");
    expect(parseSubdomainSupplement(Array.from({ length: 5010 }, (_, index) => `host${index}.example.com`).join("\n"), "example.com").issueCount).toBe(10);
  });

  it("bounds text and issue metadata and reports missing target information", () => {
    expect(parseSubdomainSupplement("", "")).toMatchObject({ domains: [], issues: [] });
    expect(parseSubdomainSupplement("api.example.com", "")).toMatchObject({ domains: [], issueCount: 1,
      issues: [{ line: 1, message: "请先填写有效的主域名，再解析外部结果。" }] });
    expect(parseSubdomainSupplement("x".repeat(MAX_SUBDOMAIN_SUPPLEMENT_CHARACTERS + 1), "example.com"))
      .toMatchObject({ domains: [], issues: [{ line: 1, message: "补充内容不能超过 2 MB，请分批粘贴。" }] });
    const result = parseSubdomainSupplement(Array(100).fill("unrecognized").join("\n"), "example.com");
    expect(result.issueCount).toBe(100);
    expect(result.issues).toHaveLength(20);
  });

  it("ignores blank lines, comments and recognizable result table headers", () => {
    expect(parseSubdomainSupplement("# exported result\n\nHostname,IP Address,Status\nvalid.example.com", "example.com"))
      .toMatchObject({ domains: ["valid.example.com"], issues: [] });
  });
});
