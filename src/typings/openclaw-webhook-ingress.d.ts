declare module "openclaw/plugin-sdk/webhook-ingress" {
  import type { IncomingMessage, ServerResponse } from "node:http";

  export interface WebhookInFlightLimiter {
    acquire(): boolean;
    release(): void;
  }

  export interface FixedWindowRateLimiter {
    check(key?: string): boolean;
  }

  export function createWebhookInFlightLimiter(opts: {
    max?: number;
    maxInFlightPerKey?: number;
    maxTrackedKeys?: number;
  }): WebhookInFlightLimiter;

  export function createFixedWindowRateLimiter(opts: {
    windowMs: number;
    max?: number;
    maxRequests?: number;
    maxTrackedKeys?: number;
  }): FixedWindowRateLimiter;

  export function registerWebhookTargetWithPluginRoute<T extends { path: string }>(opts: {
    targetsByPath: Map<string, T[]>;
    target: T;
    route: {
      auth: string;
      match: "exact" | "prefix";
      pluginId: string;
      source: string;
      accountId: string;
      replaceExisting?: boolean;
      log?: (msg: string) => void;
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void>;
    };
    onLastPathTargetRemoved?: () => void;
  }): { unregister: () => void };

  export function withResolvedWebhookRequestPipeline<T extends { path: string }>(opts: {
    req: IncomingMessage;
    res: ServerResponse;
    targetsByPath: Map<string, T[]>;
    rateLimiter: FixedWindowRateLimiter;
    inFlightLimiter: WebhookInFlightLimiter;
    requireJsonContentType?: boolean;
    handle: (ctx: { targets: T[] }) => Promise<void> | void;
  }): Promise<boolean>;

  export function resolveWebhookTargetWithAuthOrRejectSync<T>(opts: {
    targets: T[];
    res: ServerResponse;
    isMatch: (target: T) => boolean;
    unauthorizedStatusCode?: number;
    unauthorizedMessage?: string;
  }): T | null;

  export function readWebhookBodyOrReject(opts: {
    req: IncomingMessage;
    res: ServerResponse;
    maxBytes: number;
    timeoutMs: number;
  }): Promise<{ ok: true; value: string } | { ok: false }>;
}
