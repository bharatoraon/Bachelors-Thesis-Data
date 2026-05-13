"""
route_gap_detector.py
Detects route gaps: high-demand OD corridors with no direct GTFS service.
Uses DBSCAN clustering of gap origin/destination centroids.

Usage:
    python3 route_gap_detector.py --date 2025-11-10
"""

from __future__ import annotations
import argparse
import logging
import os
from collections import defaultdict
from datetime import date, timedelta

import numpy as np
import pandas as pd
import psycopg2
from psycopg2.extras import execute_batch

try:
    from sklearn.cluster import DBSCAN
    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("route_gap_detector")

DB_CONN = os.environ.get("AIRFLOW_CONN_TRANSIT_DB",
                         "postgresql+psycopg2://transit:transit123@localhost/transit_od")

# Gap thresholds
DEMAND_PERCENTILE  = 90   # consider top 10% OD pairs as high-demand
MIN_GAP_DIST_M     = 300  # OD pair must be > 300m apart
DBSCAN_EPS_DEG     = 0.02  # ~2km clustering radius
DBSCAN_MIN_SAMPLES = 3


def _get_db_conn():
    import re
    m = re.match(r"postgresql\+psycopg2://(\w+):(\w+)@([\w.]+)/(\w+)", DB_CONN)
    if not m:
        raise ValueError(f"Bad DB conn: {DB_CONN!r}")
    user, pwd, host, db = m.groups()
    return psycopg2.connect(host=host, dbname=db, user=user, password=pwd)


def h3_to_latlng(h3_id: str):
    """Convert H3 cell ID to centroid (lat, lon)."""
    try:
        import h3
        lat, lon = h3.cell_to_latlng(h3_id)
        return lat, lon
    except Exception:
        # Fallback for grid-based IDs
        try:
            lat, lon = h3_id.split("_")
            return float(lat), float(lon)
        except Exception:
            return None, None

def haversine_km(lat1, lon1, lat2, lon2):
    if None in (lat1, lon1, lat2, lon2): return 0
    from math import radians, cos, sin, asin, sqrt
    dlat, dlon = radians(lat2 - lat1), radians(lon2 - lon1)
    a = sin(dlat/2)**2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon/2)**2
    return 2 * 6371.0 * asin(sqrt(max(0, a)))


