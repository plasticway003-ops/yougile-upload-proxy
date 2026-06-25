import express from "express";
import cors from "cors";
import axios from "axios";
import FormData from "form-data";
import mammoth from "mammoth";
import XLSX from "xlsx";
import pdfParse from "pdf-parse";
import { chromium } from "playwright";

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 3000;

const APP_VERSION = "bidzaar-parser-v7";

const PROXY_KEY = process.env.PROXY_KEY;
const YOUGILE_TOKEN = process.env.YOUGILE_TOKEN;
const YOUGILE_BASE_URL =
  process.env.YOUGILE_BASE_URL || "https://ru.yougile.com";
const YOUGILE_COLUMN_ID = process.env.YOUGILE_COLUMN_ID;

const STICKERS = {
  taskType: "f0f3804f-b18f-4c40-8b26-f9d4da7b3d04",
  positionsCount: "f84ddb36-0047-4df9-8b00-f998b4882707",
  source: "dceb4af0-5778-44b3-a0de-4078fb2c8933",
  platform: "056d984a-95b0-4064-8825-9cf087fa8036",
};

const STICKER_VALUES = {
  taskType: {
    "Город": "64e5efe2bd95",
    "Межгород": "350724eb0baa",
    "Совмещенный": "cbf0040c5f59",
    "Совмещённый": "cbf0040c5f59",
  },
  source: {
    "Почта": "2cfcf21f80e9",
  },
  platform: {
    "Bidzaar": "be00170e0502",
  },
};

const UI_NOISE = [
  "menu",
  "language",
  "ВХОД",
  "РЕГИСТРАЦИЯ",
  "account_circle",
  "home",
  "Главная",
  "Все закупки",
  "Все продажи",
  "Все реестры",
  "Последний конверт",
  "Больше о bidzaar",
  "arrow_back",
  "chevron_right",
  "star_border",
  "Похожие запросы",
  "ПОКАЗАТЬ ВСЕ ПОХОЖИЕ",
  "access_time",
  "policy",
  "enable",
];

