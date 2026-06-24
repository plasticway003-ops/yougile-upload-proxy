require("dotenv").config();

const express = require("express");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const cheerio = require("cheerio");
const { chromium } = require("playwright");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const YOUGILE_TOKEN = (process.env.YOUGILE_TOKEN || "").trim();
const PROXY_KEY = (process.env.PROXY_KEY || "").trim();
const DEFAULT_COLUMN_ID = (process.env.YOUGILE_COLUMN_ID || "").trim();

const STICKERS = {
  taskType: "f0f3804f-b18f-4c40-8b26-f9d4da7b3d04",
  positionsCount: "f84ddb36-0047-4df9-8b00-f998b4882707",
  source: "dceb4af0-5778-44b3-a0de-4078fb2c8933",
  platform: "056d984a-95b0-4064-8825-9cf087fa8036"
};

const STICKER_VALUES = {
  taskType: {
    "Город": "64e5efe2bd95",
    "Межгород": "350724eb0baa",
    "Совмещенный": "cbf0040c5f59",
    "Совмещённый": "cbf0040c5f59"
  },
  source: {
    "Почта": "2cfcf21f80e9"
  },
  platform: {
    "Bidzaar": "be00170e0502"
  }
};

function checkProxyKey(req, res, next) {
  const key = (req.header("x-proxy-key") || "").trim();

  if (!PROXY_KEY || key !== PROXY_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Invalid x-proxy-key"
    });
  }

  next();
}

function axiosErrorDetails(error) {
  return {
    message: error.message,
    status: error.response?.status,
    data: error.response?.data
  };
}

function getFileNameFromUrl(fileUrl) {
  try {
    const url = new URL(fileUrl);
    const last = url.pathname.split("/").filter(Boolean).pop();
    return decodeURIComponent(last || "document");
  } catch {
    return "document";
  }
}

function absoluteUrl(baseUrl, href) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDocumentName(name) {
  return cleanText(name)
    .replace(/^article\s+/i, "")
    .replace(/^file\s+/i, "")
    .replace(/\s+\./g, ".")
    .trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function uniqueByUrl(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    result.push(item);
  }

  return result;
}

function parseRussianDateToMs(value) {
  if (!value) return null;

  const match = String(value).match(
    /([0-9]{2})\.([0-9]{2})\.([0-9]{4}),?\s*([0-9]{2}):([0-9]{2})/
  );

  if (!match) return null;

  const [, dd, mm, yyyy, hh, min] = match;

  const date = new Date(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(hh),
    Number(min),
    0,
    0
  );

  return date.getTime();
}

async function uploadBufferToYouGile(buffer, filename) {
  if (!YOUGILE_TOKEN) {
    throw new Error("YOUGILE_TOKEN is missing");
  }

  const form = new FormData();
  form.append("file", buffer, normalizeDocumentName(filename));

  const response = await axios.post(
    "https://yougile.com/api-v2/upload-file",
    form,
    {
      headers: {
        Authorization: `Bearer ${YOUGILE_TOKEN}`,
        ...form.getHeaders()
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    }
  );

  return response.data;
}

async function downloadUrlToBuffer(fileUrl, refererUrl) {
  const response = await axios.get(fileUrl, {
    responseType: "arraybuffer",
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 60000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      Referer: refererUrl || "https://bidzaar.com/"
    }
  });

  let filename = getFileNameFromUrl(fileUrl);

  const disposition = response.headers["content-disposition"];
  if (disposition) {
    const utfMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const simpleMatch = disposition.match(/filename="?([^";]+)"?/i);

    if (utfMatch?.[1]) {
      filename = decodeURIComponent(utfMatch[1]);
    } else if (simpleMatch?.[1]) {
      filename = decodeURIComponent(simpleMatch[1]);
    }
  }

  return {
    buffer: Buffer.from(response.data),
    filename: normalizeDocumentName(filename)
  };
}

