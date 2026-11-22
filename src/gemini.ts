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

async function callGemini(
  env: RuntimeEnv,
  systemInstruction: string,
  userPrompt: string,
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
            parts: [{ text: userPrompt }],
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

export async function classifyIntent(
  env: RuntimeEnv,
  userText: string,
  activeDraft: PendingDraft | null,
  availableBooks: BookCatalogItem[],
): Promise<ClassifiedIntent> {
  const catalogContext =
    availableBooks.length > 0
      ? availableBooks.map((b) => `- ${b.id}: "${b.title}" by ${b.author}`).join("\n")
      : "(Catalog is currently empty)";

  const draftContext = activeDraft
    ? `Active staged draft exists: action=${activeDraft.action}, bookId=${activeDraft.bookId}, title="${activeDraft.summary?.title ?? activeDraft.catalogItem?.title ?? activeDraft.bookId}". If the user is asking to tweak, shorten, expand, change categories/chapters/takeaways, or adjust the current draft, choose "revise_draft".`
    : "No active staged draft.";

  const systemInstruction = `You are VectorBot, a private personal AI assistant on Telegram with a Glance Book Summary CMS module.
Classify the user's message into one of these intents:
- "list_books": User wants to see all books in Glance catalog.
- "inspect_book": User wants to view details, takeaways, or chapters of an existing book in the catalog.
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
      reply: {
        type: "STRING",
        description: "Direct response when intent is general_chat",
      },
    },
  };

  const jsonText = await callGemini(env, systemInstruction, userText, schema);
  return JSON.parse(jsonText) as ClassifiedIntent;
}

export async function generateBookSummaryDraft(
  env: RuntimeEnv,
  bookQuery: string,
): Promise<GeneratedBookDraft> {
  const systemInstruction = `You are an expert literary synthesizer creating a structured book summary for the Glance reading app.
Produce a deeply insightful, accurate, and engaging book summary following these rules:
1. "id": kebab-case slug of the main book title (e.g., "the-lean-startup", "meditations").
2. "overview": 2 to 4 crisp sentences capturing the book's central thesis.
3. "keyTakeaways": 4 to 5 actionable, self-contained bullet points.
4. "chapters": 5 comprehensive chapters (~350-550 words each). Each chapter's "contentMarkdown" MUST use rich GitHub-Flavored Markdown:
   - "##" section subheadings
   - ">" blockquote for a key quote or principle
   - Bullet lists with "**bold**" lead-ins
   - Concrete examples and practical applications from the book.`;

  const userPrompt = `Create a complete Glance book summary for: ${bookQuery}`;
  const jsonText = await callGemini(env, systemInstruction, userPrompt, BOOK_DRAFT_SCHEMA);
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
    changeSummary: raw.changeSummary || `Created 5-chapter summary draft for "${raw.title}".`,
  };
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
    id: currentSummary.id,
    title: raw.title,
    author: raw.author,
    coverUrl: currentCatalogItem.coverUrl,
    categories: raw.categories,
    readTimeMinutes: raw.readTimeMinutes,
    overview: raw.overview,
    keyTakeaways: raw.keyTakeaways,
    chapters: normalizedChapters,
  };

  const catalogItem: BookCatalogItem = {
    id: currentSummary.id,
    title: raw.title,
    author: raw.author,
    coverUrl: currentCatalogItem.coverUrl,
    categories: raw.categories,
    readTimeMinutes: raw.readTimeMinutes,
    chapterCount: normalizedChapters.length,
    tagline: raw.tagline,
  };

  return {
    summary,
    catalogItem,
    changeSummary: raw.changeSummary || "Applied requested revisions to the draft.",
  };
}
