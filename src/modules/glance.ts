import { deleteBook, getBookSummary, getCatalog, upsertBook } from "../firebase";
import {
  classifyIntent,
  generateBookSummaryDraft,
  generateBookSummaryFromDocument,
  reviseBookSummaryDraft,
} from "../gemini";
import {
  answerCallbackQuery,
  downloadTelegramFile,
  editMessageText,
  escapeHtml,
  markdownToTelegramHtml,
  sendMessage,
} from "../telegram";
import type {
  BookCatalogDoc,
  BookCatalogItem,
  BookSummary,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  PendingDraft,
  RuntimeEnv,
  TelegramCallbackQuery,
  TelegramDocument,
  TelegramMessage,
} from "../types";

const DRAFT_TTL_SECONDS = 86400; // 24 hours

function draftKey(userId: string): string {
  return `draft:${userId}`;
}

export async function getActiveDraft(
  env: RuntimeEnv,
  userId: string,
): Promise<PendingDraft | null> {
  const raw = await env.DRAFTS_KV.get(draftKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingDraft;
  } catch {
    return null;
  }
}

export async function saveActiveDraft(
  env: RuntimeEnv,
  userId: string,
  draft: PendingDraft,
): Promise<void> {
  await env.DRAFTS_KV.put(draftKey(userId), JSON.stringify(draft), {
    expirationTtl: DRAFT_TTL_SECONDS,
  });
}

export async function clearActiveDraft(env: RuntimeEnv, userId: string): Promise<void> {
  await env.DRAFTS_KV.delete(draftKey(userId));
}

// --- Formatting & Keyboards ---

function formatDraftPreviewHtml(draft: PendingDraft): string {
  if (draft.action === "delete") {
    const title = draft.catalogItem?.title ?? draft.bookId;
    const author = draft.catalogItem?.author ? ` by ${escapeHtml(draft.catalogItem.author)}` : "";
    return [
      `🗑️ <b>STAGED DELETION REVIEW</b>`,
      ``,
      `Are you sure you want to permanently remove <b>${escapeHtml(title)}</b>${author} (<code>${escapeHtml(draft.bookId)}</code>) from Glance?`,
      ``,
      `• Removes <code>summaries/${escapeHtml(draft.bookId)}</code>`,
      `• Removes entry from <code>catalog/books</code>`,
    ].join("\n");
  }

  const badge =
    draft.action === "create"
      ? "🆕 <b>STAGED NEW BOOK DRAFT</b>"
      : "✏️ <b>STAGED BOOK UPDATE DRAFT</b>";

  const summary = draft.summary!;
  const catalog = draft.catalogItem!;

  const takeawaysList = summary.keyTakeaways
    .map((t, idx) => `${idx + 1}. ${escapeHtml(t)}`)
    .join("\n");

  const chaptersList = summary.chapters
    .map((ch, idx) => {
      const wordCount = ch.contentMarkdown.trim().split(/\s+/).length;
      return `  <b>Ch ${idx + 1}:</b> ${escapeHtml(ch.title)} <i>(~${wordCount}w)</i>`;
    })
    .join("\n");

  const lines = [
    badge,
    draft.changeSummary ? `<i>${escapeHtml(draft.changeSummary)}</i>\n` : "",
    `📖 <b>${escapeHtml(summary.title)}</b> — <i>${escapeHtml(summary.author)}</i>`,
    `🆔 <code>${escapeHtml(summary.id)}</code> | ⏱️ ${catalog.readTimeMinutes} min | 🏷️ ${escapeHtml(catalog.categories.join(", "))}`,
    `💬 <i>"${escapeHtml(catalog.tagline)}"</i>`,
    ``,
    `<b>Overview:</b>`,
    escapeHtml(summary.overview),
    ``,
    `<b>Key Takeaways:</b>`,
    takeawaysList,
    ``,
    `<b>Chapters (${summary.chapters.length}):</b>`,
    chaptersList,
    ``,
    `💡 <i>Reply with any text to revise this draft (e.g. "Make chapter 2 more practical" or "Change categories to Psychology"), or tap a button below:</i>`,
  ];

  return lines.filter((l) => l !== undefined).join("\n");
}

