import { extractTextFromEpub, extractTextFromPlainOrHtml } from "./ebook";
import type { BookCatalogItem, BookSummary, PendingDraft, RuntimeEnv } from "./types";

export type IntentType =
  | "list_books"
  | "inspect_book"
  | "create_book"
  | "update_book"
  | "revise_draft"
  | "delete_book"
  | "cancel_draft"
  | "general_chat";

export interface ClassifiedIntent {
  intent: IntentType;
  bookId?: string;
  bookQuery?: string;
  instruction?: string;
  page?: number;
  filterQuery?: string;
  reply?: string;
}

export interface GeneratedBookDraft {
  summary: BookSummary;
  catalogItem: BookCatalogItem;
  changeSummary: string;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: { message?: string };
}

async function callGeminiParts(
  env: RuntimeEnv,
  systemInstruction: string,
  userParts: Array<Record<string, unknown>>,
  responseSchema?: Record<string, unknown>,
): Promise<string> {
  const primaryModel = env.GEMINI_MODEL || "gemini-3.8-flash";
  const candidateModels = Array.from(
    new Set([primaryModel, "gemini-3.8-flash", "gemini-3.5-flash-lite"]),
  );

  const generationConfig: Record<string, unknown> = {
    temperature: 0.4,
  };

  if (responseSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = responseSchema;
  }

  let lastError = "";
  for (const model of candidateModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        contents: [
          {
            role: "user",
            parts: userParts,
          },
        ],
        generationConfig,
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as GeminiGenerateContentResponse;
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
    } else {
      const errText = await response.text();
      lastError = `Gemini API error (${model} -> ${response.status}): ${errText}`;
      if (response.status !== 503 && response.status !== 429 && response.status !== 404) {
        throw new Error(lastError);
      }
    }
  }

  throw new Error(lastError || "Gemini API returned an empty response.");
}

async function callGemini(
  env: RuntimeEnv,
  systemInstruction: string,
  userPrompt: string,
  responseSchema?: Record<string, unknown>,
): Promise<string> {
  return callGeminiParts(env, systemInstruction, [{ text: userPrompt }], responseSchema);
}

// --- Ephemeral Gemini File API Helpers for PDFs (Upload -> Summarize -> Immediate Delete) ---

interface GeminiUploadedFile {
  name: string;
  uri: string;
  state?: string;
}

async function uploadGeminiTempFile(
  env: RuntimeEnv,
  bytes: Uint8Array,
  mimeType: string,
  displayName: string,
): Promise<GeminiUploadedFile> {
  const startRes = await fetch(
    "https://generativelanguage.googleapis.com/upload/v1beta/files",
    {
      method: "POST",
      headers: {
        "x-goog-api-key": env.GEMINI_API_KEY,
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        file: { display_name: displayName },
      }),
    },
  );

  if (!startRes.ok) {
    const errText = await startRes.text();
    throw new Error(`Failed to initiate Gemini file upload (${startRes.status}): ${errText}`);
  }

  const uploadUrl = startRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("Gemini File API did not return an upload URL.");
  }

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`Failed to upload PDF bytes to Gemini (${uploadRes.status}): ${errText}`);
  }

  const data = (await uploadRes.json()) as { file: GeminiUploadedFile };
  return data.file;
}

