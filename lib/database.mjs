import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const COLLECTIONS = {
  creators: {
    table: "creators",
    key: item => String(item.id),
    platform: item => item.platform || "x",
    parent: item => item.platformAuthorId || item.handle || "",
    status: item => item.status || "followed",
    occurred: item => item.createdAt || item.profiledAt || null
  },
  industries: {
    table: "monitor_rules",
    key: item => String(item.id),
    platform: item => item.platform || "all",
    status: item => item.enabled === false ? "disabled" : "enabled",
    occurred: item => item.createdAt || null
  },
  jobs: {
    table: "jobs",
    key: item => String(item.id),
    platform: item => item.platform || "x",
    parent: item => item.targetId || "",
    status: item => item.status || "queued",
    occurred: item => item.requestedAt || null
  },
  posts: {
    table: "posts",
    key: item => `${item.platform || sourcePlatform(item.source)}:${item.id}`,
    platform: item => item.platform || sourcePlatform(item.source),
    parent: item => item.creatorId || item.handle || "",
    status: item => item.qualityGrade || item.analysis?.qualityGrade || item.analysis?.level || "ordinary",
    occurred: item => item.publishedAt || item.capturedAt || null
  },
  snapshots: {
    table: "snapshots",
    key: item => String(item.id),
    platform: item => item.platform || sourcePlatform(item.source),
    parent: item => item.postStorageKey || `${item.platform || sourcePlatform(item.source)}:${item.postId}`,
    status: () => "captured",
    occurred: item => item.capturedAt || null
  },
  industrySignals: {
    table: "industry_signals",
    key: item => String(item.id),
    parent: item => item.industryId || "",
    status: item => item.trend || "unknown",
    occurred: item => item.firstSeenAt || null
  },
  creatorCandidates: {
    table: "creator_candidates",
    key: item => String(item.id),
    platform: item => item.platform || "x",
    parent: item => item.handle || "",
    status: item => item.status || "discovered",
    occurred: item => item.discoveredAt || item.createdAt || null
  },
  trendingKeywords: {
    table: "trending_terms",
    key: item => String(item.id),
    status: item => item.status || "candidate",
    occurred: item => item.lastSeenAt || item.firstSeenAt || null
  },
  followUpQueue: {
    table: "follow_ups",
    key: item => String(item.id),
    parent: item => item.eventId || item.postId || "",
    status: item => item.status || "queued",
    occurred: item => item.createdAt || null
  },
  earlyEvents: {
    table: "events",
    key: item => String(item.id),
    status: item => item.stage || "new",
    occurred: item => item.firstSeenAt || item.createdAt || null
  },
  sourceRegistry: {
    table: "source_registry",
    key: item => String(item.id),
    platform: item => item.platform || "x",
    parent: item => item.handle || "",
    status: item => item.status || "candidate",
    occurred: item => item.lastSeenAt || null
  },
  eventAudit: {
    table: "audit_entries",
    key: item => String(item.id),
    parent: item => item.eventId || "",
    status: item => item.type || "event",
    occurred: item => item.createdAt || null
  },
  validationTasks: {
    table: "validation_tasks",
    key: item => String(item.id),
    parent: item => item.eventId || "",
    status: item => item.status || "queued",
    occurred: item => item.createdAt || null
  },
  discoveryHistory: {
    table: "event_history",
    key: item => `${String(item.id)}:${String(item.earliestPostId || item.firstSeenAt || item.createdAt || "unknown")}`,
    status: item => item.stage || "archived",
    occurred: item => item.resolvedAt || item.expiredAt || item.lastSeenAt || null
  }
};

const TABLES = [...new Set(Object.values(COLLECTIONS).map(value => value.table))];
const LEGACY_DERIVED_COLLECTIONS = [
  "industrySignals", "creatorCandidates", "trendingKeywords", "earlyEvents",
  "sourceRegistry", "eventAudit", "validationTasks", "discoveryHistory"
];
const LEGACY_POST_DERIVED_FIELDS = [
  "analysis", "topics", "quality", "momentum", "aiRelevant", "relevance",
  "latestAnalysis", "metrics", "followed", "sourceType"
];

