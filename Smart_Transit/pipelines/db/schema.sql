-- ============================================================
-- Smart Transit Insights — PostgreSQL/PostGIS Schema
-- Requires: PostgreSQL 14+, PostGIS 3.x, H3 extension (optional)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────
-- 1. UNIFIED STOP CATALOG (all 3 modes)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transit_mode (
    mode_id     SERIAL PRIMARY KEY,
    mode_name   VARCHAR(20) UNIQUE NOT NULL  -- 'BUS', 'METRO', 'SUBURBAN'
);

INSERT INTO transit_mode (mode_name) VALUES ('BUS'), ('METRO'), ('SUBURBAN')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS stops_unified (
    stop_uid        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stop_id         VARCHAR(100) NOT NULL,
    stop_code       VARCHAR(50),
    stop_name       VARCHAR(255) NOT NULL,
    stop_lat        DOUBLE PRECISION,
    stop_lon        DOUBLE PRECISION,
    geom            GEOMETRY(Point, 4326),
    mode_id         INTEGER REFERENCES transit_mode(mode_id),
    has_valid_coord BOOLEAN DEFAULT FALSE,
    h3_res8         VARCHAR(20),   -- H3 hex ID at resolution 8
    h3_res7         VARCHAR(20),   -- H3 hex ID at resolution 7
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (stop_id, mode_id)
);

CREATE INDEX IF NOT EXISTS idx_stops_geom ON stops_unified USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_stops_mode ON stops_unified(mode_id);
CREATE INDEX IF NOT EXISTS idx_stops_h3 ON stops_unified(h3_res8);

-- ─────────────────────────────────────────────
-- 2. GTFS ROUTES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS routes (
    route_uid       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    route_id        VARCHAR(100) NOT NULL,
    agency_id       VARCHAR(50),
    route_short_name VARCHAR(50),
    route_long_name VARCHAR(500),
    route_type      INTEGER,
    mode_id         INTEGER REFERENCES transit_mode(mode_id),
    UNIQUE (route_id, mode_id)
);

-- ─────────────────────────────────────────────
-- 3. TRIPS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trips (
    trip_uid        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id         VARCHAR(200) NOT NULL,
    route_uid       UUID REFERENCES routes(route_uid),
    service_id      VARCHAR(100),
    direction_id    INTEGER,
    mode_id         INTEGER REFERENCES transit_mode(mode_id),
    UNIQUE (trip_id, mode_id)
);

-- ─────────────────────────────────────────────
-- 4. STOP TIMES (summary — not raw 121MB)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stop_times (
    id              BIGSERIAL PRIMARY KEY,
    trip_uid        UUID REFERENCES trips(trip_uid),
    stop_uid        UUID REFERENCES stops_unified(stop_uid),
    stop_sequence   INTEGER,
    arrival_time    VARCHAR(10),
    departure_time  VARCHAR(10),
    mode_id         INTEGER REFERENCES transit_mode(mode_id)
);

CREATE INDEX IF NOT EXISTS idx_st_trip ON stop_times(trip_uid);
CREATE INDEX IF NOT EXISTS idx_st_stop ON stop_times(stop_uid);

-- ─────────────────────────────────────────────
-- 5. DAILY RIDERSHIP (from ChennaiOne API)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_ridership (
    id                  BIGSERIAL PRIMARY KEY,
    ride_date           DATE NOT NULL,
    vehicle_type        VARCHAR(20) NOT NULL,   -- BUS, METRO, SUBWAY
    os_type             VARCHAR(10),            -- ANDROID, IOS, null
    booking_count       INTEGER,
    passenger_count     INTEGER,
    new_registrations   INTEGER,
    total_revenue       NUMERIC(12,2),
    fetched_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (ride_date, vehicle_type, os_type)
);

-- ─────────────────────────────────────────────
-- 6. OD MATRIX (H3-based)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS od_matrix (
    id              BIGSERIAL PRIMARY KEY,
    analysis_date   DATE NOT NULL,
    hour_bucket     INTEGER,          -- 0–23
    origin_h3       VARCHAR(20) NOT NULL,
    dest_h3         VARCHAR(20) NOT NULL,
    mode_id         INTEGER REFERENCES transit_mode(mode_id),
    trip_count      INTEGER DEFAULT 0,
    avg_duration_min NUMERIC(6,2),
    origin_name     VARCHAR(255),
    dest_name       VARCHAR(255),
    UNIQUE (analysis_date, hour_bucket, origin_h3, dest_h3, mode_id)
);

CREATE INDEX IF NOT EXISTS idx_od_origin ON od_matrix(origin_h3);
CREATE INDEX IF NOT EXISTS idx_od_dest ON od_matrix(dest_h3);
CREATE INDEX IF NOT EXISTS idx_od_date ON od_matrix(analysis_date);

