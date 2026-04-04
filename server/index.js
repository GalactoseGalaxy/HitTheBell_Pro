import express from "express";
import cors from "cors";
import crypto from "crypto";
import { initDb, getPool } from "./db.js";

const app = express();
const PORT = process.env.PORT || 8787;
const PADDLE_API_KEY = process.env.PADDLE_API_KEY || "";
const PADDLE_API_BASE = process.env.PADDLE_API_BASE || "https://api.paddle.com";
const POSTMARK_API_TOKEN = process.env.POSTMARK_API_TOKEN || "";
const POSTMARK_FROM = process.env.POSTMARK_FROM || "";
const RESTORE_CODE_SECRET = process.env.RESTORE_CODE_SECRET || "";
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || "";
const DEBUG_MODE = process.env.DEBUG_MODE === "true";
const RESTORE_CODE_TTL_MINUTES = 10;
const MAX_RESTORE_ATTEMPTS = 5;

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.options("*", cors());

// Webhook route must be registered BEFORE express.json() so we can read
// the raw body for HMAC signature verification.
app.post(
  "/webhooks/paddle",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    // Respond immediately — Paddle retries on slow responses.
    res.sendStatus(200);

    try {
      const rawBody =
        req.body instanceof Buffer ? req.body.toString("utf8") : String(req.body);

      // Verify Paddle v2 signature: "ts=<timestamp>;h1=<hmac_sha256_hex>"
      const sigHeader = req.headers["paddle-signature"] ?? "";
      const tsMatch = sigHeader.match(/ts=(\d+)/);
      const h1Match = sigHeader.match(/h1=([a-f0-9]+)/);

      if (!tsMatch || !h1Match) {
        console.warn("[Paddle webhook] Missing signature header parts");
        return;
      }

      const ts = tsMatch[1];
      const receivedHex = h1Match[1];
      const expectedHex = crypto
        .createHmac("sha256", PADDLE_WEBHOOK_SECRET)
        .update(`${ts}:${rawBody}`)
        .digest("hex");

      const expected = Buffer.from(expectedHex, "hex");
      const received = Buffer.from(receivedHex, "hex");
      if (
        expected.length !== received.length ||
        !crypto.timingSafeEqual(expected, received)
      ) {
        console.warn("[Paddle webhook] Invalid signature — ignoring");
        return;
      }

      const event = JSON.parse(rawBody);
      const eventType = event?.event_type;
      const data = event?.data ?? {};
      const paddleCustomerId = data?.customer_id;
      const endsAt = data?.current_billing_period?.ends_at ?? null;

      if (!paddleCustomerId) {
        console.warn("[Paddle webhook] No customer_id in event:", eventType);
        return;
      }

      let internalStatus;
      switch (eventType) {
        case "subscription.activated":
          internalStatus = "active";
          break;
        case "subscription.updated": {
          const s = (data?.status ?? "").toLowerCase();
          internalStatus = ["active", "paused", "past_due", "canceled"].includes(s)
            ? s
            : "active";
          break;
        }
        case "subscription.canceled":
          internalStatus = "canceled";
          break;
        case "subscription.past_due":
          internalStatus = "past_due";
          break;
        default:
          return; // Unhandled event — ignore silently
      }

      const pool = getPool();
      await pool.query(
        `
          INSERT INTO customers (paddle_customer_id, status, paid_through)
          VALUES ($1, $2, $3)
          ON CONFLICT (paddle_customer_id)
          DO UPDATE SET
            status = EXCLUDED.status,
            paid_through = EXCLUDED.paid_through,
            updated_at = NOW();
        `,
        [paddleCustomerId, internalStatus, endsAt],
      );

      console.log(
        `[Paddle webhook] ${eventType}: ${paddleCustomerId} → ${internalStatus}, paid_through=${endsAt}`,
      );
    } catch (err) {
      console.error("[Paddle webhook] Processing error:", err);
    }
  },
);

app.use(express.json({ limit: "1mb" }));