function extractBidzaarDataFromHtml(html, tenderUrl) {
  const $ = cheerio.load(html);

  $("script, style, noscript").remove();

  const bodyText = cleanText($("body").text());

  const title =
    cleanText($("h1").first().text()) ||
    cleanText($("title").text()).replace(/\s*\|\s*Bidzaar.*$/i, "") ||
    "Bidzaar";

  const codeMatch = bodyText.match(/Код:\s*([0-9A-Za-zА-Яа-яЁё\-]+)/i);

  const deadlineMatch =
    bodyText.match(/Прием предложений до\s*([0-9]{2}\.[0-9]{2}\.[0-9]{4},?\s*[0-9]{2}:[0-9]{2})/i) ||
    bodyText.match(/до\s*([0-9]{2}\.[0-9]{2}\.[0-9]{4},?\s*[0-9]{2}:[0-9]{2})/i);

  const publishedMatch = bodyText.match(
    /Опубликован\s*([0-9]{2}\.[0-9]{2}\.[0-9]{4},?\s*[0-9]{2}:[0-9]{2})/i
  );

  const locationMatch =
    bodyText.match(/Место поставки\s*(.*?)\s*(Теги|Спецификация по позициям|Правила проведения запроса|Прием предложений до)/i);

  const positionsMatch =
    bodyText.match(/Спецификация по позициям\s*\((\d+)\)/i) ||
    bodyText.match(/Позици[ияй]\s*\((\d+)\)/i);

  const descriptionMatch =
    bodyText.match(/Описание и документы\s*(.*?)\s*(Контакты|Место поставки|Теги|Спецификация по позициям|Правила проведения запроса)/i) ||
    bodyText.match(/Описание\s*(.*?)\s*(Контакты|Место поставки|Теги|Спецификация по позициям|Правила проведения запроса)/i);

  const rulesMatch =
    bodyText.match(/Правила проведения запроса\s*(.*?)\s*(Прием предложений до|Вид запроса|После подачи|$)/i);

  const documents = [];

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const text = cleanText($(element).text());

    if (!href) return;

    const isDocumentLink =
      /filestorage\/files\/download/i.test(href) ||
      /\/api\/.*file/i.test(href) ||
      /\.(pdf|doc|docx|xls|xlsx|zip|rar|7z|txt)(\?|$)/i.test(href);

    if (!isDocumentLink) return;

    let name = text || getFileNameFromUrl(href);

    name = name
      .replace(/\s*(pdf|docx?|xlsx?|zip|rar|7z|txt)\s*/gi, ".$1")
      .replace(/\s*\d+([.,]\d+)?\s*(КБ|МБ|KB|MB).*$/i, "")
      .trim();

    documents.push({
      name: normalizeDocumentName(name || "document"),
      url: absoluteUrl(tenderUrl, href)
    });
  });

  const summaryParts = [];

  if (descriptionMatch?.[1]) {
    summaryParts.push(cleanText(descriptionMatch[1]));
  }

  if (locationMatch?.[1]) {
    summaryParts.push(`Место поставки: ${cleanText(locationMatch[1])}`);
  }

  if (deadlineMatch?.[1]) {
    summaryParts.push(`Прием предложений до: ${cleanText(deadlineMatch[1])}`);
  }

  if (positionsMatch?.[1]) {
    summaryParts.push(`Количество позиций: ${positionsMatch[1]}`);
  }

  if (rulesMatch?.[1]) {
    summaryParts.push(`Правила: ${cleanText(rulesMatch[1]).slice(0, 700)}`);
  }

  return {
    platform: "Bidzaar",
    sourceUrl: tenderUrl,
    title: cleanText(title),
    code: codeMatch?.[1] || "",
    deadline: deadlineMatch?.[1] ? cleanText(deadlineMatch[1]) : "",
    publishedAt: publishedMatch?.[1] ? cleanText(publishedMatch[1]) : "",
    location: locationMatch?.[1] ? cleanText(locationMatch[1]) : "",
    positionsCount: positionsMatch?.[1] ? Number(positionsMatch[1]) : null,
    summary: summaryParts.join("\n\n"),
    documents: uniqueByUrl(documents),
    rawTextPreview: bodyText.slice(0, 1000)
  };
}