function buildDraftKeyboard(draft: PendingDraft): InlineKeyboardMarkup {
  if (draft.action === "delete") {
    return {
      inline_keyboard: [
        [
          { text: "✅ Confirm Delete from Firestore", callback_data: "glance:confirm" },
          { text: "❌ Cancel", callback_data: "glance:cancel" },
        ],
      ],
    };
  }

  const chapterButtons: InlineKeyboardButton[] = (draft.summary?.chapters ?? []).map((_, idx) => ({
    text: `📖 Ch ${idx + 1}`,
    callback_data: `glance:ch:${idx}`,
  }));

  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < chapterButtons.length; i += 3) {
    rows.push(chapterButtons.slice(i, i + 3));
  }

  rows.push([
    { text: "✅ Confirm & Push to Firestore", callback_data: "glance:confirm" },
    { text: "❌ Cancel", callback_data: "glance:cancel" },
  ]);

  return { inline_keyboard: rows };
}

function formatPublishedBookHtml(
  summary: BookSummary,
  catalogItem?: BookCatalogItem,
): string {
  const categories =
    catalogItem?.categories?.join(", ") ?? summary.categories?.join(", ") ?? "Uncategorized";
  const readTime = catalogItem?.readTimeMinutes ?? summary.readTimeMinutes ?? 15;
  const tagline = catalogItem?.tagline ? `\n💬 <i>"${escapeHtml(catalogItem.tagline)}"</i>` : "";

  const takeaways = summary.keyTakeaways
    .map((t, i) => `${i + 1}. ${escapeHtml(t)}`)
    .join("\n");

  const chapters = summary.chapters
    .map((c, i) => `  <b>Ch ${i + 1}:</b> ${escapeHtml(c.title)}`)
    .join("\n");

  return [
    `📚 <b>${escapeHtml(summary.title)}</b> — <i>${escapeHtml(summary.author)}</i>`,
    `🆔 <code>${escapeHtml(summary.id)}</code> | ⏱️ ${readTime} min | 🏷️ ${escapeHtml(categories)}${tagline}`,
    ``,
    `<b>Overview:</b>`,
    escapeHtml(summary.overview),
    ``,
    `<b>Key Takeaways:</b>`,
    takeaways,
    ``,
    `<b>Chapters (${summary.chapters.length}):</b>`,
    chapters,
  ].join("\n");
}

function buildPublishedBookKeyboard(bookId: string, chapterCount: number): InlineKeyboardMarkup {
  const buttons: InlineKeyboardButton[] = [];
  for (let i = 0; i < chapterCount; i++) {
    buttons.push({
      text: `📖 Read Ch ${i + 1}`,
      callback_data: `glance:inspect:${bookId}:${i}`,
    });
  }
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 3) {
    rows.push(buttons.slice(i, i + 3));
  }
  return { inline_keyboard: rows };
}

// --- Paginated & Searchable Catalog View ---

const BOOKS_PER_PAGE = 10;

function parseBooksCommandArgs(rawArg: string): { page: number; filterQuery: string } {
  const trimmed = rawArg.trim();
  if (!trimmed) return { page: 1, filterQuery: "" };

  // Match "/books 2" or "/books page 2"
  const pageOnlyMatch = trimmed.match(/^(?:page\s+)?(\d+)$/i);
  if (pageOnlyMatch) {
    return { page: Math.max(1, Number(pageOnlyMatch[1])), filterQuery: "" };
  }

  // Match "/books psychology 2"
  const trailingPageMatch = trimmed.match(/^(.*?)\s+(?:page\s+)?(\d+)$/i);
  if (trailingPageMatch && trailingPageMatch[1].trim().length > 0) {
    return {
      filterQuery: trailingPageMatch[1].trim(),
      page: Math.max(1, Number(trailingPageMatch[2])),
    };
  }

  return { page: 1, filterQuery: trimmed };
}

