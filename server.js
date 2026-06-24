require("dotenv").config();

const express = require("express");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");

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

function getFileNameFromUrl(fileUrl) {
  try {
    const url = new URL(fileUrl);
    const last = url.pathname.split("/").filter(Boolean).pop();
    return decodeURIComponent(last || "document");
  } catch {
    return "document";
  }
}

function axiosErrorDetails(error) {
  return {
    message: error.message,
    status: error.response?.status,
    data: error.response?.data
  };
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

app.get("/health", (req, res) => {
  res.json({ ok: true });
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
          maxBodyLength: Infinity
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
