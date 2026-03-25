import express from "express";
import cors from "cors";
import { initDb, getPool } from "./db.js";

const app = express();
const PORT = process.env.PORT || 8787;

app.use(cors());
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
    await client.query("DELETE FROM channels WHERE customer_id = $1", [customerId]);

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

await initDb();
app.listen(PORT, () => {
  console.log(`HitTheBell backend listening on http://localhost:${PORT}`);
});