function buildCatalogPageView(
  catalog: BookCatalogDoc,
  requestedPage = 1,
  rawFilterQuery = "",
): { html: string; keyboard?: InlineKeyboardMarkup } {
  const filterQuery = rawFilterQuery.trim();
  const normalizedFilter = filterQuery.toLowerCase();

  const matchingBooks = normalizedFilter
    ? catalog.books.filter(
        (b) =>
          b.title.toLowerCase().includes(normalizedFilter) ||
          b.author.toLowerCase().includes(normalizedFilter) ||
          b.id.toLowerCase().includes(normalizedFilter) ||
          (b.tagline && b.tagline.toLowerCase().includes(normalizedFilter)) ||
          (b.categories ?? []).some((c) => c.toLowerCase().includes(normalizedFilter)),
      )
    : catalog.books;

  if (matchingBooks.length === 0) {
    const html = filterQuery
      ? `🔍 <b>No books matched</b> "<code>${escapeHtml(filterQuery)}</code>" (out of ${catalog.books.length} books in Glance).\n\nTap below to view all books or try a different keyword.`
      : `📚 <b>Glance Catalog is empty.</b>\n\nUse <code>/add &lt;Book Title&gt;</code> or upload a <b>.pdf</b> / <b>.epub</b> to create your first book summary!`;

    const keyboard: InlineKeyboardMarkup | undefined = filterQuery
      ? {
          inline_keyboard: [[{ text: "📚 Show All Books", callback_data: "glance:books:1:" }]],
        }
      : undefined;

    return { html, keyboard };
  }

  const totalPages = Math.max(1, Math.ceil(matchingBooks.length / BOOKS_PER_PAGE));
  const currentPage = Math.min(Math.max(1, requestedPage), totalPages);
  const startIdx = (currentPage - 1) * BOOKS_PER_PAGE;
  const pageBooks = matchingBooks.slice(startIdx, startIdx + BOOKS_PER_PAGE);

  const lines = pageBooks.map(
    (b, idx) =>
      `${startIdx + idx + 1}. <b>${escapeHtml(b.title)}</b> — <i>${escapeHtml(b.author)}</i>\n    🆔 <code>${escapeHtml(b.id)}</code> • ${b.chapterCount} ch • ${b.readTimeMinutes}m • 🏷️ ${escapeHtml((b.categories ?? []).join(", "))}`,
  );

  const headerTitle = filterQuery
    ? `🔍 <b>Glance Books matching "${escapeHtml(filterQuery)}" (${matchingBooks.length} of ${catalog.books.length})</b>`
    : `📚 <b>Glance Book Catalog (${catalog.books.length} books)</b>`;

  const pageSubtitle =
    totalPages > 1
      ? `📄 <b>Page ${currentPage} of ${totalPages}</b> <i>(Showing ${startIdx + 1}–${startIdx + pageBooks.length})</i>`
      : `<i>Showing all ${matchingBooks.length} book(s)</i>`;

  const html = [
    headerTitle,
    pageSubtitle,
    ``,
    ...lines,
    ``,
    `💡 <i>Inspect:</i> <code>/book &lt;id&gt;</code> • <i>Search:</i> <code>/books &lt;keyword&gt;</code> • <i>Jump:</i> <code>/books &lt;page&gt;</code>`,
  ].join("\n");

  const safeFilterCallback = filterQuery.slice(0, 32).replace(/:/g, " ");
  const rows: InlineKeyboardButton[][] = [];

  if (totalPages > 1) {
    const navRow: InlineKeyboardButton[] = [];
    if (currentPage > 1) {
      navRow.push({
        text: "⬅️ Prev",
        callback_data: `glance:books:${currentPage - 1}:${safeFilterCallback}`,
      });
    }
    navRow.push({
      text: `📄 ${currentPage} / ${totalPages}`,
      callback_data: `glance:noop:${currentPage}`,
    });
    if (currentPage < totalPages) {
      navRow.push({
        text: "Next ➡️",
        callback_data: `glance:books:${currentPage + 1}:${safeFilterCallback}`,
      });
    }
    rows.push(navRow);
  }

  if (filterQuery) {
    rows.push([{ text: "📚 Show All Books", callback_data: "glance:books:1:" }]);
  }

  return {
    html,
    keyboard: rows.length > 0 ? { inline_keyboard: rows } : undefined,
  };
}

// --- Command & Intent Actions ---

async function handleListBooks(
  env: RuntimeEnv,
  chatId: number,
  page = 1,
  filterQuery = "",
): Promise<void> {
  const catalog = await getCatalog(env);
  const view = buildCatalogPageView(catalog, page, filterQuery);
  await sendMessage(env, chatId, view.html, view.keyboard);
}

async function handleInspectBook(
  env: RuntimeEnv,
  chatId: number,
  bookIdOrQuery: string,
): Promise<void> {
  const catalog = await getCatalog(env);
  const normalized = bookIdOrQuery.trim().toLowerCase();
  const matchedCatalog =
    catalog.books.find((b) => b.id.toLowerCase() === normalized) ??
    catalog.books.find(
      (b) =>
        b.title.toLowerCase().includes(normalized) || b.id.toLowerCase().includes(normalized),
    );

  const targetId = matchedCatalog?.id ?? normalized.replace(/\s+/g, "-");
  const summary = await getBookSummary(env, targetId);

  if (!summary) {
    await sendMessage(
      env,
      chatId,
      `⚠️ Could not find book <code>${escapeHtml(targetId)}</code> in Glance.\nUse <code>/books</code> to view all available book IDs.`,
    );
    return;
  }

  await sendMessage(
    env,
    chatId,
    formatPublishedBookHtml(summary, matchedCatalog),
    buildPublishedBookKeyboard(summary.id, summary.chapters.length),
  );
}

