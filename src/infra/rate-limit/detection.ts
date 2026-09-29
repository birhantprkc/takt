import type { RateLimitInfo } from '../../core/models/response.js';
import { RATE_LIMIT_ERROR_MESSAGE } from '../../core/models/response.js';
import type { ProviderType } from '../../shared/types/provider.js';

const RATE_LIMIT_ERROR_PATTERNS = [
  /\bhttp\s+(?:status\s+)?(?:code\s+)?429\b/i,
  /\bstatus\s+code\s+429\b/i,
  /\b429\b[^\n\r]{0,40}\btoo many requests\b/i,
  /\brate[_\s-]?limit(?:ed|[_\s-]+exceeded)\b/i,
  /\brate[_\s-]?limit[_\s-]?error\b/i,
  /\b(?:exceeded|hit|reached)\s+(?:a\s+|the\s+)?rate[_\s-]?limit\b/i,
  /\bhit\s+your\s+(?:weekly|5-hour|session)\s+limit\b/i,
  /too many requests/i,
  /out of extra usage/i,
  /usage_limit_exceeded/i,
] as const;

const RATE_LIMIT_STREAM_MARKER_PATTERNS = [
  /out of extra usage/i,
  /usage_limit_exceeded/i,
] as const;

// Match the complete final agent_message item against known Codex notices.
// Arbitrary promo_message text is excluded because it can also be an ordinary reply.
// Templates follow UsageLimitReachedError::fmt in codex-rs/protocol/src/error.rs.
const RETRY_TIMESTAMP =
  '(?:[A-Za-z]{3} \\d{1,2}(?:st|nd|rd|th), \\d{4} \\d{1,2}:\\d{2} (?:AM|PM)|\\d{1,2}:\\d{2} (?:AM|PM))';
const RETRY_SUFFIX = `try again(?: later| at ${RETRY_TIMESTAMP})`;

const RATE_LIMIT_NOTICE_PATTERNS = [
  // limit_name branch (non-codex/gpt-reserve model). limit_name can itself
  // contain a period (e.g. "gpt-5.1-codex"), so it's matched lazily rather
  // than excluding ".".
  new RegExp(
    `^you['’]ve hit your usage limit for [^\\n]+?\\. switch to another model now, or ${RETRY_SUFFIX}\\.?$`,
    'i',
  ),
  // Plus plan
  new RegExp(
    `^you['’]ve hit your usage limit\\. upgrade to pro \\(https://chatgpt\\.com/explore/pro\\), visit https://chatgpt\\.com/codex/settings/usage to purchase more credits(?: or ${RETRY_SUFFIX})?\\.?$`,
    'i',
  ),
  // Team / business / enterprise-admin plans
  new RegExp(
    `^you['’]ve hit your usage limit\\. to get more access now, send a request to your admin or ${RETRY_SUFFIX}\\.?$`,
    'i',
  ),
  // Free / Go plans
  new RegExp(
    `^you['’]ve hit your usage limit\\. upgrade to plus to continue using codex \\(https://chatgpt\\.com/explore/plus\\), or ${RETRY_SUFFIX}\\.?$`,
    'i',
  ),
  // Pro / ProLite / ProMax plans
  new RegExp(
    `^you['’]ve hit your usage limit\\. visit https://chatgpt\\.com/codex/settings/usage to purchase more credits(?: or ${RETRY_SUFFIX})?\\.?$`,
    'i',
  ),
  // Enterprise / Edu / Unknown / None plans (retry_suffix, not _after_or)
  new RegExp(`^you['’]ve hit your usage limit\\. ${RETRY_SUFFIX}\\.?$`, 'i'),
] as const;

// Same source (UsageLimitReachedError::fmt, rate_limit_reached_type branch)
// but these workspace-credit / spend-cap variants don't share the "You've
// hit your usage limit" / "try again" shape, so they're matched as their own
// exact full-line strings.
const RATE_LIMIT_WORKSPACE_NOTICE_PATTERNS = [
  /^your workspace is out of credits\. add credits to continue\.$/i,
  /^your workspace is out of credits\. ask your workspace owner to refill in order to continue\.$/i,
  /^you hit your spend cap set in your workspace\. increase your spend cap to continue\.$/i,
  /^you hit your spend cap set by the owner of your workspace\. ask an owner to increase your spend cap to continue\.$/i,
] as const;

export function containsRateLimitMarker(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return RATE_LIMIT_STREAM_MARKER_PATTERNS.some((pattern) => pattern.test(text));
}

export function isRateLimitNoticeResponse(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return RATE_LIMIT_NOTICE_PATTERNS.some((pattern) => pattern.test(trimmed))
    || RATE_LIMIT_WORKSPACE_NOTICE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function containsRateLimitError(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return RATE_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(text))
    || isRateLimitNoticeResponse(text);
}

export function resolveRateLimitTextSource(text: string | undefined): 'stream_marker' | undefined {
  if (containsRateLimitMarker(text)) {
    return 'stream_marker';
  }
  return undefined;
}

export function buildRateLimitInfo(
  provider: ProviderType,
  source: RateLimitInfo['source'],
  text?: string,
): RateLimitInfo {
  const resetAtRaw = text?.match(/resets?\s+([^\n\r]+)/i)?.[1]?.trim()
    ?? text?.match(/\btry\s+again\s+at\s+((?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:st|nd|rd|th),\s+\d{4}\s+)?\d{1,2}:\d{2}\s*[ap]m(?:\s*\([^)\r\n]+\))?)/i)?.[1]?.trim();
  return {
    provider,
    detectedAt: new Date(),
    source,
    ...(resetAtRaw ? { resetAtRaw } : {}),
  };
}

export function resolveRateLimitErrorMessage(text?: string): string {
  const message = text?.trim();
  return message && message.length > 0 ? message : RATE_LIMIT_ERROR_MESSAGE;
}

export function buildRateLimitedResponseFields(
  provider: ProviderType,
  source: RateLimitInfo['source'],
  text?: string,
): {
  status: 'rate_limited';
  content: '';
  error: string;
  errorKind: 'rate_limit';
  rateLimitInfo: RateLimitInfo;
} {
  return {
    status: 'rate_limited',
    content: '',
    error: resolveRateLimitErrorMessage(text),
    errorKind: 'rate_limit',
    rateLimitInfo: buildRateLimitInfo(provider, source, text),
  };
}
