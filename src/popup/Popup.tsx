import { useEffect, useState } from "react";
import browser from "webextension-polyfill";
import type { Channel } from "../types/storage";

export default function Popup() {
  const [channels, setChannels] = useState<Channel[]>([]);

  useEffect(() => {
    async function load() {
      const result = await browser.storage.local.get("channels");
      const saved = Array.isArray(result["channels"]) ? result["channels"] : [];
      setChannels(saved);
    }
    load();
  }, []);

  async function unfollow(id: string) {
    const updated = channels.filter((c) => c.id !== id);
    await browser.storage.local.set({ channels: updated });
    setChannels(updated);
  }

  return (
    <div style={{ width: 320, padding: 16, fontFamily: "sans-serif" }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Following</h2>

      {channels.length === 0 ? (
        <p style={{ color: "#888", fontSize: 14 }}>
          Not following any channels yet. Right-click any channel or video on
          YouTube and click "Follow Channel".
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {channels.map((channel) => (
            <li
              key={channel.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 0",
                borderBottom: "1px solid #eee",
                fontSize: 14,
              }}
            >
              <span>{channel.name}</span>
              <button
                onClick={() => unfollow(channel.id)}
                style={{
                  marginLeft: 8,
                  background: "#f44336",
                  color: "white",
                  border: "none",
                  borderRadius: 4,
                  padding: "4px 10px",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Unfollow
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