async function parseBidzaarWithBrowser(tenderUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  try {
    const page = await browser.newPage({
      viewport: {
        width: 1366,
        height: 900
      },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
    });

    const apiResponses = [];

    page.on("response", async (response) => {
      const url = response.url();

      if (!url.includes("bidzaar.com")) return;

      const isUsefulApi =
        url.includes("/api/") ||
        url.includes("process") ||
        url.includes("filestorage") ||
        url.includes("files");

      if (!isUsefulApi) return;

      try {
        const contentType = response.headers()["content-type"] || "";

        if (!contentType.includes("application/json")) return;

        const json = await response.json();

        apiResponses.push({
          url,
          json
        });
      } catch {
        // ignore
      }
    });

    await page.goto(tenderUrl, {
      waitUntil: "networkidle",
      timeout: 60000
    });

    await page.waitForTimeout(5000);

    try {
      await page.waitForFunction(
        () => {
          const text = document.body.innerText || "";
          return (
            text.includes("Описание") ||
            text.includes("Спецификация") ||
            text.includes("Прием предложений") ||
            text.includes("Место поставки")
          );
        },
        {
          timeout: 20000
        }
      );
    } catch {
      // parse whatever loaded
    }

    const html = await page.content();

    const domLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a[href]")).map((a) => ({
        text: (a.innerText || a.textContent || "").trim(),
        href: a.getAttribute("href")
      }));
    });

    const data = extractBidzaarDataFromHtml(html, tenderUrl);

    const apiDocuments = [];

    function scanJsonForDocuments(value) {
      if (!value || typeof value !== "object") return;

      if (Array.isArray(value)) {
        for (const item of value) scanJsonForDocuments(item);
        return;
      }

      const keys = Object.keys(value);

      const possibleName =
        value.name ||
        value.fileName ||
        value.filename ||
        value.originalName ||
        value.title ||
        value.displayName;

      const possibleUrl =
        value.url ||
        value.downloadUrl ||
        value.fileUrl ||
        value.href ||
        value.link;

      const possibleId =
        value.id ||
        value.fileId ||
        value.uuid ||
        value.guid ||
        value.storageId;

      const cleanName = normalizeDocumentName(possibleName || "");

      const hasFileExtension =
        typeof cleanName === "string" &&
        /\.(pdf|doc|docx|xls|xlsx|zip|rar|7z|txt)$/i.test(cleanName);

      if (possibleUrl && typeof possibleUrl === "string") {
        const looksLikeDoc =
          /filestorage|download|file/i.test(possibleUrl) ||
          /\.(pdf|doc|docx|xls|xlsx|zip|rar|7z|txt)(\?|$)/i.test(possibleUrl) ||
          hasFileExtension;

        if (looksLikeDoc) {
          apiDocuments.push({
            name: normalizeDocumentName(cleanName || getFileNameFromUrl(possibleUrl) || "document"),
            url: absoluteUrl(tenderUrl, possibleUrl)
          });
        }
      }

      if (possibleId && cleanName && hasFileExtension) {
        apiDocuments.push({
          name: normalizeDocumentName(cleanName),
          url: absoluteUrl(
            tenderUrl,
            `/api/filestorage/files/download/${possibleId}`
          )
        });
      }

      for (const key of keys) {
        scanJsonForDocuments(value[key]);
      }
    }

    for (const item of apiResponses) {
      scanJsonForDocuments(item.json);
    }

    const linkDocuments = domLinks
      .filter((link) => {
        const href = link.href || "";
        const text = link.text || "";

        return (
          /filestorage\/files\/download/i.test(href) ||
          /\.(pdf|doc|docx|xls|xlsx|zip|rar|7z|txt)(\?|$)/i.test(href) ||
          /\.(pdf|doc|docx|xls|xlsx|zip|rar|7z|txt)$/i.test(text)
        );
      })
      .map((link) => ({
        name: normalizeDocumentName(link.text || getFileNameFromUrl(link.href) || "document"),
        url: absoluteUrl(tenderUrl, link.href)
      }));

    data.documents = uniqueByUrl([
      ...data.documents,
      ...linkDocuments,
      ...apiDocuments
    ]);

    data.debug = {
      domLinksCount: domLinks.length,
      apiResponsesCount: apiResponses.length
    };

    return data;
  } finally {
    await browser.close();
  }
}

