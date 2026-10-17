import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { PassThrough, type Duplex } from "node:stream";
import type { Socket } from "node:net";
import type { ConnectionOptions, TLSSocket } from "node:tls";
import { describe, expect, it, vi } from "vitest";
import { configuredNetworkProxy, requestWithConfiguredProxy, type ProxyTransportDependencies } from "./network-scan-proxy";

function outgoing() {
  const request = new EventEmitter() as ClientRequest;
  request.end = vi.fn(() => request) as ClientRequest["end"];
  request.destroy = vi.fn(() => { request.emit("close"); return request; });
  return request;
}

function harness() {
  const origin = outgoing();
  const connect = outgoing();
  const tunnel = new PassThrough() as unknown as Socket;
  const secure = new PassThrough() as unknown as TLSSocket;
  const socketReady = vi.fn();
  const originErrors = vi.fn();
  origin.on("error", originErrors);
  let originOptions: RequestOptions | undefined;
  let secureReady: (() => void) | undefined;
  const request = vi.fn<ProxyTransportDependencies["request"]>((_protocol, options) => {
    if (options.method === "CONNECT") return connect;
    originOptions = options;
    return origin;
  });
  const tlsConnect = vi.fn((options: ConnectionOptions, callback: () => void) => { secureReady = callback; return secure; });
  const dependencies: ProxyTransportDependencies = { request, tlsConnect };
  return { dependencies, request, tlsConnect, origin, connect, tunnel, secure, originErrors, socketReady,
    get originOptions() { return originOptions; },
    start() {
      const agent = originOptions?.agent;
      if (!agent || typeof agent === "boolean") throw new Error("Expected a tunnel agent");
      agent.createConnection(originOptions!, (error, socket) => {
        socketReady(error, socket);
        if (error) origin.emit("error", error);
      });
    },
    establish(statusCode = 200, head = Buffer.alloc(0)) {
      connect.emit("connect", { statusCode } as IncomingMessage, tunnel, head);
    },
    finishTls() { secureReady?.(); }
  };
}

const originOptions: RequestOptions = { protocol: "https:", hostname: "web.archive.org", servername: "web.archive.org", method: "GET", path: "/cdx/search/cdx?url=next.overload.build", agent: false,
  headers: { Host: "web.archive.org", Authorization: "Bearer origin-only-fixture" } };

describe("configured public network proxy selection", () => {
  it("uses only the matching protocol's configured proxy and honors lowercase overrides", () => {
    expect(configuredNetworkProxy("https:", "example.com", { HTTPS_PROXY: "http://proxy.example:7897", HTTP_PROXY: "http://other.example:7898" })?.href).toBe("http://proxy.example:7897/");
    expect(configuredNetworkProxy("http:", "example.com", { HTTPS_PROXY: "http://proxy.example:7897" })).toBeUndefined();
    expect(configuredNetworkProxy("http:", "example.com", { HTTP_PROXY: "https://proxy.example:8443" })?.protocol).toBe("https:");
    expect(configuredNetworkProxy("https:", "example.com", { HTTPS_PROXY: "http://ignored.example", https_proxy: "http://preferred.example" })?.hostname).toBe("preferred.example");
  });

  it.each(["example.com", ".example.com", "*.example.com", "example.com:443", "*"])("honors NO_PROXY domain and port rule %s", NO_PROXY => {
    expect(configuredNetworkProxy("https:", "example.com", { HTTPS_PROXY: "http://proxy.example", NO_PROXY })).toBeUndefined();
    expect(configuredNetworkProxy("https:", "sub.example.com", { HTTPS_PROXY: "http://proxy.example", NO_PROXY })).toBeUndefined();
  });

  it("does not bypass an unrelated domain or the wrong port, and supports IP rules", () => {
    expect(configuredNetworkProxy("https:", "evil-example.com", { HTTPS_PROXY: "http://proxy.example", NO_PROXY: "example.com" })?.hostname).toBe("proxy.example");
    expect(configuredNetworkProxy("https:", "example.com", { HTTPS_PROXY: "http://proxy.example", NO_PROXY: "example.com:80" })?.hostname).toBe("proxy.example");
    expect(configuredNetworkProxy("http:", "8.8.8.8", { HTTP_PROXY: "http://proxy.example", NO_PROXY: "8.8.8.8:80" })).toBeUndefined();
    expect(configuredNetworkProxy("https:", "[2606:4700:4700::1111]", { HTTPS_PROXY: "http://proxy.example", NO_PROXY: "[2606:4700:4700::1111]:443" })).toBeUndefined();
  });

  it.each(["socks5://proxy.example", "not-a-url", "http://proxy.example/path", "http://proxy.example/?query=x", "http://user:%0Asecret@proxy.example", "http://user:%ZZ@proxy.example"])("fails closed with a sanitized error for invalid proxy %s", HTTPS_PROXY => {
    expect(() => configuredNetworkProxy("https:", "example.com", { HTTPS_PROXY })).toThrow("配置的代理连接失败");
    try { configuredNetworkProxy("https:", "example.com", { HTTPS_PROXY }); } catch (error) { expect(String(error)).not.toContain("secret"); }
  });
});

