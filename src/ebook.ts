import { unzipSync } from "fflate";

const MAX_EXTRACTED_CHARS = 450_000; // ~110k tokens, well within Gemini's 1M context window

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&hellip;/gi, "…")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function stripHtmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "");

  const withBreaks = withoutScripts
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|blockquote|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ");

  const stripped = withBreaks.replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(stripped)
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function resolveRelativeZipPath(baseFilePath: string, relativeHref: string): string {
  const cleanHref = relativeHref.split("#")[0].split("?")[0];
  const baseParts = baseFilePath.split("/");
  baseParts.pop(); // remove filename
  for (const seg of cleanHref.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      baseParts.pop();
    } else {
      baseParts.push(seg);
    }
  }
  return baseParts.join("/");
}

export interface ExtractedEbook {
  title?: string;
  author?: string;
  text: string;
}

/**
 * Unpacks an EPUB archive entirely in Worker RAM using `fflate`, reads OPF metadata
 * and spine chapter order, and extracts clean plain text.
 */
export function extractTextFromEpub(bytes: Uint8Array): ExtractedEbook {
  const files = unzipSync(bytes);
  const decoder = new TextDecoder("utf-8");
  const allPaths = Object.keys(files);

  // 1. Locate OPF package file
  let opfPath = allPaths.find((p) => p.toLowerCase().endsWith(".opf"));
  const containerEntry = allPaths.find(
    (p) => p.toLowerCase() === "meta-inf/container.xml",
  );
  if (containerEntry) {
    const containerXml = decoder.decode(files[containerEntry]);
    const fullPathMatch = containerXml.match(/full-path=["']([^"']+\.opf)["']/i);
    if (fullPathMatch && files[fullPathMatch[1]]) {
      opfPath = fullPathMatch[1];
    }
  }

  let title: string | undefined;
  let author: string | undefined;
  const orderedChapterPaths: string[] = [];

  if (opfPath && files[opfPath]) {
    const opfXml = decoder.decode(files[opfPath]);

    const titleMatch = opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
    if (titleMatch) {
      title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, "").trim());
    }

    const creatorMatch = opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
    if (creatorMatch) {
      author = decodeHtmlEntities(creatorMatch[1].replace(/<[^>]+>/g, "").trim());
    }

    // Parse manifest items: id -> href
    const manifestMap = new Map<string, string>();
    const itemRegex = /<item\b([^>]+)\/?>/gi;
    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemRegex.exec(opfXml)) !== null) {
      const attrs = itemMatch[1];
      const idMatch = attrs.match(/\bid=["']([^"']+)["']/i);
      const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);
      if (idMatch && hrefMatch) {
        manifestMap.set(idMatch[1], decodeURIComponent(hrefMatch[1]));
      }
    }

    // Parse spine reading order: itemref -> idref
    const itemrefRegex = /<itemref\b[^>]*\bidref=["']([^"']+)["'][^>]*\/?>/gi;
    let refMatch: RegExpExecArray | null;
    while ((refMatch = itemrefRegex.exec(opfXml)) !== null) {
      const href = manifestMap.get(refMatch[1]);
      if (href) {
        const resolved = resolveRelativeZipPath(opfPath, href);
        const exactMatch =
          allPaths.find((p) => p === resolved) ??
          allPaths.find((p) => p.toLowerCase() === resolved.toLowerCase());
        if (exactMatch && !orderedChapterPaths.includes(exactMatch)) {
          orderedChapterPaths.push(exactMatch);
        }
      }
    }
  }

  // Fallback if spine was empty or missing: collect all XHTML/HTML files sorted by path
  if (orderedChapterPaths.length === 0) {
    const htmlPaths = allPaths
      .filter((p) => /\.(xhtml|html|htm|xml)$/i.test(p) && !/meta-inf|toc\.ncx/i.test(p))
      .sort();
    orderedChapterPaths.push(...htmlPaths);
  }

  const chunks: string[] = [];
  let totalChars = 0;

  for (const chapterPath of orderedChapterPaths) {
    const rawBytes = files[chapterPath];
    if (!rawBytes) continue;
    const rawHtml = decoder.decode(rawBytes);
    const chapterText = stripHtmlToText(rawHtml);
    if (chapterText.length < 40) continue; // skip empty cover/nav wrappers

    if (totalChars + chapterText.length > MAX_EXTRACTED_CHARS) {
      const remaining = MAX_EXTRACTED_CHARS - totalChars;
      if (remaining > 200) {
        chunks.push(chapterText.slice(0, remaining));
      }
      break;
    }

    chunks.push(chapterText);
    totalChars += chapterText.length;
  }

  const combinedText = chunks.join("\n\n---\n\n").trim();
  if (!combinedText) {
    throw new Error("Could not extract readable text from this EPUB file.");
  }

  return {
    title,
    author,
    text: combinedText,
  };
}

export function extractTextFromPlainOrHtml(bytes: Uint8Array, fileName: string): string {
  const decoder = new TextDecoder("utf-8");
  const raw = decoder.decode(bytes);
  const text = /\.(html|htm|xhtml)$/i.test(fileName) ? stripHtmlToText(raw) : raw.trim();
  if (!text) {
    throw new Error("The uploaded file appears to be empty.");
  }
  return text.slice(0, MAX_EXTRACTED_CHARS);
}