async function deleteGeminiTempFile(env: RuntimeEnv, fileName: string): Promise<void> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/${fileName}`;
    await fetch(url, {
      method: "DELETE",
      headers: { "x-goog-api-key": env.GEMINI_API_KEY },
    });
    console.log(JSON.stringify({ message: "gemini_temp_file_deleted", fileName }));
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "gemini_temp_file_delete_warning",
        fileName,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

const BOOK_DRAFT_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  required: [
    "id",
    "title",
    "author",
    "categories",
    "readTimeMinutes",
    "tagline",
    "overview",
    "keyTakeaways",
    "chapters",
    "changeSummary",
  ],
  properties: {
    id: {
      type: "STRING",
      description: "Kebab-case slug of the book title, e.g. 'the-lean-startup'",
    },
    title: { type: "STRING", description: "Full book title" },
    author: { type: "STRING", description: "Author full name" },
    categories: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "1 to 3 categories, e.g. ['Business', 'Productivity']",
    },
    readTimeMinutes: {
      type: "INTEGER",
      description: "Estimated reading time in minutes (typically 12 to 20)",
    },
    tagline: {
      type: "STRING",
      description: "Compelling 1-line hook for the catalog card",
    },
    overview: {
      type: "STRING",
      description: "2 to 4 sentence synopsis of the book's core premise",
    },
    keyTakeaways: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "4 to 5 concise, high-impact bullet takeaways",
    },
    chapters: {
      type: "ARRAY",
      description: "5 rich chapters (~350-550 words each) in GitHub-Flavored Markdown",
      items: {
        type: "OBJECT",
        required: ["index", "title", "contentMarkdown"],
        properties: {
          index: { type: "INTEGER", description: "0-based sequential index" },
          title: { type: "STRING", description: "Chapter title" },
          contentMarkdown: {
            type: "STRING",
            description:
              "Rich GFM Markdown (~350-550 words) using ## subheadings, > memorable quotes, bullet lists, and bold/italic emphasis",
          },
        },
      },
    },
    changeSummary: {
      type: "STRING",
      description: "1-sentence summary of what was created or modified in this draft",
    },
  },
};

function parseRawBookDraft(jsonText: string, defaultChangeSummary: string): GeneratedBookDraft {
  const raw = JSON.parse(jsonText) as {
    id: string;
    title: string;
    author: string;
    categories: string[];
    readTimeMinutes: number;
    tagline: string;
    overview: string;
    keyTakeaways: string[];
    chapters: Array<{ index: number; title: string; contentMarkdown: string }>;
    changeSummary: string;
  };

  const normalizedChapters = raw.chapters.map((ch, idx) => ({
    index: idx,
    title: ch.title,
    contentMarkdown: ch.contentMarkdown,
  }));

  const summary: BookSummary = {
    id: raw.id,
    title: raw.title,
    author: raw.author,
    categories: raw.categories,
    readTimeMinutes: raw.readTimeMinutes,
    overview: raw.overview,
    keyTakeaways: raw.keyTakeaways,
    chapters: normalizedChapters,
  };

  const catalogItem: BookCatalogItem = {
    id: raw.id,
    title: raw.title,
    author: raw.author,
    coverUrl: "",
    categories: raw.categories,
    readTimeMinutes: raw.readTimeMinutes,
    chapterCount: normalizedChapters.length,
    tagline: raw.tagline,
  };

  return {
    summary,
    catalogItem,
    changeSummary: raw.changeSummary || defaultChangeSummary,
  };
}

export async function classifyIntent(
  env: RuntimeEnv,
  userText: string,
  activeDraft: PendingDraft | null,
  availableBooks: BookCatalogItem[],
): Promise<ClassifiedIntent> {
  const catalogContext =
    availableBooks.length > 0
      ? availableBooks
          .map(
            (b) =>
              `- ${b.id}: "${b.title}" by ${b.author} [${(b.categories ?? []).join(", ")}]`,
          )
          .join("\n")
      : "(Catalog is currently empty)";

  const draftContext = activeDraft
    ? `Active staged draft exists: action=${activeDraft.action}, bookId=${activeDraft.bookId}, title="${activeDraft.summary?.title ?? activeDraft.catalogItem?.title ?? activeDraft.bookId}". If the user is asking to tweak, shorten, expand, change categories/chapters/takeaways, or adjust the current draft, choose "revise_draft".`
    : "No active staged draft.";

  const systemInstruction = `You are VectorBot, a private personal AI assistant on Telegram with a Glance Book Summary CMS module.
Classify the user's message into one of these intents:
- "list_books": User wants to see/browse/search books in the Glance catalog (all books, a specific page like "page 2", or filtered by a topic/category/author/keyword like "list psychology books" or "books by Cal Newport").
  - If the user asks for a specific page number (e.g. "page 2 of books"), set "page" to that 1-based integer.
  - If the user asks to filter or search the catalog by keyword, category, or author (e.g. "show finance books", "search habits"), set "filterQuery" to the concise keyword (e.g. "finance", "habits"). Leave "filterQuery" empty if the user wants all books.