function sourcePlatform(source = "") {
  return String(source).startsWith("douyin") ? "douyin" : "x";
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function parsePayload(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stripLegacyDerivedPost(post) {
  const clean = { ...post };
  for (const key of LEGACY_POST_DERIVED_FIELDS) delete clean[key];
  return clean;
}

function seedState() {
  return {
    version: 6,
    collector: { status: "waiting_extension", lastRunAt: null, lastError: null, nodes: [] },
    collectionSettings: { x: true, douyin: true },
    creators: [],
    industries: [],
    jobs: [],
    posts: [],
    snapshots: [],
    industrySignals: [],
    analysisUpdatedAt: null,
    creatorCandidates: [],
    trendingKeywords: [],
    followUpQueue: [],
    earlyEvents: [],
    sourceRegistry: [],
    eventAudit: [],
    validationTasks: [],
    discoveryHistory: []
  };
}

export class StateDatabase {
  constructor(path, options = {}) {
    this.path = path;
    this.readonly = options.readonly === true;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { readonly: this.readonly, fileMustExist: this.readonly });
    if (!this.readonly) this.initialize();
    this.cache = new Map();
    for (const table of TABLES) this.cache.set(table, this.readCache(table));
  }

  initialize() {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS legacy_archive (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        archived_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS grade_evidence (
        post_key TEXT NOT NULL,
        grade TEXT NOT NULL,
        formula_version TEXT NOT NULL,
        threshold_version TEXT NOT NULL,
        baseline REAL NOT NULL,
        followers INTEGER NOT NULL,
        sample_payload TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        revoke_reason TEXT,
        PRIMARY KEY (post_key, grade)
      );
      CREATE TABLE IF NOT EXISTS grade_history (
        id TEXT PRIMARY KEY,
        post_key TEXT NOT NULL,
        grade TEXT NOT NULL,
        r_value REAL,
        m_value REAL,
        evidence_hash TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threshold_versions (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        tier TEXT NOT NULL,
        m_base REAL NOT NULL,
        sample_count INTEGER NOT NULL,
        creator_count INTEGER NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        created_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS model_routes (
        task_type TEXT PRIMARY KEY,
        profile_id TEXT,
        fallback_profile_id TEXT,
        execution_mode TEXT NOT NULL DEFAULT 'automatic',
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        base_url TEXT,
        api_key_env TEXT,
        api_style TEXT NOT NULL,
        price_version TEXT,
        input_usd_per_million REAL,
        output_usd_per_million REAL,
        max_input_tokens INTEGER,
        max_output_tokens INTEGER,
        enabled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key_env TEXT NOT NULL,
        api_style TEXT NOT NULL,
        price_version TEXT NOT NULL,
        input_usd_per_million REAL NOT NULL,
        output_usd_per_million REAL NOT NULL,
        max_input_tokens INTEGER NOT NULL,
        max_output_tokens INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_test_status TEXT,
        last_test_error TEXT,
        last_tested_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analysis_tasks (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        version_key TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        manual_override INTEGER NOT NULL DEFAULT 0,
        budget_day TEXT,
        reserved_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        UNIQUE(task_type, entity_type, entity_id, version_key)
      );
      CREATE TABLE IF NOT EXISTS analysis_results (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        evidence_version TEXT NOT NULL,
        payload TEXT NOT NULL,
        usage_payload TEXT,
        estimated_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analysis_results_provider_model_created
        ON analysis_results(provider, model, created_at DESC);
      CREATE TABLE IF NOT EXISTS usage_ledger (
        id TEXT PRIMARY KEY,
        budget_day TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        reserved_usd REAL NOT NULL,
        actual_usd REAL,
        status TEXT NOT NULL,
        price_version TEXT,
        created_at TEXT NOT NULL,
        settled_at TEXT,
        UNIQUE(task_id, attempt)
      );
      CREATE TABLE IF NOT EXISTS transcripts (
        post_key TEXT PRIMARY KEY,
        provider TEXT,
        status TEXT NOT NULL,
        transcript TEXT,
        language TEXT,
        metadata_only INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS snapshot_daily_summaries (
        post_key TEXT NOT NULL,
        day TEXT NOT NULL,
        sample_count INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(post_key, day)
      );
      CREATE TABLE IF NOT EXISTS collector_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        last_seen_at TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        channel TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        UNIQUE(entity_type, entity_id, stage, channel)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id_hash TEXT PRIMARY KEY,
        csrf_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_session_csrf (
        session_id_hash TEXT NOT NULL,
        csrf_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id_hash, csrf_hash)
      );
    `);
    const modelRouteColumns = new Set(this.db.prepare("PRAGMA table_info(model_routes)").all().map(row => row.name));
    if (!modelRouteColumns.has("profile_id")) this.db.exec("ALTER TABLE model_routes ADD COLUMN profile_id TEXT");
    if (!modelRouteColumns.has("fallback_profile_id")) this.db.exec("ALTER TABLE model_routes ADD COLUMN fallback_profile_id TEXT");
    if (!modelRouteColumns.has("execution_mode")) this.db.exec("ALTER TABLE model_routes ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'automatic'");
    if (!modelRouteColumns.has("api_key_env")) {
      this.db.exec("ALTER TABLE model_routes ADD COLUMN api_key_env TEXT");
    }
    if (!modelRouteColumns.has("business_name")) this.db.exec("ALTER TABLE model_routes ADD COLUMN business_name TEXT");
    const modelProfileColumns = new Set(this.db.prepare("PRAGMA table_info(model_profiles)").all().map(row => row.name));
    if (!modelProfileColumns.has("api_key_enc")) this.db.exec("ALTER TABLE model_profiles ADD COLUMN api_key_enc TEXT");
    if (!modelProfileColumns.has("cache_hit_usd_per_million")) this.db.exec("ALTER TABLE model_profiles ADD COLUMN cache_hit_usd_per_million REAL NOT NULL DEFAULT 0");
    const analysisTaskColumns = new Set(this.db.prepare("PRAGMA table_info(analysis_tasks)").all().map(row => row.name));
    if (!analysisTaskColumns.has("manual_override")) {
      this.db.exec("ALTER TABLE analysis_tasks ADD COLUMN manual_override INTEGER NOT NULL DEFAULT 0");
    }
    if (!analysisTaskColumns.has("promoted_at")) this.db.exec("ALTER TABLE analysis_tasks ADD COLUMN promoted_at TEXT");
    if (!analysisTaskColumns.has("paused_at")) this.db.exec("ALTER TABLE analysis_tasks ADD COLUMN paused_at TEXT");
    if (!analysisTaskColumns.has("status_reason")) this.db.exec("ALTER TABLE analysis_tasks ADD COLUMN status_reason TEXT");
    if (!analysisTaskColumns.has("last_status_at")) this.db.exec("ALTER TABLE analysis_tasks ADD COLUMN last_status_at TEXT");
    if (!analysisTaskColumns.has("worker_id")) this.db.exec("ALTER TABLE analysis_tasks ADD COLUMN worker_id TEXT");
    if (!analysisTaskColumns.has("manual_triggered")) this.db.exec("ALTER TABLE analysis_tasks ADD COLUMN manual_triggered INTEGER NOT NULL DEFAULT 0");
    const usageLedgerColumns = new Set(this.db.prepare("PRAGMA table_info(usage_ledger)").all().map(column => column.name));
    if (!usageLedgerColumns.has("request_started_at")) this.db.exec("ALTER TABLE usage_ledger ADD COLUMN request_started_at TEXT");
    if (!usageLedgerColumns.has("request_finished_at")) this.db.exec("ALTER TABLE usage_ledger ADD COLUMN request_finished_at TEXT");
    if (!usageLedgerColumns.has("response_status")) this.db.exec("ALTER TABLE usage_ledger ADD COLUMN response_status INTEGER");
    if (!usageLedgerColumns.has("error")) this.db.exec("ALTER TABLE usage_ledger ADD COLUMN error TEXT");
    const routeColumns = new Set(this.db.prepare("PRAGMA table_info(model_routes)").all().map(column => column.name));
    if (!routeColumns.has("daily_budget_cny")) this.db.exec("ALTER TABLE model_routes ADD COLUMN daily_budget_cny REAL NOT NULL DEFAULT 5");
    if (!routeColumns.has("daily_versions")) this.db.exec("ALTER TABLE model_routes ADD COLUMN daily_versions INTEGER NOT NULL DEFAULT 100");
    const collectorNodeColumns = new Set(this.db.prepare("PRAGMA table_info(collector_nodes)").all().map(row => row.name));
    if (!collectorNodeColumns.has("previous_token_hash")) this.db.exec("ALTER TABLE collector_nodes ADD COLUMN previous_token_hash TEXT");
    if (!collectorNodeColumns.has("previous_expires_at")) this.db.exec("ALTER TABLE collector_nodes ADD COLUMN previous_expires_at TEXT");
    for (const table of TABLES) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id TEXT PRIMARY KEY,
          platform TEXT,
          parent_id TEXT,
          status TEXT,
          occurred_at TEXT,
          position INTEGER NOT NULL,
          payload TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_${table}_status ON ${table}(status);
        CREATE INDEX IF NOT EXISTS idx_${table}_parent ON ${table}(parent_id);
        CREATE INDEX IF NOT EXISTS idx_${table}_occurred ON ${table}(occurred_at);
      `);
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_platform_id
        ON posts(platform, json_extract(payload, '$.id'));
      CREATE INDEX IF NOT EXISTS idx_snapshots_post_time
        ON snapshots(parent_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_queue
        ON jobs(status, occurred_at);
    `);
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(1, new Date().toISOString());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(2, new Date().toISOString());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(3, new Date().toISOString());
    this.archiveLegacyDerivedData();
    this.resetLegacyCollectorPairing();
    this.recordModelSchemaVersion();
  }

  archiveLegacyDerivedData() {
    if (this.db.prepare("SELECT 1 FROM schema_migrations WHERE version=4").get()) return;
    const appliedAt = new Date().toISOString();
    const archive = this.db.prepare(`
      INSERT INTO legacy_archive(key, payload, payload_hash, archived_at)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, payload_hash=excluded.payload_hash, archived_at=excluded.archived_at
    `);
    this.db.transaction(() => {
      for (const table of ["industry_signals", "creator_candidates", "trending_terms", "events", "source_registry", "audit_entries", "validation_tasks", "event_history"]) {
        const rows = this.db.prepare(`SELECT payload FROM ${table} ORDER BY position, rowid`).all().map(row => parsePayload(row.payload)).filter(Boolean);
        if (rows.length) {
          const payload = JSON.stringify(rows);
          archive.run(`derived:${table}:v4`, payload, hash(payload), appliedAt);
          this.db.prepare(`DELETE FROM ${table}`).run();
        }
      }
      const postRows = this.db.prepare("SELECT id, payload FROM posts ORDER BY position, rowid").all();
      const derived = [];
      const updatePost = this.db.prepare("UPDATE posts SET payload=?, payload_hash=?, status='ordinary', updated_at=? WHERE id=?");
      for (const row of postRows) {
        const post = parsePayload(row.payload);
        if (!post) continue;
        const values = Object.fromEntries(LEGACY_POST_DERIVED_FIELDS.filter(key => key in post).map(key => [key, post[key]]));
        if (Object.keys(values).length) derived.push({ postKey: row.id, values });
        const clean = stripLegacyDerivedPost(post);
        const payload = JSON.stringify(clean);
        updatePost.run(payload, hash(payload), appliedAt, row.id);
      }
      if (derived.length) {
        const payload = JSON.stringify(derived);
        archive.run("derived:post-fields:v4", payload, hash(payload), appliedAt);
      }
      for (const table of ["grade_evidence", "grade_history", "threshold_versions"]) this.db.prepare(`DELETE FROM ${table}`).run();
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(4, ?)").run(appliedAt);
    })();
  }

  resetLegacyCollectorPairing() {
    if (this.db.prepare("SELECT 1 FROM schema_migrations WHERE version=5").get()) return;
    const appliedAt = new Date().toISOString();
    this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT id, name, status, last_seen_at, expires_at, revoked_at, created_at FROM collector_nodes
      `).all();
      if (rows.length) {
        const payload = JSON.stringify(rows);
        this.db.prepare(`
          INSERT INTO legacy_archive(key, payload, payload_hash, archived_at) VALUES(?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, payload_hash=excluded.payload_hash, archived_at=excluded.archived_at
        `).run("collector-nodes-pre-binding-v5", payload, hash(payload), appliedAt);
      }
      this.db.prepare("DELETE FROM collector_nodes").run();
      this.db.prepare("DELETE FROM metadata WHERE key='collector_bootstrap_consumed'").run();
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(5, ?)").run(appliedAt);
    })();
  }

  recordModelSchemaVersion() {
    if (this.db.prepare("SELECT 1 FROM schema_migrations WHERE version=6").get()) return;
    this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(6, ?)").run(new Date().toISOString());
  }

  readCache(table) {
    const result = new Map();
    if (!this.tableExists(table)) return result;
    for (const row of this.db.prepare(`SELECT id, payload_hash, position FROM ${table}`).all()) {
      result.set(row.id, { hash: row.payload_hash, position: row.position });
    }
    return result;
  }

  tableExists(table) {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  }

  isEmpty() {
    return !this.db.prepare("SELECT 1 FROM metadata WHERE key='state_version'").get();
  }

  importLegacy(path, options = {}) {
    if (!existsSync(path)) return { imported: false, reason: "legacy_missing" };
    const state = JSON.parse(readFileSync(path, "utf8"));
    const report = this.migrationReport(state);
    if (options.dryRun) return { imported: false, dryRun: true, report };
    if (!this.isEmpty() && options.force !== true) return { imported: false, reason: "database_not_empty", report };
    const sourceFacts = {
      ...seedState(),
      ...state,
      version: Math.max(6, Number(state.version) || 0),
      posts: (state.posts || []).map(stripLegacyDerivedPost),
      ...Object.fromEntries(LEGACY_DERIVED_COLLECTIONS.map(key => [key, []])),
      skills: undefined,
      skillAudit: undefined,
      skillSettings: undefined
    };
    this.persistState(sourceFacts);
    const archive = this.db.prepare(`
      INSERT INTO legacy_archive(key, payload, payload_hash, archived_at)
      VALUES(@key, @payload, @payload_hash, @archived_at)
      ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, payload_hash=excluded.payload_hash, archived_at=excluded.archived_at
    `);
    const archivedAt = new Date().toISOString();
    for (const key of ["skills", "skillAudit", "skillSettings", ...LEGACY_DERIVED_COLLECTIONS]) {
      const payload = JSON.stringify(state[key] ?? null);
      archive.run({ key, payload, payload_hash: hash(payload), archived_at: archivedAt });
    }
    const postDerived = (state.posts || []).map(post => ({
      postId: post.id,
      values: Object.fromEntries(LEGACY_POST_DERIVED_FIELDS.filter(key => key in post).map(key => [key, post[key]]))
    })).filter(item => Object.keys(item.values).length);
    const postDerivedPayload = JSON.stringify(postDerived);
    archive.run({ key: "postDerived", payload: postDerivedPayload, payload_hash: hash(postDerivedPayload), archived_at: archivedAt });
    return { imported: true, report };
  }

  migrationReport(state) {
    const collections = {};
    for (const [key, config] of Object.entries(COLLECTIONS)) {
      const values = Array.isArray(state[key]) ? state[key] : [];
      collections[key] = {
        table: config.table,
        count: values.length,
        identityHash: hash(values.map(item => config.key(item)).sort())
      };
    }
    return {
      sourceVersion: Number(state.version) || 0,
      targetVersion: 6,
      collections,
      archived: {
        skills: Array.isArray(state.skills) ? state.skills.length : 0,
        skillAudit: Array.isArray(state.skillAudit) ? state.skillAudit.length : 0,
        skillSettings: state.skillSettings ? 1 : 0,
        derivedCollections: Object.fromEntries(LEGACY_DERIVED_COLLECTIONS.map(key => [key, Array.isArray(state[key]) ? state[key].length : 0])),
        postDerived: (state.posts || []).filter(post => LEGACY_POST_DERIVED_FIELDS.some(key => key in post)).length
      }
    };
  }

  loadState() {
    const state = seedState();
    state.version = Number(this.meta("state_version") || 6);
    state.collector = parsePayload(this.meta("collector")) || state.collector;
    state.collectionSettings = {
      ...state.collectionSettings,
      ...(parsePayload(this.meta("collection_settings")) || {})
    };
    state.analysisUpdatedAt = this.meta("analysis_updated_at") || null;
    for (const [key, config] of Object.entries(COLLECTIONS)) {
      state[key] = this.db.prepare(`SELECT payload FROM ${config.table} ORDER BY position ASC, rowid ASC`)
        .all()
        .map(row => parsePayload(row.payload))
        .filter(Boolean);
    }
    return state;
  }

  dataRevision() {
    const revision = Number(this.meta("state_revision") || 0);
    const rows = this.db.prepare(TABLES.map(table => `SELECT '${table}' AS tableName, MAX(updated_at) AS updatedAt, COUNT(*) AS count FROM ${table}`).join(" UNION ALL ")).all();
    const latestUpdatedAt = rows.map(row => row.updatedAt || "").sort().at(-1) || "";
    const byTable = new Map(rows.map(row => [row.tableName, row]));
    const counts = TABLES.map(table => byTable.get(table)?.count || 0).join(",");
    return `${revision}:${latestUpdatedAt}:${counts}`;
  }

  persistState(input) {
    if (this.readonly) throw new Error("只读数据库不能写入");
    const state = { ...seedState(), ...input, version: Math.max(6, Number(input.version) || 0) };
    const transaction = this.db.transaction(() => {
      this.setMeta("state_version", String(state.version));
      this.setMeta("state_revision", String(Number(this.meta("state_revision") || 0) + 1));
      this.setMeta("collector", JSON.stringify(state.collector || seedState().collector));
      this.setMeta("collection_settings", JSON.stringify(state.collectionSettings || seedState().collectionSettings));
      this.setMeta("analysis_updated_at", state.analysisUpdatedAt || "");
      for (const [key, config] of Object.entries(COLLECTIONS)) this.syncCollection(config, state[key] || []);
    });
    transaction();
    return state;
  }

  syncCollection(config, values) {
    const table = config.table;
    const cache = this.cache.get(table) || new Map();
    const incoming = new Set();
    const upsert = this.db.prepare(`
      INSERT INTO ${table}(id, platform, parent_id, status, occurred_at, position, payload, payload_hash, updated_at)
      VALUES(@id, @platform, @parent_id, @status, @occurred_at, @position, @payload, @payload_hash, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        platform=excluded.platform,
        parent_id=excluded.parent_id,
        status=excluded.status,
        occurred_at=excluded.occurred_at,
        position=excluded.position,
        payload=excluded.payload,
        payload_hash=excluded.payload_hash,
        updated_at=excluded.updated_at
    `);
    const updatedAt = new Date().toISOString();
    values.forEach((item, position) => {
      const id = config.key(item) || randomUUID();
      const payload = JSON.stringify(item);
      const payloadHash = hash(payload);
      const previous = cache.get(id);
      incoming.add(id);
      if (!previous || previous.hash !== payloadHash || previous.position !== position) {
        upsert.run({
          id,
          platform: config.platform?.(item) || null,
          parent_id: config.parent?.(item) || null,
          status: config.status?.(item) || null,
          occurred_at: config.occurred?.(item) || null,
          position,
          payload,
          payload_hash: payloadHash,
          updated_at: updatedAt
        });
        cache.set(id, { hash: payloadHash, position });
      }
    });
    const remove = this.db.prepare(`DELETE FROM ${table} WHERE id=?`);
    for (const id of [...cache.keys()]) {
      if (incoming.has(id)) continue;
      remove.run(id);
      cache.delete(id);
    }
    this.cache.set(table, cache);
  }

  meta(key) {
    return this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key)?.value;
  }

  setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO metadata(key, value, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, String(value), new Date().toISOString());
  }

  integrityReport() {
    return {
      integrity: this.db.pragma("integrity_check", { simple: true }),
      foreignKeys: this.db.pragma("foreign_key_check"),
      counts: Object.fromEntries(TABLES.map(table => [table, this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]))
    };
  }

  close() {
    this.db.close();
  }
}

export function normalizeResultPayload(input) {
  return {
    jobId: String(input.jobId || ""),
    nodeId: String(input.nodeId || ""),
    leaseNonce: String(input.leaseNonce || ""),
    capturedAt: String(input.capturedAt || ""),
    platform: String(input.platform || ""),
    profile: input.profile || null,
    following: (input.following || []).map(item => {
      const ordered = {};
      for (const key of Object.keys(item).sort()) ordered[key] = item[key];
      return ordered;
    }),
    posts: (input.posts || []).map(post => {
      const ordered = {};
      for (const key of Object.keys(post).sort()) ordered[key] = post[key];
      return ordered;
    })
  };
}

export function payloadHash(input) {
  return hash(normalizeResultPayload(input));
}

export function newLeaseNonce() {
  return randomUUID();
}

export { seedState, stableJson };
