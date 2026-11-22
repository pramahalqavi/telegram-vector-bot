export interface RuntimeEnv extends Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_TELEGRAM_USER_ID: string;
  GEMINI_API_KEY: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
}

export interface BookCatalogItem {
  id: string;
  title: string;
  author: string;
  coverUrl: string;
  categories: string[];
  readTimeMinutes: number;
  chapterCount: number;
  tagline: string;
}

export interface BookCatalogDoc {
  updatedAt: string;
  books: BookCatalogItem[];
}

export interface Chapter {
  index: number;
  title: string;
  contentMarkdown: string;
}

export interface BookSummary {
  id: string;
  title: string;
  author: string;
  coverUrl?: string;
  categories?: string[];
  readTimeMinutes?: number;
  overview: string;
  keyTakeaways: string[];
  chapters: Chapter[];
}

export type DraftAction = "create" | "update" | "delete";

export interface PendingDraft {
  action: DraftAction;
  bookId: string;
  summary?: BookSummary;
  catalogItem?: BookCatalogItem;
  changeSummary?: string;
  createdAt: string;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}
