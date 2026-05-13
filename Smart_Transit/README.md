# Smart Transit Insights — OD Analytics Platform

> **Origin-Destination analytics for Chennai's multimodal transit network.**
> Bus (MTC/CUMTA) · Metro (CMRL) · Suburban Rail (Southern Railway)

## Quick Start

### Prerequisites
- **Docker Desktop** (for PostgreSQL + Airflow)
- **Node.js ≥ 18** (already at `/usr/local/bin/node`)
- **Python 3.9+** (`/usr/bin/python3`)

### 1. Start the full stack with Docker
```bash
# From /Volumes/Sandisk SSD/Smart_Transit/
docker compose up -d

# Wait for postgres to be healthy (~30s), then:
docker exec transit_postgres psql -U transit -d transit_od -f /docker-entrypoint-initdb.d/01_schema.sql
```

### 2. Run GTFS ingestion (once Docker is running)
```bash
# Trigger from Airflow UI at http://localhost:8080 (admin/admin123)
# Or run directly:
pip3 install -r pipelines/requirements.txt
AIRFLOW_CONN_TRANSIT_DB="postgresql+psycopg2://transit:transit123@localhost/transit_od" \
  python3 pipelines/dags/gtfs_ingest.py  # (as a script via __main__)
```

### 3. Start the Node.js dashboard (standalone, no Docker needed)
```bash
cd dashboard
npm install
node server.js        # Dashboard at http://localhost:3000
```
The dashboard works immediately with **demo data** when the DB is offline. It upgrades to live data automatically when PostgreSQL is connected.

---

## Project Structure

```
Smart_Transit/
├── Data/                        ← GTFS feeds + GeoJSON boundaries
│   ├── bus_gtfs/                ← MTC Bus: 4,031 routes, 7,130 stops
│   ├── metro_gtfs/              ← CMRL: Blue + Green lines
│   ├── suburban_gtfs/           ← Southern Railway corridors
│   └── Demographics & Boundary/ ← Ward polygons, population data
│
├── pipelines/
│   ├── dags/
│   │   ├── daily_ridership_ingest.py   ← ChennaiOne API → PostgreSQL (daily)
│   │   ├── gtfs_ingest.py              ← GTFS 3-mode ingest (weekly)
│   │   └── load_factor_monitor.py      ← Load factors + crowding alerts (daily)
│   ├── db/
│   │   └── schema.sql                  ← Full PostGIS schema (11 tables + views)
│   └── requirements.txt
│
├── analysis/
│   ├── od_matrix_builder.py     ← Gravity-model OD matrix (H3 res-8)
│   ├── route_gap_detector.py    ← DBSCAN gap clustering
│   └── fleet_optimizer.py       ← PuLP LP fleet allocation
│
├── dashboard/
│   ├── server.js                ← Express REST API (9 endpoints)
│   ├── package.json
│   └── public/
│       ├── index.html           ← SPA shell (6 views)
│       ├── css/style.css        ← Dark glassmorphism design system
│       └── js/app.js            ← Chart.js + MapLibre frontend
│
└── docker-compose.yml           ← PostgreSQL · Redis · Airflow · Dashboard
```

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | DB connection status |
| GET | `/api/ridership/daily?date=` | ChennaiOne FRFS ridership |
| GET | `/api/ridership/trend?days=` | N-day trend (all modes) |
| GET | `/api/od/matrix?date=&mode=` | H3 OD matrix for map |
| GET | `/api/routes/performance?date=` | Route load factors |
| GET | `/api/routes/hourly?routeId=` | Hourly profile per route |
| GET | `/api/gaps?date=&priority=` | Route gap GeoJSON |
| GET | `/api/alerts?date=&severity=` | Crowding alerts |
| GET | `/api/fleet/recommendations?date=` | LP fleet suggestions |
| GET | `/api/summary?date=` | KPI summary for dashboard cards |

---

## Data Pipeline Architecture

```
ChennaiOne API (daily agg. counts)
    │ bookingCount, passengerCount, totalRevenue per mode
    ▼
Airflow DAG: daily_ridership_ingest.py
    │ k-anonymity applied, upserted into daily_ridership table
    ▼
od_matrix_builder.py (gravity model)
    │ Weights = route_frequency × exp(-distance/10km)
    │ Scaled to match actual API ridership count
    ▼
od_matrix table (H3 resolution 8 hexagons, ~460m)
    │
    ├─→ route_gap_detector.py → route_gaps table (DBSCAN clusters)
    └─→ load_factor_monitor.py → crowding_alerts + fleet_recommendations
```

---

## Deliverable Mapping

| # | Deliverable | Status | Key Files |
|---|---|---|---|
| A | Data Pipelines + Anonymization | ✅ Built | `pipelines/dags/` |
| B | OD Modelling + Route Gap Detection | ✅ Built | `analysis/od_matrix_builder.py`, `route_gap_detector.py` |
| C | Fleet + Schedule Decision Tools | ✅ Built | `analysis/fleet_optimizer.py` |
| D | Overcrowding Monitoring + Dashboard | ✅ Built | `dashboard/`, `load_factor_monitor.py` |

---

## Notes on ChennaiOne API

The API (`/pilot/app/frfs/daily`) returns **aggregate** daily counts per mode:
```json
[
  { "vehicleType": "BUS",    "bookingCount": 26930, "totalPassengerCount": 29705 },
  { "vehicleType": "METRO",  "bookingCount": 2171,  "totalPassengerCount": 2557  },
  { "vehicleType": "SUBWAY", "bookingCount": 3261,  "totalPassengerCount": 3820  }
]
```
There is no stop-level OD data. The OD matrix uses a **gravity model** seeded from GTFS stop sequences and scaled to match these counts.

## Success Metrics

| Metric | Tool | Status |
|---|---|---|
| Bus load balancing | Fleet Optimizer (LP) | ✅ |
| Planning cycle speed | Route Gap Report | ✅ |
| Overcrowding detection | Load Factor Monitor DAG | ✅ |
| OD corridor identification | H3 OD Matrix + Desire Lines | ✅ |