function mapChannelRow(row) {
  return {
    id: row.channel_id,
    name: row.name,
    avatarUrl: row.avatar_url,
    uploadsPlaylistId: row.uploads_playlist_id,
    latestVideo: row.latest_video_id
      ? {
          id: row.latest_video_id,
          title: row.latest_video_title ?? "",
          thumbnail: row.latest_video_thumbnail ?? "",
          uploadDate: row.latest_video_upload_date
            ? new Date(row.latest_video_upload_date).toISOString()
            : new Date(0).toISOString(),
          duration: row.latest_video_duration ?? null,
        }
      : null,
    lastSeenVideoId: row.last_seen_video_id ?? null,
    lastCheckedAt: row.last_checked_at
      ? new Date(row.last_checked_at).toISOString()
      : null,
    lastChangedAt: row.last_changed_at
      ? new Date(row.last_changed_at).toISOString()
      : null,
    metadataLastCheckedAt: row.metadata_last_checked_at
      ? new Date(row.metadata_last_checked_at).toISOString()
      : null,
    lastError: row.last_error ?? null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function normalizeEmail(rawEmail) {
  return String(rawEmail ?? "")
    .trim()
    .toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateRestoreCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashRestoreCode(code) {
  if (!RESTORE_CODE_SECRET) {
    throw new Error("Missing RESTORE_CODE_SECRET");
  }
  return crypto
    .createHmac("sha256", RESTORE_CODE_SECRET)
    .update(code)
    .digest("hex");
}

async function sendRestoreEmail(email, code) {
  if (!POSTMARK_API_TOKEN) {
    throw new Error("Missing POSTMARK_API_TOKEN");
  }
  if (!POSTMARK_FROM) {
    throw new Error("Missing POSTMARK_FROM");
  }

  const response = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": POSTMARK_API_TOKEN,
    },
    body: JSON.stringify({
      From: POSTMARK_FROM,
      To: email,
      Subject: "Your HitTheBell sign-in code",
      TextBody: `Your HitTheBell code is ${code}. It expires in ${RESTORE_CODE_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.`,
      MessageStream: "outbound",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Postmark error (${response.status}): ${text}`);
  }
}

async function upsertRestoreCode(email, codeHash) {
  const pool = getPool();
  const expiresAt = new Date(
    Date.now() + RESTORE_CODE_TTL_MINUTES * 60 * 1000,
  ).toISOString();

  await pool.query(
    `
      INSERT INTO restore_codes (email, code_hash, expires_at, attempts, updated_at)
      VALUES ($1, $2, $3, 0, NOW())
      ON CONFLICT (email)
      DO UPDATE SET
        code_hash = EXCLUDED.code_hash,
        expires_at = EXCLUDED.expires_at,
        attempts = 0,
        updated_at = NOW();
    `,
    [email, codeHash, expiresAt],
  );

  return expiresAt;
}

async function getRestoreCode(email) {
  const pool = getPool();
  const result = await pool.query(
    "SELECT * FROM restore_codes WHERE email = $1",
    [email],
  );
  return result.rows[0] ?? null;
}

async function incrementRestoreAttempts(email) {
  const pool = getPool();
  const result = await pool.query(
    "UPDATE restore_codes SET attempts = attempts + 1, updated_at = NOW() WHERE email = $1 RETURNING attempts",
    [email],
  );
  return result.rows[0]?.attempts ?? 0;
}

async function deleteRestoreCode(email) {
  const pool = getPool();
  await pool.query("DELETE FROM restore_codes WHERE email = $1", [email]);
}

async function fetchPaddleCustomerByEmail(email) {
  if (!PADDLE_API_KEY) {
    throw new Error("Missing PADDLE_API_KEY");
  }

  const url = new URL(`${PADDLE_API_BASE}/customers`);
  url.searchParams.set("email", email);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${PADDLE_API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Paddle API error (${response.status}): ${text}`);
  }

  const payload = await response.json();
  const customers = Array.isArray(payload?.data) ? payload.data : [];
  const match = customers[0];
  return match?.id ?? null;
}

async function getCustomerByPaddleId(paddleCustomerId) {
  const pool = getPool();
  const customerResult = await pool.query(
    "SELECT * FROM customers WHERE paddle_customer_id = $1",
    [paddleCustomerId],
  );
  if (customerResult.rowCount === 0) return null;
  const customer = customerResult.rows[0];

  const channelResult = await pool.query(
    "SELECT * FROM channels WHERE customer_id = $1 ORDER BY updated_at DESC",
    [customer.id],
  );

  return {
    paddleCustomerId: customer.paddle_customer_id,
    status: customer.status,
    paidThrough: customer.paid_through?.toISOString() ?? null,
    createdAt: customer.created_at.toISOString(),
    updatedAt: customer.updated_at.toISOString(),
    channels: channelResult.rows.map(mapChannelRow),
  };
}

async function ensureCustomer(paddleCustomerId, status) {
  const pool = getPool();
  const result = await pool.query(
    `
      INSERT INTO customers (paddle_customer_id, status)
      VALUES ($1, $2)
      ON CONFLICT (paddle_customer_id)
      DO UPDATE SET status = COALESCE(EXCLUDED.status, customers.status), updated_at = NOW()
      RETURNING *;
    `,
    [paddleCustomerId, status ?? "trial"],
  );
  return result.rows[0];
}

async function replaceChannels(customerId, channels) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM channels WHERE customer_id = $1", [
      customerId,
    ]);

    const insertText = `
      INSERT INTO channels (
        customer_id,
        channel_id,
        name,
        avatar_url,
        uploads_playlist_id,
        latest_video_id,
        latest_video_title,
        latest_video_thumbnail,
        latest_video_upload_date,
        latest_video_duration,
        last_seen_video_id,
        last_checked_at,
        last_changed_at,
        metadata_last_checked_at,
        last_error,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16
      )
    `;

    for (const channel of channels) {
      const latestVideo = channel.latestVideo ?? null;
      await client.query(insertText, [
        customerId,
        channel.id,
        channel.name,
        channel.avatarUrl,
        channel.uploadsPlaylistId,
        latestVideo?.id ?? null,
        latestVideo?.title ?? null,
        latestVideo?.thumbnail ?? null,
        latestVideo?.uploadDate ?? null,
        latestVideo?.duration ?? null,
        channel.lastSeenVideoId ?? null,
        channel.lastCheckedAt ?? null,
        channel.lastChangedAt ?? null,
        channel.metadataLastCheckedAt ?? null,
        channel.lastError ?? null,
        channel.updatedAt ?? new Date().toISOString(),
      ]);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

if (DEBUG_MODE) {
  app.post("/debug/simulate-webhook", async (req, res) => {
    try {
      const { paddleCustomerId, status, paidThrough } = req.body ?? {};
      if (!paddleCustomerId || !status) {
        return res
          .status(400)
          .json({ error: "paddleCustomerId and status are required." });
      }
      const pool = getPool();
      await pool.query(
        `
          INSERT INTO customers (paddle_customer_id, status, paid_through)
          VALUES ($1, $2, $3)
          ON CONFLICT (paddle_customer_id)
          DO UPDATE SET
            status = EXCLUDED.status,
            paid_through = EXCLUDED.paid_through,
            updated_at = NOW();
        `,
        [paddleCustomerId, status, paidThrough ?? null],
      );
      const customer = await getCustomerByPaddleId(paddleCustomerId);
      return res.json({ ok: true, customer });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Simulation failed.";
      return res.status(500).json({ error: message });
    }
  });
}

app.get("/customers/:paddleCustomerId", async (req, res) => {
  const { paddleCustomerId } = req.params;
  const customer = await getCustomerByPaddleId(paddleCustomerId);
  res.json(customer);
});

app.put("/customers/:paddleCustomerId", async (req, res) => {
  const { paddleCustomerId } = req.params;
  const payload = req.body || {};
  const customer = await ensureCustomer(paddleCustomerId, payload.status);
  res.json({
    paddleCustomerId: customer.paddle_customer_id,
    status: customer.status,
    createdAt: customer.created_at.toISOString(),
    updatedAt: customer.updated_at.toISOString(),
  });
});

app.put("/customers/:paddleCustomerId/channels", async (req, res) => {
  const { paddleCustomerId } = req.params;
  const channels = Array.isArray(req.body?.channels) ? req.body.channels : [];
  const customer = await ensureCustomer(paddleCustomerId);
  await replaceChannels(customer.id, channels);
  const fullCustomer = await getCustomerByPaddleId(paddleCustomerId);
  res.json(fullCustomer);
});

app.post("/customers/:paddleCustomerId/sync", async (req, res) => {
  const { paddleCustomerId } = req.params;
  const channels = Array.isArray(req.body?.channels) ? req.body.channels : [];
  const customer = await ensureCustomer(paddleCustomerId);
  await replaceChannels(customer.id, channels);
  const fullCustomer = await getCustomerByPaddleId(paddleCustomerId);
  res.json(fullCustomer);
});

app.post("/restore/request", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "Valid email is required." });
    }

    const code = generateRestoreCode();
    const codeHash = hashRestoreCode(code);
    await upsertRestoreCode(email, codeHash);
    await sendRestoreEmail(email, code);

    return res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Restore failed.";
    return res.status(500).json({ error: message });
  }
});

