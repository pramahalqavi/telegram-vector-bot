import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const DEV_VARS_PATH = path.join(ROOT, ".dev.vars");
const WORKER_WEBHOOK_URL = "https://vector-bot.pramahalqavi97.workers.dev/webhook";

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf8");
  const result = {};

  // Handle multiline PEM private key if pasted across multiple lines
  const pemMatch = content.match(
    /FIREBASE_PRIVATE_KEY\s*=\s*["']?(-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----\\?\n?)["']?/,
  );

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }

  if (pemMatch && pemMatch[1]) {
    result.FIREBASE_PRIVATE_KEY = pemMatch[1].replace(/\r?\n/g, "\\n");
  }

  return result;
}

function serializeEnvFile(vars) {
  const lines = [
    "# VectorBot Secrets (.dev.vars - git-ignored)",
    `TELEGRAM_BOT_TOKEN=${vars.TELEGRAM_BOT_TOKEN || ""}`,
    `TELEGRAM_WEBHOOK_SECRET=${vars.TELEGRAM_WEBHOOK_SECRET || ""}`,
    `ALLOWED_TELEGRAM_USER_ID=${vars.ALLOWED_TELEGRAM_USER_ID || ""}`,
    `GEMINI_API_KEY=${vars.GEMINI_API_KEY || ""}`,
    `FIREBASE_CLIENT_EMAIL=${vars.FIREBASE_CLIENT_EMAIL || ""}`,
    `FIREBASE_PRIVATE_KEY="${(vars.FIREBASE_PRIVATE_KEY || "").replace(/\r?\n/g, "\\n")}"`,
    "",
  ];
  fs.writeFileSync(DEV_VARS_PATH, lines.join("\n"), "utf8");
}

async function main() {
  const args = process.argv.slice(2);
  const vars = parseEnvFile(DEV_VARS_PATH);
  let dirty = false;

  // Optional: --firebase-json <path> imports client_email and private_key automatically
  const fbJsonIdx = args.indexOf("--firebase-json");
  if (fbJsonIdx !== -1 && args[fbJsonIdx + 1]) {
    const jsonPath = path.resolve(args[fbJsonIdx + 1]);
    if (!fs.existsSync(jsonPath)) {
      console.error(`❌ Firebase JSON file not found at: ${jsonPath}`);
      process.exit(1);
    }
    const sa = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    if (sa.client_email && sa.private_key) {
      vars.FIREBASE_CLIENT_EMAIL = sa.client_email;
      vars.FIREBASE_PRIVATE_KEY = sa.private_key.replace(/\r?\n/g, "\\n");
      dirty = true;
      console.log(`✅ Imported FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY from JSON.`);
    } else {
      console.error(`❌ Invalid service account JSON (missing client_email or private_key).`);
      process.exit(1);
    }
  }

  // Ensure TELEGRAM_WEBHOOK_SECRET exists
  if (!vars.TELEGRAM_WEBHOOK_SECRET) {
    vars.TELEGRAM_WEBHOOK_SECRET = crypto.randomBytes(32).toString("hex");
    dirty = true;
    console.log(`✅ Generated random 64-char TELEGRAM_WEBHOOK_SECRET.`);
  }

  if (dirty) {
    serializeEnvFile(vars);
  }

  const requiredKeys = [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET",
    "ALLOWED_TELEGRAM_USER_ID",
    "GEMINI_API_KEY",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
  ];

  console.log("\n📋 Credential Status in .dev.vars:");
  let missingCount = 0;
  for (const key of requiredKeys) {
    const val = (vars[key] || "").trim();
    const present = val.length > 0;
    console.log(`  - ${key}: ${present ? `✅ PRESENT (len=${val.length})` : "❌ MISSING"}`);
    if (!present) missingCount++;
  }

  if (args.includes("--check-only") || missingCount > 0) {
    if (missingCount > 0) {
      console.log(
        `\n⚠️ Please fill in the ${missingCount} missing credential(s) in .dev.vars and re-run: npm run setup`,
      );
      process.exit(1);
    }
    return;
  }

  // 1. Upload secrets to Cloudflare Worker via wrangler secret bulk
  if (!args.includes("--webhook-only")) {
    console.log("\n☁️ Uploading secrets to Cloudflare Worker (vector-bot)...");
    const secretMap = {};
    for (const key of requiredKeys) {
      secretMap[key] = vars[key];
    }
    const tmpJsonPath = path.join(ROOT, ".tmp-secrets.json");
    fs.writeFileSync(tmpJsonPath, JSON.stringify(secretMap), "utf8");
    try {
      const res = spawnSync(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["wrangler", "secret", "bulk", tmpJsonPath],
        { stdio: "inherit" },
      );
      if (res.status !== 0) {
        console.error(
          "\n⚠️ wrangler secret bulk failed (run `npx wrangler login` if not authenticated).",
        );
        process.exit(res.status ?? 1);
      }
    } finally {
      if (fs.existsSync(tmpJsonPath)) fs.unlinkSync(tmpJsonPath);
    }
  }

  // 2. Register Telegram Webhook + Bot Command Menu
  console.log(`\n🔗 Registering Telegram Webhook -> ${WORKER_WEBHOOK_URL}`);
  const tgBase = `https://api.telegram.org/bot${vars.TELEGRAM_BOT_TOKEN}`;

  const whRes = await fetch(`${tgBase}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: WORKER_WEBHOOK_URL,
      secret_token: vars.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
  });
  const whData = await whRes.json();
  if (!whData.ok) {
    console.error(`❌ Failed to set Telegram webhook: ${whData.description || "unknown error"}`);
    process.exit(1);
  }
  console.log(`✅ Telegram Webhook registered: ${whData.description || "OK"}`);

  // Register slash commands in Telegram UI
  const cmdRes = await fetch(`${tgBase}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: [
        { command: "books", description: "List all books in Glance catalog" },
        { command: "book", description: "Inspect a book (/book <id>)" },
        { command: "add", description: "Draft a new 5-chapter book summary (/add <title>)" },
        { command: "draft", description: "View your currently staged draft" },
        { command: "delete", description: "Stage a book deletion (/delete <id>)" },
        { command: "cancel", description: "Discard the currently staged draft" },
        { command: "help", description: "Show VectorBot commands and usage" },
      ],
    }),
  });
  const cmdData = await cmdRes.json();
  if (cmdData.ok) {
    console.log(`✅ Telegram Bot command menu registered.`);
  }

  console.log(`\n🎉 VectorBot is live and connected! Send /start or /books to your bot in Telegram.`);
}

main().catch((err) => {
  console.error("❌ Setup failed:", err.message);
  process.exit(1);
});
