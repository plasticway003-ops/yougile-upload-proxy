import express from "express";
import cors from "cors";
import axios from "axios";
import FormData from "form-data";
import { chromium } from "playwright";

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;

const APP_VERSION = "bidzaar-parser-v7";

const PROXY_KEY = process.env.PROXY_KEY;
const YOUGILE_TOKEN = process.env.YOUGILE_TOKEN;
const YOUGILE_BASE_URL = process.env.YOUGILE_BASE_URL || "https://ru.yougile.com";

const YOUGILE_COLUMN_ID =
  process.env.YOUGILE_COLUMN_ID || "7efb8402-7778-42a6-a86d-d0907b55086e";

const STICKERS = {
  taskType: "f0f3804f-b18f-4c40-8b26-f9d4da7b3d04",
  positionsCount: "f84ddb36-0047-4df9-8b00-f998b4882707",
  source: "dceb4af0-5778-44b3-a0de-4078fb2c8933",
  platform: "056d984a-95b0-4064-8825-9cf087fa8036",
};

const STICKER_VALUES = {
  taskType: {
    Город: "64e5efe2bd95",
    Межгород: "350724eb0baa",
    Совмещенный: "cbf0040c5f59",
    Совмещённый: "cbf0040c5f59",
  },
  source: {
    Почта: "2cfcf21f80e9",
  },
  platform: {
    Bidzaar: "be00170e0502",
  },
};

function requireProxyKey(req, res, next) {
  if (!PROXY_KEY) {
    return res.status(500).json({
      ok: false,
      version: APP_VERSION,
      error: "PROXY_KEY is not configured",
    });
  }

  const key = req.header("x-proxy-key");

  if (key !== PROXY_KEY) {
    return res.status(401).json({
      ok: false,
      version: APP_VERSION,
      error: "Unauthorized",
    });
  }

  next();
}

function requireYouGileToken() {
  if (!YOUGILE_TOKEN) {
    throw new Error("YOUGILE_TOKEN is not configured");
  }
}

