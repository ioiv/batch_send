/**
 * Curated, non-destructive exposure probes for the website path scanner.
 *
 * Every entry is a single GET request against a fixed, public path. The list is
 * deliberately small and version-controlled so a scan stays predictable and a
 * target is never brute-forced: the scanner only adds these paths on top of the
 * paths that the site itself publishes or links to.
 *
 * `high` entries are files that essentially never belong on a public web root
 * (environment files, VCS metadata, database dumps, cloud/CI credentials).
 * `medium` entries are common operational endpoints that are weak alone but let
 * an operator pivot (backups, consoles, API descriptions, index endpoints).
 * `low` entries are informational well-known routes that are frequently
 * published on purpose and therefore never reported as an exposure.
 */
export type ExposureConfidence = "high" | "medium" | "low";
export type ExposureKind =
  | "secret-file"
  | "vcs-metadata"
  | "backup"
  | "database"
  | "ci-config"
  | "cloud-credential"
  | "auth-artifact"
  | "index"
  | "api-doc"
  | "well-known"
  | "php-info"
  | "log"
  | "server-status"
  | "actuator"
  | "graphql"
  | "console";

export interface ExposurePath {
  readonly path: string;
  readonly kind: ExposureKind;
  readonly confidence: ExposureConfidence;
  readonly description: string;
}

export const EXPOSURE_PATHS: readonly ExposurePath[] = [
  { path: "/.env", kind: "secret-file", confidence: "high", description: "环境变量文件，通常包含数据库与第三方凭据" },
  { path: "/.env.local", kind: "secret-file", confidence: "high", description: "本地环境变量文件" },
  { path: "/.git/HEAD", kind: "vcs-metadata", confidence: "high", description: "Git 仓库已暴露，可据 HEAD / config 重建源码" },
  { path: "/.git/config", kind: "vcs-metadata", confidence: "high", description: "Git 配置，可能包含远端仓库地址与凭据" },
  { path: "/.github/workflows", kind: "ci-config", confidence: "medium", description: "CI 工作流目录（无 index 时返回列表或 403）" },
  { path: "/.gitlab-ci.yml", kind: "ci-config", confidence: "high", description: "GitLab CI 配置" },
  { path: "/.circleci/config.yml", kind: "ci-config", confidence: "high", description: "CircleCI 配置" },
  { path: "/.travis.yml", kind: "ci-config", confidence: "medium", description: "Travis CI 配置" },
  { path: "/Jenkinsfile", kind: "ci-config", confidence: "medium", description: "Jenkins 流水线定义" },
  { path: "/.aws/credentials", kind: "cloud-credential", confidence: "high", description: "AWS 访问凭据" },
  { path: "/.docker/config.json", kind: "cloud-credential", confidence: "high", description: "Docker 镜像仓库登录凭据" },
  { path: "/.npmrc", kind: "cloud-credential", confidence: "high", description: "npm 注册表令牌" },
  { path: "/.htpasswd", kind: "auth-artifact", confidence: "high", description: "HTTP Basic 认证密码文件" },
  { path: "/.DS_Store", kind: "index", confidence: "medium", description: "macOS 目录索引，可能泄漏文件名" },
  { path: "/Dockerfile", kind: "index", confidence: "medium", description: "镜像构建脚本，可能泄漏内部结构与版本" },
  { path: "/docker-compose.yml", kind: "index", confidence: "medium", description: "容器编排文件，可能暴露内部服务与口令" },
  { path: "/backup.zip", kind: "backup", confidence: "medium", description: "备份压缩包" },
  { path: "/backup.sql", kind: "database", confidence: "high", description: "数据库导出文件" },
  { path: "/database.sql", kind: "database", confidence: "high", description: "数据库导出文件" },
  { path: "/dump.sql", kind: "database", confidence: "high", description: "数据库导出文件" },
  { path: "/db.sql", kind: "database", confidence: "medium", description: "数据库导出文件" },
  { path: "/phpinfo.php", kind: "php-info", confidence: "high", description: "PHP 环境信息页，泄漏路径、模块与版本" },
  { path: "/info.php", kind: "php-info", confidence: "high", description: "PHP 信息页" },
  { path: "/debug.log", kind: "log", confidence: "high", description: "调试日志，常包含堆栈与密钥" },
  { path: "/error.log", kind: "log", confidence: "high", description: "错误日志" },
  { path: "/.well-known/security.txt", kind: "well-known", confidence: "low", description: "安全联系方式声明，公开站点常主动提供" },
  { path: "/.well-known/change-password", kind: "well-known", confidence: "low", description: "密码修改跳转声明" },
  { path: "/robots.txt", kind: "well-known", confidence: "low", description: "爬虫声明，通常公开" },
  { path: "/sitemap.xml", kind: "well-known", confidence: "low", description: "站点地图，通常公开" },
  { path: "/api-docs", kind: "api-doc", confidence: "medium", description: "API 文档入口，可能暴露全部接口" },
  { path: "/swagger-ui/", kind: "api-doc", confidence: "medium", description: "Swagger UI" },
  { path: "/swagger-ui.html", kind: "api-doc", confidence: "medium", description: "Swagger UI 单页入口" },
  { path: "/swagger.json", kind: "api-doc", confidence: "high", description: "OpenAPI 描述文件" },
  { path: "/openapi.json", kind: "api-doc", confidence: "high", description: "OpenAPI 描述文件" },
  { path: "/v2/api-docs", kind: "api-doc", confidence: "medium", description: "Springfox API 描述" },
  { path: "/v3/api-docs", kind: "api-doc", confidence: "medium", description: "Springdoc API 描述" },
  { path: "/graphql", kind: "graphql", confidence: "medium", description: "GraphQL 端点，可能允许内省查询" },
  { path: "/server-status", kind: "server-status", confidence: "medium", description: "Apache 状态页" },
  { path: "/server-info", kind: "server-status", confidence: "medium", description: "Apache 配置信息页" },
  { path: "/actuator", kind: "actuator", confidence: "medium", description: "Spring Boot Actuator 入口" },
  { path: "/actuator/health", kind: "actuator", confidence: "medium", description: "Actuator 健康检查" },
  { path: "/actuator/env", kind: "actuator", confidence: "high", description: "Actuator 环境属性，可能包含明文配置" },
  { path: "/console/", kind: "console", confidence: "medium", description: "H2 等数据库控制台" },
  { path: "/adminer.php", kind: "console", confidence: "medium", description: "Adminer 数据库管理入口" }
] as const;