-- ─────────────────────────────────────────────
-- 7. ROUTE PERFORMANCE (load factor)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS route_performance (
    id              BIGSERIAL PRIMARY KEY,
    analysis_date   DATE NOT NULL,
    route_uid       UUID REFERENCES routes(route_uid),
    route_short_name VARCHAR(50),
    mode_id         INTEGER REFERENCES transit_mode(mode_id),
    hour_bucket     INTEGER,
    estimated_riders INTEGER,
    fleet_capacity  INTEGER DEFAULT 60,   -- seats per bus
    load_factor     NUMERIC(5,3),          -- riders/capacity
    overcrowded     BOOLEAN DEFAULT FALSE,
    UNIQUE (analysis_date, route_uid, hour_bucket)
);

CREATE INDEX IF NOT EXISTS idx_rp_date ON route_performance(analysis_date);
CREATE INDEX IF NOT EXISTS idx_rp_route ON route_performance(route_uid);

-- ─────────────────────────────────────────────
-- 8. ROUTE GAP ANALYSIS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS route_gaps (
    id              BIGSERIAL PRIMARY KEY,
    analysis_date   DATE NOT NULL,
    origin_h3       VARCHAR(20) NOT NULL,
    dest_h3         VARCHAR(20) NOT NULL,
    demand_score    NUMERIC(8,2),
    gap_cluster_id  INTEGER,
    nearest_route   VARCHAR(100),
    dist_to_route_m NUMERIC(8,1),
    priority        VARCHAR(10),   -- 'HIGH', 'MEDIUM', 'LOW'
    origin_lat      DOUBLE PRECISION,
    origin_lon      DOUBLE PRECISION,
    dest_lat        DOUBLE PRECISION,
    dest_lon        DOUBLE PRECISION,
    geom_line       GEOMETRY(LineString, 4326)
);

CREATE INDEX IF NOT EXISTS idx_gaps_geom ON route_gaps USING GIST(geom_line);
CREATE INDEX IF NOT EXISTS idx_gaps_date ON route_gaps(analysis_date);

-- ─────────────────────────────────────────────
-- 9. TRANSFER FRICTION (extends TFI work)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transfer_friction (
    id              BIGSERIAL PRIMARY KEY,
    from_stop_uid   UUID REFERENCES stops_unified(stop_uid),
    to_stop_uid     UUID REFERENCES stops_unified(stop_uid),
    from_mode_id    INTEGER REFERENCES transit_mode(mode_id),
    to_mode_id      INTEGER REFERENCES transit_mode(mode_id),
    walk_dist_m     NUMERIC(7,1),
    avg_wait_min    NUMERIC(6,2),
    peak_wait_min   NUMERIC(6,2),
    offpeak_wait_min NUMERIC(6,2),
    tfi_score       NUMERIC(7,3),
    analysis_date   DATE NOT NULL
);

-- ─────────────────────────────────────────────
-- 10. CROWDING ALERTS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crowding_alerts (
    id              BIGSERIAL PRIMARY KEY,
    alert_time      TIMESTAMPTZ DEFAULT NOW(),
    analysis_date   DATE NOT NULL,
    route_uid       UUID REFERENCES routes(route_uid),
    route_short_name VARCHAR(50),
    mode_id         INTEGER REFERENCES transit_mode(mode_id),
    hour_bucket     INTEGER,
    load_factor     NUMERIC(5,3),
    severity        VARCHAR(10),    -- 'WARNING' (>80%), 'CRITICAL' (>100%)
    resolved        BOOLEAN DEFAULT FALSE
);

-- ─────────────────────────────────────────────
-- 11. FLEET RECOMMENDATIONS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_recommendations (
    id              BIGSERIAL PRIMARY KEY,
    generated_at    TIMESTAMPTZ DEFAULT NOW(),
    analysis_date   DATE NOT NULL,
    route_uid       UUID REFERENCES routes(route_uid),
    route_short_name VARCHAR(50),
    current_headway_min INTEGER,
    recommended_headway_min INTEGER,
    current_fleet   INTEGER,
    recommended_fleet INTEGER,
    confidence      NUMERIC(4,3),
    reason          TEXT
);

-- ─────────────────────────────────────────────
-- VIEWS
-- ─────────────────────────────────────────────

-- Daily summary by mode
CREATE OR REPLACE VIEW v_daily_ridership_summary AS
SELECT 
    ride_date,
    vehicle_type,
    SUM(booking_count)     AS total_bookings,
    SUM(passenger_count)   AS total_passengers,
    SUM(total_revenue)     AS total_revenue_inr,
    SUM(new_registrations) AS new_users
FROM daily_ridership
GROUP BY ride_date, vehicle_type
ORDER BY ride_date DESC, vehicle_type;

-- Top OD pairs
CREATE OR REPLACE VIEW v_top_od_pairs AS
SELECT
    analysis_date,
    origin_h3,
    dest_h3,
    mode_id,
    SUM(trip_count) AS daily_trips,
    origin_name,
    dest_name
FROM od_matrix
GROUP BY analysis_date, origin_h3, dest_h3, mode_id, origin_name, dest_name
ORDER BY daily_trips DESC;

-- Active alerts
CREATE OR REPLACE VIEW v_active_alerts AS
SELECT * FROM crowding_alerts
WHERE resolved = FALSE
ORDER BY alert_time DESC;