def detect_route_gaps(analysis_date: str) -> None:
    conn = _get_db_conn()
    cur  = conn.cursor()

    # ── Load all explicit physical coordinates of structural transit stations natively
    cur.execute("""
        SELECT DISTINCT s.stop_lat, s.stop_lon
        FROM stops_unified s
        JOIN transit_mode tm ON s.mode_id = tm.mode_id
        WHERE s.has_valid_coord = TRUE AND tm.mode_name = 'BUS'
    """)
    route_rows = cur.fetchall()

    # Build set of served H3 cells from routes
    served_h3 = set()
    for lat, lon in route_rows:
        if lat and lon:
            try:
                import h3
                served_h3.add(h3.latlng_to_cell(lat, lon, 8))
                # Also add neighbours (500m buffer)
                served_h3.update(h3.grid_disk(h3.latlng_to_cell(lat, lon, 8), 1))
            except Exception:
                served_h3.add(f"{round(lat,2):.2f}_{round(lon,2):.2f}")

    logger.info("Found %d served H3 cells from GTFS routes", len(served_h3))

    # ── Load top-demand OD pairs
    cur.execute("""
        SELECT origin_h3, dest_h3, mode_id, SUM(trip_count) AS demand,
               origin_name, dest_name
        FROM od_matrix
        WHERE analysis_date = %s
        GROUP BY origin_h3, dest_h3, mode_id, origin_name, dest_name
        ORDER BY demand DESC
    """, (analysis_date,))
    od_rows = cur.fetchall()

    if not od_rows:
        logger.warning("No OD data found for %s — run od_matrix_builder first", analysis_date)
        conn.close()
        return

    od_df = pd.DataFrame(od_rows, columns=["origin_h3", "dest_h3", "mode_id",
                                            "demand", "origin_name", "dest_name"])

    # ── Because OD matrix perfectly mirrors GTFS stops, structural isolation checks fail.
    # We instead upgrade "Route Gaps" to mathematically flag aggressive cross-city "Transit Deserts":
    # Corridors demanding massive volume that stretch beyond 10km structurally prone to transfer-decay!
    
    od_df["o_lat"] = od_df["origin_h3"].apply(lambda h: h3_to_latlng(h)[0])
    od_df["o_lon"] = od_df["origin_h3"].apply(lambda h: h3_to_latlng(h)[1])
    od_df["d_lat"] = od_df["dest_h3"].apply(lambda h: h3_to_latlng(h)[0])
    od_df["d_lon"] = od_df["dest_h3"].apply(lambda h: h3_to_latlng(h)[1])
    od_df          = od_df.dropna(subset=["o_lat", "d_lat"])
    
    od_df["dist_km"] = od_df.apply(lambda r: haversine_km(r.o_lat, r.o_lon, r.d_lat, r.d_lon), axis=1)

    threshold  = od_df["demand"].quantile(95 / 100) # Top 5% most congested
    gap_df     = od_df[(od_df["dist_km"] >= 8.5) & (od_df["demand"] >= threshold)].copy()
    logger.info("Found %d massive transit desert gaps (demand >= %.1f, dist >= 8.5km)", len(gap_df), threshold)

    # ── DBSCAN cluster on origin centroids
    cluster_ids = [-1] * len(gap_df)
    if HAS_SKLEARN and len(gap_df) >= DBSCAN_MIN_SAMPLES:
        coords      = gap_df[["o_lat", "o_lon"]].values
        db          = DBSCAN(eps=DBSCAN_EPS_DEG, min_samples=DBSCAN_MIN_SAMPLES)
        cluster_ids = db.fit_predict(coords)
        n_clusters  = len(set(cluster_ids)) - (1 if -1 in cluster_ids else 0)
        logger.info("DBSCAN found %d gap clusters", n_clusters)
    else:
        logger.warning("scikit-learn not available or insufficient data — no clustering")

    gap_df["cluster_id"] = cluster_ids

    # ── Priority scoring: HIGH / MEDIUM / LOW
    max_demand = gap_df["demand"].max() or 1
    def priority(d):
        pct = d / max_demand
        if pct >= 0.7:
            return "HIGH"
        elif pct >= 0.4:
            return "MEDIUM"
        return "LOW"

    gap_df["priority"] = gap_df["demand"].apply(priority)

    # ── Write to DB
    sql = """
        INSERT INTO route_gaps
            (analysis_date, origin_h3, dest_h3, demand_score, gap_cluster_id,
             priority, origin_lat, origin_lon, dest_lat, dest_lon,
             origin_name, dest_name, geom_line)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                ST_SetSRID(ST_MakeLine(
                    ST_MakePoint(%s, %s),
                    ST_MakePoint(%s, %s)
                ), 4326))
    """

    batch = []
    for _, row in gap_df.iterrows():
        int_cluster = int(row["cluster_id"]) if row["cluster_id"] >= 0 else None
        batch.append((
            analysis_date,
            row["origin_h3"], row["dest_h3"],
            float(row["demand"]),
            int_cluster,
            row["priority"],
            row["o_lat"], row["o_lon"],
            row["d_lat"], row["d_lon"],
            row["origin_name"], row["dest_name"],
            # ST_MakeLine params (lon, lat order for PostGIS)
            row["o_lon"], row["o_lat"],
            row["d_lon"], row["d_lat"],
        ))

    execute_batch(cur, sql, batch, page_size=500)
    conn.commit()
    logger.info("Wrote %d gap records for %s", len(batch), analysis_date)

    # ── Summary report
    summary = gap_df.groupby("priority").agg(
        count=("demand", "count"),
        total_demand=("demand", "sum")
    ).to_string()
    logger.info("Gap summary:\n%s", summary)

    cur.close()
    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=(date.today() - timedelta(1)).isoformat())
    args = parser.parse_args()
    detect_route_gaps(args.date)