async function handleCreateBookDraft(
  env: RuntimeEnv,
  chatId: number,
  userId: string,
  bookQuery: string,
): Promise<void> {
  await sendMessage(
    env,
    chatId,
    `⏳ <b>Drafting 5-chapter Glance summary for:</b> <i>${escapeHtml(bookQuery)}</i>...\n<i>This takes ~10–15 seconds. Nothing is written to Firestore until you confirm.</i>`,
  );

  const generated = await generateBookSummaryDraft(env, bookQuery);
  const draft: PendingDraft = {
    action: "create",
    bookId: generated.summary.id,
    summary: generated.summary,
    catalogItem: generated.catalogItem,
    changeSummary: generated.changeSummary,
    createdAt: new Date().toISOString(),
  };

  await saveActiveDraft(env, userId, draft);
  await sendMessage(env, chatId, formatDraftPreviewHtml(draft), buildDraftKeyboard(draft));
}

async function handleUpdateExistingBookDraft(
  env: RuntimeEnv,
  chatId: number,
  userId: string,
  bookIdOrQuery: string,
  instruction: string,
): Promise<void> {
  const catalog = await getCatalog(env);
  const normalized = bookIdOrQuery.trim().toLowerCase();
  const matchedCatalog =
    catalog.books.find((b) => b.id.toLowerCase() === normalized) ??
    catalog.books.find(
      (b) =>
        b.title.toLowerCase().includes(normalized) || b.id.toLowerCase().includes(normalized),
    );

  const targetId = matchedCatalog?.id ?? normalized.replace(/\s+/g, "-");
  const existingSummary = await getBookSummary(env, targetId);

  if (!existingSummary) {
    await sendMessage(
      env,
      chatId,
      `⚠️ Book <code>${escapeHtml(targetId)}</code> was not found in Firestore. Use <code>/books</code> to see available IDs.`,
    );
    return;
  }

  const baseCatalogItem: BookCatalogItem = matchedCatalog ?? {
    id: existingSummary.id,
    title: existingSummary.title,
    author: existingSummary.author,
    coverUrl: existingSummary.coverUrl ?? "",
    categories: existingSummary.categories ?? ["General"],
    readTimeMinutes: existingSummary.readTimeMinutes ?? 15,
    chapterCount: existingSummary.chapters.length,
    tagline: existingSummary.overview.slice(0, 100),
  };

  await sendMessage(
    env,
    chatId,
    `⏳ <b>Applying requested updates to</b> <i>${escapeHtml(existingSummary.title)}</i>...`,
  );

  const revised = await reviseBookSummaryDraft(
    env,
    existingSummary,
    baseCatalogItem,
    instruction,
  );

  const draft: PendingDraft = {
    action: "update",
    bookId: existingSummary.id,
    summary: revised.summary,
    catalogItem: revised.catalogItem,
    changeSummary: revised.changeSummary,
    createdAt: new Date().toISOString(),
  };

  await saveActiveDraft(env, userId, draft);
  await sendMessage(env, chatId, formatDraftPreviewHtml(draft), buildDraftKeyboard(draft));
}

async function handleReviseActiveDraft(
  env: RuntimeEnv,
  chatId: number,
  userId: string,
  activeDraft: PendingDraft,
  instruction: string,
): Promise<void> {
  if (!activeDraft.summary || !activeDraft.catalogItem) {
    await sendMessage(
      env,
      chatId,
      `⚠️ The active draft is a deletion request. Tap <b>Confirm</b> or <b>Cancel</b> first.`,
    );
    return;
  }

  await sendMessage(
    env,
    chatId,
    `⏳ <b>Revising active draft for</b> <i>${escapeHtml(activeDraft.summary.title)}</i>...`,
  );

  const revised = await reviseBookSummaryDraft(
    env,
    activeDraft.summary,
    activeDraft.catalogItem,
    instruction,
  );

  const updatedDraft: PendingDraft = {
    ...activeDraft,
    bookId: revised.summary.id,
    summary: revised.summary,
    catalogItem: revised.catalogItem,
    changeSummary: revised.changeSummary,
    createdAt: new Date().toISOString(),
  };

  await saveActiveDraft(env, userId, updatedDraft);
  await sendMessage(
    env,
    chatId,
    formatDraftPreviewHtml(updatedDraft),
    buildDraftKeyboard(updatedDraft),
  );
}

