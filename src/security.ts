import type { RuntimeEnv, TelegramUpdate } from "./types";

/**
 * Constant-time token comparison using SHA-256 + Web Crypto timingSafeEqual
 * so length or prefix differences cannot be leaked via timing side-channels.
 */
export async function verifySecretToken(provided: string, expected: string): Promise<boolean> {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

export interface AuthVerificationResult {
  authorized: boolean;
  reason?: string;
  userId?: string;
}

/**
 * Two-Layer Single-User Webhook Authentication:
 * Layer 1: Verifies X-Telegram-Bot-Api-Secret-Token header against TELEGRAM_WEBHOOK_SECRET.
 * Layer 2: Verifies Telegram sender user ID against ALLOWED_TELEGRAM_USER_ID.
 */
export async function verifyWebhookAuth(
  request: Request,
  update: TelegramUpdate,
  env: RuntimeEnv,
): Promise<AuthVerificationResult> {
  const headerToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  const isValidHeader = await verifySecretToken(headerToken, env.TELEGRAM_WEBHOOK_SECRET ?? "");
  if (!isValidHeader) {
    return { authorized: false, reason: "invalid_webhook_secret_header" };
  }

  const rawUserId = update.message?.from?.id ?? update.callback_query?.from?.id;
  if (rawUserId === undefined || rawUserId === null) {
    return { authorized: false, reason: "missing_sender_id" };
  }

  const senderId = String(rawUserId).trim();
  const allowedId = String(env.ALLOWED_TELEGRAM_USER_ID ?? "").trim();
  const isAllowedUser = await verifySecretToken(senderId, allowedId);

  if (!isAllowedUser) {
    return { authorized: false, reason: "unauthorized_telegram_user", userId: senderId };
  }

  return { authorized: true, userId: senderId };
}
