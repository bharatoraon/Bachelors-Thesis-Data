"""
gtfs_ingest.py
Airflow DAG: Ingests all 3 GTFS feeds (Bus, Metro, Suburban) into PostgreSQL.
Schedule: Weekly on Sunday 00:00 UTC (GTFS rarely changes)
"""

from __future__ import annotations
import csv
import io
import logging
import os
from datetime import datetime, timedelta
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_batch
from airflow import DAG
from airflow.operators.python import PythonOperator

logger = logging.getLogger(__name__)

GTFS_PATHS = {
    "BUS":      Path(os.environ.get("GTFS_BUS_PATH",      "/opt/airflow/data/bus_gtfs")),
    "METRO":    Path(os.environ.get("GTFS_METRO_PATH",    "/opt/airflow/data/metro_gtfs")),
    "SUBURBAN": Path(os.environ.get("GTFS_SUBURBAN_PATH", "/opt/airflow/data/suburban_gtfs")),
}

DB_CONN = os.environ.get("AIRFLOW_CONN_TRANSIT_DB", "")

# Placeholder coordinate in MTC data — will be flagged invalid
PLACEHOLDER_LAT = 12.549663
PLACEHOLDER_LON = 80.143925
COORD_TOLERANCE = 0.0001

# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

def _get_db_conn():
    import re
    m = re.match(r"postgresql\+psycopg2://(\w+):(\w+)@([\w.]+)/(\w+)", DB_CONN)
    if not m:
        raise ValueError(f"Cannot parse DB conn: {DB_CONN!r}")
    user, pwd, host, db = m.groups()
    return psycopg2.connect(host=host, dbname=db, user=user, password=pwd)