function removeUiNoise(text = "") {
  let result = String(text);

  for (const word of UI_NOISE) {
    result = result.replace(new RegExp(word, "gi"), "");
  }

  return result
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlEscape(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeDocumentName(name) {
  return String(name || "document")
    .replace(/^article\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function requireProxyKey(req, res, next) {
  if (!PROXY_KEY) {
    return res.status(500).json({
      ok: false,
      version: APP_VERSION,
      error: "PROXY_KEY is not configured",
    });
  }

  if (req.header("x-proxy-key") !== PROXY_KEY) {
    return res.status(401).json({
      ok: false,
      version: APP_VERSION,
      error: "Unauthorized",
    });
  }

  next();
}

function buildHeaders() {
  return {
    Authorization: `Bearer ${YOUGILE_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function downloadFile(url) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 120000,
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });

  return {
    buffer: Buffer.from(response.data),
    contentType:
      response.headers["content-type"] || "application/octet-stream",
  };
}

async function extractDocumentText(filename, buffer) {
  const lower = filename.toLowerCase();

  try {
    if (lower.endsWith(".docx")) {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }

    if (lower.endsWith(".pdf")) {
      const result = await pdfParse(buffer);
      return result.text;
    }

    if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
      const wb = XLSX.read(buffer, { type: "buffer" });

      return wb.SheetNames.map((sheet) =>
        XLSX.utils.sheet_to_csv(wb.Sheets[sheet])
      ).join("\n");
    }

    return "";
  } catch (e) {
    console.error("Document parse error:", filename, e.message);
    return "";
  }
}
function getFilenameFromUrl(url, fallback = "document") {
  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname);
    const last = pathname.split("/").filter(Boolean).pop();

    return normalizeDocumentName(last || fallback);
  } catch {
    return normalizeDocumentName(fallback);
  }
}

function normalizeDocUrl(url, sourceUrl) {
  if (!url) return null;

  try {
    return new URL(url, sourceUrl).toString();
  } catch {
    return null;
  }
}

function toTimestampMs(value) {
  if (!value) return null;

  if (typeof value === "number") {
    return value;
  }

  const raw = String(value).trim();

  const ruMatch = raw.match(
    /(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/,
  );

  if (ruMatch) {
    const [, dd, mm, yyyy, hh = "18", min = "00"] = ruMatch;

    const date = new Date(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(min),
      0,
      0,
    );

    if (!Number.isNaN(date.getTime())) {
      return date.getTime();
    }
  }

  const parsed = Date.parse(raw);

  if (!Number.isNaN(parsed)) {
    return parsed;
  }

  return null;
}

function makeDeadline(deadlineValue) {
  const deadlineMs = toTimestampMs(deadlineValue);

  if (!deadlineMs) return undefined;

  return {
    deadline: deadlineMs,
    startDate: deadlineMs,
    withTime: true,
    history: [
      {
        deadline: deadlineMs,
        startDate: deadlineMs,
        withTime: true,
        timestamp: Date.now(),
      },
    ],
  };
}

function normalizeTaskType(taskType) {
  const value = String(taskType || "Город").trim();

  if (value === "Совмещённый") return "Совмещенный";

  if (STICKER_VALUES.taskType[value]) {
    return value;
  }

  return "Город";
}

function makeStickers({ taskType = "Город", positionsCount = 0 } = {}) {
  const normalizedTaskType = normalizeTaskType(taskType);

  return {
    [STICKERS.taskType]: STICKER_VALUES.taskType[normalizedTaskType],
    [STICKERS.positionsCount]: String(positionsCount ?? 0),
    [STICKERS.source]: STICKER_VALUES.source.Почта,
    [STICKERS.platform]: STICKER_VALUES.platform.Bidzaar,
  };
}

function makeShortTask(fullTask, fallback = {}) {
  return {
    id: fullTask?.id || fallback.id || null,
    idTaskProject: fullTask?.idTaskProject || null,
    idTaskCommon: fullTask?.idTaskCommon || null,
    title: fullTask?.title || fallback.title || null,
    columnId: fullTask?.columnId || null,
  };
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function flattenJson(value, result = [], depth = 0) {
  if (depth > 8) return result;

  if (Array.isArray(value)) {
    for (const item of value) {
      flattenJson(item, result, depth + 1);
    }

    return result;
  }

  if (isObject(value)) {
    result.push(value);

    for (const item of Object.values(value)) {
      flattenJson(item, result, depth + 1);
    }
  }

  return result;
}

function pickFirstString(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (typeof value === "number") {
      return String(value);
    }
  }

  return null;
}

function pickFirstNumber(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];

    if (typeof value === "number") {
      return value;
    }

    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      return Number(value.trim());
    }
  }

  return null;
}

function isBadPlaceholder(value) {
  const raw = String(value || "").trim().toLowerCase();

  if (!raw) return true;

  return (
    raw.includes("укажите") ||
    raw.includes("введите") ||
    raw.includes("заполните") ||
    raw.includes("select") ||
    raw.includes("choose") ||
    raw.includes("placeholder")
  );
}

function isValidTenderCode(value) {
  const raw = String(value || "").trim();

  if (!raw) return false;
  if (isBadPlaceholder(raw)) return false;

  return (
    /^\d{2,}[-/]\d{2,}$/.test(raw) ||
    /^[A-ZА-Я0-9]{2,}[-/]\d{2,}$/i.test(raw)
  );
}
function extractCodeFromUrl(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);

    const candidates = [
      parsed.searchParams.get("utm_content"),
      parsed.searchParams.get("code"),
      parsed.searchParams.get("number"),
      parsed.searchParams.get("tenderCode"),
      parsed.searchParams.get("procedureCode"),
    ];

    for (const candidate of candidates) {
      if (isValidTenderCode(candidate)) {
        return candidate.trim();
      }
    }

    return null;
  } catch {
    return null;
  }
}

function extractTitleFromPageTitle(pageTitle) {
  const raw = String(pageTitle || "").replace(/\s+/g, " ").trim();

  if (!raw) return null;

  const bidzaarMatch = raw.match(/^Тендер\s*\|\s*(.*?)\s*\|\s*Bidzaar$/i);

  if (bidzaarMatch?.[1]) {
    const title = bidzaarMatch[1].trim();

    if (title && !isBadPlaceholder(title)) {
      return title;
    }
  }

  if (raw && raw.toLowerCase() !== "bidzaar" && !isBadPlaceholder(raw)) {
    return raw;
  }

  return null;
}

function looksLikeCompany(value) {
  const raw = String(value || "").trim();

  if (!raw) return false;
  if (raw.length < 2 || raw.length > 140) return false;
  if (isBadPlaceholder(raw)) return false;

  const lower = raw.toLowerCase();

  if (
    lower.includes("ооо") ||
    lower.includes("ао ") ||
    lower.includes("пао") ||
    lower.includes("зао") ||
    lower.includes("ип ") ||
    lower.includes("кордиант") ||
    lower.includes("zolla") ||
    lower.includes("фактор") ||
    lower.includes("megafon") ||
    lower.includes("мегафон") ||
    lower.includes("билайн")
  ) {
    return true;
  }

  return /^[А-ЯA-Z0-9 «»"()._-]{3,}$/.test(raw);
}

function normalizeCompanyName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^Компания\s*[:\-]?\s*/i, "")
    .replace(/^Заказчик\s*[:\-]?\s*/i, "")
    .trim();
}

function extractCompanyFromJsonObjects(objects) {
  const companyKeys = [
    "company",
    "companyName",
    "customer",
    "customerName",
    "client",
    "clientName",
    "organizer",
    "organizerName",
    "organization",
    "organizationName",
    "buyer",
    "buyerName",
    "ownerName",
  ];

  const candidates = [];

  for (const obj of objects) {
    const candidate = pickFirstString(obj, companyKeys);

    if (candidate && looksLikeCompany(candidate)) {
      candidates.push(normalizeCompanyName(candidate));
    }
  }

  const unique = [...new Set(candidates)];

  const strong = unique.find((item) =>
    /кордиант|zolla|фактор|ооо|пао|ао |зао|ип |мегафон|билайн/i.test(item),
  );

  return strong || unique[0] || null;
}

function buildFinalTitle({ pageTitle, jsonTitle, company }) {
  const titleFromPage = extractTitleFromPageTitle(pageTitle);

  const cleanJsonTitle =
    jsonTitle && !isBadPlaceholder(jsonTitle) && jsonTitle.toLowerCase() !== "bidzaar"
      ? jsonTitle.trim()
      : null;

  const baseTitle = titleFromPage || cleanJsonTitle || "Тендер Bidzaar";

  if (company && !baseTitle.toLowerCase().includes(company.toLowerCase())) {
    return `${company} (${baseTitle})`;
  }

  if (baseTitle === "Тендер Bidzaar") {
    return baseTitle;
  }

  if (/^тендер/i.test(baseTitle)) {
    return baseTitle;
  }

  return `Тендер | ${baseTitle}`;
}

function extractDocumentsFromJsonObjects(objects, sourceUrl) {
  const docs = [];
  const seen = new Set();

  const urlKeys = [
    "url",
    "href",
    "downloadUrl",
    "fileUrl",
    "link",
    "src",
    "path",
    "uri",
  ];

  const nameKeys = [
    "name",
    "title",
    "fileName",
    "filename",
    "originalName",
    "displayName",
    "label",
  ];

  for (const obj of objects) {
    const maybeType = String(
      obj.type || obj.kind || obj.contentType || obj.mimeType || "",
    ).toLowerCase();

    const maybeName = pickFirstString(obj, nameKeys);
    const maybeUrl = pickFirstString(obj, urlKeys);

    const lowerName = String(maybeName || "").toLowerCase();
    const lowerUrl = String(maybeUrl || "").toLowerCase();

    const looksLikeFile =
      lowerName.includes(".doc") ||
      lowerName.includes(".docx") ||
      lowerName.includes(".xls") ||
      lowerName.includes(".xlsx") ||
      lowerName.includes(".pdf") ||
      lowerUrl.includes(".doc") ||
      lowerUrl.includes(".docx") ||
      lowerUrl.includes(".xls") ||
      lowerUrl.includes(".xlsx") ||
      lowerUrl.includes(".pdf") ||
      lowerUrl.includes("download") ||
      maybeType.includes("pdf") ||
      maybeType.includes("word") ||
      maybeType.includes("excel") ||
      maybeType.includes("spreadsheet");

    if (!maybeUrl || !looksLikeFile) continue;

    const finalUrl = normalizeDocUrl(maybeUrl, sourceUrl);

    if (!finalUrl) continue;

    const finalName = normalizeDocumentName(
      maybeName || getFilenameFromUrl(finalUrl, "Документ"),
    );

    const key = `${finalName}|${finalUrl}`;

    if (seen.has(key)) continue;

    seen.add(key);

    docs.push({
      name: finalName,
      url: finalUrl,
    });
  }

  return docs;
}

function extractDocumentsFromDomLinks(links, sourceUrl) {
  const docs = [];
  const seen = new Set();

  for (const link of links || []) {
    const href = link.href;
    const text = normalizeDocumentName(link.text || "");

    const lower = `${href || ""} ${text}`.toLowerCase();

    const isDoc =
      lower.includes(".doc") ||
      lower.includes(".docx") ||
      lower.includes(".xls") ||
      lower.includes(".xlsx") ||
      lower.includes(".pdf") ||
      lower.includes("download") ||
      lower.includes("attachment") ||
      lower.includes("file");

    if (!href || !isDoc) continue;

    const finalUrl = normalizeDocUrl(href, sourceUrl);

    if (!finalUrl) continue;

    const finalName = normalizeDocumentName(
      text || getFilenameFromUrl(finalUrl, "Документ"),
    );

    const key = `${finalName}|${finalUrl}`;

    if (seen.has(key)) continue;

    seen.add(key);

    docs.push({
      name: finalName,
      url: finalUrl,
    });
  }

  return docs;
}

function mergeDocuments(...lists) {
  const result = [];
  const seen = new Set();

  for (const list of lists) {
    for (const doc of list || []) {
      const key = `${doc.name}|${doc.url}`;

      if (seen.has(key)) continue;

      seen.add(key);
      result.push(doc);
    }
  }

  return result;
}
function extractCodeFromUrl(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);

    const candidates = [
      parsed.searchParams.get("utm_content"),
      parsed.searchParams.get("code"),
      parsed.searchParams.get("number"),
      parsed.searchParams.get("tenderCode"),
      parsed.searchParams.get("procedureCode"),
    ];

    for (const candidate of candidates) {
      if (isValidTenderCode(candidate)) {
        return candidate.trim();
      }
    }

    return null;
  } catch {
    return null;
  }
}

function extractTitleFromPageTitle(pageTitle) {
  const raw = String(pageTitle || "").replace(/\s+/g, " ").trim();

  if (!raw) return null;

  const bidzaarMatch = raw.match(/^Тендер\s*\|\s*(.*?)\s*\|\s*Bidzaar$/i);

  if (bidzaarMatch?.[1]) {
    const title = bidzaarMatch[1].trim();

    if (title && !isBadPlaceholder(title)) {
      return title;
    }
  }

  if (raw && raw.toLowerCase() !== "bidzaar" && !isBadPlaceholder(raw)) {
    return raw;
  }

  return null;
}

function looksLikeCompany(value) {
  const raw = String(value || "").trim();

  if (!raw) return false;
  if (raw.length < 2 || raw.length > 140) return false;
  if (isBadPlaceholder(raw)) return false;

  const lower = raw.toLowerCase();

  if (
    lower.includes("ооо") ||
    lower.includes("ао ") ||
    lower.includes("пао") ||
    lower.includes("зао") ||
    lower.includes("ип ") ||
    lower.includes("кордиант") ||
    lower.includes("zolla") ||
    lower.includes("фактор") ||
    lower.includes("megafon") ||
    lower.includes("мегафон") ||
    lower.includes("билайн")
  ) {
    return true;
  }

  return /^[А-ЯA-Z0-9 «»"()._-]{3,}$/.test(raw);
}

function normalizeCompanyName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^Компания\s*[:\-]?\s*/i, "")
    .replace(/^Заказчик\s*[:\-]?\s*/i, "")
    .trim();
}

function extractCompanyFromJsonObjects(objects) {
  const companyKeys = [
    "company",
    "companyName",
    "customer",
    "customerName",
    "client",
    "clientName",
    "organizer",
    "organizerName",
    "organization",
    "organizationName",
    "buyer",
    "buyerName",
    "ownerName",
  ];

  const candidates = [];

  for (const obj of objects) {
    const candidate = pickFirstString(obj, companyKeys);

    if (candidate && looksLikeCompany(candidate)) {
      candidates.push(normalizeCompanyName(candidate));
    }
  }

  const unique = [...new Set(candidates)];

  const strong = unique.find((item) =>
    /кордиант|zolla|фактор|ооо|пао|ао |зао|ип |мегафон|билайн/i.test(item),
  );

  return strong || unique[0] || null;
}

function buildFinalTitle({ pageTitle, jsonTitle, company }) {
  const titleFromPage = extractTitleFromPageTitle(pageTitle);

  const cleanJsonTitle =
    jsonTitle && !isBadPlaceholder(jsonTitle) && jsonTitle.toLowerCase() !== "bidzaar"
      ? jsonTitle.trim()
      : null;

  const baseTitle = titleFromPage || cleanJsonTitle || "Тендер Bidzaar";

  if (company && !baseTitle.toLowerCase().includes(company.toLowerCase())) {
    return `${company} (${baseTitle})`;
  }

  if (baseTitle === "Тендер Bidzaar") {
    return baseTitle;
  }

  if (/^тендер/i.test(baseTitle)) {
    return baseTitle;
  }

  return `Тендер | ${baseTitle}`;
}

function extractDocumentsFromJsonObjects(objects, sourceUrl) {
  const docs = [];
  const seen = new Set();

  const urlKeys = [
    "url",
    "href",
    "downloadUrl",
    "fileUrl",
    "link",
    "src",
    "path",
    "uri",
  ];

  const nameKeys = [
    "name",
    "title",
    "fileName",
    "filename",
    "originalName",
    "displayName",
    "label",
  ];

  for (const obj of objects) {
    const maybeType = String(
      obj.type || obj.kind || obj.contentType || obj.mimeType || "",
    ).toLowerCase();

    const maybeName = pickFirstString(obj, nameKeys);
    const maybeUrl = pickFirstString(obj, urlKeys);

    const lowerName = String(maybeName || "").toLowerCase();
    const lowerUrl = String(maybeUrl || "").toLowerCase();

    const looksLikeFile =
      lowerName.includes(".doc") ||
      lowerName.includes(".docx") ||
      lowerName.includes(".xls") ||
      lowerName.includes(".xlsx") ||
      lowerName.includes(".pdf") ||
      lowerUrl.includes(".doc") ||
      lowerUrl.includes(".docx") ||
      lowerUrl.includes(".xls") ||
      lowerUrl.includes(".xlsx") ||
      lowerUrl.includes(".pdf") ||
      lowerUrl.includes("download") ||
      maybeType.includes("pdf") ||
      maybeType.includes("word") ||
      maybeType.includes("excel") ||
      maybeType.includes("spreadsheet");

    if (!maybeUrl || !looksLikeFile) continue;

    const finalUrl = normalizeDocUrl(maybeUrl, sourceUrl);

    if (!finalUrl) continue;

    const finalName = normalizeDocumentName(
      maybeName || getFilenameFromUrl(finalUrl, "Документ"),
    );

    const key = `${finalName}|${finalUrl}`;

    if (seen.has(key)) continue;

    seen.add(key);

    docs.push({
      name: finalName,
      url: finalUrl,
    });
  }

  return docs;
}

function extractDocumentsFromDomLinks(links, sourceUrl) {
  const docs = [];
  const seen = new Set();

  for (const link of links || []) {
    const href = link.href;
    const text = normalizeDocumentName(link.text || "");

    const lower = `${href || ""} ${text}`.toLowerCase();

    const isDoc =
      lower.includes(".doc") ||
      lower.includes(".docx") ||
      lower.includes(".xls") ||
      lower.includes(".xlsx") ||
      lower.includes(".pdf") ||
      lower.includes("download") ||
      lower.includes("attachment") ||
      lower.includes("file");

    if (!href || !isDoc) continue;

    const finalUrl = normalizeDocUrl(href, sourceUrl);

    if (!finalUrl) continue;

    const finalName = normalizeDocumentName(
      text || getFilenameFromUrl(finalUrl, "Документ"),
    );

    const key = `${finalName}|${finalUrl}`;

    if (seen.has(key)) continue;

    seen.add(key);

    docs.push({
      name: finalName,
      url: finalUrl,
    });
  }

  return docs;
}

function mergeDocuments(...lists) {
  const result = [];
  const seen = new Set();

  for (const list of lists) {
    for (const doc of list || []) {
      const key = `${doc.name}|${doc.url}`;

      if (seen.has(key)) continue;

      seen.add(key);
      result.push(doc);
    }
  }

  return result;
}
function extractTenderFromJsonResponses(jsonResponses, sourceUrl) {
  const allObjects = [];

  for (const response of jsonResponses || []) {
    flattenJson(response.json, allObjects);
  }

  let jsonTitle = null;
  let code = extractCodeFromUrl(sourceUrl);
  let deadline = null;
  let positionsCount = null;

  const titleKeys = [
    "procedureName",
    "processName",
    "tenderName",
    "lotName",
    "subject",
    "title",
    "name",
  ];

  const strictCodeKeys = [
    "procedureCode",
    "tenderCode",
    "processCode",
    "codeNumber",
    "procedureNumber",
    "processNumber",
    "tenderNumber",
    "publicNumber",
    "publicId",
  ];

  const deadlineKeys = [
    "deadline",
    "endDate",
    "finishDate",
    "endAt",
    "finishedAt",
    "submissionDeadline",
    "applicationDeadline",
    "dateEnd",
    "bidEndDate",
    "requestEndDate",
  ];

  const positionKeys = [
    "positionsCount",
    "itemsCount",
    "lotsCount",
    "quantity",
    "count",
  ];

  for (const obj of allObjects) {
    if (!jsonTitle) {
      const maybeTitle = pickFirstString(obj, titleKeys);

      if (
        maybeTitle &&
        maybeTitle.length > 5 &&
        maybeTitle.length < 300 &&
        !isBadPlaceholder(maybeTitle) &&
        !["bidzaar", "тендер"].includes(maybeTitle.toLowerCase())
      ) {
        jsonTitle = maybeTitle;
      }
    }

    if (!code) {
      const maybeCode = pickFirstString(obj, strictCodeKeys);

      if (isValidTenderCode(maybeCode)) {
        code = maybeCode;
      }
    }

    if (!deadline) {
      for (const key of deadlineKeys) {
        const value = obj?.[key];

        if (value && toTimestampMs(value)) {
          deadline = value;
          break;
        }
      }
    }

    if (positionsCount === null) {
      const maybeCount = pickFirstNumber(obj, positionKeys);

      if (typeof maybeCount === "number" && maybeCount >= 0 && maybeCount < 10000) {
        positionsCount = maybeCount;
      }
    }
  }

  const company = extractCompanyFromJsonObjects(allObjects);
  const documents = extractDocumentsFromJsonObjects(allObjects, sourceUrl);

  return {
    jsonTitle,
    code,
    deadline,
    positionsCount,
    company,
    documents,
    jsonObjectsCount: allObjects.length,
  };
}

function extractCompactFromText(text = {}) {
  const raw = removeUiNoise(text.text || "");
  const title = removeUiNoise(text.title || "");

  let code = null;
  let deadline = null;
  let positionsCount = null;

  const codeMatch = raw.match(/\b\d{2,}[-/]\d{2,}\b/);

  if (codeMatch) {
    code = codeMatch[0];
  }

  const deadlineMatch =
    raw.match(/(?:до|окончание|при[её]м.*?до|заявк.*?до)\s+(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}(?:\s+\d{1,2}:\d{2})?)/i) ||
    raw.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[\d.]+Z?)/i);

  if (deadlineMatch) {
    deadline = deadlineMatch[1];
  }

  const positionsMatch =
    raw.match(/(?:позиц(?:ий|ии|ия)|лот(?:ов|а)?)[^\d]{0,20}(\d{1,4})/i) ||
    raw.match(/(\d{1,4})\s+(?:позиц(?:ий|ии|ия)|лот(?:ов|а)?)/i);

  if (positionsMatch) {
    positionsCount = Number(positionsMatch[1]);
  }

  return {
    title,
    code,
    deadline,
    positionsCount,
  };
}

async function parseBidzaarTenderPage(sourceUrl) {
  const jsonResponses = [];
  let domData = {
    title: null,
    text: "",
    links: [],
  };

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage({
    viewport: { width: 1365, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome Safari",
  });

  page.on("response", async (response) => {
    const contentType = response.headers()["content-type"] || "";

    if (!contentType.includes("application/json")) return;

    try {
      const json = await response.json();

      jsonResponses.push({
        url: response.url(),
        json,
      });
    } catch {
      // ignore bad json responses
    }
  });

  try {
    await page.goto(sourceUrl, {
      waitUntil: "networkidle",
      timeout: 120000,
    });

    await page.waitForTimeout(3000);

    domData = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a"))
        .map((a) => ({
          href: a.href,
          text: a.innerText || a.textContent || "",
        }))
        .filter((item) => item.href);

      return {
        title: document.title || "",
        text: document.body?.innerText || "",
        links,
      };
    });
  } finally {
    await browser.close();
  }

  const fromJson = extractTenderFromJsonResponses(jsonResponses, sourceUrl);
  const fromText = extractCompactFromText(domData);
  const docsFromDom = extractDocumentsFromDomLinks(domData.links, sourceUrl);

  const title = buildFinalTitle({
    pageTitle: domData.title || fromText.title,
    jsonTitle: fromJson.jsonTitle || fromText.title,
    company: fromJson.company,
  });

  const documents = mergeDocuments(fromJson.documents, docsFromDom);

  return {
    title,
    code: fromJson.code || fromText.code || null,
    deadline: fromJson.deadline || fromText.deadline || null,
    positionsCount:
      fromJson.positionsCount !== null && fromJson.positionsCount !== undefined
        ? fromJson.positionsCount
        : fromText.positionsCount || documents.length || 0,
    company: fromJson.company || null,
    documents,
    documentsCount: documents.length,
    rawTextLength: String(domData.text || "").length,
    jsonResponsesCount: jsonResponses.length,
    jsonObjectsCount: fromJson.jsonObjectsCount,
  };
}
function makeDescription({ summaryHtml, documents = [], sourceUrl }) {
  const safeSummaryHtml =
    summaryHtml ||
    `<p><strong>Статус выжимки:</strong> документы не обработаны, выжимка предварительная.</p>`;

  const docsHtml = documents.length
    ? documents
        .map((doc) => {
          const name = htmlEscape(normalizeDocumentName(doc.name || doc.filename));
          const url = htmlEscape(doc.yougileUrl || doc.url);

          return `<a target="_blank" rel="noopener noreferrer" href="${url}">${name}</a>`;
        })
        .join("<br>")
    : "Документы не найдены.";

  const safeSourceUrl = htmlEscape(sourceUrl);

  return [
    safeSummaryHtml,
    `<p><strong>Документация:</strong><br>${docsHtml}</p>`,
    `<p><strong>Ссылка:</strong> <a target="_blank" rel="noopener noreferrer" href="${safeSourceUrl}">ссылка</a></p>`,
  ].join("");
}

async function createYouGileTask(taskPayload) {
  if (!YOUGILE_TOKEN) {
    throw new Error("YOUGILE_TOKEN is not configured");
  }

  const response = await axios.post(
    `${YOUGILE_BASE_URL}/api-v2/tasks`,
    taskPayload,
    {
      timeout: 120000,
      headers: buildHeaders(),
    },
  );

  return response.data;
}

async function getYouGileTaskByIdApi(taskId) {
  if (!taskId) {
    throw new Error("taskId is required");
  }

  if (!YOUGILE_TOKEN) {
    throw new Error("YOUGILE_TOKEN is not configured");
  }

  const response = await axios.get(
    `${YOUGILE_BASE_URL}/api-v2/tasks/${taskId}`,
    {
      timeout: 120000,
      headers: buildHeaders(),
    },
  );

  return response.data;
}

function getCreatedTaskId(createdResponse) {
  return (
    createdResponse?.id ||
    createdResponse?.task?.id ||
    createdResponse?.taskId ||
    createdResponse?.data?.id ||
    createdResponse?.data?.task?.id ||
    null
  );
}

function normalizeCreateMode(value) {
  const mode = String(value || "auto").trim().toLowerCase();

  if (["final", "preliminary", "auto"].includes(mode)) {
    return mode;
  }

  return "auto";
}

function makePreliminarySummary(tender) {
  return [
    `<p><strong>Статус выжимки:</strong> документы не обработаны, выжимка предварительная.</p>`,
    `<p><strong>Предмет закупки:</strong> ${htmlEscape(tender.title || "не найдено в документах/доступных данных")}</p>`,
    `<p><strong>Маршрут/адреса:</strong> не найдено в документах/доступных данных</p>`,
    `<p><strong>Характеристики груза:</strong> не найдено в документах/доступных данных</p>`,
    `<p><strong>Требования к машине/ТС:</strong> не найдено в документах/доступных данных</p>`,
    `<p><strong>Объём/позиции:</strong> ${htmlEscape(String(tender.positionsCount ?? "не найдено в документах/доступных данных"))}</p>`,
    `<p><strong>Сроки/этапы:</strong> ${htmlEscape(tender.deadline || "не найдено в документах/доступных данных")}</p>`,
    `<p><strong>Условия оплаты:</strong> не найдено в документах/доступных данных</p>`,
    `<p><strong>Штрафы/ответственность:</strong> не найдено в документах/доступных данных</p>`,
    `<p><strong>Критерии выбора:</strong> не найдено в документах/доступных данных</p>`,
    `<p><strong>Документы/КП:</strong> документы найдены, но текст не обработан</p>`,
  ].join("");
}

async function createTenderFromBidzaar({
  url,
  columnId,
  taskType = "Город",
  assigned,
  color,
  requireDocsProcessed = true,
  createMode = "auto",
}) {
  const mode = normalizeCreateMode(createMode);
  const targetColumnId =
    columnId || YOUGILE_COLUMN_ID || "7efb8402-7778-42a6-a86d-d0907b55086e";

  const tender = await parseBidzaarTenderPage(url);
  const documentResult = await processTenderDocuments(tender.documents);

  const hasDocs = tender.documents.length > 0;
  const docsProcessed = documentResult.docsProcessed;

  const shouldCreatePreliminary =
    mode === "preliminary" || (!hasDocs && mode === "auto");

  if (
    hasDocs &&
    !docsProcessed &&
    requireDocsProcessed &&
    mode !== "preliminary"
  ) {
    return {
      ok: false,
      version: APP_VERSION,
      status: 422,
      error:
        "Документы найдены, но не обработаны. Финальная карточка не создана.",
      tender,
      docsProcessed: false,
      processedFiles: [],
      skippedFiles: documentResult.skippedFiles,
      qualityWarnings: documentResult.qualityWarnings,
      summaryStatus: "blocked_no_documents_processed",
    };
  }

  const summaryHtml = docsProcessed
    ? buildStructuredSummary({
        tender,
        processedFiles: documentResult.processedFiles,
        preliminary: false,
      })
    : makePreliminarySummary(tender);

  const summaryStatus = docsProcessed
    ? "final_from_documents"
    : "preliminary_documents_not_processed";

  const uploadedDocuments = [
    ...documentResult.processedFiles.map((file) => ({
      name: file.name,
      originalUrl: file.originalUrl,
      yougileUrl: file.yougileUrl,
    })),
    ...documentResult.skippedFiles
      .filter((file) => file.yougileUrl)
      .map((file) => ({
        name: file.name,
        originalUrl: file.url,
        yougileUrl: file.yougileUrl,
      })),
  ];

  const description = makeDescription({
    summaryHtml,
    documents: uploadedDocuments,
    sourceUrl: url,
  });

  const taskPayload = {
    title: tender.title,
    columnId: targetColumnId,
    description,
    stickers: makeStickers({
      taskType,
      positionsCount: tender.positionsCount || tender.documentsCount || 0,
    }),
  };

  const deadline = makeDeadline(tender.deadline);

  if (deadline) {
    taskPayload.deadline = deadline;
  }

  if (Array.isArray(assigned) && assigned.length) {
    taskPayload.assigned = assigned;
  }

  if (color) {
    taskPayload.color = color;
  }

  const created = await createYouGileTask(taskPayload);
  const createdTaskId = getCreatedTaskId(created);

  let actualTask = null;

  if (createdTaskId) {
    try {
      actualTask = await getYouGileTaskByIdApi(createdTaskId);
    } catch {
      actualTask = null;
    }
  }

  return {
    ok: true,
    version: APP_VERSION,
    task: makeShortTask(actualTask || created, {
      id: createdTaskId,
      title: tender.title,
    }),
    taskId: createdTaskId,
    actualColumnId: actualTask?.columnId || targetColumnId,
    tender,
    docsProcessed,
    processedFiles: documentResult.processedFiles.map((file) => ({
      name: file.name,
      textLength: file.textLength,
      yougileUrl: file.yougileUrl,
    })),
    skippedFiles: documentResult.skippedFiles,
    qualityWarnings: documentResult.qualityWarnings,
    summaryStatus,
    summaryHtml,
    createdMode: shouldCreatePreliminary ? "preliminary" : "final",
  };
}
app.get("/", (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    service: "YouGile Upload Proxy / Bidzaar Parser",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
  });
});

app.post("/upload-tender-file-by-url", requireProxyKey, async (req, res) => {
  try {
    const urls = Array.isArray(req.body?.urls)
      ? req.body.urls
      : req.body?.url
        ? [req.body.url]
        : [];

    if (!urls.length) {
      return res.status(400).json({
        ok: false,
        version: APP_VERSION,
        error: "url or urls is required",
      });
    }

    const uploaded = [];
    const errors = [];

    for (const url of urls) {
      try {
        const filename = getFilenameFromUrl(url, "Документ");
        const downloaded = await downloadFile(url);
        const result = await uploadFileToYouGile({
          buffer: downloaded.buffer,
          filename,
          contentType: downloaded.contentType,
        });

        uploaded.push({
          name: filename,
          originalUrl: url,
          yougileUrl: result.url,
        });
      } catch (error) {
        errors.push({
          url,
          error: error.message,
        });
      }
    }

    res.json({
      ok: errors.length === 0,
      version: APP_VERSION,
      uploaded,
      uploadedCount: uploaded.length,
      errors,
      errorsCount: errors.length,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: APP_VERSION,
      error: error.message,
    });
  }
});

app.post("/parse-bidzaar-compact", requireProxyKey, async (req, res) => {
  try {
    const url = req.body?.url;

    if (!url) {
      return res.status(400).json({
        ok: false,
        version: APP_VERSION,
        error: "url is required",
      });
    }

    const tender = await parseBidzaarTenderPage(url);

    res.json({
      ok: true,
      version: APP_VERSION,
      title: tender.title,
      code: tender.code,
      deadline: tender.deadline,
      positionsCount: tender.positionsCount,
      documentsCount: tender.documentsCount,
      documents: tender.documents.map((doc) => ({
        name: doc.name,
        url: doc.url,
      })),
      meta: {
        rawTextLength: tender.rawTextLength,
        jsonResponsesCount: tender.jsonResponsesCount,
        jsonObjectsCount: tender.jsonObjectsCount,
      },
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: APP_VERSION,
      error: error.message,
    });
  }
});

app.post("/create-tender-from-url", requireProxyKey, async (req, res) => {
  try {
    const url = req.body?.url;

    if (!url) {
      return res.status(400).json({
        ok: false,
        version: APP_VERSION,
        error: "url is required",
      });
    }

    const result = await createTenderFromBidzaar({
      url,
      columnId: req.body?.columnId,
      taskType: req.body?.taskType || req.body?.type || "Город",
      assigned: req.body?.assigned,
      color: req.body?.color,
      requireDocsProcessed:
        req.body?.requireDocsProcessed === undefined
          ? true
          : Boolean(req.body.requireDocsProcessed),
      createMode: req.body?.createMode || "auto",
    });

    if (result.status === 422) {
      return res.status(422).json(result);
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: APP_VERSION,
      error: error.message,
    });
  }
});

app.post("/create-bidzaar-tender", requireProxyKey, async (req, res) => {
  try {
    const url = req.body?.url;

    if (!url) {
      return res.status(400).json({
        ok: false,
        version: APP_VERSION,
        error: "url is required",
      });
    }

    const result = await createTenderFromBidzaar({
      url,
      columnId: req.body?.columnId,
      taskType: req.body?.taskType || req.body?.type || "Город",
      assigned: req.body?.assigned,
      color: req.body?.color,
      requireDocsProcessed:
        req.body?.requireDocsProcessed === undefined
          ? true
          : Boolean(req.body.requireDocsProcessed),
      createMode: req.body?.createMode || "auto",
    });

    if (result.status === 422) {
      return res.status(422).json(result);
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: APP_VERSION,
      error: error.message,
    });
  }
});
app.post("/create-task", requireProxyKey, async (req, res) => {
  try {
    const {
      title,
      description,
      columnId,
      deadline,
      taskType = "Город",
      positionsCount = 0,
      assigned,
      color,
    } = req.body || {};

    if (!title) {
      return res.status(400).json({
        ok: false,
        version: APP_VERSION,
        error: "title is required",
      });
    }

    const targetColumnId =
      columnId || YOUGILE_COLUMN_ID || "7efb8402-7778-42a6-a86d-d0907b55086e";

    const payload = {
      title,
      columnId: targetColumnId,
      description: description || "",
      stickers: makeStickers({
        taskType,
        positionsCount,
      }),
    };

    const deadlinePayload = makeDeadline(deadline);

    if (deadlinePayload) {
      payload.deadline = deadlinePayload;
    }

    if (Array.isArray(assigned) && assigned.length) {
      payload.assigned = assigned;
    }

    if (color) {
      payload.color = color;
    }

    const created = await createYouGileTask(payload);
    const createdTaskId = getCreatedTaskId(created);

    let actualTask = null;

    if (createdTaskId) {
      try {
        actualTask = await getYouGileTaskByIdApi(createdTaskId);
      } catch {
        actualTask = null;
      }
    }

    res.json({
      ok: true,
      version: APP_VERSION,
      task: makeShortTask(actualTask || created, {
        id: createdTaskId,
        title,
      }),
      taskId: createdTaskId,
      actualColumnId: actualTask?.columnId || targetColumnId,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: APP_VERSION,
      error: error.message,
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    version: APP_VERSION,
    error: "Not found",
  });
});

app.listen(PORT, () => {
  console.log(`${APP_VERSION} listening on port ${PORT}`);
});