- "inspect_book": User wants to view details, takeaways, or chapters of a single specific book in the catalog.
- "create_book": User wants to create/add a new book summary for Glance.
- "update_book": User wants to edit/modify an existing book in the Glance catalog (and not the active draft).
- "revise_draft": An active draft exists and the user is giving feedback/edits to modify that active draft.
- "delete_book": User wants to delete/remove a book from Glance.
- "cancel_draft": User wants to discard/cancel the current pending draft.
- "general_chat": General question or conversation unrelated to Glance book CRUD. Provide a helpful, concise answer in the "reply" field.

Current Glance Catalog:
${catalogContext}

Draft State:
${draftContext}`;

  const schema: Record<string, unknown> = {
    type: "OBJECT",
    required: ["intent"],
    properties: {
      intent: {
        type: "STRING",
        enum: [
          "list_books",
          "inspect_book",
          "create_book",
          "update_book",
          "revise_draft",
          "delete_book",
          "cancel_draft",
          "general_chat",
        ],
      },
      bookId: {
        type: "STRING",
        description: "Exact bookId slug from the catalog if referencing an existing book",
      },
      bookQuery: {
        type: "STRING",
        description: "Book title and/or author when creating a new book",
      },
      instruction: {
        type: "STRING",
        description: "Specific update or revision instructions from the user",
      },
      page: {
        type: "INTEGER",
        description: "1-based page number when intent is list_books (default 1)",
      },
      filterQuery: {
        type: "STRING",
        description:
          "Optional keyword/category/author filter when intent is list_books (leave empty for all books)",
      },
      reply: {
        type: "STRING",
        description: "Direct response when intent is general_chat",
      },
    },
  };

  const jsonText = await callGemini(env, systemInstruction, userText, schema);
  return JSON.parse(jsonText) as ClassifiedIntent;
}

const SUMMARY_SYSTEM_PROMPT = `You are an expert literary synthesizer creating a structured book summary for the Glance reading app.
Produce a deeply insightful, accurate, and engaging book summary following these rules:
1. "id": kebab-case slug of the main book title (e.g., "the-lean-startup", "meditations").
2. "overview": 2 to 4 crisp sentences capturing the book's central thesis.
3. "keyTakeaways": 4 to 5 actionable, self-contained bullet points.
4. "chapters": 5 comprehensive chapters (~350-550 words each). Each chapter's "contentMarkdown" MUST use rich GitHub-Flavored Markdown:
   - "##" section subheadings
   - ">" blockquote for a key quote or principle
   - Bullet lists with "**bold**" lead-ins
   - Concrete examples and practical applications from the book.`;

export async function generateBookSummaryDraft(
  env: RuntimeEnv,
  bookQuery: string,
): Promise<GeneratedBookDraft> {
  const userPrompt = `Create a complete Glance book summary for: ${bookQuery}`;
  const jsonText = await callGemini(env, SUMMARY_SYSTEM_PROMPT, userPrompt, BOOK_DRAFT_SCHEMA);
  return parseRawBookDraft(jsonText, `Created 5-chapter summary draft.`);
}

export async function generateBookSummaryFromDocument(
  env: RuntimeEnv,
  options: {
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
    userCaption?: string;
  },
): Promise<GeneratedBookDraft> {
  const { fileName, mimeType, bytes, userCaption } = options;
  const lowerName = fileName.toLowerCase();
  const extraInstruction = userCaption
    ? `\nAdditional user instructions / focus: ${userCaption}`
    : "";

  // Case 1: PDF file -> Upload temporarily to Gemini File API, generate summary, and DELETE immediately in `finally`
  if (lowerName.endsWith(".pdf") || mimeType === "application/pdf") {
    const uploaded = await uploadGeminiTempFile(env, bytes, "application/pdf", fileName);
    try {
      const prompt = `Create a complete, accurate 5-chapter Glance book summary grounded strictly in the attached PDF book ("${fileName}"). Extract the book's true title and author from the document.${extraInstruction}`;
      const jsonText = await callGeminiParts(
        env,
        SUMMARY_SYSTEM_PROMPT,
        [
          {
            fileData: {
              mimeType: "application/pdf",
              fileUri: uploaded.uri,
            },
          },
          { text: prompt },
        ],
        BOOK_DRAFT_SCHEMA,
      );
      return parseRawBookDraft(
        jsonText,
        `Summarized from uploaded PDF "${fileName}" (temporary file purged).`,
      );
    } finally {
      await deleteGeminiTempFile(env, uploaded.name);
    }
  }

  // Case 2: EPUB file -> Unpack and extract chapters in Worker RAM (0 external files created)
  if (lowerName.endsWith(".epub") || mimeType === "application/epub+zip") {
    const extracted = extractTextFromEpub(bytes);
    const metaHint = [
      extracted.title ? `Detected Title: ${extracted.title}` : "",
      extracted.author ? `Detected Author: ${extracted.author}` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    const prompt = [
      `Create a complete, accurate 5-chapter Glance book summary grounded strictly in the following book text extracted from "${fileName}".`,
      metaHint ? `Metadata Hint: ${metaHint}` : "",
      extraInstruction,
      `\n--- BEGIN EXTRACTED BOOK TEXT ---\n${extracted.text}\n--- END EXTRACTED BOOK TEXT ---`,
    ]
      .filter(Boolean)
      .join("\n");

    const jsonText = await callGemini(env, SUMMARY_SYSTEM_PROMPT, prompt, BOOK_DRAFT_SCHEMA);
    return parseRawBookDraft(
      jsonText,
      `Summarized from uploaded EPUB "${fileName}" in ephemeral memory.`,
    );
  }

  // Case 3: Plain Text / Markdown / HTML (.txt, .md, .html, .htm) -> Extract in Worker RAM
  if (/\.(txt|md|markdown|html|htm|xhtml)$/i.test(lowerName) || mimeType.startsWith("text/")) {
    const text = extractTextFromPlainOrHtml(bytes, fileName);
    const prompt = [
      `Create a complete, accurate 5-chapter Glance book summary grounded strictly in the following text from "${fileName}".`,
      extraInstruction,
      `\n--- BEGIN DOCUMENT TEXT ---\n${text}\n--- END DOCUMENT TEXT ---`,
    ]
      .filter(Boolean)
      .join("\n");

    const jsonText = await callGemini(env, SUMMARY_SYSTEM_PROMPT, prompt, BOOK_DRAFT_SCHEMA);
    return parseRawBookDraft(
      jsonText,
      `Summarized from uploaded document "${fileName}" in ephemeral memory.`,
    );
  }

  throw new Error(
    `Unsupported file format ("${fileName}"). Supported formats: .pdf, .epub, .txt, .md, .html`,
  );
}

