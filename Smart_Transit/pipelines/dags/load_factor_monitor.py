"""
load_factor_monitor.py
Airflow DAG: Daily computation of load factors and crowding alerts.
Schedule: Daily at 03:00 UTC
"""

from __future__ import annotations
import logging
import os
from datetime import datetime, timedelta

import psycopg2
from psycopg2.extras import execute_batch
from airflow import DAG
from airflow.operators.python import PythonOperator

logger = logging.getLogger(__name__)
DB_CONN = os.environ.get("AIRFLOW_CONN_TRANSIT_DB", "")


def _get_db_conn():
    import re
    m = re.match(r"postgresql\+psycopg2://(\w+):(\w+)@([\w.]+)/(\w+)", DB_CONN)
    if not m:
        raise ValueError(f"Cannot parse DB conn: {DB_CONN!r}")
    user, pwd, host, db = m.groups()
    return psycopg2.connect(host=host, dbname=db, user=user, password=pwd)


def compute_load_factors(ds: str, **_):
    """Scale yesterday's estimated riders by actual daily ridership ratio."""
    conn = _get_db_conn()
    cur  = conn.cursor()

    # Get actual ridership for the day vs baseline assumption
    cur.execute("""
        SELECT vehicle_type, SUM(passenger_count) AS actual
        FROM daily_ridership
        WHERE ride_date = %s
        GROUP BY vehicle_type
    """, (ds,))
    actuals = {row[0]: row[1] for row in cur.fetchall()}

    # Mode mapping: API uses BUS/METRO/SUBWAY, DB uses BUS/METRO/SUBURBAN
    mode_map_api = {"BUS": "BUS", "METRO": "METRO", "SUBWAY": "SUBURBAN"}

    # Get baseline estimated passengers
    cur.execute("""
        SELECT rp.route_uid, rp.route_short_name, rp.mode_id,
               rp.hour_bucket, rp.estimated_riders, rp.fleet_capacity,
               tm.mode_name
        FROM route_performance rp
        JOIN transit_mode tm ON tm.mode_id = rp.mode_id
        WHERE analysis_date = (
            SELECT MAX(analysis_date) FROM route_performance
        )
    """)
    rows = cur.fetchall()

    if not rows:
        logger.warning("No route performance baseline found")
        conn.close()
        return

    # Compute total baseline per mode
    from collections import defaultdict
    baseline_total = defaultdict(int)
    for _, _, _, _, est_riders, _, mode_name in rows:
        baseline_total[mode_name] += est_riders

    perf_sql = """
        INSERT INTO route_performance
            (analysis_date, route_uid, route_short_name, mode_id, hour_bucket,
             estimated_riders, fleet_capacity, load_factor, overcrowded)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (analysis_date, route_uid, hour_bucket) DO UPDATE SET
            estimated_riders = EXCLUDED.estimated_riders,
            load_factor      = EXCLUDED.load_factor,
            overcrowded      = EXCLUDED.overcrowded;
    """

    alert_sql = """
        INSERT INTO crowding_alerts
            (analysis_date, route_uid, route_short_name, mode_id, hour_bucket,
             load_factor, severity)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT DO NOTHING;
    """

    perf_batch  = []
    alert_batch = []

    for (route_uid, short_name, mode_id, hour, base_est, capacity, mode_name) in rows:
        # Scale rider estimate
        api_key  = next((k for k, v in mode_map_api.items() if v == mode_name), None)
        actual   = actuals.get(api_key or mode_name, 0)
        baseline = baseline_total.get(mode_name, 1)

        scale = (actual / baseline) if baseline > 0 else 1.0
        scaled_riders = int(base_est * scale)
        load = round(scaled_riders / max(capacity, 1), 3)
        overcrowded = load > 1.0

        perf_batch.append((ds, str(route_uid), short_name, mode_id, hour,
                           scaled_riders, capacity, load, overcrowded))

        if load >= 0.05:
            severity = "CRITICAL" if load >= 0.25 else "WARNING"
            alert_batch.append((ds, str(route_uid), short_name, mode_id,
                                 hour, load, severity))

    execute_batch(cur, perf_sql, perf_batch, page_size=1000)

    if alert_batch:
        execute_batch(cur, alert_sql, alert_batch, page_size=500)
        logger.info("Generated %d crowding alerts", len(alert_batch))

    conn.commit()
    cur.close()
    conn.close()
    logger.info("Load factor computed for %d route×hours on %s", len(perf_batch), ds)


def generate_fleet_recommendations(ds: str, **_):
    """
    Simple LP-free fleet recommendation:
    Routes with load_factor > 0.9 for peak hours → reduce headway by 20%.
    Routes with load_factor < 0.4 for all hours → increase headway by 25%.
    """
    conn = _get_db_conn()
    cur  = conn.cursor()

    PEAK_HOURS = {7, 8, 9, 17, 18, 19}

    cur.execute("""
        SELECT rp.route_uid, rp.route_short_name, rp.mode_id,
               AVG(rp.load_factor) FILTER (WHERE rp.hour_bucket = ANY(%s)) AS peak_lf,
               AVG(rp.load_factor)                                          AS all_lf
        FROM route_performance rp
        WHERE rp.analysis_date = %s
        GROUP BY rp.route_uid, rp.route_short_name, rp.mode_id
    """, (list(PEAK_HOURS), ds))

    rows = cur.fetchall()
    sql  = """
        INSERT INTO fleet_recommendations
            (analysis_date, route_uid, route_short_name, current_headway_min,
             recommended_headway_min, current_fleet, recommended_fleet,
             confidence, reason)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
    """

    batch = []
    for route_uid, short_name, mode_id, peak_lf, all_lf in rows:
        peak_lf = peak_lf or 0.0
        all_lf  = all_lf  or 0.0
        current_hw    = 15   # default baseline headway minutes
        current_fleet = 1

        if peak_lf > 0.75:
            rec_hw    = round(current_hw * 0.8)
            rec_fleet = 2
            reason    = f"Peak load factor {peak_lf:.2f} — reduce headway"
            conf      = min(0.95, peak_lf)
        elif all_lf < 0.40:
            rec_hw    = round(current_hw * 1.25)
            rec_fleet = 1
            reason    = f"Low overall load {all_lf:.2f} — increase headway"
            conf      = 0.70
        else:
            continue  # no change needed

        batch.append((ds, str(route_uid), short_name, current_hw, rec_hw,
                       current_fleet, rec_fleet, conf, reason))

    if batch:
        execute_batch(cur, sql, batch, page_size=500)
        conn.commit()
        logger.info("Generated %d fleet recommendations", len(batch))

    cur.close()
    conn.close()


# ─────────────────────────────────────────────────────────────
default_args = {
    "owner": "transit",
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
}

with DAG(
    dag_id="load_factor_monitor",
    description="Daily load factor computation + crowding alerts + fleet recommendations",
    schedule_interval="0 21 * * *",   # 21:00 UTC = 02:30 IST
    start_date=datetime(2025, 1, 1),
    catchup=True,
    max_active_runs=1,
    default_args=default_args,
    tags=["transit", "monitoring", "crowding"],
) as dag:

    t_load  = PythonOperator(task_id="compute_load_factors",        python_callable=compute_load_factors)
    t_fleet = PythonOperator(task_id="generate_fleet_recommendations", python_callable=generate_fleet_recommendations)

    t_load >> t_fleet
