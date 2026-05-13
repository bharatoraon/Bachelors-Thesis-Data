import os
import csv
import psycopg2
from collections import defaultdict
from pathlib import Path

GTFS_PATHS = {
    "BUS": Path("/opt/airflow/data/bus_gtfs"),
    "METRO": Path("/opt/airflow/data/metro_gtfs"),
    "SUBURBAN": Path("/opt/airflow/data/suburban_gtfs"),
}

DB_CONN = "host=transit_postgres port=5432 dbname=transit_od user=transit password=transit123"

def main():
    conn = psycopg2.connect(DB_CONN)
    cur = conn.cursor()

    # 1. Add column if not exists
    cur.execute("ALTER TABLE stops_unified ADD COLUMN IF NOT EXISTS estimated_riders NUMERIC DEFAULT 0;")
    conn.commit()

    # 2. Get mode map
    cur.execute("SELECT mode_id, mode_name FROM transit_mode")
    mode_map = {name: mid for mid, name in cur.fetchall()}

    # 3. Get latest ridership total from API DB wrapper
    cur.execute("""
        SELECT vehicle_type, passenger_count
        FROM daily_ridership
        WHERE ride_date = (SELECT MAX(ride_date) FROM daily_ridership)
    """)
    daily_totals = {row[0]: row[1] for row in cur.fetchall()}
    
    # Map 'SUBWAY' to 'SUBURBAN' for fallback
    if 'SUBWAY' in daily_totals:
        daily_totals['SUBURBAN'] = daily_totals.get('SUBURBAN', 0) + daily_totals['SUBWAY']

    print(f"Latest Daily Passengers: {daily_totals}")

    # 4. Parse stop_times to calculate weights
    total_updates = 0
    
    for mode, path in GTFS_PATHS.items():
        if not path.exists():
            continue
            
        mode_id = mode_map[mode]
        stop_weights = defaultdict(int)
        
        st_file = path / "stop_times.txt"
        if not st_file.exists():
            print(f"Skipping {mode}: stop_times.txt not found")
            continue
            
        print(f"Parsing stop_times for {mode}...")
        with open(st_file, encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                stop_weights[row["stop_id"]] += 1
                
        total_weight = sum(stop_weights.values())
        if total_weight == 0:
            continue
            
        mode_passengers = float(daily_totals.get(mode, 10000)) # Fallback if missing
        multiplier = mode_passengers / total_weight
        
        # 5. Update DB
        batch = []
        for stop_id, weight in stop_weights.items():
            est_riders = round(weight * multiplier, 1)
            batch.append((est_riders, stop_id, mode_id))
            
        from psycopg2.extras import execute_batch
        execute_batch(cur, """
            UPDATE stops_unified SET estimated_riders = %s
            WHERE stop_id = %s AND mode_id = %s
        """, batch, page_size=1000)
        conn.commit()
        
        total_updates += len(batch)
        print(f"[{mode}] Updated {len(batch)} stops with proportionally scaled passenger volumes.")
        
    cur.close()
    conn.close()
    print(f"Successfully processed and updated {total_updates} stops based on GTFS schedules + API data!")

if __name__ == "__main__":
    main()
