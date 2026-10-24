import { isIP } from "node:net";

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./
];

const ALLOWED_MEDIA_HOSTS = [
  /(^|\.)video\.twimg\.com$/i,
  /(^|\.)douyinvod\.com$/i,
  /(^|\.)douyin\.com$/i,
  /(^|\.)youtube\.com$/i,
  /(^|\.)youtu\.be$/i,
  /(^|\.)googlevideo\.com$/i
];

export function validateMediaUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("媒体地址无效");
  }
  if (url.protocol !== "https:") throw new Error("媒体地址必须使用 HTTPS");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) throw new Error("媒体地址不能指向本机");
  if (isIP(host) && (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") || PRIVATE_V4.some(pattern => pattern.test(host)))) {
    throw new Error("媒体地址不能指向私有网络");
  }
  if (!ALLOWED_MEDIA_HOSTS.some(pattern => pattern.test(host))) throw new Error("媒体域名不在允许列表");
  return url.toString();
}

export function queueTranscript(database, post, options = {}) {
  const platform = post.platform || "x";
  const postKey = `${platform}:${post.id}`;
  const now = new Date().toISOString();
  const current = database.db.prepare("SELECT * FROM transcripts WHERE post_key=?").get(postKey);
  if (current && !["failed", "metadata_only"].includes(current.status)) return current;
  const mediaUrl = post.videoUrl || post.mediaUrls?.find(value => {
    try {
      validateMediaUrl(value);
      return true;
    } catch {
      return false;
    }
  }) || null;
  const status = mediaUrl ? "queued" : "metadata_only";
  const error = mediaUrl ? null : "作品没有可验证的视频直链，等待采集器补充";
  database.db.prepare(`
    INSERT INTO transcripts(post_key, provider, status, transcript, language, metadata_only, created_at, updated_at, error)
    VALUES(?, ?, ?, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(post_key) DO UPDATE SET
      provider=excluded.provider, status=excluded.status, language=excluded.language,
      metadata_only=excluded.metadata_only, updated_at=excluded.updated_at, error=excluded.error
  `).run(
    postKey,
    options.provider || null,
    status,
    post.language || null,
    mediaUrl ? 0 : 1,
    current?.created_at || now,
    now,
    error
  );
  return { post_key: postKey, status, media_url: mediaUrl, metadata_only: mediaUrl ? 0 : 1, error };
}

export function transcriptFor(database, post) {
  return database.db.prepare("SELECT * FROM transcripts WHERE post_key=?").get(`${post.platform || "x"}:${post.id}`) || null;
}

export { ALLOWED_MEDIA_HOSTS };
