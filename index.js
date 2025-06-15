const express = require("express");
const axios = require("axios");
require("dotenv").config();
const cors = require("cors");
const AWS = require("aws-sdk");
const multer = require("multer");
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB
  },
});

// Configure S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const app = express();
const PORT = 3000;

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(cors());

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ACCESS_TOKEN_1 = process.env.ACCESS_TOKEN_1;
const ACCESS_TOKEN_2 = process.env.ACCESS_TOKEN_2;
const TEMPLATE_PRODUCT_ID = process.env.TEMPLATE_PRODUCT_ID;

async function uploadFileToS3(fileStream, fileName, mimeType) {
  const params = {
    Bucket: "t-shirt-website",
    Key: `uploads/${new Date().getTime()}/${fileName}`,
    Body: fileStream,
    ContentType: mimeType,
    ACL: "public-read",
    CacheControl: "no-cache",
  };

  return new Promise((resolve, reject) => {
    s3.upload(params, (err, data) => {
      if (err) return reject(err);
      return resolve(data.Location);
    });
  });
}

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const fileStream = req; // raw body stream

    const s3Url = await uploadFileToS3(
      fileStream.file.buffer,
      fileStream.file.originalname,
      fileStream.file.mimetype
    );
    res.json({ message: "Upload successful", url: s3Url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Upload failed", error: error.message });
  }
});

app.post("/generate-image", async (req, res) => {
  const { prompt, numImages = 8, transparency = false } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required." });
  }

  const modelId = "2067ae52-33fd-4a82-bb92-c2c55e7d2786"; // AlbedoBase XL

  const payload = {
    prompt,
    width: 1024,
    height: 1024,
    num_images: numImages,
    guidance_scale: 7,
    num_inference_steps: 20,
    modelId,
  };

  // Only include transparency if user requested it
  if (transparency) {
    payload.transparency = "foreground_only";
  }

  try {
    const generationResponse = await axios.post(
      "https://cloud.leonardo.ai/api/rest/v1/generations",
      payload,
      {
        headers: {
          Authorization: `Bearer a00319bb-1705-410a-a3e6-e5985bd02ac2`,
          "Content-Type": "application/json",
        },
      }
    );

    const generationId = generationResponse.data?.sdGenerationJob?.generationId;

    if (!generationId) {
      console.error("No generationId returned:", generationResponse.data);
      return res
        .status(500)
        .json({ error: "No generation ID returned from Leonardo API" });
    }

    // Poll for image result
    let imageUrls = [];
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const pollResponse = await axios.get(
        `https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`,
        {
          headers: {
            Authorization: `Bearer a00319bb-1705-410a-a3e6-e5985bd02ac2`,
          },
        }
      );

      const imageData = pollResponse.data?.generations_by_pk;
      if (imageData?.generated_images?.length > 0) {
        imageUrls = imageData.generated_images.map((img) => img.url);
        break;
      }
    }

    if (imageUrls.length === 0) {
      return res
        .status(202)
        .json({ message: "Image generation in progress. Try again later." });
    }

    res.json({ imageUrls });
  } catch (err) {
    console.error("Leonardo API Error:");
    console.error(err.response?.data || err.message || err);

    return res.status(500).json({
      error: err.response?.data || err.message || "Unknown error",
    });
  }
});

app.get("/template-product-variants", async (req, res) => {
  try {
    const response = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2025-04/products/${TEMPLATE_PRODUCT_ID}.json`,
      {
        headers: {
          "X-Shopify-Access-Token": ACCESS_TOKEN_1,
          "Content-Type": "application/json",
        },
      }
    );

    const { variants, options } = response.data.product;

    // Fetch store currency
    const shopResponse = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2025-04/shop.json`,
      {
        headers: {
          "X-Shopify-Access-Token": ACCESS_TOKEN_1,
          "Content-Type": "application/json",
        },
      }
    );

    const storeCurrency = shopResponse.data.shop.currency;

    res.json({ variants, options, storeCurrency });
  } catch (error) {
    console.error("Error fetching template variants:", error.message);
    res.status(500).send("Failed to load variants");
  }
});

app.post("/create-product", async (req, res) => {
  try {
    const {
      title,
      body_html,
      vendor,
      product_type,
      images,
      variants,
      options,
    } = req.body;

    const productPayload = {
      title,
      body_html,
      vendor,
      product_type,
      images,
      variants,
      options,
    };

    const response = await axios.post(
      `https://${SHOPIFY_STORE}/admin/api/2025-04/products.json`,
      { product: productPayload },
      {
        headers: {
          "X-Shopify-Access-Token": ACCESS_TOKEN_1,
          "Content-Type": "application/json",
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("Shopify API error:", error.response?.data || error.message);
    res.status(500).json({
      error: "Error creating product",
      details: error.response?.data || error.message,
    });
  }
});

app.post("/sync-preview", async (req, res) => {
  const {
    customerId,
    myDesigns = [],
    aiPrompt = "",
    aiImages = [],
    selectedImage = "",
  } = req.body;

  // Log the incoming data
  console.log("Received Request Body:", req.body);

  if (!customerId || !Array.isArray(myDesigns)) {
    return res
      .status(400)
      .json({ error: "Missing customerId or invalid myDesigns" });
  }

  const fullPayload = {
    designs: myDesigns,
    aiPrompt,
    aiImages,
    selectedImage,
  };

  const metafieldPayload = {
    metafield: {
      namespace: "custom_preview",
      key: "design_list",
      type: "json",
      value: JSON.stringify(fullPayload),
    },
  };

  try {
    const existing = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2023-10/customers/${customerId}/metafields.json`,
      {
        headers: {
          "X-Shopify-Access-Token": ACCESS_TOKEN_2,
        },
      }
    );

    const existingMetafield = existing.data.metafields.find(
      (mf) => mf.namespace === "custom_preview" && mf.key === "design_list"
    );

    if (existingMetafield) {
      const response = await axios.put(
        `https://${SHOPIFY_STORE}/admin/api/2023-10/metafields/${existingMetafield.id}.json`,
        metafieldPayload,
        {
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ACCESS_TOKEN_2,
          },
        }
      );
      res.json({ status: "updated", metafield: response.data });
    } else {
      const response = await axios.post(
        `https://${SHOPIFY_STORE}/admin/api/2023-10/customers/${customerId}/metafields.json`,
        metafieldPayload,
        {
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ACCESS_TOKEN_2,
          },
        }
      );
      res.json({ status: "created", metafield: response.data });
    }
  } catch (err) {
    console.error("Error syncing preview:", err.response?.data || err.message);
    res
      .status(500)
      .json({
        error: "Failed to sync preview",
        details: err.response?.data || err.message,
      });
  }
});

app.get("/fetch-preview/:customerId", async (req, res) => {
  const { customerId } = req.params;

  try {
    const response = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2025-04/customers/${customerId}/metafields.json`,
      {
        headers: {
          "X-Shopify-Access-Token": ACCESS_TOKEN_2,
        },
      }
    );

    const metafield = response.data.metafields.find(
      (mf) => mf.namespace === "custom_preview" && mf.key === "design_list"
    );

    if (metafield && metafield.type === "json") {
      try {
        metafield.value = JSON.parse(metafield.value);
      } catch (err) {
        metafield.value = {}; // fallback
      }
    }

    res.json(metafield?.value || {});
  } catch (err) {
    console.error(
      "Error fetching metafield:",
      err.response?.data || err.message
    );
    res.status(500).json({ error: "Failed to fetch metafields" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
