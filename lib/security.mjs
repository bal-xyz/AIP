import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function cookieValue(header = "", name) {
  for (const part of String(header).split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export class SecurityManager {
  constructor(database, options = {}) {
    this.database = database;
    this.requireAuth = options.requireAuth ?? process.env.AIP_REQUIRE_AUTH === "1";
    this.adminPassword = options.adminPassword ?? process.env.AIP_ADMIN_PASSWORD ?? "";
    const configuredCollectorToken = options.collectorToken ?? process.env.AIP_COLLECTOR_TOKEN ?? "";
    this.collectorToken = configuredCollectorToken || "local-dev-collector";
    this.sessionHours = Number(options.sessionHours || process.env.AIP_SESSION_HOURS || 12);
    if (this.requireAuth && (!this.adminPassword || !configuredCollectorToken)) {
      throw new Error("生产认证已启用，但缺少 AIP_ADMIN_PASSWORD 或 AIP_COLLECTOR_TOKEN");
    }
  }

  status(req) {
    const session = this.session(req);
    let csrf = "";
    if (this.requireAuth && session) {
      csrf = randomBytes(24).toString("base64url");
      this.database.db.prepare(`
        INSERT OR IGNORE INTO admin_session_csrf(session_id_hash, csrf_hash, created_at) VALUES(?, ?, ?)
      `).run(session.id_hash, sha256(csrf), new Date().toISOString());
    }
    return {
      required: this.requireAuth,
      authenticated: !this.requireAuth || Boolean(session),
      collectorConfigured: Boolean(this.collectorToken),
      csrf
    };
  }

  login(password) {
    if (!this.requireAuth) return this.createSession();
    const salt = "aip-monitor-admin-v1";
    const expected = scryptSync(this.adminPassword, salt, 32);
    const provided = scryptSync(String(password || ""), salt, 32);
    if (!timingSafeEqual(expected, provided)) return null;
    return this.createSession();
  }

  createSession() {
    const session = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.sessionHours * 3_600_000);
    this.database.db.prepare(`
      INSERT INTO admin_sessions(id_hash, csrf_hash, expires_at, created_at)
      VALUES(?, ?, ?, ?)
    `).run(sha256(session), sha256(csrf), expiresAt.toISOString(), createdAt.toISOString());
    return { session, csrf, expiresAt: expiresAt.toISOString() };
  }

  session(req) {
    if (!this.requireAuth) return { local: true };
    const raw = cookieValue(req.headers.cookie, "aip_session");
    if (!raw) return null;
    const row = this.database.db.prepare(`
      SELECT id_hash, csrf_hash, expires_at FROM admin_sessions WHERE id_hash=?
    `).get(sha256(raw));
    if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
    return row;
  }

  authorizeAdmin(req) {
    if (!this.requireAuth) return { ok: true };
    const session = this.session(req);
    if (!session) return { ok: false, status: 401, error: "需要管理员登录" };
    if (!SAFE_METHODS.has(req.method)) {
      const csrf = String(req.headers["x-csrf-token"] || "");
      const csrfHash = sha256(csrf);
      const secondary = csrf ? this.database.db.prepare(`
        SELECT 1 FROM admin_session_csrf WHERE session_id_hash=? AND csrf_hash=?
      `).get(session.id_hash, csrfHash) : null;
      if (!csrf || (!secureEqual(csrfHash, session.csrf_hash) && !secondary)) {
        return { ok: false, status: 403, error: "跨站请求令牌无效" };
      }
    }
    return { ok: true };
  }

  authorizeCollector(req) {
    const authorization = String(req.headers.authorization || "");
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) return { ok: false, status: 401, error: "采集节点令牌无效" };
    const claimedNodeId = String(req.headers["x-aip-node-id"] || "").trim();
    if (!claimedNodeId) return { ok: false, status: 400, error: "缺少采集节点标识" };
    const now = new Date().toISOString();
    const tokenHash = sha256(token);
    let node = this.database.db.prepare(`
      SELECT * FROM collector_nodes
      WHERE token_hash=? OR (previous_token_hash=? AND previous_expires_at>?)
    `).get(tokenHash, tokenHash, now);
    if (!node && secureEqual(tokenHash, sha256(this.collectorToken))) {
      const paired = this.database.db.transaction(() => {
        const consumed = this.database.meta("collector_bootstrap_consumed") === "1";
        const existing = this.database.db.prepare("SELECT 1 FROM collector_nodes WHERE id=?").get(claimedNodeId);
        if (consumed || existing) return false;
        const expiresAt = new Date(Date.now() + Number(process.env.AIP_COLLECTOR_TOKEN_DAYS || 30) * 86_400_000).toISOString();
        this.database.db.prepare(`
          INSERT INTO collector_nodes(id, name, token_hash, status, last_seen_at, expires_at, revoked_at, created_at)
          VALUES(?, ?, ?, 'online', ?, ?, NULL, ?)
        `).run(claimedNodeId, claimedNodeId, tokenHash, now, expiresAt, now);
        this.database.setMeta("collector_bootstrap_consumed", "1");
        return true;
      })();
      if (paired) node = this.database.db.prepare("SELECT * FROM collector_nodes WHERE id=?").get(claimedNodeId);
    }
    if (!node || node.id !== claimedNodeId || node.revoked_at || (node.expires_at && node.expires_at <= now)) {
      return { ok: false, status: 401, error: "采集节点令牌无效、已过期或已撤销" };
    }
    this.database.db.prepare("UPDATE collector_nodes SET status='online', last_seen_at=? WHERE id=?").run(now, node.id);
    return { ok: true, nodeId: node.id };
  }

  collectorNodes() {
    return this.database.db.prepare(`
      SELECT id, name, status, last_seen_at AS lastSeenAt, expires_at AS expiresAt,
             revoked_at AS revokedAt, created_at AS createdAt
      FROM collector_nodes ORDER BY created_at DESC
    `).all();
  }

  createCollectorNode(name, options = {}) {
    const id = `node-${randomBytes(10).toString("hex")}`;
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Number(options.days || 30) * 86_400_000).toISOString();
    this.database.db.transaction(() => {
      this.database.db.prepare(`
        INSERT INTO collector_nodes(id, name, token_hash, status, expires_at, created_at)
        VALUES(?, ?, ?, 'paired', ?, ?)
      `).run(id, String(name || "采集节点").slice(0, 80), sha256(token), expiresAt, now.toISOString());
      this.database.setMeta("collector_bootstrap_consumed", "1");
    })();
    return { id, token, expiresAt };
  }

  rotateCollectorNode(id, options = {}) {
    const node = this.database.db.prepare("SELECT * FROM collector_nodes WHERE id=?").get(id);
    if (!node) return null;
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const graceExpiresAt = new Date(now.getTime() + Number(options.graceMinutes || 15) * 60_000).toISOString();
    const expiresAt = new Date(now.getTime() + Number(options.days || 30) * 86_400_000).toISOString();
    this.database.db.prepare(`
      UPDATE collector_nodes SET previous_token_hash=token_hash, previous_expires_at=?, token_hash=?,
        expires_at=?, revoked_at=NULL, status='paired' WHERE id=?
    `).run(graceExpiresAt, sha256(token), expiresAt, id);
    return { id, token, expiresAt, graceExpiresAt };
  }

  revokeCollectorNode(id) {
    const now = new Date().toISOString();
    const result = this.database.db.prepare(`
      UPDATE collector_nodes SET revoked_at=?, status='revoked', previous_token_hash=NULL, previous_expires_at=NULL WHERE id=?
    `).run(now, id);
    return result.changes > 0;
  }

  allowedOrigin(origin = "", host = "") {
    if (!origin) return "";
    const configured = String(process.env.AIP_ALLOWED_ORIGINS || "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);
    const local = new Set([
      `http://${host}`,
      "http://127.0.0.1:4173",
      "http://localhost:4173"
    ]);
    if (configured.includes(origin) || local.has(origin) || /^chrome-extension:\/\/[a-z]{32}$/.test(origin)) return origin;
    return "";
  }

  cookieHeader(session) {
    const secure = process.env.AIP_COOKIE_SECURE === "1" ? "; Secure" : "";
    return `aip_session=${encodeURIComponent(session.session)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${this.sessionHours * 3600}${secure}`;
  }
}

export function securityHeaders() {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' https://pbs.twimg.com https://abs.twimg.com https://p3-sign.douyinpic.com https://p9-sign.douyinpic.com data:",
      "media-src 'self' https://video.twimg.com https://*.douyinvod.com",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'"
    ].join("; "),
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };
}