async function handleStageDeleteBook(
  env: RuntimeEnv,
  chatId: number,
  userId: string,
  bookIdOrQuery: string,
): Promise<void> {
  const catalog = await getCatalog(env);
  const normalized = bookIdOrQuery.trim().toLowerCase();
  const matchedCatalog =
    catalog.books.find((b) => b.id.toLowerCase() === normalized) ??
    catalog.books.find(
      (b) =>
        b.title.toLowerCase().includes(normalized) || b.id.toLowerCase().includes(normalized),
    );

  const targetId = matchedCatalog?.id ?? normalized.replace(/\s+/g, "-");
  const existingSummary = await getBookSummary(env, targetId);

  if (!matchedCatalog && !existingSummary) {
    await sendMessage(
      env,
      chatId,
      `⚠️ Book <code>${escapeHtml(targetId)}</code> not found in Glance catalog or summaries.`,
    );
    return;
  }

  const draft: PendingDraft = {
    action: "delete",
    bookId: targetId,
    catalogItem: matchedCatalog ?? {
      id: targetId,
      title: existingSummary?.title ?? targetId,
      author: existingSummary?.author ?? "Unknown",
      coverUrl: existingSummary?.coverUrl ?? "",
      categories: existingSummary?.categories ?? [],
      readTimeMinutes: existingSummary?.readTimeMinutes ?? 15,
      chapterCount: existingSummary?.chapters?.length ?? 0,
      tagline: "",
    },
    createdAt: new Date().toISOString(),
  };

  await saveActiveDraft(env, userId, draft);
  await sendMessage(env, chatId, formatDraftPreviewHtml(draft), buildDraftKeyboard(draft));
}

function getHelpHtml(): string {
  return [
    `🤖 <b>VectorBot — Personal AI Assistant & Glance CMS</b>`,
    ``,
    `<b>Glance Book Summary Commands:</b>`,
    `• <code>/books</code> — Browse books in Glance (10 per page with buttons)`,
    `• <code>/books &lt;page&gt;</code> — Jump to a specific page (e.g. <code>/books 2</code>)`,
    `• <code>/books &lt;keyword&gt;</code> — Search books by title, author, or category (e.g. <code>/books finance</code>)`,
    `• <code>/book &lt;id&gt;</code> — Inspect a book's overview, takeaways & chapters`,
    `• <code>/add &lt;Title by Author&gt;</code> — Draft a new 5-chapter book summary`,
    `• <code>/delete &lt;id&gt;</code> — Stage a book deletion (with confirmation)`,
    `• <code>/draft</code> — View your currently staged draft`,
    `• <code>/cancel</code> — Discard your currently staged draft`,
    ``,
    `<b>📄 Summarize From Ebook / Document File:</b>`,
    `• Upload any <b>.pdf</b>, <b>.epub</b>, <b>.txt</b>, <b>.md</b>, or <b>.html</b> file (up to 20 MB) directly to this chat (with an optional caption for focus instructions).`,
    `• Processed in ephemeral memory — 0 bytes are kept on Cloudflare or Gemini after drafting!`,
    ``,
    `<b>Natural Language & Review Flow:</b>`,
    `• Browse & search naturally: <i>"Show me page 2 of my books"</i> or <i>"List my psychology books"</i>`,
    `• Create naturally: <i>"Create a summary for The Lean Startup by Eric Ries"</i>`,
    `• Update existing: <i>"Update atomic-habits: add a 6th chapter on environment design"</i>`,
    `• Revise active draft: While a draft is pending, just reply with changes (e.g. <i>"Make chapter 3 more practical with examples"</i>) before tapping <b>✅ Confirm & Push</b>.`,
  ].join("\n");
}

const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024; // 20 MB Telegram Bot API limit