function buildYouGileHeaders() {
  requireYouGileToken();

  return {
    Authorization: `Bearer ${YOUGILE_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripHtml(value) {
  return String(value ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDocumentName(name) {
  return String(name || "document")
    .replace(/^article\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
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

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function flattenJson(value, result = [], depth = 0) {
  if (depth > 10) return result;

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
    raw.includes("placeholder") ||
    raw === "bidzaar"
  );
}

function isValidTenderCode(value) {
  const raw = String(value || "").trim();

  if (!raw) return false;
  if (isBadPlaceholder(raw)) return false;

  return /^\d{2,}[-/]\d{2,}$/.test(raw) || /^[A-ZА-Я0-9]{2,}[-/]\d{2,}$/i.test(raw);
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

function normalizeDocUrl(url, sourceUrl) {
  if (!url) return null;

  try {
    return new URL(url, sourceUrl).toString();
  } catch {
    return null;
  }
}

function isDocumentUrlOrName(value) {
  const raw = String(value || "").toLowerCase();

  return (
    raw.includes(".doc") ||
    raw.includes(".docx") ||
    raw.includes(".xls") ||
    raw.includes(".xlsx") ||
    raw.includes(".pdf") ||
    raw.includes(".zip") ||
    raw.includes("download") ||
    raw.includes("attachment") ||
    raw.includes("file")
  );
}

function looksLikeCaptchaOrAntibot(text) {
  const raw = String(text || "").toLowerCase();

  return (
    raw.includes("are you not a robot") ||
    raw.includes("are you a robot") ||
    raw.includes("not a robot") ||
    raw.includes("smart-captcha") ||
    raw.includes("checkbox-captcha") ||
    raw.includes("advanced-captcha") ||
    raw.includes("captcha-backgrounds") ||
    raw.includes("cloudlogo.svg") ||
    raw.includes("captcha") ||
    (raw.includes("yandex") && raw.includes("robot")) ||
    (raw.includes("яндекс") && raw.includes("робот"))
  );
}

function looksLikeCssOrUiTrash(text) {
  const raw = String(text || "").toLowerCase();

  return (
    raw.includes("@media") ||
    raw.includes("prefers-color-scheme") ||
    raw.includes("background-image:url") ||
    raw.includes("--smart-captcha") ||
    raw.includes("rgba(") ||
    raw.includes("border-radius") ||
    raw.includes("font-family") ||
    raw.includes("stylesheet") ||
    raw.includes("javascript") ||
    raw.includes("webpack") ||
    raw.includes("__next_data__") ||
    raw.includes("cdn.yandex.net") ||
    raw.includes("svc.cdn.yandex.net")
  );
}

function cleanSummaryText(text) {
  const source = String(text || "");

  if (!source.trim()) return "";

  if (looksLikeCaptchaOrAntibot(source) || looksLikeCssOrUiTrash(source)) {
    return "";
  }

  const raw = stripHtml(source)
    .replace(/\b(Войти|Регистрация|Личный кабинет|Главная|Меню|Назад|Далее)\b/gi, " ")
    .replace(/\b(Are you not a robot|Are you a robot|not a robot|captcha|SmartCaptcha)\b/gi, " ")
    .replace(/@media[^{]*\{[^}]*\}/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\{[^{}]{50,}\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!raw) return "";

  if (looksLikeCaptchaOrAntibot(raw) || looksLikeCssOrUiTrash(raw)) {
    return "";
  }

  if (raw.length < 20) return "";

  return raw.slice(0, 1200);
}

function extractTitleFromPageTitle(pageTitle) {
  const raw = String(pageTitle || "").replace(/\s+/g, " ").trim();

  if (!raw) return null;
  if (looksLikeCaptchaOrAntibot(raw) || looksLikeCssOrUiTrash(raw)) return null;

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
  if (looksLikeCaptchaOrAntibot(raw) || looksLikeCssOrUiTrash(raw)) return false;

  const lower = raw.toLowerCase();

  if (
    lower.includes("ооо") ||
    lower.includes("ао ") ||
    lower.includes("пао") ||
    lower.includes("зао") ||
    lower.includes("ип ") ||
    lower.includes("кордиант") ||
    lower.includes("megafon") ||
    lower.includes("мегафон") ||
    lower.includes("билайн") ||
    lower.includes("positive technologies")
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
    /кордиант|ооо|пао|ао |зао|ип |мегафон|билайн|positive/i.test(item),
  );

  return strong || unique[0] || null;
}

function buildFinalTitle({ pageTitle, jsonTitle, company }) {
  const titleFromPage = extractTitleFromPageTitle(pageTitle);

  const cleanJsonTitle =
    jsonTitle &&
    !isBadPlaceholder(jsonTitle) &&
    !looksLikeCaptchaOrAntibot(jsonTitle) &&
    !looksLikeCssOrUiTrash(jsonTitle) &&
    jsonTitle.length > 5
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

function looksLikeDeadline(value) {
  if (!value) return false;

  const raw = String(value);

  return (
    /\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}/.test(raw) ||
    /\d{4}-\d{2}-\d{2}/.test(raw) ||
    /T\d{2}:\d{2}/.test(raw)
  );
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
    columnId: fullTask?.columnId || fallback.columnId || null,
  };
}

function buildSummary({ pageSummary, documentSummaries }) {
  const docText = documentSummaries
    .map((doc) => doc.summary)
    .filter(Boolean)
    .join(" ");

  const cleanDocText = cleanSummaryText(docText);

  if (cleanDocText) {
    return cleanDocText;
  }

  const cleanPageText = cleanSummaryText(pageSummary);

  if (cleanPageText) {
    return cleanPageText;
  }

  return "";
}

function makeDescription({ summary, documents = [], sourceUrl, preliminaryReason }) {
  const finalSummary =
    summary || "Выжимку не удалось сформировать автоматически. Проверьте вложения вручную.";

  const safeSummary = htmlEscape(finalSummary);

  const docsHtml = documents.length
    ? documents
        .map((doc) => {
          const name = htmlEscape(normalizeDocumentName(doc.name || doc.filename));
          const url = htmlEscape(doc.yougileUrl || doc.url);

          return `<a target="_blank" rel="noopener noreferrer" href="${url}">${name}</a>`;
        })
        .join("<br>")
    : "Документы не найдены.";

  const warningHtml = preliminaryReason
    ? `<p><strong>Важно:</strong> ${htmlEscape(preliminaryReason)}</p>`
    : "";

  const safeSourceUrl = htmlEscape(sourceUrl);

  return [
    warningHtml,
    `<p><strong>Выжимка:</strong> ${safeSummary}</p>`,
    `<p><strong>Документация:</strong><br>${docsHtml}</p>`,
    `<p><strong>Ссылка:</strong> <a target="_blank" rel="noopener noreferrer" href="${safeSourceUrl}">ссылка</a></p>`,
  ].join("");
}

async function optionalImport(packageName) {
  try {
    return await import(packageName);
  } catch {
    return null;
  }
}

async function extractTextFromBuffer({ buffer, filename, contentType }) {
  const name = String(filename || "").toLowerCase();
  const type = String(contentType || "").toLowerCase();

  try {
    if (name.endsWith(".docx") || type.includes("wordprocessingml")) {
      const mammothModule = await optionalImport("mammoth");
      const mammoth = mammothModule?.default || mammothModule;

      if (!mammoth?.extractRawText) return "";

      const result = await mammoth.extractRawText({ buffer });

      return cleanSummaryText(result.value || "");
    }

    if (name.endsWith(".xlsx") || name.endsWith(".xls") || type.includes("spreadsheet")) {
      const xlsxModule = await optionalImport("xlsx");
      const XLSX = xlsxModule?.default || xlsxModule;

      if (!XLSX?.read || !XLSX?.utils) return "";

      const workbook = XLSX.read(buffer, { type: "buffer" });

      const chunks = [];

      for (const sheetName of workbook.SheetNames.slice(0, 5)) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);

        if (csv) {
          chunks.push(`${sheetName}: ${csv}`);
        }
      }

      return cleanSummaryText(chunks.join(" "));
    }

    if (name.endsWith(".pdf") || type.includes("pdf")) {
      const pdfModule = await optionalImport("pdf-parse");
      const pdfParse = pdfModule?.default || pdfModule;

      if (!pdfParse) return "";

      const result = await pdfParse(buffer);

      return cleanSummaryText(result.text || "");
    }

    if (
      type.startsWith("text/") ||
      name.endsWith(".txt") ||
      name.endsWith(".csv") ||
      name.endsWith(".json")
    ) {
      return cleanSummaryText(buffer.toString("utf8"));
    }
  } catch {
    return "";
  }

  return "";
}

async function downloadFileByUrl(url, filename) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 120000,
    maxRedirects: 10,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Accept:
        "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/msword,application/vnd.ms-excel,application/zip,*/*",
    },
  });

  return {
    buffer: Buffer.from(response.data),
    contentType: response.headers["content-type"] || "application/octet-stream",
    filename: normalizeDocumentName(filename || getFilenameFromUrl(url)),
  };
}

async function uploadFileToYouGile({ buffer, filename, contentType }) {
  requireYouGileToken();

  const safeFilename = normalizeDocumentName(filename);

  const form = new FormData();

  form.append("file", buffer, {
    filename: safeFilename,
    contentType: contentType || "application/octet-stream",
  });

  const response = await axios.post(`${YOUGILE_BASE_URL}/api-v2/upload-file`, form, {
    timeout: 120000,
    headers: {
      Authorization: `Bearer ${YOUGILE_TOKEN}`,
      ...form.getHeaders(),
    },
  });

  const data = response.data || {};

  const url =
    data.url ||
    data.href ||
    data.downloadUrl ||
    data.fileUrl ||
    data?.data?.url ||
    data?.data?.href;

  if (!url) {
    throw new Error("YouGile upload response has no file url");
  }

  return {
    name: safeFilename,
    url,
  };
}

async function uploadTenderFileByUrl(url, filename) {
  const downloaded = await downloadFileByUrl(url, filename);

  const summary = await extractTextFromBuffer(downloaded);

  const uploaded = await uploadFileToYouGile(downloaded);

  return {
    name: normalizeDocumentName(downloaded.filename),
    originalUrl: url,
    yougileUrl: uploaded.url,
    summary,
    parsed: Boolean(summary),
  };
}

async function createYouGileTask(taskPayload) {
  const response = await axios.post(`${YOUGILE_BASE_URL}/api-v2/tasks`, taskPayload, {
    timeout: 120000,
    headers: buildYouGileHeaders(),
  });

  return response.data;
}

async function getYouGileTaskByIdApi(taskId) {
  if (!taskId) {
    throw new Error("taskId is required");
  }

  const response = await axios.get(`${YOUGILE_BASE_URL}/api-v2/tasks/${taskId}`, {
    timeout: 120000,
    headers: buildYouGileHeaders(),
  });

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

    const looksLikeFile =
      isDocumentUrlOrName(maybeName) ||
      isDocumentUrlOrName(maybeUrl) ||
      maybeType.includes("pdf") ||
      maybeType.includes("word") ||
      maybeType.includes("excel") ||
      maybeType.includes("spreadsheet") ||
      maybeType.includes("zip");

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

function extractTenderFromJsonResponses(jsonResponses, sourceUrl) {
  const allObjects = [];

  for (const response of jsonResponses) {
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
        !looksLikeCaptchaOrAntibot(maybeTitle) &&
        !looksLikeCssOrUiTrash(maybeTitle) &&
        !["bidzaar", "menu", "home", "бейджи"].includes(maybeTitle.toLowerCase())
      ) {
        jsonTitle = maybeTitle;
      }
    }

    if (!code) {
      for (const key of strictCodeKeys) {
        const maybeCode = obj?.[key];

        if (isValidTenderCode(maybeCode)) {
          code = String(maybeCode).trim();
          break;
        }
      }
    }

    if (!deadline) {
      for (const key of deadlineKeys) {
        const value = obj?.[key];

        if (value && looksLikeDeadline(value)) {
          deadline = String(value);
          break;
        }
      }
    }

    if (!positionsCount) {
      const maybeCount = pickFirstNumber(obj, positionKeys);

      if (maybeCount && maybeCount > 0 && maybeCount < 100000) {
        positionsCount = maybeCount;
      }
    }
  }

  const company = extractCompanyFromJsonObjects(allObjects);
  const documents = extractDocumentsFromJsonObjects(allObjects, sourceUrl);

  return {
    jsonTitle,
    company,
    code,
    deadline,
    positionsCount,
    documents,
  };
}

function extractTenderFromText(text, sourceUrl) {
  const safeText = String(text || "");

  if (looksLikeCaptchaOrAntibot(safeText) || looksLikeCssOrUiTrash(safeText)) {
    return {
      code: extractCodeFromUrl(sourceUrl),
      deadline: null,
      positionsCount: null,
    };
  }

  const codeMatch =
    safeText.match(/\b(\d{2,}[-/]\d{2,})\b/) ||
    safeText.match(/код[:\s№-]*(\d{2,}[-/]\d{2,})/i) ||
    safeText.match(/№[:\s]*(\d{2,}[-/]\d{2,})/i);

  const urlCode = extractCodeFromUrl(sourceUrl);

  const deadlineMatch =
    safeText.match(
      /(дата\s+окончания|дедлайн|окончание|срок\s+подачи)[^\d]{0,80}(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}(?:\s+\d{1,2}:\d{2})?)/i,
    ) || safeText.match(/(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}\s+\d{1,2}:\d{2})/);

  const positionsMatch =
    safeText.match(/позици[ийя]{1,2}[^\d]{0,20}(\d+)/i) ||
    safeText.match(/лотов[^\d]{0,20}(\d+)/i);

  return {
    code: urlCode || codeMatch?.[1] || null,
    deadline: deadlineMatch?.[2] || deadlineMatch?.[1] || null,
    positionsCount: positionsMatch ? Number(positionsMatch[1]) : null,
  };
}

async function parseBidzaarTenderPage(url) {
  let browser;

  const jsonResponses = [];
  const responseUrls = [];

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage({
      viewport: {
        width: 1440,
        height: 1200,
      },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    });

    await page.setExtraHTTPHeaders({
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    });

    page.on("response", async (response) => {
      try {
        const responseUrl = response.url();
        const contentType = response.headers()["content-type"] || "";

        const shouldTryJson =
          contentType.includes("application/json") ||
          responseUrl.includes("/api/") ||
          responseUrl.includes("/graphql") ||
          responseUrl.includes("process") ||
          responseUrl.includes("procedure") ||
          responseUrl.includes("tender");

        if (!shouldTryJson) return;

        const json = await response.json().catch(() => null);

        if (!json) return;

        responseUrls.push(responseUrl);

        if (jsonResponses.length < 100) {
          jsonResponses.push({
            url: responseUrl,
            json,
          });
        }
      } catch {
        // пропускаем закрытые и не-JSON ответы
      }
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });

    await page
      .waitForLoadState("networkidle", {
        timeout: 45000,
      })
      .catch(() => null);

    await page.waitForTimeout(7000);

    await page
      .evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      })
      .catch(() => null);

    await page.waitForTimeout(3000);

    const domData = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const html = document.documentElement?.innerHTML || "";

      const pageTitle =
        document.querySelector("h1")?.innerText?.trim() ||
        document.querySelector("h2")?.innerText?.trim() ||
        document.title?.trim() ||
        "Bidzaar";

      const anchors = Array.from(document.querySelectorAll("a"));

      const documents = anchors
        .map((a) => {
          const href = a.href;
          const name = (a.innerText || a.getAttribute("download") || "").trim();

          return {
            name,
            url: href,
          };
        })
        .filter((item) => {
          if (!item.url) return false;

          const lowerUrl = item.url.toLowerCase();
          const lowerName = item.name.toLowerCase();

          return (
            lowerUrl.includes(".doc") ||
            lowerUrl.includes(".docx") ||
            lowerUrl.includes(".xls") ||
            lowerUrl.includes(".xlsx") ||
            lowerUrl.includes(".pdf") ||
            lowerUrl.includes(".zip") ||
            lowerUrl.includes("download") ||
            lowerUrl.includes("attachment") ||
            lowerName.includes(".doc") ||
            lowerName.includes(".docx") ||
            lowerName.includes(".xls") ||
            lowerName.includes(".xlsx") ||
            lowerName.includes(".pdf") ||
            lowerName.includes(".zip")
          );
        });

      return {
        pageTitle,
        text,
        html,
        documents,
      };
    });

    const pageIsCaptcha =
      looksLikeCaptchaOrAntibot(domData.text) ||
      looksLikeCaptchaOrAntibot(domData.html) ||
      looksLikeCssOrUiTrash(domData.text) ||
      looksLikeCssOrUiTrash(domData.html);

    const safePageText = pageIsCaptcha ? "" : domData.text;

    const textTender = extractTenderFromText(safePageText, url);
    const jsonTender = extractTenderFromJsonResponses(jsonResponses, url);

    const title = buildFinalTitle({
      pageTitle: pageIsCaptcha ? "" : domData.pageTitle,
      jsonTitle: jsonTender.jsonTitle,
      company: jsonTender.company,
    });

    const code = jsonTender.code || textTender.code || null;
    const deadline = jsonTender.deadline || textTender.deadline || null;

    const domDocuments = pageIsCaptcha
      ? []
      : domData.documents.map((doc, index) => ({
          name: normalizeDocumentName(
            doc.name || getFilenameFromUrl(doc.url, `Документ ${index + 1}`),
          ),
          url: doc.url,
        }));

    const documents = [];
    const seenDocs = new Set();

    for (const doc of [...jsonTender.documents, ...domDocuments]) {
      const finalUrl = normalizeDocUrl(doc.url, url);

      if (!finalUrl) continue;

      const finalName = normalizeDocumentName(
        doc.name || getFilenameFromUrl(finalUrl, "Документ"),
      );

      const key = `${finalName}|${finalUrl}`;

      if (seenDocs.has(key)) continue;

      seenDocs.add(key);
      documents.push({
        name: finalName,
        url: finalUrl,
      });
    }

    const positionsCount =
      jsonTender.positionsCount || textTender.positionsCount || documents.length || 0;

    const pageSummary = pageIsCaptcha ? "" : cleanSummaryText(domData.text);

    return {
      title,
      code,
      deadline,
      positionsCount,
      pageSummary,
      pageIsCaptcha,
      documents,
      sourceUrl: url,
      diagnostics: {
        pageTitle: domData.pageTitle,
        extractedPageTitle: pageIsCaptcha ? null : extractTitleFromPageTitle(domData.pageTitle),
        jsonTitle: jsonTender.jsonTitle,
        company: jsonTender.company,
        jsonResponsesCount: jsonResponses.length,
        responseUrlsCount: responseUrls.length,
        pageIsCaptcha,
      },
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function makeCompactParseResponse(tender) {
  return {
    ok: true,
    version: APP_VERSION,
    title: tender.title || null,
    code: tender.code || null,
    deadline: tender.deadline || null,
    positionsCount: tender.positionsCount || 0,
    documentsCount: tender.documents?.length || 0,
    pageIsCaptcha: Boolean(tender.pageIsCaptcha),
    pageTitle: tender.diagnostics?.pageTitle || null,
    jsonResponsesCount: tender.diagnostics?.jsonResponsesCount || 0,
  };
}

function normalizeCreateMode(value) {
  const raw = String(value || "auto").trim().toLowerCase();

  if (raw === "final") return "final";
  if (raw === "preliminary") return "preliminary";

  return "auto";
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    service: "yougile-upload-proxy",
    defaultColumnId: YOUGILE_COLUMN_ID,
    endpoints: [
      "POST /parse-bidzaar",
      "POST /parse-bidzaar-compact",
      "POST /upload-by-url",
      "POST /create-tender-from-url",
    ],
  });
});

app.post("/parse-bidzaar-compact", requireProxyKey, async (req, res) => {
  try {
    const { url } = req.body || {};

    if (!url) {
      return res.status(400).json({
        ok: false,
        version: APP_VERSION,
        error: "url is required",
      });
    }

    const tender = await parseBidzaarTenderPage(url);

    return res.json(makeCompactParseResponse(tender));
  } catch (error) {
    return res.status(500).json({
      ok: false,
      version: APP_VERSION,
      error: error.message,
    });
  }
});

app.post("/parse-bidzaar", requireProxyKey, async (req, res) => {
  try {
    const { url } = req.body || {};

    if (!url) {
      return res.status(400).json({
        ok: false,
        version: APP_VERSION,
        error: "url is required",
      });
    }

    const tender = await parseBidzaarTenderPage(url);

    return res.json({
      ok: true,
      version: APP_VERSION,
      tender: {
        title: tender.title,
        code: tender.code,
        deadline: tender.deadline,
        positionsCount: tender.positionsCount,
        documentsCount: tender.documents.length,
        pageSummary: tender.pageSummary,
        pageIsCaptcha: tender.pageIsCaptcha,
      },
      diagnostics: {
        pageTitle: tender.diagnostics?.pageTitle || null,
        extractedPageTitle: tender.diagnostics?.extractedPageTitle || null,
        jsonResponsesCount: tender.diagnostics?.jsonResponsesCount || 0,
        company: tender.diagnostics?.company || null,
        jsonTitle: tender.diagnostics?.jsonTitle || null,
        pageIsCaptcha: tender.diagnostics?.pageIsCaptcha || false,
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      version: APP_VERSION,
      error: error.message,
    });
  }
});

app.post("/upload-by-url", requireProxyKey, async (req, res) => {
  try {
    const { url, urls } = req.body || {};

    const items = Array.isArray(urls) ? urls : url ? [url] : [];

    if (!items.length) {
      return res.status(400).json({
        ok: false,
        version: APP_VERSION,
        error: "url or urls is required",
      });
    }

    let uploadedCount = 0;
    let errorCount = 0;
    let parsedCount = 0;

    for (const itemUrl of items) {
      try {
        const uploaded = await uploadTenderFileByUrl(itemUrl);

        uploadedCount += 1;

        if (uploaded.parsed) {
          parsedCount += 1;
        }
      } catch {
        errorCount += 1;
      }
    }

    return res.json({
      ok: errorCount === 0,
      version: APP_VERSION,
      uploaded: uploadedCount,
      parsed: parsedCount,
      errors: errorCount,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      version: APP_VERSION,
      error: error.message,
    });
  }
});

app.post("/create-tender-from-url", requireProxyKey, async (req, res) => {
  try {
    const {
      url,
      columnId: bodyColumnId,
      taskType = "Город",
      type,
      assigned = [],
      color,
      requireDocsProcessed = true,
      createMode = "auto",
    } = req.body || {};

    if (!url) {
      return res.status(400).json({
        ok: false,
        version: APP_VERSION,
        error: "url is required",
      });
    }

    const mode = normalizeCreateMode(createMode);
    const columnId = bodyColumnId || YOUGILE_COLUMN_ID;

    if (!columnId) {
      return res.status(400).json({
        ok: false,
        version: APP_VERSION,
        error: "columnId is required. Pass columnId in body or set YOUGILE_COLUMN_ID env.",
      });
    }

    const tender = await parseBidzaarTenderPage(url);

    const uploadedDocuments = [];
    const documentSummaries = [];
    let uploadErrorCount = 0;
    let parsedDocumentsCount = 0;

    for (const doc of tender.documents || []) {
      try {
        const uploaded = await uploadTenderFileByUrl(
          doc.url,
          normalizeDocumentName(doc.name),
        );

        uploadedDocuments.push(uploaded);

        if (uploaded.parsed && uploaded.summary) {
          parsedDocumentsCount += 1;
          documentSummaries.push({
            name: uploaded.name,
            summary: uploaded.summary,
          });
        }
      } catch {
        uploadErrorCount += 1;
      }
    }

    const summary = buildSummary({
      pageSummary: tender.pageSummary,
      documentSummaries,
    });

    const docsProcessed =
      uploadedDocuments.length > 0 &&
      uploadErrorCount === 0 &&
      parsedDocumentsCount > 0 &&
      Boolean(summary);

    const noDocsFound = !tender.documents?.length;
    const noDocsParsed = uploadedDocuments.length > 0 && parsedDocumentsCount === 0;
    const hasUploadErrors = uploadErrorCount > 0;

    let preliminaryReason = "";

    if (tender.pageIsCaptcha) {
      preliminaryReason =
        "Bidzaar отдал антибот-страницу/Captcha. Текст страницы не использован в выжимке.";
    } else if (noDocsFound) {
      preliminaryReason = "Документы в Bidzaar не найдены или недоступны для скачивания.";
    } else if (hasUploadErrors) {
      preliminaryReason = "Не все документы удалось скачать или загрузить в YouGile.";
    } else if (noDocsParsed) {
      preliminaryReason =
        "Документы загружены, но текст из них не удалось извлечь. Проверьте вложения вручную.";
    } else if (!summary) {
      preliminaryReason =
        "Не удалось получить чистую выжимку. Captcha/UI/CSS-мусор был отфильтрован.";
    }

    const mustBeFinal = mode === "final" || (mode === "auto" && requireDocsProcessed);

    if (mustBeFinal && !docsProcessed) {
      return res.status(422).json({
        ok: false,
        version: APP_VERSION,
        error: "docsProcessed=false. Final task was not created.",
        docsProcessed,
        preliminaryReason,
        tender: {
          title: tender.title,
          code: tender.code,
          deadline: tender.deadline,
          positionsCount: tender.positionsCount,
          pageIsCaptcha: tender.pageIsCaptcha,
          documentsFound: tender.documents?.length || 0,
          documentsUploaded: uploadedDocuments.length,
          documentsParsed: parsedDocumentsCount,
          uploadErrors: uploadErrorCount,
          summaryCreated: Boolean(summary),
        },
      });
    }

    const shouldCreatePreliminary = mode === "preliminary" || !docsProcessed;

    const finalTaskType = type || taskType || "Город";
    const title = tender.title || "Тендер Bidzaar";

    const taskPayload = {
      title,
      columnId,
      description: makeDescription({
        summary,
        documents: uploadedDocuments,
        sourceUrl: url,
        preliminaryReason: shouldCreatePreliminary ? preliminaryReason : "",
      }),
      stickers: makeStickers({
        taskType: finalTaskType,
        positionsCount: tender.positionsCount || uploadedDocuments.length || 0,
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

    const createdTask = await createYouGileTask(taskPayload);
    const createdTaskId = getCreatedTaskId(createdTask);

    if (!createdTaskId) {
      return res.status(500).json({
        ok: false,
        version: APP_VERSION,
        error: "Task created, but created task id was not found in YouGile response",
      });
    }

    const fullTask = await getYouGileTaskByIdApi(createdTaskId);

    const shortTask = makeShortTask(fullTask, {
      id: createdTaskId,
      title,
      columnId,
    });

    return res.json({
      ok: true,
      version: APP_VERSION,
      docsProcessed,
      preliminary: shouldCreatePreliminary,
      preliminaryReason: shouldCreatePreliminary ? preliminaryReason : null,
      task: shortTask,
      tender: {
        title: tender.title,
        code: tender.code,
        deadline: tender.deadline,
        positionsCount: tender.positionsCount,
        pageIsCaptcha: tender.pageIsCaptcha,
      },
      documents: {
        total: tender.documents?.length || 0,
        uploaded: uploadedDocuments.length,
        parsed: parsedDocumentsCount,
        errors: uploadErrorCount,
      },
      summaryCreated: Boolean(summary),
      parser: {
        jsonResponsesCount: tender.diagnostics?.jsonResponsesCount || 0,
        pageTitle: tender.diagnostics?.pageTitle || null,
        extractedPageTitle: tender.diagnostics?.extractedPageTitle || null,
        company: tender.diagnostics?.company || null,
        pageIsCaptcha: tender.diagnostics?.pageIsCaptcha || false,
      },
      usedColumnId: columnId,
      actualColumnId: fullTask?.columnId || null,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      version: APP_VERSION,
      error: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`YouGile proxy is running on port ${PORT}`);
  console.log(`Version: ${APP_VERSION}`);
});
