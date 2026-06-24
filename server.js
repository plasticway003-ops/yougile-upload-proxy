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

async function uploadBufferToYouGile(buffer, filename) {
  if (!YOUGILE_TOKEN) {
    throw new Error("YOUGILE_TOKEN is missing");
  }

  const form = new FormData();
  form.append("file", buffer, filename);

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

  const publishedMatch = bodyText.match(/Опубликован\s*([0-9]{2}\.[0-9]{2}\.[0-9]{4},?\s*[0-9]{2}:[0-9]{2})/i);

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
      name: name || "document",
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
    rawTextPreview: bodyText.slice(0, 3000)
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
        // ignore non-json or already-consumed responses
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
      // page can still be parsed from whatever loaded
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

      const hasFileExtension =
        typeof possibleName === "string" &&
        /\.(pdf|doc|docx|xls|xlsx|zip|rar|7z|txt)$/i.test(possibleName);

      if (possibleUrl && typeof possibleUrl === "string") {
        const looksLikeDoc =
          /filestorage|download|file/i.test(possibleUrl) ||
          /\.(pdf|doc|docx|xls|xlsx|zip|rar|7z|txt)(\?|$)/i.test(possibleUrl) ||
          hasFileExtension;

        if (looksLikeDoc) {
          apiDocuments.push({
            name: cleanText(possibleName || getFileNameFromUrl(possibleUrl) || "document"),
            url: absoluteUrl(tenderUrl, possibleUrl)
          });
        }
      }

      if (possibleId && possibleName && hasFileExtension) {
        apiDocuments.push({
          name: cleanText(possibleName),
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
        name: cleanText(link.text || getFileNameFromUrl(link.href) || "document"),
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
      ...data
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

app.post("/upload", checkProxyKey, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "No file uploaded. Use multipart field: file"
      });
    }

    const result = await uploadBufferToYouGile(
      req.file.buffer,
      req.file.originalname
    );

    res.json({
      ok: true,
      filename: req.file.originalname,
      result,
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
        const download = await axios.get(fileUrl, {
          responseType: "arraybuffer",
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 60000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
          }
        });

        let filename = getFileNameFromUrl(fileUrl);

        const disposition = download.headers["content-disposition"];
        if (disposition) {
          const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
          if (match && match[1]) {
            filename = decodeURIComponent(match[1].replace(/"/g, ""));
          }
        }

        const result = await uploadBufferToYouGile(
          Buffer.from(download.data),
          filename
        );

        uploaded.push({
          sourceUrl: fileUrl,
          ok: true,
          filename,
          result,
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