async function handleDocumentUpload(
  env: RuntimeEnv,
  chatId: number,
  userId: string,
  doc: TelegramDocument,
  caption?: string,
): Promise<void> {
  const fileName = doc.file_name || "uploaded_document";
  const mimeType = doc.mime_type || "application/octet-stream";
  const lowerName = fileName.toLowerCase();

  const isSupported =
    /\.(pdf|epub|txt|md|markdown|html|htm|xhtml)$/i.test(lowerName) ||
    mimeType === "application/pdf" ||
    mimeType === "application/epub+zip" ||
    mimeType.startsWith("text/");

  if (!isSupported) {
    await sendMessage(
      env,
      chatId,
      `⚠️ <b>Unsupported file format:</b> <code>${escapeHtml(fileName)}</code>\n\nSupported formats: <b>.pdf</b>, <b>.epub</b>, <b>.txt</b>, <b>.md</b>, <b>.html</b>`,
    );
    return;
  }

  if (doc.file_size && doc.file_size > MAX_TELEGRAM_FILE_BYTES) {
    const sizeMb = (doc.file_size / (1024 * 1024)).toFixed(1);
    await sendMessage(
      env,
      chatId,
      `⚠️ <b>File too large (${sizeMb} MB):</b> Telegram's Bot API limits file downloads to <b>20 MB</b>. Try uploading an <b>.epub</b> or compressed PDF under 20 MB.`,
    );
    return;
  }

  await sendMessage(
    env,
    chatId,
    [
      `⏳ <b>Reading & summarizing uploaded file:</b> <code>${escapeHtml(fileName)}</code>`,
      caption ? `📝 <i>Focus: "${escapeHtml(caption)}"</i>` : "",
      `<i>Processed in ephemeral RAM — file is discarded immediately after the draft is created (~15–25s)...</i>`,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const { bytes } = await downloadTelegramFile(env, doc.file_id);
  const generated = await generateBookSummaryFromDocument(env, {
    fileName,
    mimeType,
    bytes,
    userCaption: caption,
  });

  const draft: PendingDraft = {
    action: "create",
    bookId: generated.summary.id,
    summary: generated.summary,
    catalogItem: generated.catalogItem,
    changeSummary: generated.changeSummary,
    createdAt: new Date().toISOString(),
  };

  await saveActiveDraft(env, userId, draft);
  await sendMessage(env, chatId, formatDraftPreviewHtml(draft), buildDraftKeyboard(draft));
}

// --- Public Entrypoints for Messages and Callbacks ---

export async function handleTelegramMessage(
  env: RuntimeEnv,
  message: TelegramMessage,
  userId: string,
): Promise<void> {
  const chatId = message.chat.id;

  // Handle uploaded Ebook / Document files (.pdf, .epub, .txt, .md, .html)
  if (message.document) {
    try {
      await handleDocumentUpload(
        env,
        chatId,
        userId,
        message.document,
        message.caption?.trim(),
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ message: "handleDocumentUpload_error", error: errMsg }));
      await sendMessage(
        env,
        chatId,
        `⚠️ <b>File Summarization Failed:</b> <code>${escapeHtml(errMsg.slice(0, 400))}</code>`,
      );
    }
    return;
  }

  const text = (message.text ?? "").trim();
  if (!text) return;

  try {
    // 1. Explicit Slash Commands
    if (text.startsWith("/start") || text.startsWith("/help")) {
      await sendMessage(env, chatId, getHelpHtml());
      return;
    }

    if (
      text === "/books" ||
      text.startsWith("/books@") ||
      text.startsWith("/books ") ||
      text.startsWith("/search ")
    ) {
      const rawArg = text.startsWith("/search ")
        ? text.slice("/search ".length)
        : text.replace(/^\/books(?:@\S+)?\s*/i, "");
      const { page, filterQuery } = parseBooksCommandArgs(rawArg);
      await handleListBooks(env, chatId, page, filterQuery);
      return;
    }

    if (text.startsWith("/book ")) {
      const arg = text.slice("/book ".length).trim();
      await handleInspectBook(env, chatId, arg);
      return;
    }

    if (text.startsWith("/add ")) {
      const arg = text.slice("/add ".length).trim();
      if (!arg) {
        await sendMessage(env, chatId, `Usage: <code>/add The Lean Startup by Eric Ries</code>`);
        return;
      }
      await handleCreateBookDraft(env, chatId, userId, arg);
      return;
    }

    if (text.startsWith("/delete ")) {
      const arg = text.slice("/delete ".length).trim();
      if (!arg) {
        await sendMessage(env, chatId, `Usage: <code>/delete &lt;book-id&gt;</code>`);
        return;
      }
      await handleStageDeleteBook(env, chatId, userId, arg);
      return;
    }

    if (text === "/draft" || text.startsWith("/draft@")) {
      const draft = await getActiveDraft(env, userId);
      if (!draft) {
        await sendMessage(env, chatId, `ℹ️ You have no pending draft in staging.`);
        return;
      }
      await sendMessage(env, chatId, formatDraftPreviewHtml(draft), buildDraftKeyboard(draft));
      return;
    }

    if (text === "/cancel" || text.startsWith("/cancel@")) {
      const draft = await getActiveDraft(env, userId);
      if (!draft) {
        await sendMessage(env, chatId, `ℹ️ No active draft to cancel.`);
        return;
      }
      await clearActiveDraft(env, userId);
      await sendMessage(
        env,
        chatId,
        `❌ Discarded staged draft for <code>${escapeHtml(draft.bookId)}</code>.`,
      );
      return;
    }

    // 2. Natural Language Routing via Gemini
    const [activeDraft, catalog] = await Promise.all([
      getActiveDraft(env, userId),
      getCatalog(env),
    ]);

    const classified = await classifyIntent(env, text, activeDraft, catalog.books);

    switch (classified.intent) {
      case "list_books":
        await handleListBooks(
          env,
          chatId,
          classified.page && classified.page > 0 ? classified.page : 1,
          classified.filterQuery || "",
        );
        break;

      case "inspect_book":
        await handleInspectBook(
          env,
          chatId,
          classified.bookId || classified.bookQuery || text,
        );
        break;

      case "create_book":
        await handleCreateBookDraft(env, chatId, userId, classified.bookQuery || text);
        break;

      case "update_book":
        if (!classified.bookId && !classified.bookQuery) {
          await sendMessage(
            env,
            chatId,
            `Please specify which book to update (e.g., <i>"Update atomic-habits: ..."</i>).`,
          );
          return;
        }
        await handleUpdateExistingBookDraft(
          env,
          chatId,
          userId,
          classified.bookId || classified.bookQuery!,
          classified.instruction || text,
        );
        break;

      case "revise_draft":
        if (!activeDraft) {
          await sendMessage(
            env,
            chatId,
            `ℹ️ You don't have an active draft right now. Use <code>/add &lt;Book&gt;</code> or ask me to update an existing book first.`,
          );
          return;
        }
        await handleReviseActiveDraft(
          env,
          chatId,
          userId,
          activeDraft,
          classified.instruction || text,
        );
        break;

      case "delete_book":
        await handleStageDeleteBook(
          env,
          chatId,
          userId,
          classified.bookId || classified.bookQuery || text,
        );
        break;

      case "cancel_draft":
        await clearActiveDraft(env, userId);
        await sendMessage(env, chatId, `❌ Active draft discarded.`);
        break;

      case "general_chat":
      default:
        await sendMessage(
          env,
          chatId,
          markdownToTelegramHtml(
            classified.reply || "How can I help you manage Glance or assist you today?",
          ),
        );
        break;
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "handleTelegramMessage_error", error: errMsg }));
    await sendMessage(
      env,
      chatId,
      `⚠️ <b>Error:</b> <code>${escapeHtml(errMsg.slice(0, 400))}</code>`,
    );
  }
}

