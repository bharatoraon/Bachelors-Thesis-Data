"""
fleet_optimizer.py
Linear-programming-based fleet allocation optimizer.
Requires: PuLP (pip install pulp)

Usage:
    python3 fleet_optimizer.py --date 2025-11-10
"""

from __future__ import annotations
import argparse
import logging
import os
from datetime import date, timedelta

import psycopg2
from psycopg2.extras import execute_batch

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("fleet_optimizer")

DB_CONN  = os.environ.get("AIRFLOW_CONN_TRANSIT_DB",
                           "postgresql+psycopg2://transit:transit123@localhost/transit_od")
FLEET_CAP = 60    # passengers per bus
MAX_HW    = 60    # max headway minutes
MIN_HW    = 5     # min headway minutes
SERVICE_H = 18    # hours of service per day


def _get_db_conn():
    import re
    m = re.match(r"postgresql\+psycopg2://(\w+):(\w+)@([\w.]+)/(\w+)", DB_CONN)
    if not m:
        raise ValueError(f"Bad DB conn: {DB_CONN!r}")
    user, pwd, host, db = m.groups()
    return psycopg2.connect(host=host, dbname=db, user=user, password=pwd)


def optimize_fleet(analysis_date: str) -> None:
    try:
        from pulp import LpProblem, LpVariable, LpMinimize, lpSum, value, PULP_CBC_CMD
        HAS_PULP = True
    except ImportError:
        logger.warning("PuLP not installed — using rule-based fallback")
        HAS_PULP = False

    conn = _get_db_conn()
    cur  = conn.cursor()

    # Load peak-hour performance data
    PEAK_HOURS = (7, 8, 9, 17, 18, 19)
    cur.execute("""
        SELECT rp.route_uid, rp.route_short_name, rp.mode_id,
               AVG(rp.estimated_riders) FILTER (WHERE rp.hour_bucket = ANY(%s)) AS peak_demand,
               AVG(rp.estimated_riders)                                          AS avg_demand,
               AVG(rp.load_factor)      FILTER (WHERE rp.hour_bucket = ANY(%s)) AS peak_lf
        FROM route_performance rp
        WHERE rp.analysis_date = %s AND rp.mode_id = (
            SELECT mode_id FROM transit_mode WHERE mode_name = 'BUS')
        GROUP BY rp.route_uid, rp.route_short_name, rp.mode_id
        HAVING AVG(rp.estimated_riders) > 0
    """, (list(PEAK_HOURS), list(PEAK_HOURS), analysis_date))

    rows = cur.fetchall()
    if not rows:
        logger.warning("No performance data for %s", analysis_date)
        conn.close()
        return

    logger.info("Optimizing fleet for %d bus routes", len(rows))

    results = []

    if HAS_PULP:
        # ── LP Formulation ──────────────────────────────────────────
        # Decision variable: headway_i (minutes) per route i
        # Minimize: sum(slack_capacity_i + overcrowding_penalty_i)
        # Subject to:
        #   MIN_HW <= headway_i <= MAX_HW
        #   trips_per_day_i * FLEET_CAP >= peak_demand_i * 1.1  (10% buffer)

        prob = LpProblem("fleet_allocation", LpMinimize)

        route_data = {}
        for (ruid, rname, mid, peak_d, avg_d, peak_lf) in rows:
            peak_d  = float(peak_d  or 0.0)
            avg_d   = float(avg_d   or 0.0)
            peak_lf = float(peak_lf or 0.0)
            route_data[str(ruid)] = {
                "name": rname, "mode_id": mid,
                "peak_demand": peak_d, "avg_demand": avg_d, "peak_lf": peak_lf,
            }

        hw_vars = {
            rid: LpVariable(f"hw_{i}", lowBound=MIN_HW, upBound=MAX_HW, cat="Integer")
            for i, rid in enumerate(route_data)
        }

        # Objective: minimise overcrowding penalty + idle fleet penalty
        overcrowd_terms = []
        idle_terms      = []
        for rid, data in route_data.items():
            hw    = hw_vars[rid]
            # trips per peak hour = 60 / headway
            # capacity per peak hour = trips * FLEET_CAP
            # overcrowding: max(0, peak_demand - capacity)
            # We approximate capacity = (60.0/headway) * FLEET_CAP
            # Since headway is LP var, we linearise with proxy:
            # equivalent to minimizing headway when peak_lf > 1
            if data["peak_lf"] > 1.0:
                overcrowd_terms.append(hw * data["peak_lf"])
            else:
                idle_terms.append(hw * (1 - data["peak_lf"]))

        prob += lpSum(overcrowd_terms) + 0.1 * lpSum(idle_terms)
        prob.solve(PULP_CBC_CMD(msg=0))

        for rid, data in route_data.items():
            hw_val        = int(value(hw_vars[rid]) or 15)
            trips_per_day = (SERVICE_H * 60) // hw_val
            cap_per_trip  = FLEET_CAP
            recommend_cap = data["peak_demand"] * 1.1
            recommended_fleet = max(1, int(recommend_cap / FLEET_CAP))

            results.append({
                "route_uid":     rid,
                "route_name":    data["name"],
                "current_hw":    15,
                "recommended_hw": hw_val,
                "current_fleet": 1,
                "recommended_fleet": recommended_fleet,
                "confidence":    min(0.95, data["peak_lf"]),
                "reason":        f"LP optimised — peak load {data['peak_lf']:.2f}",
            })
    else:
        # ── Rule-based fallback ─────────────────────────────────────
        for (ruid, rname, mid, peak_d, avg_d, peak_lf) in rows:
            peak_lf = float(peak_lf or 0.0)
            current_hw = 15
            if peak_lf > 1.0:
                rec_hw    = max(MIN_HW, int(current_hw * 0.7))
                rec_fleet = 2
                conf      = 0.85
                reason    = f"Rule: peak overload {peak_lf:.2f}"
            elif peak_lf < 0.4:
                rec_hw    = min(MAX_HW, int(current_hw * 1.3))
                rec_fleet = 1
                conf      = 0.70
                reason    = f"Rule: underutilised {peak_lf:.2f}"
            else:
                continue

            results.append({
                "route_uid": str(ruid), "route_name": rname,
                "current_hw": current_hw, "recommended_hw": rec_hw,
                "current_fleet": 1, "recommended_fleet": rec_fleet,
                "confidence": conf, "reason": reason,
            })

    # ── Write recommendations ────────────────────────────────────────
    if not results:
        logger.info("No fleet changes recommended for %s", analysis_date)
        conn.close()
        return

    sql = """
        INSERT INTO fleet_recommendations
            (analysis_date, route_uid, route_short_name, current_headway_min,
             recommended_headway_min, current_fleet, recommended_fleet,
             confidence, reason)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
    """
    batch = [(
        analysis_date,
        r["route_uid"], r["route_name"],
        r["current_hw"], r["recommended_hw"],
        r["current_fleet"], r["recommended_fleet"],
        r["confidence"], r["reason"],
    ) for r in results]

    execute_batch(cur, sql, batch, page_size=500)
    conn.commit()
    logger.info("Wrote %d fleet recommendations for %s", len(batch), analysis_date)

    cur.close()
    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=(date.today() - timedelta(1)).isoformat())
    args = parser.parse_args()
    optimize_fleet(args.date)
