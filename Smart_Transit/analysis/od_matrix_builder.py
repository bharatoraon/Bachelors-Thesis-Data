"""
od_matrix_builder.py
Builds Origin-Destination matrix from GTFS + ChennaiOne ridership data.

Since the ChennaiOne API gives AGGREGATE counts (not trip-level OD),
we use a gravity model approach:
  1. Load all stop sequences from GTFS
  2. Weight each OD pair by: route frequency × passenger demand × distance decay
  3. Scale the total so it matches the API's daily ridership count
  4. Store H3-aggregated OD matrix in PostgreSQL

Usage:
    python3 od_matrix_builder.py --date 2025-11-10
    python3 od_matrix_builder.py  # uses yesterday
"""

from __future__ import annotations
import argparse
import logging
import os
import sys
from collections import defaultdict
from datetime import date, timedelta
from math import exp
from pathlib import Path

import pandas as pd
import psycopg2
from psycopg2.extras import execute_batch

# H3 is optional — fallback to lat/lon binning if not installed
try:
    import h3
    HAS_H3 = True
except ImportError:
    HAS_H3 = False
    logging.warning("h3 not installed — using 0.01° grid bins instead")

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("od_matrix_builder")

# ── Config ────────────────────────────────────────────────────
DB_CONN  = os.environ.get("AIRFLOW_CONN_TRANSIT_DB",
                          "postgresql+psycopg2://transit:transit123@localhost/transit_od")
H3_RES   = 8      # ~460m hex diameter
DECAY_KM = 10.0   # gravity model distance decay (km)


def _get_db_conn():
    import re
    m = re.match(r"postgresql\+psycopg2://(\w+):(\w+)@([\w.]+)/(\w+)", DB_CONN)
    if not m:
        raise ValueError(f"Bad DB conn: {DB_CONN!r}")
    user, pwd, host, db = m.groups()
    return psycopg2.connect(host=host, dbname=db, user=user, password=pwd)


def coord_to_h3(lat: float, lon: float, res: int = H3_RES) -> str:
    if HAS_H3 and lat and lon:
        return h3.latlng_to_cell(lat, lon, res)
    # Fallback: round to 0.01°
    return f"{round(lat, 2):.2f}_{round(lon, 2):.2f}"


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    """Simple haversine distance in km."""
    from math import radians, cos, sin, asin, sqrt
    R = 6371.0
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat/2)**2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon/2)**2
    return 2 * R * asin(sqrt(max(0, a)))


def load_stops_from_db(cur) -> pd.DataFrame:
    cur.execute("""
        SELECT stop_uid, stop_id, stop_name, stop_lat, stop_lon,
               mode_id, has_valid_coord
        FROM stops_unified
        WHERE has_valid_coord = TRUE
        ORDER BY mode_id, stop_id
    """)
    cols = [d[0] for d in cur.description]
    return pd.DataFrame(cur.fetchall(), columns=cols)


def load_stop_sequences_from_csv(mode_name: str) -> pd.DataFrame:
    """Load stop sequences directly from massive raw GTFS flatfiles to bypass PostgreSQL limits."""
    paths = {
        "BUS": "/opt/airflow/data/bus_gtfs",
        "METRO": "/opt/airflow/data/metro_gtfs",
        "SUBURBAN": "/opt/airflow/data/suburban_gtfs",
    }
    base_dir = Path(paths.get(mode_name, ""))
    if not base_dir.exists():
        return pd.DataFrame()
        
    st_file = base_dir / "stop_times.txt"
    if not st_file.exists():
        return pd.DataFrame()
        
    logger.info(f"Loading raw stop_times.txt into memory for {mode_name}...")
    
    st_df = pd.read_csv(st_file, usecols=["trip_id", "stop_id", "stop_sequence", "departure_time"], dtype=str)
    st_df = st_df.rename(columns={"trip_id": "trip_uid"})
    
    # Because GTFS BUS contains >100,000 trips (which yields 100M+ OD combinations due to long routes),
    # we take a massive statistically significant sample to compute the spatial distribution matrix blazingly fast.
    unique_trips = st_df['trip_uid'].unique()
    max_trips = 10000 if mode_name == "BUS" else len(unique_trips)
    if len(unique_trips) > max_trips:
        import numpy as np
        sampled_trips = np.random.choice(unique_trips, max_trips, replace=False)
        st_df = st_df[st_df['trip_uid'].isin(sampled_trips)]
        logger.info(f"Sampled {max_trips} trips out of {len(unique_trips)} for OD gravity calculation.")
        
    return st_df


