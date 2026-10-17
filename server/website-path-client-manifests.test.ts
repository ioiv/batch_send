import { describe, expect, it, vi } from "vitest";
import { extractPublishedClientRoutes } from "./website-path-client-manifests";
import { javascriptTokens } from "./website-path-javascript";

const helper = 'function route(value){return `${prefix}/${value}`}';
const manifest = (navigation = "pages.map(page=>({to:route(page.slug)}))", extra = "") => `
  const prefix='/docs';
  const pages=[{slug:'introduction',analytics:{slug:'not-a-page'}},{slug:'pulling'},{slug:'items'}];
  ${helper}
  const routes=[{path:\`${"${prefix}"}/:slug\`}];
  const links=${navigation};${extra}`;
const expected = ["/docs/introduction", "/docs/pulling", "/docs/items"];

describe("published navigation route compatibility", () => {
  it("recovers only a navigation array's direct fields and reuses caller tokens", () => {
    const script = 'const css=`outer ${ok?`inner ${size}`:"plain"}`;const pattern=/["\'`]/g;' +
      manifest(undefined, "const unrelated={slug:'analytics-event'};const text='/unrelated';");
    expect(extractPublishedClientRoutes(script, { tokens: javascriptTokens(script) })).toEqual({ urls: expected, warnings: [], partial: false });
  });

  it.each([
    'const route=value=>`${prefix}/${value}`;',
    'const route=(value)=>`${prefix}/${value}`;',
    'const route=(value)=>{return `${prefix}/${value}`;};',
    'const route=value=>{return `${prefix}/${value}`};'
  ])("supports a single-parameter arrow helper: %s", replacement => {
    expect(extractPublishedClientRoutes(manifest().replace(helper, replacement)).urls).toEqual(expected);
  });

  it.each([
    "pages.map(page=>({to:route(analytics.slug)}))",
    "pages.map(page=>({...page,slug:'changed'})).map(page=>({to:route(page.slug)}))"
  ])("does not infer URLs from an unrelated or rewritten collection: %s", navigation => {
    expect(extractPublishedClientRoutes(manifest(navigation)).urls).toEqual([]);
  });

  it("rejects a dynamically reassigned prefix", () => {
    const script = manifest().replace("const prefix='/docs';", "let prefix='/docs';prefix=getBase();");
    expect(extractPublishedClientRoutes(script).urls).toEqual([]);
  });

  it.each([
    "function change(){prefix='/other'}change();",
    "prefix += '/other';",
  ])("rejects prefix writes outside its declaration: %s", mutation => {
    const script = manifest().replace("const prefix='/docs';", "let prefix='/docs';").replace("const links=", mutation + "const links=");
    expect(extractPublishedClientRoutes(script).urls).toEqual([]);
  });

  it("rejects a helper capturing a shadowed prefix parameter", () => {
    const script = manifest().replace(helper, `function outer(prefix){${helper}return pages.map(page=>({to:route(page.slug)}))}`);
    expect(extractPublishedClientRoutes(script).urls).toEqual([]);
  });

  it("checks actual bindings without rejecting unrelated same-name function parameters", () => {
    expect(extractPublishedClientRoutes(manifest() + "function unrelated(prefix){prefix='/elsewhere';return prefix}").urls).toEqual(expected);
  });

  it("rejects writes to an immutable prefix even when the write is nested or augmented", () => {
    expect(extractPublishedClientRoutes(manifest().replace("const links=", "function change(){prefix='/other'}const links=")).urls).toEqual([]);
    expect(extractPublishedClientRoutes(manifest().replace("const links=", "prefix += '/other';const links=")).urls).toEqual([]);
  });

  it.each([
    'pages.map(page=>({note:"to:route(page.slug)"}))',
    "pages.map(page=>({note:'href:route(page.slug)'}))",
    'pages.map(page=>({note:`to:route(page.slug)`}))'
  ])("does not take navigation examples inside strings as route evidence: %s", navigation => {
    expect(extractPublishedClientRoutes(manifest(navigation)).urls).toEqual([]);
  });

  it.each([
    "pages[0].slug=getDynamicSlug();",
    "pages[0]['slug']=getDynamicSlug();",
    "pages.push({slug:'unpublished'});",
    "const first=pages[0];first.slug=getDynamicSlug();",
    "mutate(pages);",
    "pages=loadPages();"
  ])("rejects a mutated or escaped navigation collection: %s", mutation => {
    expect(extractPublishedClientRoutes(manifest().replace("const links=", `${mutation}const links=`)).urls).toEqual([]);
  });

  it.each([
    "pages.map(page=>{page.slug=getDynamicSlug();return {to:route(page.slug)}})",
    "pages.map(page=>{mutate(page);return {to:route(page.slug)}})",
    "pages.filter(page=>{delete page.slug;return true}).map(page=>({to:route(page.slug)}))"
  ])("rejects element mutations inside navigation callbacks: %s", navigation => {
    expect(extractPublishedClientRoutes(manifest(navigation)).urls).toEqual([]);
  });

  it("rejects a reassigned or shadowed route helper", () => {
    expect(extractPublishedClientRoutes(manifest().replace("const links=", "route=dynamicRoute;const links=")).urls).toEqual([]);
    expect(extractPublishedClientRoutes(manifest().replace("const links=", "function route(value){return value}const links=")).urls).toEqual([]);
  });

  it("retains grouped arrays of original pages with distinct callback names", () => {
    const script = manifest().replace("const links=pages.map(page=>({to:route(page.slug)}));", "const groups=pages.reduce((acc,item)=>{const group=acc.at(-1);return group?.name===item.group?[...acc.slice(0,-1),{...group,pages:[...group.pages,item]}]:[...acc,{name:item.group,pages:[item]}]},[]);const links=groups.map(group=>group.pages.map(item=>({to:route(item.slug)})));");
    expect(extractPublishedClientRoutes(script).urls).toEqual(expected);
  });

  it("resolves outputs against the caller's base without collecting arbitrary absolute strings", () => {
    expect(extractPublishedClientRoutes(manifest(undefined, 'fetch("/api/unrelated");'), { baseUrl: "https://example.com/assets/app.js" }).urls)
      .toEqual(expected.map(path => `https://example.com${path}`));
    expect(extractPublishedClientRoutes('const path="/foo";fetch("/api/unrelated");').urls).toEqual([]);
  });

  it("reports the 20-route-template bound while keeping previously proven routes", () => {
    const script = manifest() + Array.from({ length: 30 }, (_, index) => 'const extra' + index + '={path:`${prefix}/:parameter' + index + '`};').join("");
    const result = extractPublishedClientRoutes(script);
    expect(result.urls).toEqual(expected);
    expect(result.partial).toBe(true);
    expect(result.warnings).toContain("达到静态前端路由清单读取上限，已保留解析结果");
  });

  it("reports the 32-array bound without mistaking unrelated SDK strings for lost route data", () => {
    const script = manifest() + Array.from({ length: 33 }, (_, index) => `const decoy${index}=[{slug:'unused-${index}'}];`).join("");
    const arrays = extractPublishedClientRoutes(script);
    expect(arrays.urls).toEqual(expected);
    expect(arrays.warnings).toContain("达到静态前端路由数组读取上限，已保留解析结果");
    const literals = extractPublishedClientRoutes("const values=[" + Array.from({ length: 20001 }, () => "'unused'").join(",") + "];");
    expect(literals).toEqual({ urls: [], warnings: [], partial: false });
  });

  it("finds an actual published route manifest after more than 20,000 unrelated strings", () => {
    const prefix = "const values=[" + Array.from({ length: 20001 }, () => "'unused'").join(",") + "];";
    expect(extractPublishedClientRoutes(prefix + manifest())).toEqual({ urls: expected, warnings: [], partial: false });
  });

  it("does not spend the manifest budget on SDK parameter strings without a navigation helper", () => {
    const script = 'const endpoint={path:"/api/v1/apps/:app_id",method:"GET"};const values=['
      + Array.from({ length: 28000 }, () => "'unrelated'").join(",") + "];";
    expect(extractPublishedClientRoutes(script)).toEqual({ urls: [], warnings: [], partial: false });
  });

  it("stops on deadline or cancellation", () => {
    const controller = new AbortController();
    controller.abort();
    expect(extractPublishedClientRoutes(manifest(), { signal: controller.signal })).toMatchObject({ urls: [], partial: true });
    expect(extractPublishedClientRoutes(manifest(), { deadline: 0 })).toMatchObject({ urls: [], partial: true });
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now += 50);
    try {
      expect(extractPublishedClientRoutes(manifest())).toMatchObject({ urls: [], partial: true,
        warnings: ["达到静态前端路由解析时间上限，已保留解析结果"] });
    } finally { clock.mockRestore(); }
  });

  it("excludes incomplete literals and parameter values containing URL delimiters", () => {
    const script = manifest().replace("{slug:'items'}", "{slug:'items?admin=true'},{slug:'../outside'},{slug:'%7Bdynamic%7D'}");
    expect(extractPublishedClientRoutes(script).urls).toEqual(expected.slice(0, 2));
    expect(extractPublishedClientRoutes(manifest().replace("{slug:'items'}", "{slug:'incomplete" )).urls).toEqual([]);
  });
});