function buildTenderDescriptionHtml(tender, uploadedDocs) {
  const summary = escapeHtml(tender.summary || "Выжимка не сформирована.");

  const docLinks = uploadedDocs.length
    ? uploadedDocs
        .map((doc) => {
          const name = escapeHtml(normalizeDocumentName(doc.filename || doc.name || "document"));
          const url = escapeHtml(doc.fullUrl || doc.url || "");
          return `<a target="_blank" rel="noopener noreferrer" href="${url}">${name}</a>`;
        })
        .join("<br>")
    : "Документы не загружены.";

  const sourceUrl = escapeHtml(tender.sourceUrl || "");

  return [
    `<p><strong>Выжимка:</strong></p>`,
    `<p>${summary.replace(/\n/g, "<br>")}</p>`,
    `<p><strong>Код:</strong> ${escapeHtml(tender.code || "")}</p>`,
    `<p><strong>Срок подачи:</strong> ${escapeHtml(tender.deadline || "")}</p>`,
    `<p><strong>Место:</strong> ${escapeHtml(tender.location || "")}</p>`,
    `<p><strong>Количество позиций:</strong> ${escapeHtml(tender.positionsCount || "")}</p>`,
    `<p><strong>Документация:</strong><br>${docLinks}</p>`,
    `<p><strong>Ссылка:</strong> <a target="_blank" rel="noopener noreferrer" href="${sourceUrl}">ссылка</a></p>`
  ].join("");
}

async function listYouGileTasksByTitle(title) {
  if (!YOUGILE_TOKEN) {
    throw new Error("YOUGILE_TOKEN is missing");
  }

  if (!title) return [];

  const response = await axios.get("https://yougile.com/api-v2/tasks", {
    headers: {
      Authorization: `Bearer ${YOUGILE_TOKEN}`
    },
    params: {
      title,
      limit: 50,
      offset: 0,
      includeDeleted: false
    },
    timeout: 60000
  });

  return response.data?.content || [];
}

async function findDuplicateTender(tender) {
  const candidates = [];

  if (tender.code) {
    candidates.push(...(await listYouGileTasksByTitle(tender.code)));
  }

  const titleWords = cleanText(tender.title)
    .split(" ")
    .filter((word) => word.length > 5)
    .slice(0, 4)
    .join(" ");

  if (titleWords) {
    candidates.push(...(await listYouGileTasksByTitle(titleWords)));
  }

  const seen = new Set();
  const unique = [];

  for (const task of candidates) {
    if (!task.id || seen.has(task.id)) continue;
    seen.add(task.id);
    unique.push(task);
  }

  const sourceUrl = tender.sourceUrl || "";
  const code = tender.code || "";

  return unique.find((task) => {
    const title = task.title || "";
    const description = task.description || "";

    return (
      (code && (title.includes(code) || description.includes(code))) ||
      (sourceUrl && description.includes(sourceUrl))
    );
  }) || null;
}