export async function reviseBookSummaryDraft(
  env: RuntimeEnv,
  currentSummary: BookSummary,
  currentCatalogItem: BookCatalogItem,
  instruction: string,
): Promise<GeneratedBookDraft> {
  const systemInstruction = `You are updating an existing Glance book summary draft based on the user's revision instructions.
Preserve all chapters, metadata, and content that the user did NOT ask to change.
Keep the exact "id" ("${currentSummary.id}") unless explicitly instructed to rename the slug.
Return the complete updated book object and a concise "changeSummary" describing what you modified.`;

  const userPrompt = `Current Catalog Item:
${JSON.stringify(currentCatalogItem, null, 2)}

Current Book Summary:
${JSON.stringify(currentSummary, null, 2)}

User Revision Instruction:
${instruction}`;

  const jsonText = await callGemini(env, systemInstruction, userPrompt, BOOK_DRAFT_SCHEMA);
  const parsed = parseRawBookDraft(jsonText, "Applied requested revisions to the draft.");

  return {
    summary: {
      ...parsed.summary,
      id: currentSummary.id,
      coverUrl: currentCatalogItem.coverUrl,
    },
    catalogItem: {
      ...parsed.catalogItem,
      id: currentSummary.id,
      coverUrl: currentCatalogItem.coverUrl,
    },
    changeSummary: parsed.changeSummary,
  };
}