const BY_PATH = new Map<string, ExposurePath>(EXPOSURE_PATHS.map((entry) => [entry.path, entry]));

/** Fixed probe list as absolute URLs, never mixed into the site's own path counts. */
export function exposureProbeUrls(baseUrl: string): string[] {
  const origin = new URL(baseUrl).origin;
  return [...new Set(EXPOSURE_PATHS.map((entry) => `${origin}${entry.path}`))];
}

export function exposurePathFor(url: string): ExposurePath | undefined {
  try { return BY_PATH.get(new URL(url).pathname); } catch { return undefined; }
}

/** Minimum severity that an actual 2xx response to this path represents. */
export type ExposureVerdict = "high" | "medium" | "informational";

export function exposureVerdict(entry: ExposurePath): ExposureVerdict {
  return entry.confidence === "high" ? "high" : entry.confidence === "medium" ? "medium" : "informational";
}

/**
 * An exposure only counts when the fixed path actually answered and is neither a
 * catch-all response nor a runtime-declared client route. `probeMiss` carries the
 * fingerprint of one random, nonexistent path so an SPA fallback cannot mint
 * findings on its own.
 */
export function confirmedExposure(result: {
  url: string; status: string; statusCode?: number; fingerprint?: string; soft404?: boolean; clientRoute?: boolean;
}, probeMiss?: { statusCode: number; fingerprint: string }): { path: ExposurePath; verdict: ExposureVerdict } | undefined {
  const entry = exposurePathFor(result.url);
  if (!entry || entry.confidence === "low") return undefined;
  if (result.status !== "responded" || result.statusCode === undefined || result.statusCode < 200 || result.statusCode >= 300) return undefined;
  if (result.soft404 || result.clientRoute) return undefined;
  if (!probeMiss?.fingerprint || !result.fingerprint) return undefined;
  if (result.statusCode === probeMiss.statusCode && result.fingerprint === probeMiss.fingerprint) return undefined;
  return { path: entry, verdict: exposureVerdict(entry) };
}