async function createYouGileTask(payload) {
  if (!YOUGILE_TOKEN) {
    throw new Error("YOUGILE_TOKEN is missing");
  }

  const response = await axios.post(
    "https://yougile.com/api-v2/tasks",
    payload,
    {
      headers: {
        Authorization: `Bearer ${YOUGILE_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 60000
    }
  );

  return response.data;
}

async function getYouGileTaskByIdApi(taskId) {
  if (!YOUGILE_TOKEN) {
    throw new Error("YOUGILE_TOKEN is missing");
  }

  if (!taskId) return null;

  const response = await axios.get(
    `https://yougile.com/api-v2/tasks/${taskId}`,
    {
      headers: {
        Authorization: `Bearer ${YOUGILE_TOKEN}`
      },
      timeout: 60000
    }
  );

  return response.data;
}

function extractCreatedTaskId(taskResponse) {
  return (
    taskResponse?.id ||
    taskResponse?.task?.id ||
    taskResponse?.result?.id ||
    taskResponse?.data?.id ||
    ""
  );
}

function makeShortTask(task) {
  return {
    id: task?.id || "",
    idTaskProject: task?.idTaskProject || "",
    idTaskCommon: task?.idTaskCommon || "",
    title: task?.title || "",
    columnId: task?.columnId || ""
  };
}

async function createTenderFromUrl({
  url,
  columnId,
  taskType,
  assigned,
  color,
  skipDuplicateCheck
}) {
  const finalColumnId = columnId || DEFAULT_COLUMN_ID;

  if (!finalColumnId) {
    throw new Error("columnId is required. Pass columnId or set YOUGILE_COLUMN_ID in Render Environment.");
  }

  const tender = await parseBidzaarWithBrowser(url);

  if (!skipDuplicateCheck) {
    const duplicate = await findDuplicateTender(tender);

    if (duplicate) {
      return {
        status: "duplicate",
        tender,
        duplicateTask: duplicate,
        uploadedDocs: [],
        task: null
      };
    }
  }

  const uploadedDocs = [];

  for (const doc of tender.documents || []) {
    try {
      const downloaded = await downloadUrlToBuffer(doc.url, tender.sourceUrl);

      const cleanDocName = normalizeDocumentName(doc.name || "");
      const cleanDownloadedName = normalizeDocumentName(downloaded.filename || "");

      const filename =
        cleanDocName && /\.(pdf|doc|docx|xls|xlsx|zip|rar|7z|txt)$/i.test(cleanDocName)
          ? cleanDocName
          : cleanDownloadedName;

      const result = await uploadBufferToYouGile(downloaded.buffer, filename);

      uploadedDocs.push({
        sourceUrl: doc.url,
        ok: true,
        name: cleanDocName,
        filename: normalizeDocumentName(filename),
        url: result?.url,
        fullUrl: result?.fullUrl
      });
    } catch (error) {
      uploadedDocs.push({
        sourceUrl: doc.url,
        ok: false,
        name: normalizeDocumentName(doc.name),
        error: axiosErrorDetails(error)
      });
    }
  }

  const taskTypeName = taskType || "Город";
  const taskTypeValue =
    STICKER_VALUES.taskType[taskTypeName] || STICKER_VALUES.taskType["Город"];

  const stickers = {
    [STICKERS.platform]: STICKER_VALUES.platform.Bidzaar,
    [STICKERS.source]: STICKER_VALUES.source["Почта"],
    [STICKERS.positionsCount]: String(tender.positionsCount || ""),
    [STICKERS.taskType]: taskTypeValue
  };

  const deadlineMs = parseRussianDateToMs(tender.deadline);

  const taskPayload = {
    title: tender.title || "Тендер Bidzaar",
    columnId: finalColumnId,
    description: buildTenderDescriptionHtml(
      tender,
      uploadedDocs.filter((doc) => doc.ok)
    ),
    stickers
  };

  if (Array.isArray(assigned) && assigned.length > 0) {
    taskPayload.assigned = assigned;
  }

  if (color) {
    taskPayload.color = color;
  }

  if (deadlineMs) {
    taskPayload.deadline = {
      deadline: deadlineMs,
      startDate: deadlineMs,
      withTime: true,
      history: [
        {
          deadline: deadlineMs,
          startDate: deadlineMs,
          timestamp: Date.now(),
          notifyBefore: 900000,
          withTime: true
        }
      ]
    };
  }

  const createdTaskResponse = await createYouGileTask(taskPayload);
  const createdTaskId = extractCreatedTaskId(createdTaskResponse);

  let fullTask = createdTaskResponse;

  if (createdTaskId) {
    try {
      fullTask = await getYouGileTaskByIdApi(createdTaskId);
    } catch (error) {
      console.log("GET CREATED TASK ERROR", axiosErrorDetails(error));
    }
  }

  return {
    status: "created",
    tender,
    uploadedDocs,
    task: fullTask
  };
}

function makeCreateTenderShortResponse(result) {
  const tender = result.tender || {};
  const uploadedDocs = result.uploadedDocs || [];
  const successfulFiles = uploadedDocs.filter((doc) => doc.ok);
  const failedFiles = uploadedDocs.filter((doc) => !doc.ok);

  if (result.status === "duplicate") {
    return {
      ok: true,
      status: "duplicate",
      message: "Карточка по этому тендеру уже существует. Новая карточка не создана.",
      duplicateTask: makeShortTask(result.duplicateTask),
      title: tender.title || "",
      code: tender.code || "",
      deadline: tender.deadline || "",
      sourceUrl: tender.sourceUrl || ""
    };
  }

  return {
    ok: true,
    status: "created",
    task: makeShortTask(result.task),
    title: tender.title || "",
    code: tender.code || "",
    deadline: tender.deadline || "",
    location: tender.location || "",
    positionsCount: tender.positionsCount || null,
    sourceUrl: tender.sourceUrl || "",
    documentsFound: Array.isArray(tender.documents) ? tender.documents.length : 0,
    documentsUploaded: successfulFiles.length,
    uploadedFiles: successfulFiles.map((doc) => ({
      filename: normalizeDocumentName(doc.filename || doc.name || ""),
      fullUrl: doc.fullUrl || doc.url || ""
    })),
    failedFiles: failedFiles.map((doc) => ({
      name: normalizeDocumentName(doc.name || ""),
      sourceUrl: doc.sourceUrl || "",
      error: doc.error?.message || "Upload failed"
    }))
  };
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/parse-bidzaar", checkProxyKey, async (req, res) => {
  try {
    const tenderUrl = req.body.url;

    if (!tenderUrl) {
      return res.status(400).json({
        ok: false,
        error: "Pass url"
      });
    }

    if (!/^https:\/\/bidzaar\.com\/app\/process\/light\//i.test(tenderUrl)) {
      return res.status(400).json({
        ok: false,
        error: "Only Bidzaar light tender URLs are supported"
      });
    }

    const data = await parseBidzaarWithBrowser(tenderUrl);

    res.json({
      ok: true,
      platform: data.platform,
      sourceUrl: data.sourceUrl,
      title: data.title,
      code: data.code,
      deadline: data.deadline,
      publishedAt: data.publishedAt,
      location: data.location,
      positionsCount: data.positionsCount,
      summary: data.summary,
      documents: data.documents,
      debug: data.debug
    });
  } catch (error) {
    const details = axiosErrorDetails(error);

    console.log("PARSE-BIDZAAR ERROR", details);

    res.status(500).json({
      ok: false,
      error: "Bidzaar parse failed",
      details
    });
  }
});

app.post("/create-tender-from-url", checkProxyKey, async (req, res) => {
  try {
    const tenderUrl = req.body.url;

    if (!tenderUrl) {
      return res.status(400).json({
        ok: false,
        error: "Pass url"
      });
    }

    if (!/^https:\/\/bidzaar\.com\/app\/process\/light\//i.test(tenderUrl)) {
      return res.status(400).json({
        ok: false,
        error: "Only Bidzaar light tender URLs are supported"
      });
    }

    const result = await createTenderFromUrl({
      url: tenderUrl,
      columnId: req.body.columnId,
      taskType: req.body.taskType || req.body.type,
      assigned: req.body.assigned,
      color: req.body.color,
      skipDuplicateCheck: Boolean(req.body.skipDuplicateCheck)
    });

    res.json(makeCreateTenderShortResponse(result));
  } catch (error) {
    const details = axiosErrorDetails(error);

    console.log("CREATE-TENDER-FROM-URL ERROR", details);

    res.status(500).json({
      ok: false,
      error: "Create tender from URL failed",
      details
    });
  }
});

app.post("/upload", checkProxyKey, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "No file uploaded. Use multipart field: file"
      });
    }

    const cleanFilename = normalizeDocumentName(req.file.originalname);

    const result = await uploadBufferToYouGile(
      req.file.buffer,
      cleanFilename
    );

    res.json({
      ok: true,
      filename: cleanFilename,
      url: result?.url,
      fullUrl: result?.fullUrl
    });
  } catch (error) {
    const details = axiosErrorDetails(error);

    console.log("UPLOAD ERROR", details);

    res.status(500).json({
      ok: false,
      error: "Upload failed",
      details
    });
  }
});

