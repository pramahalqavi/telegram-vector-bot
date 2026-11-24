import type { InlineKeyboardMarkup, RuntimeEnv } from "./types";

const TELEGRAM_MAX_LENGTH = 4000;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Converts basic GFM Markdown (headings, bold, italic, blockquotes) into Telegram-safe HTML.
 */
export function markdownToTelegramHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const headingMatch = line.match(/^#{1,4}\s+(.*)$/);
    if (headingMatch) {
      out.push(`\n<b>${formatInlineMarkdown(headingMatch[1])}</b>`);
      continue;
    }
    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      out.push(`<blockquote>${formatInlineMarkdown(quoteMatch[1])}</blockquote>`);
      continue;
    }
    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      out.push(`• ${formatInlineMarkdown(bulletMatch[1])}`);
      continue;
    }
    out.push(formatInlineMarkdown(line));
  }

  return out.join("\n").trim();
}

function formatInlineMarkdown(text: string): string {
  let escaped = escapeHtml(text);
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  escaped = escaped.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<i>$1</i>");
  escaped = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
  return escaped;
}

interface TelegramApiResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function callTelegramApi<T = unknown>(
  env: RuntimeEnv,
  method: string,
  payload: Record<string, unknown>,
): Promise<T | null> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = (await response.json()) as TelegramApiResponse<T>;
  if (!data.ok) {
    console.error(
      JSON.stringify({
        message: "telegram_api_error",
        method,
        status: response.status,
        description: data.description ?? "unknown",
      }),
    );
    return null;
  }
  return data.result ?? null;
}

function safeTruncateHtml(htmlText: string, maxLen: number): string {
  if (htmlText.length <= maxLen) return htmlText;
  // Cut at the last newline before maxLen - 35 to avoid slicing inside an HTML tag
  const sliceTarget = maxLen - 35;
  const lastNewline = htmlText.lastIndexOf("\n", sliceTarget);
  const cutIdx = lastNewline > sliceTarget * 0.5 ? lastNewline : sliceTarget;
  return `${htmlText.slice(0, cutIdx)}\n\n<i>…(truncated)</i>`;
}

export async function sendMessage(
  env: RuntimeEnv,
  chatId: number,
  htmlText: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<{ message_id: number } | null> {
  // If there's no inline keyboard and the message exceeds TELEGRAM_MAX_LENGTH, split by newline chunks
  if (!replyMarkup && htmlText.length > TELEGRAM_MAX_LENGTH) {
    const lines = htmlText.split("\n");
    let currentChunk = "";
    let lastResult: { message_id: number } | null = null;

    for (const line of lines) {
      const candidate = currentChunk ? `${currentChunk}\n${line}` : line;
      if (candidate.length > TELEGRAM_MAX_LENGTH && currentChunk) {
        lastResult = await callTelegramApi<{ message_id: number }>(env, "sendMessage", {
          chat_id: chatId,
          text: currentChunk,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
        currentChunk = line;
      } else {
        currentChunk = candidate;
      }
    }

    if (currentChunk) {
      lastResult = await callTelegramApi<{ message_id: number }>(env, "sendMessage", {
        chat_id: chatId,
        text: safeTruncateHtml(currentChunk, TELEGRAM_MAX_LENGTH),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    }
    return lastResult;
  }

  const trimmed = safeTruncateHtml(htmlText, TELEGRAM_MAX_LENGTH);

  return callTelegramApi<{ message_id: number }>(env, "sendMessage", {
    chat_id: chatId,
    text: trimmed,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

export async function editMessageText(
  env: RuntimeEnv,
  chatId: number,
  messageId: number,
  htmlText: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<void> {
  const trimmed = safeTruncateHtml(htmlText, TELEGRAM_MAX_LENGTH);

  await callTelegramApi(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: trimmed,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

export async function answerCallbackQuery(
  env: RuntimeEnv,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await callTelegramApi(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

/**
 * Downloads an uploaded Telegram file into ephemeral Worker RAM (Uint8Array).
 * Telegram Bot API supports downloading files up to 20 MB.
 */
export async function downloadTelegramFile(
  env: RuntimeEnv,
  fileId: string,
): Promise<{ bytes: Uint8Array; filePath: string }> {
  const fileInfo = await callTelegramApi<{ file_id: string; file_path?: string }>(
    env,
    "getFile",
    { file_id: fileId },
  );

  if (!fileInfo?.file_path) {
    throw new Error(
      "Could not retrieve file path from Telegram (note: Telegram limits bot downloads to 20 MB).",
    );
  }

  const downloadUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file from Telegram (${response.status}).`);
  }

  const buffer = await response.arrayBuffer();
  return {
    bytes: new Uint8Array(buffer),
    filePath: fileInfo.file_path,
  };
}