export async function handleTelegramCallback(
  env: RuntimeEnv,
  callback: TelegramCallbackQuery,
  userId: string,
): Promise<void> {
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;
  const data = callback.data ?? "";

  if (!chatId || !messageId) {
    await answerCallbackQuery(env, callback.id);
    return;
  }

  try {
    // 0. Paginated Catalog Navigation (glance:books:<page>:<filter>)
    if (data.startsWith("glance:books:")) {
      const rest = data.slice("glance:books:".length);
      const colonIdx = rest.indexOf(":");
      const targetPage =
        colonIdx === -1 ? Number(rest) || 1 : Number(rest.slice(0, colonIdx)) || 1;
      const filterQuery = colonIdx === -1 ? "" : rest.slice(colonIdx + 1);

      const catalog = await getCatalog(env);
      const view = buildCatalogPageView(catalog, targetPage, filterQuery);
      await answerCallbackQuery(env, callback.id, `Page ${targetPage}`);
      await editMessageText(env, chatId, messageId, view.html, view.keyboard);
      return;
    }

    if (data.startsWith("glance:noop")) {
      await answerCallbackQuery(env, callback.id);
      return;
    }

    // 1. Confirm Staged Draft -> Commit to Firestore
    if (data === "glance:confirm") {
      const draft = await getActiveDraft(env, userId);
      if (!draft) {
        await answerCallbackQuery(env, callback.id, "No active draft found (may have expired).");
        return;
      }

      await answerCallbackQuery(env, callback.id, "Publishing to Firestore...");

      if (draft.action === "delete") {
        await deleteBook(env, draft.bookId);
        await clearActiveDraft(env, userId);
        await editMessageText(
          env,
          chatId,
          messageId,
          `✅ <b>Deleted from Glance!</b>\nRemoved <code>${escapeHtml(draft.bookId)}</code> from both <code>summaries/${escapeHtml(draft.bookId)}</code> and <code>catalog/books</code>.`,
        );
        return;
      }

      if (!draft.summary || !draft.catalogItem) {
        throw new Error("Draft payload is incomplete.");
      }

      await upsertBook(env, draft.summary, draft.catalogItem);
      await clearActiveDraft(env, userId);

      const actionVerb = draft.action === "create" ? "Published new book" : "Updated book";
      await editMessageText(
        env,
        chatId,
        messageId,
        [
          `✅ <b>${actionVerb} in Glance!</b>`,
          ``,
          `📖 <b>${escapeHtml(draft.summary.title)}</b> — <i>${escapeHtml(draft.summary.author)}</i>`,
          `🆔 <code>${escapeHtml(draft.summary.id)}</code> (${draft.summary.chapters.length} chapters synced to <code>summaries/${escapeHtml(draft.summary.id)}</code> & <code>catalog/books</code>)`,
        ].join("\n"),
      );
      return;
    }

    // 2. Cancel Staged Draft
    if (data === "glance:cancel") {
      await clearActiveDraft(env, userId);
      await answerCallbackQuery(env, callback.id, "Draft cancelled.");
      await editMessageText(
        env,
        chatId,
        messageId,
        `❌ <b>Staged draft discarded.</b> No changes were made to Firestore.`,
      );
      return;
    }

    // 3. View Draft Overview
    if (data === "glance:preview") {
      const draft = await getActiveDraft(env, userId);
      if (!draft) {
        await answerCallbackQuery(env, callback.id, "Draft expired.");
        return;
      }
      await answerCallbackQuery(env, callback.id);
      await editMessageText(
        env,
        chatId,
        messageId,
        formatDraftPreviewHtml(draft),
        buildDraftKeyboard(draft),
      );
      return;
    }

    // 4. Inspect a Chapter inside the Staged Draft
    if (data.startsWith("glance:ch:")) {
      const chIdx = Number(data.slice("glance:ch:".length));
      const draft = await getActiveDraft(env, userId);
      if (!draft || !draft.summary) {
        await answerCallbackQuery(env, callback.id, "Draft expired.");
        return;
      }

      const chapter = draft.summary.chapters[chIdx];
      if (!chapter) {
        await answerCallbackQuery(env, callback.id, "Chapter not found.");
        return;
      }

      await answerCallbackQuery(env, callback.id, `Chapter ${chIdx + 1}`);
      const html = [
        `📝 <b>DRAFT — ${escapeHtml(draft.summary.title)}</b>`,
        `<b>Chapter ${chIdx + 1}: ${escapeHtml(chapter.title)}</b>`,
        ``,
        markdownToTelegramHtml(chapter.contentMarkdown),
      ].join("\n");

      const kb: InlineKeyboardMarkup = {
        inline_keyboard: [
          [{ text: "⬅️ Back to Draft Overview", callback_data: "glance:preview" }],
          [
            { text: "✅ Confirm & Push to Firestore", callback_data: "glance:confirm" },
            { text: "❌ Cancel", callback_data: "glance:cancel" },
          ],
        ],
      };

      await editMessageText(env, chatId, messageId, html, kb);
      return;
    }

    // 5. Inspect a Chapter of an already-published Book
    if (data.startsWith("glance:inspect:")) {
      const parts = data.split(":");
      const bookId = parts[2];
      const chIdx = Number(parts[3]);
      const summary = await getBookSummary(env, bookId);
      if (!summary || !summary.chapters[chIdx]) {
        await answerCallbackQuery(env, callback.id, "Chapter not found.");
        return;
      }

      await answerCallbackQuery(env, callback.id, `Chapter ${chIdx + 1}`);
      const ch = summary.chapters[chIdx];
      const html = [
        `📚 <b>${escapeHtml(summary.title)}</b>`,
        `<b>Chapter ${chIdx + 1}: ${escapeHtml(ch.title)}</b>`,
        ``,
        markdownToTelegramHtml(ch.contentMarkdown),
      ].join("\n");

      const kb: InlineKeyboardMarkup = {
        inline_keyboard: [
          [{ text: "⬅️ Back to Book Overview", callback_data: `glance:book:${bookId}` }],
        ],
      };

      await editMessageText(env, chatId, messageId, html, kb);
      return;
    }

    // 6. Back to Published Book Overview
    if (data.startsWith("glance:book:")) {
      const bookId = data.slice("glance:book:".length);
      const [catalog, summary] = await Promise.all([
        getCatalog(env),
        getBookSummary(env, bookId),
      ]);
      if (!summary) {
        await answerCallbackQuery(env, callback.id, "Book not found.");
        return;
      }
      const catalogItem = catalog.books.find((b) => b.id === bookId);
      await answerCallbackQuery(env, callback.id);
      await editMessageText(
        env,
        chatId,
        messageId,
        formatPublishedBookHtml(summary, catalogItem),
        buildPublishedBookKeyboard(summary.id, summary.chapters.length),
      );
      return;
    }

    await answerCallbackQuery(env, callback.id);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "handleTelegramCallback_error", error: errMsg }));
    await answerCallbackQuery(env, callback.id, "Error occurred");
    await sendMessage(
      env,
      chatId,
      `⚠️ <b>Action Failed:</b> <code>${escapeHtml(errMsg.slice(0, 400))}</code>`,
    );
  }
}