app.post("/restore/verify", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code ?? "").trim();

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "Valid email is required." });
    }

    if (!code) {
      return res.status(400).json({ error: "Code is required." });
    }

    const record = await getRestoreCode(email);
    if (!record) {
      return res
        .status(404)
        .json({ error: "No active code for that email. Request a new one." });
    }

    const expiresAt = new Date(record.expires_at).getTime();
    if (Number.isNaN(expiresAt) || expiresAt < Date.now()) {
      await deleteRestoreCode(email);
      return res
        .status(410)
        .json({ error: "Code expired. Request a new one." });
    }

    if (record.attempts >= MAX_RESTORE_ATTEMPTS) {
      return res
        .status(429)
        .json({ error: "Too many attempts. Request a new code." });
    }

    const codeHash = hashRestoreCode(code);
    if (codeHash !== record.code_hash) {
      const attempts = await incrementRestoreAttempts(email);
      if (attempts >= MAX_RESTORE_ATTEMPTS) {
        return res
          .status(429)
          .json({ error: "Too many attempts. Request a new code." });
      }
      return res.status(401).json({ error: "Invalid code. Try again." });
    }

    await deleteRestoreCode(email);

    const paddleCustomerId = await fetchPaddleCustomerByEmail(email);
    if (!paddleCustomerId) {
      return res
        .status(404)
        .json({ error: "No customer found for that email." });
    }

    await ensureCustomer(paddleCustomerId, "paid");
    const fullCustomer = await getCustomerByPaddleId(paddleCustomerId);
    return res.json({
      paddleCustomerId,
      customer: fullCustomer,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Restore failed.";
    return res.status(500).json({ error: message });
  }
});

await initDb();
app.listen(PORT, () => {
  console.log(`HitTheBell backend listening on http://localhost:${PORT}`);
});