app.post("/upload-by-url", checkProxyKey, async (req, res) => {
  try {
    const inputUrls = req.body.urls || (req.body.url ? [req.body.url] : []);

    if (!Array.isArray(inputUrls) || inputUrls.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Pass url or urls[]"
      });
    }

    const uploaded = [];

    for (const fileUrl of inputUrls) {
      try {
        const downloaded = await downloadUrlToBuffer(fileUrl);

        const cleanFilename = normalizeDocumentName(downloaded.filename);

        const result = await uploadBufferToYouGile(
          downloaded.buffer,
          cleanFilename
        );

        uploaded.push({
          sourceUrl: fileUrl,
          ok: true,
          filename: cleanFilename,
          url: result?.url,
          fullUrl: result?.fullUrl
        });
      } catch (error) {
        const details = axiosErrorDetails(error);

        console.log("UPLOAD-BY-URL ERROR", {
          sourceUrl: fileUrl,
          ...details
        });

        uploaded.push({
          sourceUrl: fileUrl,
          ok: false,
          error: details
        });
      }
    }

    res.json({
      ok: true,
      count: uploaded.length,
      uploaded
    });
  } catch (error) {
    const details = axiosErrorDetails(error);

    console.log("UPLOAD-BY-URL FATAL ERROR", details);

    res.status(500).json({
      ok: false,
      error: "upload-by-url failed",
      details
    });
  }
});

app.listen(PORT, () => {
  console.log(`YouGile upload proxy started on port ${PORT}`);
});
