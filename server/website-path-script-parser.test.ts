import { describe, expect, it } from "vitest";
import { extractWebsiteScriptPaths } from "./website-path-script-parser";

const urls = (source: string) => [...new Set(extractWebsiteScriptPaths(source).candidates.map(candidate => candidate.url))];

describe("syntax-led website script discovery", () => {
  it("finds the observed mint config through the actual identity wrapper shape", () => {
    const source = `
      async function Fe(e,t={}) {
        const n=new Headers(t.headers);
        n.set('Accept','application/json');
        const s=await fetch(e,{...t,headers:n,credentials:'include'});
        const i=await s.text();
        if(!s.ok)throw Error(i);
        return i;
      }
      let lu=null;
      function uu(){return lu??=Fe('/api/mint/config').finally(()=>{lu=null}),lu}
    `;
    expect(extractWebsiteScriptPaths(source)).toMatchObject({
      partial: false,
      candidates: [{ url: "/api/mint/config", kind: "request" }],
    });
  });

  it("resolves constant prefixes, templates, and one helper forwarding layer", () => {
    const source = `
      const I5='/api';
      async function de(e,t) { const r=await fetch(
        \`\${I5}\${e}\`,{...t,credentials:'include'});return r.json() }
      function post(path,data){return de(path,{method:'POST',body:JSON.stringify(data)})}
      de('/config'); post('/beta/holder',{});
    `;
    expect(urls(source)).toEqual(["/api/config", "/api/beta/holder"]);
  });

  it("resolves the observed support empty build prefix without executing source", () => {
    expect(urls(`const types={perReport:12},p=''.trim()||'';
      async function d(n,t,a){return fetch(\`\${p}/api/support\${n}\`,{method:a?'POST':'GET'})}
      const L=(n,t)=>d('/reports',t,n);`)).toEqual(["/api/support/reports"]);
  });

  it("keeps static pathnames when only the query or hash is dynamic", () => {
    expect(urls(`
      const p='/api';
      fetch(p+'/search?q='+term);
      fetch(\`/api/config?account=\${account}\`);
      fetch(\`/api/items/\${id}?q=static\`);
      fetch('/api/'+segment+'/details');
      fetch('/api/config#'+tab);
    `)).toEqual(["/api/search", "/api/config"]);
  });

  it("recognizes browser fetch, axios imports and XHR, without treating arbitrary get methods as HTTP", () => {
    expect(extractWebsiteScriptPaths(`
      import http from 'axios';
      http.get('/api/axios');
      axios.post('/api/post',{});
      axios({url:'/api/options',method:'GET'});
      window.fetch('/api/window');
      const xhr=new XMLHttpRequest();xhr.open('GET','/api/xhr');
      const headers=new Headers();headers.get('/not-a-request');
      sdk.get('/sdk-example'); const cfg={docsPath:'/documentation',path:'/tmp'};
      const example='fetch("/example")';
    `).candidates).toEqual([
      { url: "/api/axios", kind: "request", method: "GET" },
      { url: "/api/post", kind: "request", method: "POST" },
      { url: "/api/options", kind: "request", method: "GET" },
      { url: "/api/window", kind: "request", method: "GET" },
      { url: "/api/xhr", kind: "request", method: "GET" },
    ]);
  });

  it("discovers only real module import syntax", () => {
    expect(extractWebsiteScriptPaths(`
      import './core.js'; export {x} from './other.js';
      import('./lazy.js'); import('package/path'); importScripts('worker.js');
      const example='./example.js'; const docs='import("/fake.js")';
    `).candidates).toEqual([
      { url: "./core.js", kind: "import" },
      { url: "./other.js", kind: "import" },
      { url: "./lazy.js", kind: "import" },
      { url: "./worker.js", kind: "import", documentRelative: true },
    ]);
  });

  it("retains complete conditional paths and relative request URLs", () => {
    expect(urls(`fetch(flag?'/one':'/two');fetch('/api/'+(flag?'a':'b'));fetch('config');fetch('/my%20file');`)).toEqual(["/one", "/two", "/api/a", "/api/b", "config", "/my%20file"]);
  });

  it("finds compiled JSX links without promoting arbitrary props", () => {
    expect(urls(`x.jsx('a',{href:'/one'});React.createElement(Link,{to:'/two'});x.jsxs('div',{href:'/fake'});`)).toEqual(["/one", "/two"]);
  });

  it("uses lexical bindings for identical parameter names and shadowed request functions", () => {
    const source = `
      const prefix='/api';function request(path){return fetch(prefix+path)}
      request('/config');
      function unrelated(path){return path}
      function shadow(request){request('/fake')}
      function shadowFetch(fetch){fetch('/fake-fetch')}
      function scoped(){const prefix='/other';fetch(prefix+'/real')}
    `;
    expect(urls(source)).toEqual(["/api/config", "/other/real"]);
  });

  it.each([
    "const prefix='/api';prefix='/other';function request(path){return fetch(prefix+path)}request('/config');",
    "let prefix='/api';function request(path){return fetch(prefix+path)}request('/config');",
    "const prefix='/api';function request(path){path='/other';return fetch(prefix+path)}request('/config');",
    "const prefix='/api';function request(path){[path]=other;return fetch(prefix+path)}request('/config');",
    "function request(path){return fetch(path)}request=other;request('/config');",
    "const fetch=custom;fetch('/api/fake');",
    "const {fetch}=custom;fetch('/api/fake');",
    "fetch=custom;fetch('/api/fake');",
    "window.fetch=custom;window.fetch('/api/fake');",
    "axios.get=custom;axios.get('/api/fake');",
    "import http from 'axios';http.get=custom;http.get('/api/fake');",
    "function request(path){return other(path)}request('/api/fake');",
    "{fetch(prefix+'/before')}const prefix='/api';",
  ])("fails closed for mutable or unproven requests: %s", source => {
    expect(urls(source)).toEqual([]);
  });

  it("extracts browser navigation and JSX links with evidence", () => {
    expect(extractWebsiteScriptPaths(`
      location.assign('/login');window.location.href='/account';
      history.pushState({},'', '/settings');
      const element=<a href='/about'/>;
      const config={href:'/example'};
    `).candidates).toEqual([
      { url: "/account", kind: "navigation" },
      { url: "/about", kind: "navigation" },
      { url: "/login", kind: "navigation" },
      { url: "/settings", kind: "navigation" },
    ]);
  });

  it("walks nested static route tables without promoting metadata and arbitrary path objects", () => {
    expect(extractWebsiteScriptPaths(`const routes=[
      {path:'/dashboard',children:[{path:'settings'},{children:[{path:'help'}]}]},
      {path:'/users/:id',children:[{path:'edit'},{path:'/login'}]},
      {path:'/safe',meta:{path:'/metadata'}}
    ];const config={path:'/tmp'};createBrowserRouter(routes);`).candidates).toEqual([
      { url: "/dashboard", kind: "route", clientRoute: true },
      { url: "/dashboard/settings", kind: "route", clientRoute: true },
      { url: "/dashboard/help", kind: "route", clientRoute: true },
      { url: "/login", kind: "route", clientRoute: true },
      { url: "/safe", kind: "route", clientRoute: true },
    ]);
  });

  it("rejects modified route arrays", () => {
    expect(urls(`const routes=[{path:'/gone'}];routes.pop();createBrowserRouter(routes);`)).toEqual([]);
    expect(urls(`const routes=[{path:'/gone'}];mutate(routes);createBrowserRouter(routes);`)).toEqual([]);
    expect(urls(`const routes=[{path:'/gone'}];const alias=routes;alias.pop();createBrowserRouter(routes);`)).toEqual([]);
  });

  it.each([
    "createHashRouter(routes)", "createMemoryRouter(routes)", "useRoutes(routes)",
    "createBrowserRouter(routes,{basename:'/app'})",
    "createRouter({history:createWebHashHistory(),routes})",
    "createRouter({history:createWebHistory('/app'),routes})",
  ])("does not turn non-root client routes into HTTP paths: %s", call => {
    expect(urls(`const routes=[{path:'/only-client'}];${call}`)).toEqual([]);
  });

  it("bounds route alias chains and preserves independent imports", () => {
    const source = `import './keep.js';const r0=[];` + Array.from({ length: 150 }, (_, index) => `const r${index + 1}=r${index};`).join("") + `createBrowserRouter(r150)`;
    const result = extractWebsiteScriptPaths(source);
    expect(result).toMatchObject({ partial: true, candidates: [{ url: "./keep.js", kind: "import" }] });
  });

  it("bounds module imports independently so dependencies cannot starve request paths", () => {
    const source = Array.from({ length: 2001 }, (_, index) => `import './chunk-${index}.js';`).join("")
      + "fetch('/api/after-imports');";
    const result = extractWebsiteScriptPaths(source);
    expect(result.candidates.filter(candidate => candidate.kind === "import")).toHaveLength(2000);
    expect(result.candidates).toContainEqual({ url: "/api/after-imports", kind: "request", method: "GET" });
    expect(result.partial).toBe(true);
  });

  it("prioritizes explicit API requests over a full navigation quota", () => {
    const source = Array.from({ length: 2000 }, (_, index) => `jsx('a',{href:'/navigation-${index}'});`).join("") + "fetch('/api/important');";
    const result = extractWebsiteScriptPaths(source);
    expect(result.candidates).toHaveLength(2000);
    expect(result.candidates[0]).toEqual({ url: "/api/important", kind: "request", method: "GET" });
    expect(result.partial).toBe(true);
  });

  it("records declared request methods without executing any request", () => {
    const result = extractWebsiteScriptPaths(`
      fetch('/default');fetch('/post',{method:'post'});
      const options={method:'PATCH'};fetch('/constant',options);
      axios.put('/axios',{});axios({url:'/axios-config',method:'DELETE'});
      const xhr=new XMLHttpRequest();xhr.open('HEAD','/xhr');
      fetch('/overridden',{method:'POST',...unknown});
      fetch('/final',{...unknown,method:'OPTIONS'});
    `);
    expect(result.candidates.filter(candidate => candidate.kind === "request")).toEqual([
      { url: "/default", kind: "request", method: "GET" },
      { url: "/post", kind: "request", method: "POST" },
      { url: "/constant", kind: "request", method: "PATCH" },
      { url: "/axios", kind: "request", method: "PUT" },
      { url: "/axios-config", kind: "request", method: "DELETE" },
      { url: "/xhr", kind: "request", method: "HEAD" },
      { url: "/overridden", kind: "request" },
      { url: "/final", kind: "request", method: "OPTIONS" },
    ]);
  });

  it("propagates static options and defaults through transparent request wrappers", () => {
    const source = `
      function request(path,options={}){return fetch(path,{...options,credentials:'include'})}
      function post(path,data){return request(path,{method:'POST',body:JSON.stringify(data)})}
      request('/default');request('/put',{method:'PUT'});post('/nested',{});
      function explicit(path,method){return fetch(path,{method})}explicit('/method','PATCH');
      function field(path,options){return fetch(path,{method:options.method})}field('/field',{method:'DELETE'});
    `;
    expect(extractWebsiteScriptPaths(source).candidates).toEqual([
      { url: "/default", kind: "request", method: "GET" },
      { url: "/put", kind: "request", method: "PUT" },
      { url: "/nested", kind: "request", method: "POST" },
      { url: "/method", kind: "request", method: "PATCH" },
      { url: "/field", kind: "request", method: "DELETE" },
    ]);
  });

  it("retains distinct methods for the same URL and leaves dynamic methods unknown", () => {
    expect(extractWebsiteScriptPaths(`fetch('/same');fetch('/same',{method:'POST'});fetch('/unknown',{method:verb});`).candidates).toEqual([
      { url: "/same", kind: "request", method: "GET" },
      { url: "/same", kind: "request", method: "POST" },
      { url: "/unknown", kind: "request" },
    ]);
  });

  it("preserves conditional option methods while respecting earlier spread fallbacks", () => {
    const result = extractWebsiteScriptPaths(`
      fetch('/body',{method:flag?'GET':'POST',...flag?{}:{body:'x'}});
      fetch('/fallback',{method:'PUT',...flag?{}:{method:'POST'}});
      fetch('/empty',flag?{signal:cancel}:{});
    `);
    expect(result.candidates).toEqual([
      { url: "/body", kind: "request", method: "GET" },
      { url: "/body", kind: "request", method: "POST" },
      { url: "/fallback", kind: "request", method: "POST" },
      { url: "/fallback", kind: "request", method: "PUT" },
      { url: "/empty", kind: "request", method: "GET" },
    ]);
  });

  it("retains the correct document or module base for worker entry points", () => {
    expect(extractWebsiteScriptPaths(`
      new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
      new SharedWorker('/shared.js');navigator.serviceWorker.register('/sw.js');
      new Worker('worker.js');navigator.serviceWorker.register('./relative-sw.js');
      new Worker(new URL('./wrong.js',location.href));
      new URL('./unconsumed.js',import.meta.url);
      function local(Worker){new Worker('/fake.js')}
    `).candidates).toEqual([
      { url: "./worker.js", kind: "import", workerContext: true },
      { url: "/shared.js", kind: "import", documentRelative: true, workerContext: true },
      { url: "/sw.js", kind: "import", documentRelative: true, workerContext: true },
      { url: "./worker.js", kind: "import", documentRelative: true, workerContext: true },
      { url: "./relative-sw.js", kind: "import", documentRelative: true, workerContext: true },
    ]);
  });

  const vite = (entries: string[]) => `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=${JSON.stringify(entries)})))=>i.map(i=>d[i]);`;
  it("follows only referenced Vite manifest entries and anchors their asset base to real imports", () => {
    const result = extractWebsiteScriptPaths(vite(['assets/core.js','assets/used.js','assets/unused.js','assets/style.css'])
      + `import './core.js';preload(()=>import('./core.js'),__vite__mapDeps([1,3]));`);
    expect(result.candidates).toEqual([
      { url: "./core.js", kind: "import" },
      { url: "./used.js", kind: "import" },
    ]);
  });

  it("rejects uncalled, mutated, escaped or base-ambiguous Vite dependency tables", () => {
    expect(urls(vite(['assets/unreferenced.js']))).toEqual([]);
    expect(urls(vite(['assets/uncertain.js']) + '__vite__mapDeps([0]);')).toEqual([]);
    expect(urls(vite(['assets/core.js','assets/fake.js']) + "import './core.js';__vite__mapDeps.f[1]='other';__vite__mapDeps([1]);")).toEqual(['./core.js']);
    expect(urls(vite(['assets/core.js','assets/fake.js']) + "import './core.js';const alias=__vite__mapDeps.f;alias[1]='other';__vite__mapDeps([1]);")).toEqual(['./core.js']);
  });

  it("recovers complete literal requests and imports before broken trailing syntax", () => {
    const result = extractWebsiteScriptPaths(`import './core.js'; fetch('/api/before');
      axios.get('/api/axios'); const incomplete=(`);
    expect(result.partial).toBe(true);
    expect(result.candidates).toEqual([
      { url: "./core.js", kind: "import" },
      { url: "/api/before", kind: "request" },
      { url: "/api/axios", kind: "request" },
    ]);
  });

  it("does not recover unfinished request literals, code examples or wrapper guesses", () => {
    expect(urls(`const path='/api/example';
      const text='fetch("/fake")'; request('/unknown-wrapper');
      fetch('/api/incomplete`)).toEqual([]);
  });

  it("keeps recovery conservative around shadows and mismatched delimiters", () => {
    expect(urls(`function local(x,fetch){fetch('/fake')}const unfinished=(`)).toEqual([]);
    expect(urls(`fetch('/incomplete-options',{signal:);const unfinished=(`)).toEqual([]);
    expect(urls(`const from='/prefix';from '/fake.js';const unfinished=(`)).toEqual([]);
  });

  it("does not trust bindings or route tables when unread trailing source could change them", () => {
    const source = `import './keep.js';const prefix='/api';
      function request(path){return fetch(prefix+path)}request('/wrapped');
      fetch(prefix+'/joined');fetch('/api/direct');
      const routes=[{path:'/unproven-route'}];`;
    const result = extractWebsiteScriptPaths(source, { truncated: true });
    expect(result).toMatchObject({ partial: true, candidates: [
      { url: "./keep.js", kind: "import" },
      { url: "/api/direct", kind: "request" },
    ] });
  });

  it("preserves complete literal evidence before a UTF-8 byte limit", () => {
    const prefix = "import './keep.js';fetch('/api/direct');";
    const result = extractWebsiteScriptPaths(prefix + "const unicode='汉字';", {
      maxBytes: Buffer.byteLength(prefix + "const unicode='汉", "utf8") - 1,
    });
    expect(result).toMatchObject({ partial: true, candidates: [
      { url: "./keep.js", kind: "import" },
      { url: "/api/direct", kind: "request" },
    ] });
  });

  it("reports cancellation, byte, node and time limits without inferring partial bindings", () => {
    const source = "const p='/api';fetch(p+'/config')";
    expect(extractWebsiteScriptPaths(source, { maxBytes: 8 })).toMatchObject({ candidates: [], partial: true });
    expect(extractWebsiteScriptPaths(source, { maxNodes: 2 })).toMatchObject({ candidates: [], partial: true });
    expect(extractWebsiteScriptPaths(source, { deadline: 0 })).toMatchObject({ candidates: [], partial: true });
    expect(extractWebsiteScriptPaths(source, { signal: AbortSignal.abort() })).toMatchObject({ candidates: [], partial: true });
  });

  it("recovers module imports on both sides of a full request-token and AST node budget", () => {
    const source = "import './before.js';" + Array.from({ length: 500 }, (_, index) => `const v${index}=${index};`).join("")
      + "import('./after.js');fetch(prefix+'/unproven');";
    expect(extractWebsiteScriptPaths(source, { maxNodes: 16 })).toMatchObject({ partial: true, candidates: [
      { url: "./before.js", kind: "import" },
      { url: "./after.js", kind: "import" },
    ] });
  });

  it("recovers long module import clauses without storing every imported binding", () => {
    const clause = Array.from({ length: 300 }, (_, index) => `x as value${index}`).join(",");
    const source = `import {${clause}} from './many-bindings.js';const unfinished=(`;
    expect(extractWebsiteScriptPaths(source, { maxNodes: 8 })).toMatchObject({ partial: true, candidates: [
      { url: "./many-bindings.js", kind: "import" },
    ] });
  });

  it("keeps explicit literal requests independent of the AST limit but respects late API shadows", () => {
    const padding = Array.from({ length: 500 }, (_, index) => `const v${index}=${index};`).join("");
    expect(extractWebsiteScriptPaths("fetch('/before');" + padding + "fetch('/after');", { maxNodes: 8 })).toMatchObject({ partial: true, candidates: [
      { url: "/before", kind: "request" },
      { url: "/after", kind: "request" },
    ] });
    expect(extractWebsiteScriptPaths("import './keep.js';fetch('/unsafe');" + padding + "const fetch=custom;const incomplete=(", { maxNodes: 8 })).toMatchObject({ partial: true, candidates: [
      { url: "./keep.js", kind: "import" },
    ] });
  });

  it("never turns partial dynamic module prefixes into import evidence during recovery", () => {
    expect(extractWebsiteScriptPaths("import('./prefix/'+name);import('./unfinished.js';const incomplete=(").candidates).toEqual([]);
  });

  it("does not mistake prototype property names for closing delimiters during recovery", () => {
    expect(extractWebsiteScriptPaths("import('./module.js',{constructor:kind,toString:other});fetch('/api/config',{constructor:kind});const incomplete=(").candidates).toEqual([
      { url: "./module.js", kind: "import" },
      { url: "/api/config", kind: "request" },
    ]);
  });

  it("reports bounded recovery depth only when fallback evidence is actually used", () => {
    const source = "import('./deep.js',{options:" + "[".repeat(260) + "0" + "]".repeat(260) + "});";
    expect(extractWebsiteScriptPaths(source)).toMatchObject({ partial: false, warnings: [], candidates: [{ url: "./deep.js", kind: "import" }] });
    expect(extractWebsiteScriptPaths(source + "const incomplete=(")).toMatchObject({ partial: true, candidates: [] });
    expect(extractWebsiteScriptPaths(source + "const incomplete=(").warnings).toContain("达到独立请求和模块恢复括号深度上限，已保留确认结果");
  });

  it("completes bindings after a large vendor prefix beyond the old fixed node ceiling", () => {
    const source = "import './vendor-dependency.js';/*" + "vendor ".repeat(50000) + "*/const values=["
      + "0,".repeat(360000) + "0];function request(path){return fetch(path)}request('/api/after-large-bundle');";
    const result = extractWebsiteScriptPaths(source, { maxDurationMs: 5000 });
    expect(result).toMatchObject({ partial: false, warnings: [], candidates: [
      { url: "./vendor-dependency.js", kind: "import" },
      { url: "/api/after-large-bundle", kind: "request", method: "GET" },
    ] });
  }, 10000);
});
