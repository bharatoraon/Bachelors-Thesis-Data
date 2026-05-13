import os
import requests
import psycopg2
from datetime import datetime, timedelta

# Connect to the PostgreSQL database inside docker
conn = psycopg2.connect("host=transit_postgres port=5432 dbname=transit_od user=transit password=transit123")
cur = conn.cursor()

base_date = datetime.today() # Fetch relative to today's current date
days = 45 # Fetch 45 days of historical ridership data

print(f"Downloading ChennaiOne ridership data for the past {days} days...")
total_fetched = 0

for i in range(days):
    ds = (base_date - timedelta(days=i)).strftime('%Y-%m-%d')
    url = f"https://api.moving.tech/pilot/app/frfs/daily?date={ds}"
    headers = {"accept": "application/json", "x-api-key": "1407d220-536a-48de-baf4-524c8347b487"}
    
    try:
        resp = requests.get(url, headers=headers)
        if resp.status_code == 200:
            data = resp.json()
            for r in data:
                v_type = r.get("vehicleType")
                if v_type == 'SUBWAY':
                    v_type = 'SUBURBAN' # Align with dashboard constants
                
                sql = """
                    INSERT INTO daily_ridership
                        (ride_date, vehicle_type, os_type, booking_count,
                         passenger_count, new_registrations, total_revenue)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (ride_date, vehicle_type, os_type) 
                    DO UPDATE SET 
                        passenger_count = EXCLUDED.passenger_count,
                        total_revenue = EXCLUDED.total_revenue;
                """
                cur.execute(sql, (
                    r.get("date", ds), v_type, r.get("osType", "UNKNOWN"),
                    r.get("bookingCount", 0), r.get("totalPassengerCount", 0),
                    r.get("newRegistrations", 0), r.get("totalRevenue", 0)
                ))
            conn.commit()
            total_fetched += len(data)
            print(f"[{ds}] Inserted {len(data)} sub-records.")
        else:
            print(f"[{ds}] Failed to fetch: HTTP {resp.status_code}")
    except Exception as e:
        print(f"[{ds}] Error: {e}")

cur.close()
conn.close()
print(f"nSuccessfully downloaded and inserted {total_fetched} mode-level records into the database!")
