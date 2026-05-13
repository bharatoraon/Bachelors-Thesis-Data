"""
daily_ridership_ingest.py
Airflow DAG: Fetches ChennaiOne FRFS daily ridership and loads into PostgreSQL.
Schedule: Daily at 02:00 IST
"""

from __future__ import annotations
import os
import logging
from datetime import datetime, timedelta

import requests
import psycopg2
from airflow import DAG
from airflow.operators.python import PythonOperator

logger = logging.getLogger(__name__)

API_URL  = os.environ.get("CHENNAI_ONE_API_URL",  "https://api.moving.tech/pilot/app/frfs/daily")
API_KEY  = os.environ.get("CHENNAI_ONE_API_KEY",  "1407d220-536a-48de-baf4-524c8347b487")
DB_CONN  = os.environ.get("AIRFLOW_CONN_TRANSIT_DB", "")


def _get_db_conn():
    """Parse Airflow connection string → psycopg2 connection."""
    import re
    m = re.match(r"postgresql\+psycopg2://(\w+):(\w+)@([\w.]+)/(\w+)", DB_CONN)
    if not m:
        raise ValueError(f"Cannot parse DB conn: {DB_CONN!r}")
    user, pwd, host, db = m.groups()
    return psycopg2.connect(host=host, dbname=db, user=user, password=pwd)


# ──────────────────────────────────────────────
# Task 1: Fetch from ChennaiOne API
# ──────────────────────────────────────────────
def fetch_ridership(ds: str, **_):
    """Fetch daily ridership for ds (YYYY-MM-DD)."""
    headers = {
        "accept": "application/json;charset=utf-8",
        "x-api-key": API_KEY,
    }
    url = f"{API_URL}?date={ds}"
    logger.info("Fetching ridership for %s from %s", ds, url)
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    logger.info("Received %d records", len(data))
    return data   # pushed to XCom


# ──────────────────────────────────────────────
# Task 2: Load into PostgreSQL
# ──────────────────────────────────────────────
def load_ridership(ds: str, ti, **_):
    """Insert records into daily_ridership with UPSERT."""
    records = ti.xcom_pull(task_ids="fetch_ridership")
    if not records:
        logger.warning("No records to load for %s", ds)
        return

    sql = """
        INSERT INTO daily_ridership
            (ride_date, vehicle_type, os_type, booking_count,
             passenger_count, new_registrations, total_revenue)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (ride_date, vehicle_type, os_type)
        DO UPDATE SET
            booking_count     = EXCLUDED.booking_count,
            passenger_count   = EXCLUDED.passenger_count,
            new_registrations = EXCLUDED.new_registrations,
            total_revenue     = EXCLUDED.total_revenue,
            fetched_at        = NOW();
    """

    conn = _get_db_conn()
    cur  = conn.cursor()
    rows = []
    for r in records:
        rows.append((
            r.get("date", ds),
            r.get("vehicleType"),
            r.get("osType"),
            r.get("bookingCount"),
            r.get("totalPassengerCount"),
            r.get("newRegistrations"),
            r.get("totalRevenue"),
        ))

    cur.executemany(sql, rows)
    conn.commit()
    cur.close()
    conn.close()
    logger.info("Loaded %d ridership records for %s", len(rows), ds)


# ──────────────────────────────────────────────
# Task 3: Trigger OD matrix rebuild
# ──────────────────────────────────────────────
def trigger_od_rebuild(ds: str, **_):
    """Signal that new data is available for OD matrix computation."""
    import subprocess
    script = "/opt/airflow/analysis/od_matrix_builder.py"
    if os.path.exists(script):
        subprocess.run(["python3", script, "--date", ds], check=True)
        logger.info("OD matrix rebuild triggered for %s", ds)
    else:
        logger.warning("OD matrix script not found at %s", script)


# ──────────────────────────────────────────────
# DAG Definition
# ──────────────────────────────────────────────
default_args = {
    "owner": "transit",
    "retries": 3,
    "retry_delay": timedelta(minutes=5),
    "email_on_failure": False,
}

with DAG(
    dag_id="daily_ridership_ingest",
    description="Fetch ChennaiOne FRFS ridership + load into PostgreSQL",
    schedule_interval="0 20 * * *",   # 20:00 UTC = 01:30 IST next day
    start_date=datetime(2025, 1, 1),
    catchup=True,
    max_active_runs=1,
    default_args=default_args,
    tags=["transit", "ingestion", "ridership"],
) as dag:

    t_fetch = PythonOperator(
        task_id="fetch_ridership",
        python_callable=fetch_ridership,
    )

    t_load = PythonOperator(
        task_id="load_ridership",
        python_callable=load_ridership,
    )

    t_od = PythonOperator(
        task_id="trigger_od_rebuild",
        python_callable=trigger_od_rebuild,
    )

    t_fetch >> t_load >> t_od