def build_od_matrix(analysis_date: str) -> None:
    conn = _get_db_conn()
    cur  = conn.cursor()

    # ── Load actual ridership counts from API data
    cur.execute("""
        SELECT vehicle_type, SUM(passenger_count)
        FROM daily_ridership
        WHERE ride_date = %s
        GROUP BY vehicle_type
    """, (analysis_date,))
    ridership = {row[0]: row[1] for row in cur.fetchall()}
    logger.info("Actual ridership for %s: %s", analysis_date, ridership)

    if not ridership:
        logger.warning("No ridership data for %s — cannot build OD matrix", analysis_date)
        conn.close()
        return

    # ── Load valid stops
    stops_df = load_stops_from_db(cur)
    if stops_df.empty:
        logger.error("No valid stops found in DB — run GTFS ingest first")
        conn.close()
        return

    stop_coords = stops_df.set_index("stop_uid")[["stop_lat", "stop_lon", "stop_name", "mode_id"]].to_dict("index")

    # ── Get mode IDs
    cur.execute("SELECT mode_id, mode_name FROM transit_mode")
    mode_map = {row[1]: row[0] for row in cur.fetchall()}
    api_mode_map = {"BUS": "BUS", "METRO": "METRO", "SUBWAY": "SUBURBAN"}

    od_counts = defaultdict(float)   # (origin_h3, dest_h3, mode_id, hour) → count

    for api_mode, db_mode in api_mode_map.items():
        mode_id     = mode_map.get(db_mode)
        total_pax   = ridership.get(api_mode, 0)
        if not mode_id or total_pax == 0:
            continue

        logger.info("Building OD for mode %s (mode_id=%d, pax=%d)", db_mode, mode_id, total_pax)

        # ── Load stop sequences natively for this mode
        seq_df = load_stop_sequences_from_csv(db_mode)
        if seq_df.empty:
            logger.warning("No stop times for mode %s — generating synthetic OD", db_mode)
            # Synthetic: use valid stops for this mode, random OD pairs
            mode_stops = stops_df[stops_df.mode_id == mode_id].sample(
                min(100, len(stops_df[stops_df.mode_id == mode_id]))
            )
            if len(mode_stops) < 2:
                continue
            pairs_per_stop = total_pax // max(1, len(mode_stops))
            for _, orig in mode_stops.iterrows():
                for _, dest in mode_stops.sample(min(5, len(mode_stops))).iterrows():
                    if orig.stop_uid == dest.stop_uid:
                        continue
                    o_h3 = coord_to_h3(orig.stop_lat, orig.stop_lon)
                    d_h3 = coord_to_h3(dest.stop_lat, dest.stop_lon)
                    od_counts[(o_h3, d_h3, mode_id, 8)] += pairs_per_stop / 5
            continue

        # ── Merge with stop coordinates using natural GTFS stop_id
        # We also need to match on mode_id to prevent distinct modes with colliding IDs from merging incorrectly
        seq_df = seq_df.merge(
            stops_df[stops_df.mode_id == mode_id][["stop_id", "stop_lat", "stop_lon", "stop_name"]],
            on="stop_id", how="left"
        ).dropna(subset=["stop_lat", "stop_lon"])

        # ── Parse hour from departure_time
        def parse_hour(t):
            try:
                return int(str(t).split(":")[0]) % 24
            except Exception:
                return 8

        seq_df["hour"] = seq_df["departure_time"].apply(parse_hour)

        # ── Build OD pairs: for each trip, pair first stop with each subsequent
        trip_groups = seq_df.groupby("trip_uid")
        raw_od = defaultdict(float)
        num_trips = 0

        for trip_id, group in trip_groups:
            group = group.sort_values("stop_sequence").reset_index(drop=True)
            if len(group) < 2:
                continue
            origin = group.iloc[0]
            hour   = int(origin["hour"])
            o_h3   = coord_to_h3(origin.stop_lat, origin.stop_lon)
            o_name = origin.get("stop_name", "")

            for _, row in group.iloc[1:].iterrows():
                d_h3   = coord_to_h3(row.stop_lat, row.stop_lon)
                if o_h3 == d_h3:
                    continue
                dist   = haversine_km(origin.stop_lat, origin.stop_lon,
                                      row.stop_lat,    row.stop_lon)
                weight = exp(-dist / DECAY_KM)
                raw_od[(o_h3, d_h3, mode_id, hour)] += weight
            num_trips += 1

        if num_trips == 0:
            continue

        # ── Scale to match actual ridership
        raw_total = sum(raw_od.values()) or 1.0
        scale = total_pax / raw_total

        for (o_h3, d_h3, m_id, hour), raw_count in raw_od.items():
            od_counts[(o_h3, d_h3, m_id, hour)] += raw_count * scale

        logger.info("Mode %s: generated %d OD pairs from %d trips (scale=%.2f)",
                    db_mode, len(raw_od), num_trips, scale)

    # ── Write to DB
    if not od_counts:
        logger.error("No OD data generated")
        conn.close()
        return

    # Build stop name lookup from h3
    h3_name_cache = {}
    for uid, info in stop_coords.items():
        h3c = coord_to_h3(info["stop_lat"], info["stop_lon"])
        if h3c not in h3_name_cache:
            h3_name_cache[h3c] = info["stop_name"]

    sql = """
        INSERT INTO od_matrix
            (analysis_date, hour_bucket, origin_h3, dest_h3, mode_id,
             trip_count, origin_name, dest_name)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (analysis_date, hour_bucket, origin_h3, dest_h3, mode_id)
        DO UPDATE SET trip_count = EXCLUDED.trip_count;
    """

    batch = []
    for (o_h3, d_h3, m_id, hour), count in od_counts.items():
        if count < 1:
            continue
        batch.append((
            analysis_date, hour, o_h3, d_h3, m_id,
            int(count),
            h3_name_cache.get(o_h3, ""),
            h3_name_cache.get(d_h3, ""),
        ))

    execute_batch(cur, sql, batch, page_size=1000)
    conn.commit()
    logger.info("Wrote %d OD matrix entries for %s", len(batch), analysis_date)

    cur.close()
    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=(date.today() - timedelta(1)).isoformat())
    args = parser.parse_args()
    build_od_matrix(args.date)
