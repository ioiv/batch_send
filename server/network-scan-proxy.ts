import { Agent as HttpAgent, request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";
import { isPublicIp } from "./network-scan.js";

type Protocol = "http:" | "https:";
type ProxyEnvironment = Readonly<Record<string, string | undefined>>;
export interface ProxyTransportDependencies {
  request(protocol: Protocol, options: RequestOptions, callback?: (response: IncomingMessage) => void): ClientRequest;
  tlsConnect(options: ConnectionOptions, callback: () => void): TLSSocket;
}
const defaults: ProxyTransportDependencies = {
  request: (protocol, options, callback) => protocol === "https:" ? httpsRequest(options, callback) : httpRequest(options, callback),
  tlsConnect: (options, callback) => tlsConnect(options, callback)
};

function proxyFailure(error?: unknown): Error {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : "EPROXY";
  return Object.assign(new Error("配置的代理连接失败"), { code });
}

function bypassProxy(hostname: string, port: number, value: string | undefined): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  return (value ?? "").split(",").some(raw => {
    let rule = raw.trim().toLowerCase();
    if (rule === "*") return true;
    if (!rule) return false;
    const withPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(rule);
    if (withPort) {
      if (Number(withPort[2]) !== port) return false;
      rule = withPort[1];
    }
    rule = rule.replace(/^\[|\]$/g, "").replace(/\.$/, "").replace(/^\*?\./, "");
    return host === rule || !isIP(host) && !isIP(rule) && host.endsWith(`.${rule}`);
  });
}

/** Only administrator-provided environment settings participate in proxy selection. */
export function configuredNetworkProxy(protocol: Protocol, hostname: string, environment: ProxyEnvironment = process.env): URL | undefined {
  const port = protocol === "https:" ? 443 : 80;
  if (bypassProxy(hostname, port, environment.no_proxy ?? environment.NO_PROXY)) return;
  const configured = protocol === "https:" ? environment.https_proxy ?? environment.HTTPS_PROXY : environment.http_proxy ?? environment.HTTP_PROXY;
  if (!configured) return;
  try {
    if (configured.length > 4096 || /[\u0000-\u0020\u007f]/.test(configured)) throw proxyFailure();
    const url = new URL(configured);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.pathname !== "/" && url.pathname !== "" || url.search || url.hash) throw proxyFailure();
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    if (credentials.length > 2048 || /[\u0000-\u001f\u007f]/.test(credentials)) throw proxyFailure();
    return url;
  } catch { throw proxyFailure(); }
}

/** CONNECT receives only a checked public IP; Host, SNI and certificate checks keep the original hostname. */
export function requestWithConfiguredProxy(protocol: Protocol, options: RequestOptions, callback: (response: IncomingMessage) => void,
  address: string, environment: ProxyEnvironment = process.env, dependencies: ProxyTransportDependencies = defaults): ClientRequest {
  const hostname = String(options.hostname ?? "").replace(/^\[|\]$/g, "");
  const proxy = configuredNetworkProxy(protocol, hostname, environment);
  if (!proxy) return dependencies.request(protocol, options, callback);
  if (!isPublicIp(address) || options.port !== undefined && Number(options.port) !== (protocol === "https:" ? 443 : 80)) throw proxyFailure();
  const authority = `${isIP(address) === 6 ? `[${address}]` : address}:${protocol === "https:" ? 443 : 80}`;
  const proxyHostname = proxy.hostname.replace(/^\[|\]$/g, "");
  const headers: Record<string, string> = { Host: authority };
  if (proxy.username || proxy.password) headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
  let connectRequest: ClientRequest | undefined;
  let tunnel: Socket | undefined;
  let secure: TLSSocket | undefined;
  let closed = false;
  let connected = false;
  let complete: ((error: Error | null, socket?: Duplex) => void) | undefined;
  const agent = protocol === "https:" ? new HttpsAgent({ keepAlive: false, maxSockets: 1 }) : new HttpAgent({ keepAlive: false, maxSockets: 1 });
  const stop = () => {
    if (closed) return;
    closed = true;
    connectRequest?.destroy();
    secure?.destroy();
    tunnel?.destroy();
    complete?.(proxyFailure());
  };
  agent.createConnection = (_connectionOptions, ready) => {
    let settled = false;
    complete = (error, socket) => {
      if (settled) return;
      settled = true;
      ready?.(error, socket!);
    };
    if (closed) { queueMicrotask(() => complete?.(proxyFailure())); return undefined; }
    const fail = (error?: unknown) => {
      if (settled || closed) return;
      complete?.(proxyFailure(error));
      stop();
    };
    try {
      connectRequest = dependencies.request(proxy.protocol as Protocol, { protocol: proxy.protocol, hostname: proxyHostname,
        port: proxy.port ? Number(proxy.port) : proxy.protocol === "https:" ? 443 : 80,
        ...(proxy.protocol === "https:" ? { rejectUnauthorized: true, ...(isIP(proxyHostname) ? {} : { servername: proxyHostname }) } : {}),
        method: "CONNECT", path: authority, headers, agent: false });
      connectRequest.once("error", fail);
      connectRequest.once("response", response => { response.destroy(); fail(); });
      connectRequest.once("close", () => { if (!connected) fail(); });
      connectRequest.once("connect", (response: IncomingMessage, socket: Socket, head: Buffer) => {
        tunnel = socket;
        if (closed || settled) { socket.destroy(); return; }
        connected = true;
        socket.once("error", fail);
        if (response.statusCode !== 200) { fail(); return; }
        if (head.length) socket.unshift(head);
        if (protocol === "http:") { complete?.(null, socket); return; }
        try {
          secure = dependencies.tlsConnect({ socket, host: hostname, ...(isIP(hostname) ? {} : { servername: hostname }), rejectUnauthorized: true }, () => {
            if (closed) { secure?.destroy(); return; }
            complete?.(null, secure);
          });
          secure.once("error", fail);
        } catch (error) { fail(error); }
      });
      connectRequest.end();
    } catch (error) { queueMicrotask(() => fail(error)); }
    return undefined;
  };
  try {
    const request = dependencies.request(protocol, { ...options, agent }, callback);
    const destroy = request.destroy.bind(request);
    // ClientRequest can be cancelled before the asynchronous Agent has assigned a
    // socket. Destroy the CONNECT/TLS work explicitly in that state as well.
    request.destroy = error => { stop(); return destroy(error); };
    request.once("close", stop);
    return request;
  } catch (error) { stop(); throw proxyFailure(error); }
}