describe("DNS-pinned CONNECT requests", () => {
  it("keeps the direct transport unchanged without proxy settings or for an excluded hostname", () => {
    for (const environment of [{}, { HTTPS_PROXY: "http://proxy.example", NO_PROXY: "web.archive.org" }]) {
      const adapter = harness();
      const callback = vi.fn();
      expect(requestWithConfiguredProxy("https:", originOptions, callback, "207.241.237.3", environment, adapter.dependencies)).toBe(adapter.origin);
      expect(adapter.request).toHaveBeenCalledExactlyOnceWith("https:", originOptions, callback);
      expect(adapter.tlsConnect).not.toHaveBeenCalled();
    }
  });

  it("CONNECTs to the vetted IP while retaining the origin Host, SNI and certificate checks", () => {
    const adapter = harness();
    const request = requestWithConfiguredProxy("https:", originOptions, vi.fn(), "207.241.237.3", { HTTPS_PROXY: "http://127.0.0.1:7897" }, adapter.dependencies);
    adapter.start();
    expect(adapter.request.mock.calls[1]).toEqual(["http:", expect.objectContaining({ hostname: "127.0.0.1", port: 7897, method: "CONNECT", path: "207.241.237.3:443", headers: { Host: "207.241.237.3:443" }, agent: false })]);
    expect(adapter.originOptions).toMatchObject({ hostname: "web.archive.org", servername: "web.archive.org", headers: originOptions.headers });
    adapter.establish();
    expect(adapter.tlsConnect).toHaveBeenCalledWith({ socket: adapter.tunnel, host: "web.archive.org", servername: "web.archive.org", rejectUnauthorized: true }, expect.any(Function));
    adapter.finishTls();
    expect(adapter.socketReady).toHaveBeenCalledExactlyOnceWith(null, adapter.secure);
    request.destroy();
    expect(adapter.secure.destroyed).toBe(true);
    expect(adapter.tunnel.destroyed).toBe(true);
  });

  it("sends proxy credentials only on CONNECT and keeps origin authorization separate", () => {
    const adapter = harness();
    const request = requestWithConfiguredProxy("https:", originOptions, vi.fn(), "207.241.237.3", { HTTPS_PROXY: "http://proxy-user:proxy-password@proxy.example:8080" }, adapter.dependencies);
    adapter.start();
    const connectHeaders = adapter.request.mock.calls[1][1].headers;
    expect(connectHeaders).toEqual({ Host: "207.241.237.3:443", "Proxy-Authorization": `Basic ${Buffer.from("proxy-user:proxy-password").toString("base64")}` });
    expect(adapter.originOptions?.headers).toEqual(originOptions.headers);
    expect(JSON.stringify(adapter.originOptions?.headers)).not.toContain("proxy-password");
    request.destroy();
  });

  it("uses CONNECT for HTTP origins and brackets vetted IPv6 addresses", () => {
    const adapter = harness();
    const request = requestWithConfiguredProxy("http:", { ...originOptions, protocol: "http:", hostname: "example.com", servername: undefined }, vi.fn(), "2606:4700:4700::1111", { HTTP_PROXY: "https://proxy.example:8443" }, adapter.dependencies);
    adapter.start();
    expect(adapter.request.mock.calls[1]).toEqual(["https:", expect.objectContaining({ path: "[2606:4700:4700::1111]:80", rejectUnauthorized: true, servername: "proxy.example" })]);
    adapter.establish();
    expect(adapter.socketReady).toHaveBeenCalledExactlyOnceWith(null, adapter.tunnel);
    expect(adapter.tlsConnect).not.toHaveBeenCalled();
    request.destroy();
  });

  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "not-an-ip"])("refuses a non-public CONNECT address %s before contacting a proxy", address => {
    const adapter = harness();
    expect(() => requestWithConfiguredProxy("https:", originOptions, vi.fn(), address, { HTTPS_PROXY: "http://proxy.example" }, adapter.dependencies)).toThrow();
    expect(adapter.request).not.toHaveBeenCalled();
  });

  it("destroys a pending CONNECT when the origin request is cancelled before socket assignment", () => {
    const adapter = harness();
    const request = requestWithConfiguredProxy("https:", originOptions, vi.fn(), "207.241.237.3", { HTTPS_PROXY: "http://proxy.example" }, adapter.dependencies);
    adapter.start();
    request.destroy();
    expect(adapter.connect.destroy).toHaveBeenCalledOnce();
    expect(adapter.socketReady).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "EPROXY" }), undefined);
    adapter.establish();
    expect(adapter.tunnel.destroyed).toBe(true);
    expect(adapter.tlsConnect).not.toHaveBeenCalled();
  });

  it("destroys both tunnel and pending TLS work on timeout-style request destruction", () => {
    const adapter = harness();
    const request = requestWithConfiguredProxy("https:", originOptions, vi.fn(), "207.241.237.3", { HTTPS_PROXY: "http://proxy.example" }, adapter.dependencies);
    adapter.start();
    adapter.establish();
    request.destroy();
    expect(adapter.secure.destroyed).toBe(true);
    expect(adapter.tunnel.destroyed).toBe(true);
    adapter.finishTls();
    expect(adapter.socketReady).toHaveBeenCalledTimes(1);
  });

  it.each([403, 407, 500])("rejects a proxy CONNECT response %i and closes its socket", status => {
    const adapter = harness();
    const request = requestWithConfiguredProxy("https:", originOptions, vi.fn(), "207.241.237.3", { HTTPS_PROXY: "http://user:password@proxy.example" }, adapter.dependencies);
    adapter.start();
    adapter.establish(status);
    expect(adapter.originErrors).toHaveBeenCalledWith(expect.objectContaining({ code: "EPROXY" }));
    expect(String(adapter.originErrors.mock.calls[0][0])).not.toContain("password");
    expect(adapter.tunnel.destroyed).toBe(true);
    expect(adapter.tlsConnect).not.toHaveBeenCalled();
    request.destroy();
  });

  it("retains certificate failures and closes CONNECT work without weakening TLS verification", () => {
    const adapter = harness();
    const request = requestWithConfiguredProxy("https:", originOptions, vi.fn(), "207.241.237.3", { HTTPS_PROXY: "http://proxy.example" }, adapter.dependencies);
    adapter.start();
    adapter.establish();
    adapter.secure.emit("error", Object.assign(new Error("sensitive certificate detail"), { code: "CERT_HAS_EXPIRED" }));
    expect(adapter.originErrors).toHaveBeenCalledWith(expect.objectContaining({ code: "CERT_HAS_EXPIRED", message: "配置的代理连接失败" }));
    expect(adapter.tlsConnect.mock.calls[0][0].rejectUnauthorized).toBe(true);
    expect(adapter.secure.destroyed).toBe(true);
    request.destroy();
  });
});
