/**
 * server.js — Smart Transit Insights Analytics Dashboard
 * Express server + REST API + ChennaiOne proxy + PostgreSQL connection pool
 */

require("dotenv").config();
const express     = require("express");
const helmet      = require("helmet");
const cors        = require("cors");
const morgan      = require("morgan");
const rateLimit   = require("express-rate-limit");
const { Pool }    = require("pg");
const path        = require("path");
const cron        = require("node-cron");

// Node 18+ has globalThis.fetch built-in; polyfill for older Node
const _fetch = globalThis.fetch || require("node-fetch");


const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────
// PostgreSQL Connection Pool
// ─────────────────────────────────────────────────────────────
const pool = new Pool({
  host:     process.env.DB_HOST     || "localhost",
  port:     parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME     || "transit_od",
  user:     process.env.DB_USER     || "transit",
  password: process.env.DB_PASSWORD || "transit123",
  max:      10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err.message);
});

// ─────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: "Too many requests" },
});
app.use("/api", limiter);

// ─────────────────────────────────────────────────────────────
// Helper: safe DB query
// ─────────────────────────────────────────────────────────────
async function dbQuery(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────
// In-Memory Cache for ChennaiOne API (refreshed daily)
// ─────────────────────────────────────────────────────────────
let ridershipCache = { data: null, date: null };

async function fetchChennaiOneRidership(date) {
  const API_URL = process.env.CHENNAI_ONE_API_URL || "https://api.moving.tech/pilot/app/frfs/daily";
  const API_KEY = process.env.CHENNAI_ONE_API_KEY || "1407d220-536a-48de-baf4-524c8347b487";

  try {
    const resp = await _fetch(`${API_URL}?date=${date}`, {
      headers: {
        "accept": "application/json;charset=utf-8",
        "x-api-key": API_KEY,
      },
      timeout: 10000,
    });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    return await resp.json();
  } catch (err) {
    console.error("ChennaiOne API error:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/health
 */
app.get("/api/health", async (req, res) => {
  try {
    await dbQuery("SELECT 1");
    res.json({ status: "ok", db: "connected", timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: "error", db: "disconnected", error: err.message });
  }
});

/**
 * GET /api/ridership/daily?date=YYYY-MM-DD
 * Returns ChennaiOne daily ridership (live API + DB fallback)
 */
app.get("/api/ridership/daily", async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  // Try DB first
  try {
    const rows = await dbQuery(
      `SELECT vehicle_type, SUM(booking_count) AS bookings,
              SUM(passenger_count) AS passengers,
              SUM(total_revenue)   AS revenue,
              SUM(new_registrations) AS new_users
       FROM daily_ridership
       WHERE ride_date = $1
       GROUP BY vehicle_type
       ORDER BY vehicle_type`,
      [date]
    );

    if (rows.length > 0) {
      return res.json({ source: "database", date, data: rows });
    }
  } catch (err) {
    console.warn("DB query failed, falling back to API:", err.message);
  }

  // Live API fallback
  const data = await fetchChennaiOneRidership(date);
  if (data) {
    res.json({ source: "live_api", date, data });
  } else {
    res.status(503).json({ error: "Ridership data unavailable for " + date });
  }
});

/**
 * GET /api/ridership/trend?days=30
 * Returns ridership trend over N days
 */
app.get("/api/ridership/trend", async (req, res) => {
  const days = Math.min(parseInt(req.query.days || "30"), 365);
  try {
    const rows = await dbQuery(
      `SELECT ride_date::text AS date,
              vehicle_type,
              SUM(passenger_count) AS passengers,
              SUM(booking_count)   AS bookings
       FROM daily_ridership
       WHERE ride_date >= CURRENT_DATE - INTERVAL '1 day' * $1
       GROUP BY ride_date, vehicle_type
       ORDER BY ride_date, vehicle_type`,
      [days]
    );
    res.json({ days, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/od/matrix?date=YYYY-MM-DD&mode=BUS&limit=200
 * Returns top OD pairs for map rendering
 */
app.get("/api/od/matrix", async (req, res) => {
  const { date, mode, limit = 200 } = req.query;
  const queryDate = date || new Date().toISOString().slice(0, 10);
  const maxRows   = Math.min(parseInt(limit), 500);

  try {
    let sql = `
      SELECT om.origin_h3, om.dest_h3, om.mode_id,
             SUM(om.trip_count)  AS demand,
             om.origin_name, om.dest_name,
             tm.mode_name
      FROM od_matrix om
      JOIN transit_mode tm ON tm.mode_id = om.mode_id
      WHERE om.analysis_date = (
        SELECT COALESCE(
          (SELECT MAX(analysis_date) FROM od_matrix WHERE analysis_date <= $1),
          (SELECT MAX(analysis_date) FROM od_matrix)
        )
      )
    `;
    const params = [queryDate];

    if (mode) {
      sql += ` AND tm.mode_name = $${params.length + 1}`;
      params.push(mode.toUpperCase());
    }

    sql += `
      GROUP BY om.origin_h3, om.dest_h3, om.mode_id, om.origin_name, om.dest_name, tm.mode_name
      ORDER BY demand DESC
      LIMIT $${params.length + 1}
    `;
    params.push(maxRows);

    const rows = await dbQuery(sql, params);
    res.json({ date: queryDate, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/routes/performance?date=YYYY-MM-DD&mode=BUS
 */
app.get("/api/routes/performance", async (req, res) => {
  const { date, mode } = req.query;
  const queryDate = date || new Date().toISOString().slice(0, 10);

  try {
    let sql = `
      SELECT rp.route_short_name,
             tm.mode_name,
             AVG(rp.load_factor) AS avg_load,
             MAX(rp.load_factor) AS peak_load,
             SUM(rp.estimated_riders) AS total_riders,
             BOOL_OR(rp.overcrowded)  AS any_overcrowded,
             MAX(rp.route_uid::text)  AS route_uid
      FROM route_performance rp
      JOIN transit_mode tm ON tm.mode_id = rp.mode_id
      WHERE rp.analysis_date = (
        SELECT COALESCE(
          (SELECT MAX(analysis_date) FROM route_performance WHERE analysis_date <= $1),
          (SELECT MAX(analysis_date) FROM route_performance)
        )
      )
    `;
    const params = [queryDate];

    if (mode) {
      sql += ` AND tm.mode_name = $${params.length + 1}`;
      params.push(mode.toUpperCase());
    }

    sql += `
      GROUP BY rp.route_short_name, tm.mode_name
      ORDER BY peak_load DESC
      LIMIT 200
    `;

    const rows = await dbQuery(sql, params);
    res.json({ date: queryDate, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/routes/hourly?date=YYYY-MM-DD&routeId=UUID
 */
app.get("/api/routes/hourly", async (req, res) => {
  const { date, routeId } = req.query;
  if (!routeId) return res.status(400).json({ error: "routeId required" });

  try {
    const rows = await dbQuery(
      `SELECT hour_bucket AS hour, estimated_riders, load_factor, overcrowded
       FROM route_performance
       WHERE analysis_date = $1 AND route_uid = $2
       ORDER BY hour_bucket`,
      [date || new Date().toISOString().slice(0, 10), routeId]
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/gaps?date=YYYY-MM-DD&priority=HIGH
 */
app.get("/api/gaps", async (req, res) => {
  const { date, priority } = req.query;
  const queryDate = date || new Date().toISOString().slice(0, 10);

  try {
    let sql = `
      SELECT id, origin_h3, dest_h3, demand_score, gap_cluster_id,
             priority, origin_lat, origin_lon, dest_lat, dest_lon,
             origin_name, dest_name,
             ST_AsGeoJSON(geom_line)::json AS geometry
      FROM route_gaps
      WHERE analysis_date = (
        SELECT COALESCE(
          (SELECT MAX(analysis_date) FROM route_gaps WHERE analysis_date <= $1),
          (SELECT MAX(analysis_date) FROM route_gaps)
        )
      )
    `;
    const params = [queryDate];

    if (priority) {
      sql += ` AND priority = $${params.length + 1}`;
      params.push(priority.toUpperCase());
    }

    sql += ` ORDER BY demand_score DESC LIMIT 200`;
    const rows = await dbQuery(sql, params);

    // Format as GeoJSON FeatureCollection
    const features = rows.map(r => ({
      type: "Feature",
      geometry: r.geometry,
      properties: {
        id:          r.id,
        origin_h3:   r.origin_h3,
        dest_h3:     r.dest_h3,
        demand:      parseFloat(r.demand_score),
        cluster_id:  r.gap_cluster_id,
        priority:    r.priority,
        origin_name: r.origin_name,
        dest_name:   r.dest_name,
      },
    }));

    res.json({
      type: "FeatureCollection",
      date: queryDate,
      count: features.length,
      features,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/alerts?date=YYYY-MM-DD&severity=CRITICAL
 */
app.get("/api/alerts", async (req, res) => {
  const { date, severity, mode } = req.query;
  const queryDate = date || new Date().toISOString().slice(0, 10);

  try {
    let sql = `
      SELECT ca.id, ca.analysis_date::text, ca.route_short_name,
             ca.load_factor, ca.severity, ca.hour_bucket,
             ca.resolved, tm.mode_name
      FROM crowding_alerts ca
      JOIN transit_mode tm ON tm.mode_id = ca.mode_id
      WHERE ca.analysis_date = (
        SELECT COALESCE(
          (SELECT MAX(analysis_date) FROM crowding_alerts WHERE analysis_date <= $1),
          (SELECT MAX(analysis_date) FROM crowding_alerts)
        )
      )
    `;
    const params = [queryDate];

    if (severity) {
      sql += ` AND ca.severity = $${params.length + 1}`;
      params.push(severity.toUpperCase());
    }
    if (mode && mode !== 'ALL') {
      sql += ` AND tm.mode_name = $${params.length + 1}`;
      params.push(mode.toUpperCase());
    }
    sql += ` ORDER BY ca.load_factor DESC LIMIT 100`;

    const rows = await dbQuery(sql, params);
    res.json({ date: queryDate, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/fleet/recommendations?date=YYYY-MM-DD
 */
app.get("/api/fleet/recommendations", async (req, res) => {
  const { date, mode } = req.query;
  const queryDate = date || new Date().toISOString().slice(0, 10);

  try {
    let sql = `SELECT fr.route_short_name, fr.current_headway_min, fr.recommended_headway_min,
              fr.current_fleet, fr.recommended_fleet, fr.confidence, fr.reason,
              fr.generated_at::text, tm.mode_name
       FROM fleet_recommendations fr
       JOIN routes r ON r.route_uid = fr.route_uid
       JOIN transit_mode tm ON tm.mode_id = r.mode_id
       WHERE fr.analysis_date = (
         SELECT COALESCE(
           (SELECT MAX(analysis_date) FROM fleet_recommendations WHERE analysis_date <= $1),
           (SELECT MAX(analysis_date) FROM fleet_recommendations)
         )
       )`;
    const params = [queryDate];
    
    if (mode && mode !== 'ALL') {
      sql += ` AND tm.mode_name = $${params.length + 1}`;
      params.push(mode.toUpperCase());
    }
    
    sql += ` ORDER BY fr.confidence DESC LIMIT 100`;

    const rows = await dbQuery(sql, params);
    res.json({ date: queryDate, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/stops?mode=BUS&valid=true
 * Returns valid stop locations for map display
 */
app.get("/api/stops", async (req, res) => {
  const { mode, valid } = req.query;
  const limit = req.query.limit ? parseInt(req.query.limit) : 800; // default top 800 hubs
  try {
    let sql = `
      SELECT su.stop_uid::text, su.stop_id, su.stop_name,
             su.stop_lat, su.stop_lon, tm.mode_name, su.has_valid_coord,
             su.estimated_riders as volume
      FROM stops_unified su
      JOIN transit_mode tm ON tm.mode_id = su.mode_id
      WHERE 1=1
    `;
    const params = [];

    if (mode) {
      sql += ` AND tm.mode_name = $${params.length + 1}`;
      params.push(mode.toUpperCase());
    }
    if (valid !== "false") {
      sql += ` AND su.has_valid_coord = TRUE`;
    }

    // Sort by highest estimated riders first to guarantee drawing critical hubs
    sql += ` ORDER BY su.estimated_riders DESC NULLS LAST LIMIT $${params.length + 1}`;
    params.push(limit);

    const rows = await dbQuery(sql, params);
    res.json({ count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/summary?date=YYYY-MM-DD
 * KPI summary for dashboard cards
 */
app.get("/api/summary", async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  try {
    const [ridership, alerts, gaps, recs] = await Promise.all([
      dbQuery(
        `SELECT COALESCE(SUM(passenger_count),0) AS total,
                COALESCE(SUM(total_revenue),0)   AS revenue
         FROM daily_ridership WHERE ride_date = COALESCE(
           (SELECT MAX(ride_date) FROM daily_ridership WHERE ride_date <= $1),
           (SELECT MAX(ride_date) FROM daily_ridership))`, [date]
      ),
      dbQuery(
        `SELECT COUNT(*) AS total_alerts,
                COUNT(*) FILTER (WHERE severity='CRITICAL') AS critical
         FROM crowding_alerts WHERE analysis_date = COALESCE(
           (SELECT MAX(analysis_date) FROM crowding_alerts WHERE analysis_date <= $1),
           (SELECT MAX(analysis_date) FROM crowding_alerts))`, [date]
      ),
      dbQuery(
        `SELECT COUNT(*) FILTER (WHERE priority='HIGH')   AS high,
                COUNT(*) FILTER (WHERE priority='MEDIUM') AS medium,
                COUNT(*)                                  AS total
         FROM route_gaps WHERE analysis_date = COALESCE(
           (SELECT MAX(analysis_date) FROM route_gaps WHERE analysis_date <= $1),
           (SELECT MAX(analysis_date) FROM route_gaps))`, [date]
      ),
      dbQuery(
        `SELECT COUNT(*) AS total,
                AVG(confidence)::numeric(4,2) AS avg_confidence
         FROM fleet_recommendations WHERE analysis_date = COALESCE(
           (SELECT MAX(analysis_date) FROM fleet_recommendations WHERE analysis_date <= $1),
           (SELECT MAX(analysis_date) FROM fleet_recommendations))`, [date]
      ),
    ]);


    res.json({
      date,
      ridership: ridership[0] || { total: 0, revenue: 0 },
      alerts:    alerts[0]    || { total_alerts: 0, critical: 0 },
      gaps:      gaps[0]      || { high: 0, medium: 0, total: 0 },
      fleet:     recs[0]      || { total: 0, avg_confidence: 0 },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Scheduled: Cache today's ridership every hour
// ─────────────────────────────────────────────────────────────
cron.schedule("0 * * * *", async () => {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[CRON] Refreshing ridership cache for ${today}`);
  ridershipCache.data = await fetchChennaiOneRidership(today);
  ridershipCache.date = today;
});

// ─────────────────────────────────────────────────────────────
// Serve SPA index for all non-API routes
// ─────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  if (!req.path.startsWith("/api")) {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  } else {
    res.status(404).json({ error: "API endpoint not found" });
  }
});

// ─────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║  Smart Transit Insights Dashboard         ║
  ║  http://localhost:${PORT}                    ║
  ║  PostgreSQL: ${process.env.DB_HOST || "localhost"}:5432              ║
  ╚═══════════════════════════════════════════╝
  `);
});

module.exports = app;
