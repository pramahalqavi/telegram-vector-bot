import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEV_VARS_PATH = path.join(process.cwd(), ".dev.vars");

function parseEnvFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const result = {};
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

async function verifyAll() {
  const vars = parseEnvFile(DEV_VARS_PATH);

  // 1. Verify Telegram Bot
  const tgMeRes = await fetch(`https://api.telegram.org/bot${vars.TELEGRAM_BOT_TOKEN}/getMe`);
  const tgMe = await tgMeRes.json();
  if (!tgMe.ok) throw new Error(`Telegram getMe failed: ${tgMe.description}`);
  console.log(`✅ Telegram Bot OK: @${tgMe.result.username} (${tgMe.result.first_name})`);

  const whInfoRes = await fetch(
    `https://api.telegram.org/bot${vars.TELEGRAM_BOT_TOKEN}/getWebhookInfo`,
  );
  const whInfo = await whInfoRes.json();
  console.log(`📡 Telegram Webhook Info:`, JSON.stringify(whInfo.result, null, 2));

  // 2. Verify Gemini API
  let geminiOk = false;
  for (const model of ["gemini-3.8-flash", "gemini-3.5-flash-lite"]) {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": vars.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Reply with the single word READY" }] }],
        }),
      },
    );
    if (geminiRes.ok) {
      console.log(`✅ Gemini API (${model}) OK`);
      geminiOk = true;
      break;
    }
  }
  if (!geminiOk) throw new Error("Gemini API failed on all candidate models");

  // 3. Verify Firebase Service Account JWT & Firestore read using the exact Web Crypto logic from src/firebase.ts
  const rawPem = vars.FIREBASE_PRIVATE_KEY;
  const cleanedBase64 = rawPem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");

  const derBytes = Buffer.from(cleanedBase64, "base64");
  const cryptoKey = await crypto.webcrypto.subtle.importKey(
    "pkcs8",
    derBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: vars.FIREBASE_CLIENT_EMAIL,
      sub: vars.FIREBASE_CLIENT_EMAIL,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
      scope: "https://www.googleapis.com/auth/datastore",
    }),
  ).toString("base64url");
  const sigBuf = await crypto.webcrypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const sig = Buffer.from(sigBuf).toString("base64url");
  const jwt = `${header}.${payload}.${sig}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Firebase OAuth2 token failed (${tokenRes.status}): ${errText}`);
  }
  const { access_token } = await tokenRes.json();

  const fsRes = await fetch(
    "https://firestore.googleapis.com/v1/projects/glance-book-summary/databases/(default)/documents/catalog/books",
    { headers: { Authorization: `Bearer ${access_token}` } },
  );
  if (!fsRes.ok && fsRes.status !== 404) {
    const errText = await fsRes.text();
    throw new Error(`Firestore read failed (${fsRes.status}): ${errText}`);
  }
  const fsDoc = fsRes.status === 404 ? {} : await fsRes.json();
  const bookCount = fsDoc?.fields?.books?.arrayValue?.values?.length ?? 0;
  console.log(`✅ Firebase Firestore (glance-book-summary) OK — ${bookCount} books in catalog/books`);
}

verifyAll().catch((err) => {
  console.error(`❌ Verification error: ${err.message}`);
  process.exit(1);
});