def _read_gtfs_file(path: Path, filename: str) -> list[dict]:
    fp = path / filename
    if not fp.exists():
        logger.warning("GTFS file not found: %s", fp)
        return []
    with open(fp, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def _is_valid_coord(lat: float, lon: float) -> bool:
    return not (
        abs(lat - PLACEHOLDER_LAT) < COORD_TOLERANCE and
        abs(lon - PLACEHOLDER_LON) < COORD_TOLERANCE
    )


# ─────────────────────────────────────────────────────────────
# Task: Ingest Stops
# ─────────────────────────────────────────────────────────────

def ingest_stops(**_):
    conn = _get_db_conn()
    cur  = conn.cursor()

    # Get mode_id mapping
    cur.execute("SELECT mode_id, mode_name FROM transit_mode")
    mode_map = {row[1]: row[0] for row in cur.fetchall()}

    sql = """
        INSERT INTO stops_unified
            (stop_id, stop_code, stop_name, stop_lat, stop_lon, geom,
             mode_id, has_valid_coord)
        VALUES (%s, %s, %s, %s, %s,
                ST_SetSRID(ST_MakePoint(%s, %s), 4326),
                %s, %s)
        ON CONFLICT (stop_id, mode_id) DO UPDATE SET
            stop_name      = EXCLUDED.stop_name,
            stop_lat       = EXCLUDED.stop_lat,
            stop_lon       = EXCLUDED.stop_lon,
            geom           = EXCLUDED.geom,
            has_valid_coord= EXCLUDED.has_valid_coord;
    """

    total = 0
    for mode, gtfs_path in GTFS_PATHS.items():
        stops_file = "stops_clean.txt" if (gtfs_path / "stops_clean.txt").exists() else "stops.txt"
        rows = _read_gtfs_file(gtfs_path, stops_file)
        mode_id = mode_map[mode]
        batch = []

        for r in rows:
            try:
                lat = float(r.get("stop_lat", 0) or 0)
                lon = float(r.get("stop_lon", 0) or 0)
            except ValueError:
                lat, lon = 0.0, 0.0

            valid = _is_valid_coord(lat, lon) and lat != 0

            batch.append((
                r["stop_id"],
                r.get("stop_code", ""),
                r.get("stop_name", "UNKNOWN"),
                lat, lon, lon, lat,   # ST_MakePoint(lon, lat)
                mode_id,
                valid,
            ))

        execute_batch(cur, sql, batch, page_size=500)
        conn.commit()
        logger.info("Ingested %d stops for mode %s (valid coords: %d)",
                    len(batch), mode, sum(1 for b in batch if b[-1]))
        total += len(batch)

    cur.close()
    conn.close()
    logger.info("Total stops ingested: %d", total)


# ─────────────────────────────────────────────────────────────
# Task: Ingest Routes
# ─────────────────────────────────────────────────────────────

def ingest_routes(**_):
    conn = _get_db_conn()
    cur  = conn.cursor()

    cur.execute("SELECT mode_id, mode_name FROM transit_mode")
    mode_map = {row[1]: row[0] for row in cur.fetchall()}

    sql = """
        INSERT INTO routes (route_id, agency_id, route_short_name, route_long_name, route_type, mode_id)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (route_id, mode_id) DO UPDATE SET
            route_short_name = EXCLUDED.route_short_name,
            route_long_name  = EXCLUDED.route_long_name;
    """

    for mode, gtfs_path in GTFS_PATHS.items():
        rows  = _read_gtfs_file(gtfs_path, "routes.txt")
        mode_id = mode_map[mode]
        batch = [(
            r["route_id"],
            r.get("agency_id", ""),
            r.get("route_short_name", ""),
            r.get("route_long_name", ""),
            int(r.get("route_type", 3) or 3),
            mode_id,
        ) for r in rows]
        execute_batch(cur, sql, batch, page_size=500)
        conn.commit()
        logger.info("Ingested %d routes for mode %s", len(batch), mode)

    cur.close()
    conn.close()


# ─────────────────────────────────────────────────────────────
# Task: Ingest Trips (sample — full trip set per mode)
# ─────────────────────────────────────────────────────────────

def ingest_trips(**_):
    conn = _get_db_conn()
    cur  = conn.cursor()

    cur.execute("SELECT mode_id, mode_name FROM transit_mode")
    mode_map = {row[1]: row[0] for row in cur.fetchall()}

    # Build route_uid lookup
    cur.execute("SELECT route_id, route_uid, mode_id FROM routes")
    route_lookup = {(row[0], row[2]): row[1] for row in cur.fetchall()}

    sql = """
        INSERT INTO trips (trip_id, route_uid, service_id, direction_id, mode_id)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (trip_id, mode_id) DO NOTHING;
    """

    for mode, gtfs_path in GTFS_PATHS.items():
        rows    = _read_gtfs_file(gtfs_path, "trips.txt")
        mode_id = mode_map[mode]
        batch   = []

        for r in rows:
            route_uid = route_lookup.get((r["route_id"], mode_id))
            if not route_uid:
                continue
            batch.append((
                r["trip_id"],
                str(route_uid),
                r.get("service_id", ""),
                int(r.get("direction_id", 0) or 0),
                mode_id,
            ))

        execute_batch(cur, sql, batch, page_size=500)
        conn.commit()
        logger.info("Ingested %d trips for mode %s", len(batch), mode)

    cur.close()
    conn.close()


# ─────────────────────────────────────────────────────────────
# Task: Compute Route Performance Baseline
# ─────────────────────────────────────────────────────────────

def compute_route_baseline(**_):
    """Compute an estimated daily ridership per route using frequencies.txt."""
    conn = _get_db_conn()
    cur  = conn.cursor()

    cur.execute("SELECT mode_id, mode_name FROM transit_mode")
    mode_map = {row[1]: row[0] for row in cur.fetchall()}

    from datetime import timedelta as td

    # For bus mode, use frequencies.txt to estimate trips per day per route
    mode = "BUS"
    gtfs_path = GTFS_PATHS[mode]
    mode_id   = mode_map[mode]

    freqs = _read_gtfs_file(gtfs_path, "frequencies.txt")
    trips_data = _read_gtfs_file(gtfs_path, "trips.txt")
    trip_to_route = {r["trip_id"]: r["route_id"] for r in trips_data}

    # Aggregate headway per route
    from collections import defaultdict
    route_headways = defaultdict(list)
    for f in freqs:
        route_id = trip_to_route.get(f.get("trip_id", ""), "UNKNOWN")
        try:
            hw = int(f.get("headway_secs", 3600))
            route_headways[route_id].append(hw)
        except (ValueError, TypeError):
            pass

    # Estimate daily trips = (service_hours * 3600) / avg_headway
    # Assume 18 hr service day
    SERVICE_HOURS = 18
    AVG_OCCUPANCY = 30  # conservative avg passengers per bus for estimation

    sql = """
        INSERT INTO route_performance
            (analysis_date, route_uid, route_short_name, mode_id, hour_bucket,
             estimated_riders, fleet_capacity, load_factor, overcrowded)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (analysis_date, route_uid, hour_bucket) DO NOTHING;
    """

    from datetime import date as dt_date
    today = dt_date.today().isoformat()

    cur.execute("SELECT route_id, route_uid, route_short_name FROM routes WHERE mode_id = %s", (mode_id,))
    route_rows = cur.fetchall()

    batch = []
    for route_id, route_uid, short_name in route_rows:
        headways = route_headways.get(route_id, [3600])
        avg_hw   = sum(headways) / len(headways)
        daily_trips = (SERVICE_HOURS * 3600) / avg_hw
        for hour in range(5, 23):  # service hours 5am–11pm
            est_riders  = int(daily_trips / 18 * AVG_OCCUPANCY)
            load        = min(round(est_riders / 60.0, 3), 1.5)
            overcrowded = load > 1.0
            batch.append((today, str(route_uid), short_name, mode_id, hour,
                          est_riders, 60, load, overcrowded))

    execute_batch(cur, sql, batch, page_size=1000)
    conn.commit()
    logger.info("Computed baseline performance for %d route×hours", len(batch))

    cur.close()
    conn.close()


# ─────────────────────────────────────────────────────────────
# DAG Definition
# ─────────────────────────────────────────────────────────────

default_args = {
    "owner": "transit",
    "retries": 2,
    "retry_delay": timedelta(minutes=10),
}

with DAG(
    dag_id="gtfs_ingest",
    description="Ingest all 3 GTFS feeds (Bus/Metro/Suburban) into PostgreSQL",
    schedule_interval="@weekly",
    start_date=datetime(2025, 1, 1),
    catchup=False,
    default_args=default_args,
    tags=["transit", "gtfs", "ingestion"],
) as dag:

    t_stops   = PythonOperator(task_id="ingest_stops",             python_callable=ingest_stops)
    t_routes  = PythonOperator(task_id="ingest_routes",            python_callable=ingest_routes)
    t_trips   = PythonOperator(task_id="ingest_trips",             python_callable=ingest_trips)
    t_perf    = PythonOperator(task_id="compute_route_baseline",   python_callable=compute_route_baseline)

    t_stops >> t_routes >> t_trips >> t_perf
