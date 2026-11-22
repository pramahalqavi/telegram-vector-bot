import type { BookCatalogDoc, BookCatalogItem, BookSummary, RuntimeEnv } from "./types";

const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const TOKEN_KV_KEY = "system:firebase_access_token";

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(str: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(str));
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const normalized = pem.replace(/\\n/g, "\n");
  const base64 = normalized
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Mints a short-lived Google OAuth2 Access Token from the Service Account credentials
 * using Web Crypto RS256 and caches it in Cloudflare KV for 50 minutes.
 */
async function getFirestoreAccessToken(env: RuntimeEnv): Promise<string> {
  const cached = await env.DRAFTS_KV.get(TOKEN_KV_KEY);
  if (cached) return cached;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    sub: env.FIREBASE_CLIENT_EMAIL,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
    scope: FIRESTORE_SCOPE,
  };

  const signingInput = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(
    JSON.stringify(payload),
  )}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(env.FIREBASE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  const jwt = `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to mint Firebase OAuth2 token (${response.status}): ${errText}`);
  }

  const tokenData = (await response.json()) as { access_token: string; expires_in?: number };
  await env.DRAFTS_KV.put(TOKEN_KV_KEY, tokenData.access_token, { expirationTtl: 3000 });
  return tokenData.access_token;
}

// --- Firestore REST Value Converters ---

type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

function toFirestoreValue(val: unknown): FirestoreValue {
  if (val === null || val === undefined) {
    return { nullValue: null };
  }
  if (typeof val === "boolean") {
    return { booleanValue: val };
  }
  if (typeof val === "number") {
    if (Number.isInteger(val)) {
      return { integerValue: String(val) };
    }
    return { doubleValue: val };
  }
  if (typeof val === "string") {
    return { stringValue: val };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((item) => toFirestoreValue(item)) } };
  }
  if (typeof val === "object") {
    const fields: Record<string, FirestoreValue> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        fields[k] = toFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFirestoreValue(val: FirestoreValue | undefined): unknown {
  if (!val) return undefined;
  if ("nullValue" in val) return null;
  if ("booleanValue" in val) return val.booleanValue;
  if ("integerValue" in val) return Number(val.integerValue);
  if ("doubleValue" in val) return Number(val.doubleValue);
  if ("stringValue" in val) return val.stringValue;
  if ("arrayValue" in val) {
    return (val.arrayValue.values ?? []).map((v) => fromFirestoreValue(v));
  }
  if ("mapValue" in val) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val.mapValue.fields ?? {})) {
      out[k] = fromFirestoreValue(v);
    }
    return out;
  }
  return undefined;
}

interface FirestoreDocument {
  name?: string;
  fields?: Record<string, FirestoreValue>;
}

function toFirestoreFields(obj: Record<string, unknown>): Record<string, FirestoreValue> {
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      fields[k] = toFirestoreValue(v);
    }
  }
  return fields;
}

function fromFirestoreDocument<T>(doc: FirestoreDocument): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.fields ?? {})) {
    out[k] = fromFirestoreValue(v);
  }
  return out as T;
}

function firestoreDocUrl(projectId: string, docPath: string): string {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${docPath}`;
}

// --- SVG Cover Generator for New Books ---

const COVER_PALETTES: Array<{ bgStart: string; bgEnd: string; accent: string; textSub: string }> = [
  { bgStart: "#064e3b", bgEnd: "#047857", accent: "#fbbf24", textSub: "#a7f3d0" },
  { bgStart: "#1e1b4b", bgEnd: "#3730a3", accent: "#38bdf8", textSub: "#c7d2fe" },
  { bgStart: "#4c0519", bgEnd: "#881337", accent: "#fb7185", textSub: "#fecdd3" },
  { bgStart: "#14532d", bgEnd: "#15803d", accent: "#a3e635", textSub: "#bbf7d0" },
  { bgStart: "#3b0764", bgEnd: "#6b21a8", accent: "#f472b6", textSub: "#e9d5ff" },
  { bgStart: "#0f172a", bgEnd: "#1e293b", accent: "#f59e0b", textSub: "#cbd5e1" },
];

function escapeSvg(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function generateSvgCoverDataUri(title: string, author: string, bookId: string): string {
  let hash = 0;
  for (let i = 0; i < bookId.length; i++) {
    hash = (hash * 31 + bookId.charCodeAt(i)) >>> 0;
  }
  const palette = COVER_PALETTES[hash % COVER_PALETTES.length];

  const words = title.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length <= 16 || current === "") {
      current = (current + " " + word).trim();
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  const displayLines = lines.slice(0, 3);

  const titleSvg = displayLines
    .map(
      (line, idx) =>
        `<text x="36" y="${410 + idx * 38}" fill="#f8fafc" font-family="Georgia, serif" font-size="32" font-weight="700">${escapeSvg(line)}</text>`,
    )
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 560"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${palette.bgStart}"/><stop offset="100%" stop-color="${palette.bgEnd}"/></linearGradient></defs><rect width="400" height="560" fill="url(#g)"/><circle cx="200" cy="215" r="112" fill="none" stroke="${palette.textSub}" stroke-width="2" opacity="0.35"/><circle cx="200" cy="215" r="72" fill="none" stroke="${palette.textSub}" stroke-width="2" opacity="0.55"/><circle cx="200" cy="215" r="38" fill="${palette.accent}" opacity="0.9"/>${titleSvg}<text x="36" y="520" fill="${palette.textSub}" font-family="system-ui, sans-serif" font-size="15" font-weight="600" letter-spacing="2">${escapeSvg(author.toUpperCase().slice(0, 28))}</text></svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// --- Glance Firestore Operations ---

export async function getCatalog(env: RuntimeEnv): Promise<BookCatalogDoc> {
  const token = await getFirestoreAccessToken(env);
  const url = firestoreDocUrl(env.FIREBASE_PROJECT_ID, "catalog/books");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 404) {
    return { updatedAt: new Date().toISOString(), books: [] };
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Firestore getCatalog error (${response.status}): ${errText}`);
  }

  const doc = (await response.json()) as FirestoreDocument;
  const parsed = fromFirestoreDocument<BookCatalogDoc>(doc);
  return {
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    books: Array.isArray(parsed.books) ? parsed.books : [],
  };
}

