import express from "express";
import cors from "cors";
import axios from "axios";
import FormData from "form-data";
import { chromium } from "playwright";

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 3000;

const APP_VERSION = "compact-response-v2";

const PROXY_KEY = process.env.PROXY_KEY;
const YOUGILE_TOKEN = process.env.YOUGILE_TOKEN;
const YOUGILE_BASE_URL = process.env.YOUGILE_BASE_URL || "https://ru.yougile.com";
const YOUGILE_COLUMN_ID = process.env.YOUGILE_COLUMN_ID;

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
      error: "PROXY_KEY is not configured",
    });
  }

  const key = req.header("x-proxy-key");

  if (key !== PROXY_KEY) {
    return res.status(401).json({
      ok: false,
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

function normalizeDocumentName(name) {
  return String(name || "document")
    .replace(/^article\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

function toTimestampMs(value) {
  if (!value) return null;

  if (typeof value === "number") {
    return value;
  }

  const raw = String(value).trim();

  const match = raw.match(
    /(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/,
  );

  if (!match) return null;

  const [, dd, mm, yyyy, hh = "18", min = "00"] = match;

  const date = new Date(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(hh),
    Number(min),
    0,
    0,
  );

  if (Number.isNaN(date.getTime())) return null;

  return date.getTime();
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

function makeDescription({ summary, documents = [], sourceUrl }) {
  const safeSummary = summary
    ? htmlEscape(summary)
    : "Данные автоматически перенесены из Bidzaar.";

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
    `<p><strong>Выжимка:</strong> ${safeSummary}</p>`,
    `<p><strong>Документация:</strong><br>${docsHtml}</p>`,
    `<p><strong>Ссылка:</strong> <a target="_blank" rel="noopener noreferrer" href="${safeSourceUrl}">ссылка</a></p>`,
  ].join("");
}

async function downloadFileByUrl(url, filename) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 120000,
    maxRedirects: 10,
    headers: {
      "User-Agent": "Mozilla/5.0",
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

  const response = await axios.post(
    `${YOUGILE_BASE_URL}/api-v2/upload-file`,
    form,
    {
      timeout: 120000,
      headers: {
        Authorization: `Bearer ${YOUGILE_TOKEN}`,
        ...form.getHeaders(),
      },
    },
  );

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
  const uploaded = await uploadFileToYouGile(downloaded);

  return {
    name: normalizeDocumentName(downloaded.filename),
    originalUrl: url,
    yougileUrl: uploaded.url,
  };
}

async function createYouGileTask(taskPayload) {
  const response = await axios.post(
    `${YOUGILE_BASE_URL}/api-v2/tasks`,
    taskPayload,
    {
      timeout: 120000,
      headers: buildYouGileHeaders(),
    },
  );

  return response.data;
}

async function getYouGileTaskByIdApi(taskId) {
  if (!taskId) {
    throw new Error("taskId is required");
  }

  const response = await axios.get(
    `${YOUGILE_BASE_URL}/api-v2/tasks/${taskId}`,
    {
      timeout: 120000,
      headers: buildYouGileHeaders(),
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

async function parseBidzaarTenderPage(url) {
  let browser;

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

    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: 90000,
    });

    await page.waitForTimeout(3000);

    const data = await page.evaluate(() => {
      const text = document.body?.innerText || "";

      const title =
        document.querySelector("h1")?.innerText?.trim() ||
        document.querySelector("h2")?.innerText?.trim() ||
        document.title?.trim() ||
        "Тендер Bidzaar";

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
            lowerName.includes(".doc") ||
            lowerName.includes(".docx") ||
            lowerName.includes(".xls") ||
            lowerName.includes(".xlsx") ||
            lowerName.includes(".pdf") ||
            lowerName.includes(".zip")
          );
        });

      return {
        title,
        text,
        documents,
      };
    });

    const text = data.text || "";

    const codeMatch =
      text.match(/код[:\s№-]*([0-9]{2,}[-/][0-9]{2,})/i) ||
      text.match(/№[:\s]*([0-9]{2,}[-/][0-9]{2,})/i);

    const deadlineMatch =
      text.match(
        /(дата\s+окончания|дедлайн|окончание|срок\s+подачи)[^\d]{0,40}(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}(?:\s+\d{1,2}:\d{2})?)/i,
      ) || text.match(/(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}\s+\d{1,2}:\d{2})/);

    const positionsMatch =
      text.match(/позици[ийя]{1,2}[^\d]{0,20}(\d+)/i) ||
      text.match(/лотов[^\d]{0,20}(\d+)/i);

    const summary = text.replace(/\s+/g, " ").trim().slice(0, 900);

    const documents = data.documents.map((doc, index) => ({
      name: normalizeDocumentName(
        doc.name || getFilenameFromUrl(doc.url, `Документ ${index + 1}`),
      ),
      url: doc.url,
    }));

    return {
      title: data.title || "Тендер Bidzaar",
      code: codeMatch?.[1] || null,
      deadline: deadlineMatch?.[2] || deadlineMatch?.[1] || null,
      positionsCount: positionsMatch ? Number(positionsMatch[1]) : documents.length || 0,
      summary,
      documents,
      sourceUrl: url,
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    service: "yougile-upload-proxy",
    endpoints: [
      "POST /parse-bidzaar",
      "POST /upload-by-url",
      "POST /create-tender-from-url",
    ],
  });
});

app.post("/parse-bidzaar", requireProxyKey, async (req, res) => {
  try {
    const { url } = req.body || {};

    if (!url) {
      return res.status(400).json({
        ok: false,
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

    for (const itemUrl of items) {
      try {
        await uploadTenderFileByUrl(itemUrl);
        uploadedCount += 1;
      } catch {
        errorCount += 1;
      }
    }

    return res.json({
      ok: errorCount === 0,
      version: APP_VERSION,
      uploaded: uploadedCount,
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
    } = req.body || {};

    if (!url) {
      return res.status(400).json({
        ok: false,
        version: APP_VERSION,
        error: "url is required",
      });
    }

    const columnId = bodyColumnId || YOUGILE_COLUMN_ID;

    if (!columnId) {
      return res.status(400).json({
        ok: false,
        version: APP_VERSION,
        error:
          "columnId is required. Pass columnId in body or set YOUGILE_COLUMN_ID env.",
      });
    }

    const tender = await parseBidzaarTenderPage(url);

    const uploadedDocuments = [];
    let uploadErrorCount = 0;

    for (const doc of tender.documents || []) {
      try {
        const uploaded = await uploadTenderFileByUrl(
          doc.url,
          normalizeDocumentName(doc.name),
        );

        uploadedDocuments.push(uploaded);
      } catch {
        uploadErrorCount += 1;
      }
    }

    const finalTaskType = type || taskType || "Город";
    const title = tender.title || "Тендер Bidzaar";

    const taskPayload = {
      title,
      columnId,
      description: makeDescription({
        summary: tender.summary,
        documents: uploadedDocuments,
        sourceUrl: url,
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
    });

    return res.json({
      ok: true,
      version: APP_VERSION,
      task: shortTask,
      tender: {
        title: tender.title,
        code: tender.code,
        deadline: tender.deadline,
        positionsCount: tender.positionsCount,
      },
      documents: {
        total: tender.documents?.length || 0,
        uploaded: uploadedDocuments.length,
        errors: uploadErrorCount,
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
