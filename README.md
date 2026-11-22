# 🤖 VectorBot — Personal Modular Telegram AI Assistant (Cloudflare Workers)

A private, general-purpose, modular Telegram AI assistant running on a **\$0 free-tier serverless stack** (**Cloudflare Workers + Cloudflare KV + Gemini API + Firebase Firestore REST API**).

Includes the **Glance Book Summary CMS Module** with a mandatory **Staged Review-Before-Publish (Human-in-the-Loop)** workflow.

---

## 🏗️ Architecture & Security

- **Two-Layer Single-User Auth (`src/security.ts`):**
  1. Verifies `X-Telegram-Bot-Api-Secret-Token` using constant-time SHA-256 + `crypto.subtle.timingSafeEqual`.
  2. Verifies the sender's Telegram User ID against `ALLOWED_TELEGRAM_USER_ID`.
- **Non-Blocking Webhook Execution (`src/index.ts`):**
  - Responds `200 OK` immediately to Telegram and executes Gemini generation + Firestore writes inside `ctx.waitUntil()`.
- **Staged Review-Before-Publish (`src/modules/glance.ts`):**
  - Every `create`, `update`, or `delete` action writes a pending draft to Cloudflare KV (`DRAFTS_KV`, 24h TTL) and sends an interactive preview with inline buttons (`📖 Ch 1..5`, `✅ Confirm & Push to Firestore`, `❌ Cancel`).
  - Plain-text replies while a draft is active revise the draft in place via Gemini.
  - Only explicit confirmation writes to Firestore—keeping `summaries/{bookId}` and `catalog/books` in sync.

---

## 📁 Project Structure

```text
vector_bot/
├── wrangler.jsonc          # Cloudflare Worker config, KV binding, and observability
├── package.json            # Scripts & dependencies
├── tsconfig.json           # TypeScript config
├── .dev.vars.example       # Local development secrets template
└── src/
    ├── index.ts            # Main Worker fetch handler (/health, /webhook)
    ├── types.ts            # Glance Firestore, KV Draft, and Telegram types
    ├── security.ts         # Constant-time two-layer webhook authentication
    ├── telegram.ts         # Telegram Bot API client & Markdown->HTML converter
    ├── firebase.ts         # Web Crypto RS256 JWT signer & Firestore REST client
    ├── gemini.ts           # Gemini structured output, PDF File API & natural language router
    ├── ebook.ts            # In-memory EPUB (fflate), HTML, Markdown & TXT extractor
    └── modules/
        └── glance.ts       # Glance CMS module & KV staged draft state machine
```
*(The earlier Python prototype files have been preserved in `_legacy_python/`.)*

---

## 💬 Supported Commands & Natural Language

| Action | Slash Command / Input | Natural Language / Usage Example |
| :--- | :--- | :--- |
| **List Catalog** | `/books` | *"List all Glance books"* |
| **Inspect Book** | `/book atomic-habits` | *"Show me Atomic Habits chapters"* |
| **Create Draft (Title)** | `/add The Lean Startup by Eric Ries` | *"Create a summary for The Lean Startup"* |
| **Create Draft (File Upload)** | Upload `.pdf`, `.epub`, `.txt`, `.md`, `.html` (≤20 MB) | Attach file in Telegram (optional caption for focus instructions); processed in ephemeral memory with 0 bytes retained |
| **Update Book** | *(natural language)* | *"Update atomic-habits: add a 6th chapter on environment design"* |
| **Revise Active Draft** | *(reply while draft is active)* | *"Make chapter 3 more practical with examples"* |
| **View Active Draft** | `/draft` | — |
| **Delete Book** | `/delete atomic-habits` | *"Remove atomic-habits from Glance"* |
| **Cancel Draft** | `/cancel` | *"Cancel the current draft"* |
