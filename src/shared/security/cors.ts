import config from "../../config/index.js";

const LOCAL_DEVELOPMENT_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const DEVTUNNEL_HOST_SUFFIX = ".devtunnels.ms";

function normalizeOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    return url.origin;
  } catch {
    return null;
  }
}

const configuredOrigins = new Set(
  config.frontendUrl
    .map((origin) => normalizeOrigin(origin))
    .filter((origin): origin is string => Boolean(origin))
);

export function isAllowedCorsOrigin(origin?: string): boolean {
  if (!origin) return true;

  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return false;
  if (configuredOrigins.has(normalizedOrigin)) return true;

  const { hostname } = new URL(normalizedOrigin);

  if (LOCAL_DEVELOPMENT_HOSTS.has(hostname)) return true;

  if (config.env !== "production" && hostname.endsWith(DEVTUNNEL_HOST_SUFFIX)) {
    return true;
  }

  return false;
}

export function fastifyCorsOriginCallback(
  origin: string | undefined,
  callback: (error: Error | null, origin: string | boolean) => void
) {
  callback(null, isAllowedCorsOrigin(origin) ? (origin ?? true) : false);
}

export function socketCorsOriginCallback(
  origin: string | undefined,
  callback: (error: Error | null, allow: boolean) => void
) {
  callback(null, isAllowedCorsOrigin(origin));
}