export async function getBookSummary(
  env: RuntimeEnv,
  bookId: string,
): Promise<BookSummary | null> {
  const token = await getFirestoreAccessToken(env);
  const url = firestoreDocUrl(
    env.FIREBASE_PROJECT_ID,
    `summaries/${encodeURIComponent(bookId)}`,
  );
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Firestore getBookSummary error (${response.status}): ${errText}`);
  }

  const doc = (await response.json()) as FirestoreDocument;
  return fromFirestoreDocument<BookSummary>(doc);
}

/**
 * Publishes a BookSummary to `summaries/{bookId}` and keeps `catalog/books` in sync.
 */
export async function upsertBook(
  env: RuntimeEnv,
  summary: BookSummary,
  catalogItem: BookCatalogItem,
): Promise<void> {
  const token = await getFirestoreAccessToken(env);

  const finalCoverUrl =
    catalogItem.coverUrl && catalogItem.coverUrl.trim().length > 0
      ? catalogItem.coverUrl
      : generateSvgCoverDataUri(summary.title, summary.author, summary.id);

  const normalizedSummary: BookSummary = {
    ...summary,
    coverUrl: finalCoverUrl,
    categories: catalogItem.categories,
    readTimeMinutes: catalogItem.readTimeMinutes,
    chapters: summary.chapters.map((ch, idx) => ({
      index: idx,
      title: ch.title,
      contentMarkdown: ch.contentMarkdown,
    })),
  };

  const normalizedCatalogItem: BookCatalogItem = {
    ...catalogItem,
    id: summary.id,
    title: summary.title,
    author: summary.author,
    coverUrl: finalCoverUrl,
    chapterCount: normalizedSummary.chapters.length,
  };

  // 1. Write `summaries/{bookId}`
  const summaryUrl = firestoreDocUrl(
    env.FIREBASE_PROJECT_ID,
    `summaries/${encodeURIComponent(summary.id)}`,
  );
  const summaryRes = await fetch(summaryUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: toFirestoreFields(normalizedSummary as unknown as Record<string, unknown>),
    }),
  });

  if (!summaryRes.ok) {
    const errText = await summaryRes.text();
    throw new Error(`Failed to write summaries/${summary.id} (${summaryRes.status}): ${errText}`);
  }

  // 2. Sync `catalog/books`
  const currentCatalog = await getCatalog(env);
  const existingIndex = currentCatalog.books.findIndex((b) => b.id === summary.id);
  const updatedBooks = [...currentCatalog.books];
  if (existingIndex >= 0) {
    updatedBooks[existingIndex] = normalizedCatalogItem;
  } else {
    updatedBooks.push(normalizedCatalogItem);
  }

  const updatedCatalog: BookCatalogDoc = {
    updatedAt: new Date().toISOString(),
    books: updatedBooks,
  };

  const catalogUrl = firestoreDocUrl(env.FIREBASE_PROJECT_ID, "catalog/books");
  const catalogRes = await fetch(catalogUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: toFirestoreFields(updatedCatalog as unknown as Record<string, unknown>),
    }),
  });

  if (!catalogRes.ok) {
    const errText = await catalogRes.text();
    throw new Error(`Failed to update catalog/books (${catalogRes.status}): ${errText}`);
  }
}

/**
 * Deletes `summaries/{bookId}` and removes the entry from `catalog/books`.
 */
export async function deleteBook(env: RuntimeEnv, bookId: string): Promise<void> {
  const token = await getFirestoreAccessToken(env);

  // 1. Delete `summaries/{bookId}`
  const summaryUrl = firestoreDocUrl(
    env.FIREBASE_PROJECT_ID,
    `summaries/${encodeURIComponent(bookId)}`,
  );
  const delRes = await fetch(summaryUrl, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!delRes.ok && delRes.status !== 404) {
    const errText = await delRes.text();
    throw new Error(`Failed to delete summaries/${bookId} (${delRes.status}): ${errText}`);
  }

  // 2. Remove from `catalog/books`
  const currentCatalog = await getCatalog(env);
  const updatedCatalog: BookCatalogDoc = {
    updatedAt: new Date().toISOString(),
    books: currentCatalog.books.filter((b) => b.id !== bookId),
  };

  const catalogUrl = firestoreDocUrl(env.FIREBASE_PROJECT_ID, "catalog/books");
  const catalogRes = await fetch(catalogUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: toFirestoreFields(updatedCatalog as unknown as Record<string, unknown>),
    }),
  });

  if (!catalogRes.ok) {
    const errText = await catalogRes.text();
    throw new Error(`Failed to update catalog/books after delete (${catalogRes.status}): ${errText}`);
  }
}
