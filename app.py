from pathlib import Path
import sqlite3
import json
import math
import os
from datetime import datetime, timezone

import geopandas as gpd
import pandas as pd
from flask import Flask, jsonify, render_template, request, session
from shapely.geometry import Point
from werkzeug.security import generate_password_hash, check_password_hash


# =========================================================
# FLASK APPLICATION CONFIGURATION
# =========================================================

app = Flask(__name__)

# Local academic prototype. Configure a secure environment variable
# before deploying this application beyond your local computer.
app.secret_key = os.environ.get(
    "ABHAYASETU_SECRET_KEY",
    "local-demo-change-this-secret"
)

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax"
)


# =========================================================
# PROJECT CONFIGURATION
# =========================================================

PROJECT_DIR = Path(__file__).resolve().parent
DATA_DIR = PROJECT_DIR / "Datasets" / "Bengaluru_Study_Area"

BOUNDARY_FILE = DATA_DIR / "bengaluru_urban_boundary.geojson"

GRID_FILE = DATA_DIR / "bengaluru_grid_infrastructure.geojson"

ACCESSIBILITY_FILE = (
    DATA_DIR / "bengaluru_grid_accessibility_review.csv"
)

DATABASE_FILE = (
    Path(__file__).resolve().parent / "abhayasetu.db"
)


# =========================================================
# DATABASE FUNCTIONS
# =========================================================

def get_db_connection():
    """Create a SQLite database connection."""

    connection = sqlite3.connect(DATABASE_FILE)
    connection.row_factory = sqlite3.Row

    return connection


def initialize_database():
    """Create required database tables and migrate older databases."""

    with get_db_connection() as connection:

        connection.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)

        connection.execute("""
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                event_type TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                latitude REAL,
                longitude REAL,
                radius_m REAL,
                mode TEXT NOT NULL,
                description TEXT
            )
        """)

        connection.execute("""
            CREATE INDEX IF NOT EXISTS idx_events_timestamp
            ON events(timestamp)
        """)

        connection.execute("""
            CREATE TABLE IF NOT EXISTS trusted_contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT NOT NULL DEFAULT '',
                email TEXT NOT NULL DEFAULT '',
                consent_confirmed INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
        """)

        connection.execute("""
            CREATE TABLE IF NOT EXISTS sos_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                timestamp TEXT NOT NULL,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                accuracy_m REAL,
                message TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'RECORDED_LOCAL_ONLY',
                contacts_snapshot TEXT NOT NULL DEFAULT '[]'
            )
        """)

        connection.execute("""
            CREATE TABLE IF NOT EXISTS notification_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sos_id INTEGER NOT NULL,
                contact_name TEXT NOT NULL,
                channel TEXT NOT NULL,
                destination TEXT NOT NULL,
                status TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )
        """)

        # Migrate databases created by earlier prototype versions.
        for table in ("events", "trusted_contacts", "sos_requests"):

            columns = {
                row["name"]
                for row in connection.execute(
                    f"PRAGMA table_info({table})"
                ).fetchall()
            }

            if "user_id" not in columns:
                connection.execute(
                    f"ALTER TABLE {table} ADD COLUMN user_id INTEGER"
                )

        connection.commit()

    print(f"SQLite database ready: {DATABASE_FILE}")


# =========================================================
# LOAD AND VALIDATE GIS DATA
# =========================================================

print("Loading AbhayaSetu GIS data...")


# ---------------------------------------------------------
# STEP 1: Check required files
# ---------------------------------------------------------

if not BOUNDARY_FILE.exists():
    raise FileNotFoundError(
        f"Bengaluru boundary file not found: {BOUNDARY_FILE}"
    )

if not GRID_FILE.exists():
    raise FileNotFoundError(
        f"Infrastructure grid file not found: {GRID_FILE}"
    )

if not ACCESSIBILITY_FILE.exists():
    raise FileNotFoundError(
        f"Accessibility dataset not found: {ACCESSIBILITY_FILE}"
    )


# ---------------------------------------------------------
# STEP 2: Load boundary and infrastructure grid
# ---------------------------------------------------------

boundary = gpd.read_file(
    BOUNDARY_FILE
).to_crs("EPSG:4326")

grid = gpd.read_file(
    GRID_FILE
).to_crs("EPSG:4326")

print(f"Boundary features loaded: {len(boundary)}")
print(f"Grid cells loaded: {len(grid)}")


# ---------------------------------------------------------
# STEP 3: Load accessibility measurements
# ---------------------------------------------------------

print("Loading accessibility review data...")

accessibility_data = pd.read_csv(ACCESSIBILITY_FILE)

print(
    f"Accessibility records loaded: {len(accessibility_data)}"
)


# ---------------------------------------------------------
# STEP 4: Validate required columns
# ---------------------------------------------------------

if "grid_id" not in grid.columns:
    raise ValueError(
        "The infrastructure grid does not contain a grid_id column."
    )

if "grid_id" not in accessibility_data.columns:
    raise ValueError(
        "The accessibility CSV does not contain a grid_id column."
    )


# ---------------------------------------------------------
# STEP 5: Validate grid IDs
# ---------------------------------------------------------

if grid["grid_id"].isna().any():
    raise ValueError(
        "Missing grid IDs found in the infrastructure grid."
    )

if accessibility_data["grid_id"].isna().any():
    raise ValueError(
        "Missing grid IDs found in the accessibility dataset."
    )

# Use consistent data types before comparison and merging.
grid["grid_id"] = grid["grid_id"].astype(str)

accessibility_data["grid_id"] = (
    accessibility_data["grid_id"].astype(str)
)

if grid["grid_id"].duplicated().any():
    raise ValueError(
        "Duplicate grid IDs found in the infrastructure grid."
    )

if accessibility_data["grid_id"].duplicated().any():
    raise ValueError(
        "Duplicate grid IDs found in the accessibility dataset."
    )

grid_ids = set(grid["grid_id"])

accessibility_ids = set(
    accessibility_data["grid_id"]
)

if grid_ids != accessibility_ids:

    missing_from_csv = grid_ids - accessibility_ids
    missing_from_grid = accessibility_ids - grid_ids

    raise ValueError(
        "Infrastructure grid IDs do not match accessibility dataset IDs. "
        f"Missing from CSV: {len(missing_from_csv)}; "
        f"missing from grid: {len(missing_from_grid)}."
    )

print("Accessibility grid IDs validated successfully.")


# ---------------------------------------------------------
# STEP 6: Select accessibility measurements
# ---------------------------------------------------------

accessibility_columns = [
    "nearest_police_geometry_distance_m",
    "nearest_police_distance_m",
    "nearest_hospital_distance_m",
    "nearest_bus_stop_distance_m",
    "police_over_3km",
    "hospital_over_3km",
    "bus_stop_over_1km",
    "low_road_density_review",
    "number_of_accessibility_review_flags",
    "multiple_review_flags",
]

# Only use columns that actually exist in the CSV.
available_columns = [
    column
    for column in accessibility_columns
    if column in accessibility_data.columns
]

if not available_columns:
    raise ValueError(
        "No expected accessibility measurement columns "
        "were found in the accessibility CSV."
    )

# Avoid duplicating columns that already exist in the grid.
columns_to_add = [
    column
    for column in available_columns
    if column not in grid.columns
]

print("Integrating accessibility measurements into grid...")


# ---------------------------------------------------------
# STEP 7: Merge the measurements into the grid
# ---------------------------------------------------------

original_grid_count = len(grid)

grid = grid.merge(
    accessibility_data[["grid_id"] + columns_to_add],
    on="grid_id",
    how="left",
    validate="one_to_one"
)

# Ensure that the merge has not changed the number of cells.
if len(grid) != original_grid_count:
    raise ValueError(
        "Grid cell count changed after accessibility integration."
    )

# Confirm that the newly added columns matched every grid cell.
if columns_to_add and grid[columns_to_add].isna().any().any():
    raise ValueError(
        "Some accessibility measurements are missing after merging."
    )

print(
    "Accessibility measurements integrated: "
    f"{len(columns_to_add)} columns"
)

print(f"Grid cells after integration: {len(grid)}")


# ---------------------------------------------------------
# STEP 8: Load facility datasets
# ---------------------------------------------------------

FACILITY_FILES = {
    "police": DATA_DIR / "bengaluru_urban_police.geojson",
    "hospitals": DATA_DIR / "bengaluru_urban_hospitals.geojson",
    "bus_stops": DATA_DIR / "bengaluru_urban_bus_stops.geojson",
}

facility_layers = {}
facility_load_errors = {}

for category, file_path in FACILITY_FILES.items():

    try:

        if not file_path.exists():
            raise FileNotFoundError(str(file_path))

        layer = gpd.read_file(file_path)

        if layer.crs is not None:
            layer = layer.to_crs("EPSG:4326")
        else:
            # These project GeoJSON datasets are expected to use WGS84.
            layer = layer.set_crs("EPSG:4326")

        facility_layers[category] = layer

        print(
            f"{category} facility features loaded: {len(layer)}"
        )

    except Exception as exc:

        facility_layers[category] = None
        facility_load_errors[category] = str(exc)

        print(
            f"Warning: could not load {category} facilities: {exc}"
        )


# ---------------------------------------------------------
# STEP 9: Build spatial indexes
# ---------------------------------------------------------

boundary.sindex
grid.sindex


# ---------------------------------------------------------
# STEP 10: Initialize the database
# ---------------------------------------------------------

initialize_database()

print("AbhayaSetu GIS data loaded successfully!")


# =========================================================
# HELPER FUNCTIONS
# =========================================================

def json_value(value):
    """Convert values to JSON-compatible Python values."""

    if value is None:
        return None

    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass

    if hasattr(value, "item"):
        value = value.item()

    return value


def find_grid_cell(latitude, longitude):
    """Find the grid cell containing a given coordinate."""

    point = Point(longitude, latitude)

    # Check whether the point is inside the study-area boundary.
    if not boundary.geometry.covers(point).any():
        return None, "outside"

    # Find candidate grid cells using the spatial index.
    positions = grid.sindex.query(
        point,
        predicate="intersects"
    )

    candidates = grid.iloc[positions]

    # Select cells that cover the point.
    matches = candidates[
        candidates.geometry.covers(point)
    ]

    if matches.empty:
        return None, "no_grid"

    # Deterministic handling of shared grid boundaries.
    if "grid_position" in matches.columns:
        matches = matches.sort_values("grid_position")

    return matches.iloc[0], "success"


def serialize_cell(cell, latitude, longitude):
    """Serialize all non-geometry attributes of a grid cell."""

    data = {}

    for column in grid.columns:

        if column == "geometry":
            continue

        data[column] = json_value(cell[column])

    data["selected_latitude"] = latitude
    data["selected_longitude"] = longitude

    return data


def valid_coordinates(latitude, longitude):
    """Check whether coordinates are within valid geographic ranges."""

    return (
        math.isfinite(latitude)
        and math.isfinite(longitude)
        and -90 <= latitude <= 90
        and -180 <= longitude <= 180
    )


def current_user_id():
    """Return the authenticated user's ID, if available."""

    return session.get("user_id")


# =========================================================
# WEB PAGE AND AUTHENTICATION
# =========================================================

@app.route("/")
def home():
    return render_template("index.html")


@app.before_request
def require_login_for_private_api():
    """Require login for private APIs while keeping reference GIS APIs public."""

    public_api = {
        "/api/auth/register",
        "/api/auth/login",
        "/api/auth/me",
        "/api/auth/logout",
        "/api/assess",
        "/api/boundary",
        "/api/grid-cell",
    }

    if (
        request.path.startswith("/api/")
        and request.path not in public_api
        and current_user_id() is None
    ):
        return jsonify({
            "success": False,
            "message": "Please log in to access your account data."
        }), 401


# ---------------------------------------------------------
# REGISTER
# ---------------------------------------------------------

@app.route("/api/auth/register", methods=["POST"])
def register_api():

    data = request.get_json(silent=True) or {}

    name = str(data.get("name", "")).strip()[:100]
    email = str(data.get("email", "")).strip().lower()[:160]
    password = str(data.get("password", ""))

    if len(name) < 2 or "@" not in email or len(password) < 8:
        return jsonify({
            "success": False,
            "message": (
                "Enter your name, a valid email, and a password "
                "with at least 8 characters."
            )
        }), 400

    try:

        with get_db_connection() as connection:

            cur = connection.execute(
                """
                INSERT INTO users(
                    name,
                    email,
                    password_hash,
                    created_at
                )
                VALUES (?, ?, ?, ?)
                """,
                (
                    name,
                    email,
                    generate_password_hash(password),
                    datetime.now(timezone.utc).isoformat()
                )
            )

            user_id = cur.lastrowid

    except sqlite3.IntegrityError:

        return jsonify({
            "success": False,
            "message": (
                "An account with this email already exists. "
                "Please log in."
            )
        }), 409

    session.clear()
    session["user_id"] = user_id
    session["user_name"] = name

    return jsonify({
        "success": True,
        "user": {
            "id": user_id,
            "name": name,
            "email": email
        }
    }), 201


# ---------------------------------------------------------
# LOGIN
# ---------------------------------------------------------

@app.route("/api/auth/login", methods=["POST"])
def login_api():

    data = request.get_json(silent=True) or {}

    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))

    with get_db_connection() as connection:

        user = connection.execute(
            """
            SELECT id, name, email, password_hash
            FROM users
            WHERE email = ? COLLATE NOCASE
            """,
            (email,)
        ).fetchone()

    if not user or not check_password_hash(
        user["password_hash"],
        password
    ):
        return jsonify({
            "success": False,
            "message": "Email or password is incorrect."
        }), 401

    session.clear()
    session["user_id"] = user["id"]
    session["user_name"] = user["name"]

    return jsonify({
        "success": True,
        "user": {
            "id": user["id"],
            "name": user["name"],
            "email": user["email"]
        }
    })


# ---------------------------------------------------------
# CURRENT LOGIN STATUS
# ---------------------------------------------------------

@app.route("/api/auth/me", methods=["GET"])
def auth_me_api():

    if current_user_id() is None:
        return jsonify({
            "success": True,
            "authenticated": False
        })

    with get_db_connection() as connection:

        user = connection.execute(
            """
            SELECT id, name, email
            FROM users
            WHERE id = ?
            """,
            (current_user_id(),)
        ).fetchone()

    if not user:
        session.clear()

        return jsonify({
            "success": True,
            "authenticated": False
        })

    return jsonify({
        "success": True,
        "authenticated": True,
        "user": dict(user)
    })


# ---------------------------------------------------------
# LOGOUT
# ---------------------------------------------------------

@app.route("/api/auth/logout", methods=["POST"])
def logout_api():

    session.clear()

    return jsonify({
        "success": True,
        "message": "Logged out."
    })


# =========================================================
# API: ASSESS A LOCATION
# =========================================================

@app.route("/api/assess", methods=["GET"])
def assess_location():

    try:
        latitude = float(request.args.get("lat", ""))
        longitude = float(request.args.get("lon", ""))

    except (TypeError, ValueError):

        return jsonify({
            "success": False,
            "message": "Please provide valid latitude and longitude."
        }), 400

    if not valid_coordinates(latitude, longitude):

        return jsonify({
            "success": False,
            "message": (
                "Latitude or longitude is outside its valid range."
            )
        }), 400

    cell, status = find_grid_cell(latitude, longitude)

    if status == "outside":

        return jsonify({
            "success": False,
            "message": (
                "This location is outside the Bengaluru Urban study area."
            )
        }), 404

    if status == "no_grid":

        return jsonify({
            "success": False,
            "message": "No matching infrastructure grid cell was found."
        }), 404

    # serialize_cell now includes the accessibility columns
    # that were merged into the grid during application startup.
    return jsonify({
        "success": True,
        "message": "Location assessment retrieved successfully.",
        "assessment": serialize_cell(
            cell,
            latitude,
            longitude
        )
    })


# =========================================================
# API: GET STUDY-AREA BOUNDARY
# =========================================================

@app.route("/api/boundary", methods=["GET"])
def get_boundary():

    return jsonify(boundary.__geo_interface__)


# =========================================================
# API: GET ONE GRID CELL'S GEOMETRY
# =========================================================

@app.route("/api/grid-cell", methods=["GET"])
def get_grid_cell():

    try:
        latitude = float(request.args.get("lat", ""))
        longitude = float(request.args.get("lon", ""))

    except (TypeError, ValueError):

        return jsonify({
            "success": False,
            "message": "Please provide valid latitude and longitude."
        }), 400

    if not valid_coordinates(latitude, longitude):

        return jsonify({
            "success": False,
            "message": "Coordinates are outside valid ranges."
        }), 400

    cell, status = find_grid_cell(latitude, longitude)

    if cell is None:

        message = (
            "Location is outside the study area."
            if status == "outside"
            else "No matching grid cell was found."
        )

        return jsonify({
            "success": False,
            "message": message
        }), 404

    feature = {
        "type": "Feature",
        "geometry": cell.geometry.__geo_interface__,
        "properties": {
            "grid_id": str(cell["grid_id"])
        }
    }

    return jsonify({
        "success": True,
        "feature": feature
    })


# =========================================================
# API: FIND NEARBY POLICE, HOSPITALS, AND BUS STOPS
# =========================================================

@app.route("/api/nearby-facilities", methods=["GET"])
def nearby_facilities_api():

    try:
        latitude = float(request.args.get("lat", ""))
        longitude = float(request.args.get("lon", ""))
        radius_m = float(request.args.get("radius", "1000"))

    except (TypeError, ValueError):

        return jsonify({
            "success": False,
            "message": (
                "Provide valid latitude, longitude, and radius values."
            )
        }), 400

    if not valid_coordinates(latitude, longitude):

        return jsonify({
            "success": False,
            "message": (
                "Latitude or longitude is outside its valid range."
            )
        }), 400

    if not math.isfinite(radius_m) or not 0 < radius_m <= 50000:

        return jsonify({
            "success": False,
            "message": (
                "Radius must be greater than 0 and no more "
                "than 50,000 metres."
            )
        }), 400

    # Approximate degree-based bounding box.
    lat_delta = radius_m / 110540.0

    lon_scale = max(
        0.01,
        111320.0 * abs(math.cos(math.radians(latitude)))
    )

    lon_delta = radius_m / lon_scale

    results = {
        "police": [],
        "hospitals": [],
        "bus_stops": []
    }

    unavailable = []

    for category, layer in facility_layers.items():

        if layer is None:
            unavailable.append(category)
            continue

        if layer.empty or "geometry" not in layer.columns:
            continue

        # Filter possible candidates before calculating distances.
        try:

            bounds = layer.geometry.bounds

            candidates = layer[
                (bounds["maxx"] >= longitude - lon_delta)
                & (bounds["minx"] <= longitude + lon_delta)
                & (bounds["maxy"] >= latitude - lat_delta)
                & (bounds["miny"] <= latitude + lat_delta)
            ]

        except Exception:
            candidates = layer

        for _, row in candidates.iterrows():

            geom = row.geometry

            if geom is None or geom.is_empty:
                continue

            try:

                point = (
                    geom
                    if geom.geom_type == "Point"
                    else geom.representative_point()
                )

                fac_lon = float(point.x)
                fac_lat = float(point.y)

                dlat = math.radians(fac_lat - latitude)
                dlon = math.radians(fac_lon - longitude)

                a = (
                    math.sin(dlat / 2) ** 2
                    + math.cos(math.radians(latitude))
                    * math.cos(math.radians(fac_lat))
                    * math.sin(dlon / 2) ** 2
                )

                distance_m = (
                    6371000.0
                    * 2
                    * math.atan2(
                        math.sqrt(a),
                        math.sqrt(max(0.0, 1.0 - a))
                    )
                )

                if distance_m > radius_m:
                    continue

                attributes = {}

                for column in layer.columns:

                    if column == "geometry":
                        continue

                    value = json_value(row[column])

                    if value is None:
                        continue

                    if isinstance(value, (str, int, float, bool)):
                        attributes[str(column)] = value
                    else:
                        attributes[str(column)] = str(value)

                results[category].append({
                    "category": category,
                    "latitude": fac_lat,
                    "longitude": fac_lon,
                    "distance_m": round(distance_m, 1),
                    "geometry_type": geom.geom_type,
                    "attributes": attributes
                })

            except (TypeError, ValueError, AttributeError):
                continue

        results[category].sort(
            key=lambda item: item["distance_m"]
        )

    total = sum(
        len(items)
        for items in results.values()
    )

    message = (
        f"Found {total} mapped facility feature(s) within "
        f"{radius_m:g} metres. Distances are straight-line estimates."
    )

    if unavailable:
        message += (
            " Some facility datasets could not be loaded: "
            + ", ".join(unavailable)
            + "."
        )

    return jsonify({
        "success": True,
        "message": message,
        "radius_m": radius_m,
        "results": results,
        "data_warnings": [
            (
                "Mapped records may contain duplicates "
                "or incomplete attributes."
            ),
            (
                "A mapped feature does not guarantee that "
                "a facility is open or operational."
            )
        ]
    })


# =========================================================
# API: SAVE A GEOFENCE OR SOS DEMONSTRATION EVENT
# =========================================================

@app.route("/api/events", methods=["POST"])
def save_event():

    data = request.get_json(silent=True)

    if not isinstance(data, dict):

        return jsonify({
            "success": False,
            "message": "A valid JSON request body is required."
        }), 400

    event_type = str(
        data.get("event_type", "")
    ).strip()

    mode = str(
        data.get("mode", "")
    ).strip().upper()

    allowed_events = {
        "STARTED_OUTSIDE",
        "STARTED_INSIDE",
        "ENTERED_GEOFENCE",
        "EXITED_GEOFENCE",
        "SOS_DEMO",
        "JOURNEY_STARTED",
        "ROUTE_DEVIATION",
        "ROUTE_REPLANNED",
        "JOURNEY_COMPLETED"
    }

    allowed_modes = {
        "SIMULATED",
        "LOCAL_DEMO",
        "LIVE_GPS"
    }

    if event_type not in allowed_events:

        return jsonify({
            "success": False,
            "message": "Invalid event type."
        }), 400

    if mode not in allowed_modes:

        return jsonify({
            "success": False,
            "message": "Invalid event mode."
        }), 400

    latitude = data.get("latitude")
    longitude = data.get("longitude")
    radius_m = data.get("radius_m")

    try:

        if latitude is not None:

            latitude = float(latitude)

            if not math.isfinite(latitude) or not -90 <= latitude <= 90:
                raise ValueError("Invalid latitude.")

        if longitude is not None:

            longitude = float(longitude)

            if not math.isfinite(longitude) or not -180 <= longitude <= 180:
                raise ValueError("Invalid longitude.")

        if radius_m is not None:

            radius_m = float(radius_m)

            if not math.isfinite(radius_m) or not 0 < radius_m <= 100000:
                raise ValueError("Invalid radius.")

    except (TypeError, ValueError):

        return jsonify({
            "success": False,
            "message": "Invalid coordinates or geofence radius."
        }), 400

    # Latitude and longitude must be supplied together.
    if (latitude is None) != (longitude is None):

        return jsonify({
            "success": False,
            "message": (
                "Latitude and longitude must be supplied together."
            )
        }), 400

    timestamp = datetime.now(timezone.utc).isoformat()

    description = str(
        data.get("description", "")
    )[:500]

    with get_db_connection() as connection:

        cursor = connection.execute(
            """
            INSERT INTO events (
                user_id,
                event_type,
                timestamp,
                latitude,
                longitude,
                radius_m,
                mode,
                description
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                current_user_id(),
                event_type,
                timestamp,
                latitude,
                longitude,
                radius_m,
                mode,
                description
            )
        )

        event_id = cursor.lastrowid
        connection.commit()

    return jsonify({
        "success": True,
        "message": "Event saved successfully.",
        "event_id": event_id,
        "timestamp": timestamp
    }), 201


# =========================================================
# API: RETRIEVE SAVED EVENTS
# =========================================================

@app.route("/api/events", methods=["GET"])
def get_events():

    try:
        limit = int(request.args.get("limit", 100))

    except (TypeError, ValueError):
        limit = 100

    limit = max(1, min(limit, 500))

    with get_db_connection() as connection:

        rows = connection.execute(
            """
            SELECT
                id,
                event_type,
                timestamp,
                latitude,
                longitude,
                radius_m,
                mode,
                description
            FROM events
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (current_user_id(), limit)
        ).fetchall()

    return jsonify({
        "success": True,
        "events": [
            dict(row)
            for row in rows
        ]
    })


# =========================================================
# API: CLEAR DEMONSTRATION EVENTS
# =========================================================

@app.route("/api/events", methods=["DELETE"])
def delete_events():

    with get_db_connection() as connection:

        connection.execute(
            """
            DELETE FROM events
            WHERE user_id = ?
              AND mode IN ('SIMULATED', 'LOCAL_DEMO')
            """,
            (current_user_id(),)
        )

        connection.commit()

    return jsonify({
        "success": True,
        "message": "Demonstration events cleared."
    })


# =========================================================
# LOCAL SOS WORKFLOW
# No real email, SMS, or emergency call is sent.
# =========================================================

@app.route("/api/contacts", methods=["GET", "POST"])
def contacts_api():

    if request.method == "GET":

        with get_db_connection() as connection:

            rows = connection.execute(
                """
                SELECT
                    id,
                    name,
                    phone,
                    email,
                    consent_confirmed,
                    created_at
                FROM trusted_contacts
                WHERE user_id = ?
                ORDER BY id DESC
                """,
                (current_user_id(),)
            ).fetchall()

        return jsonify({
            "success": True,
            "contacts": [
                dict(row)
                for row in rows
            ]
        })

    data = request.get_json(silent=True) or {}

    name = str(data.get("name", "")).strip()[:100]
    phone = str(data.get("phone", "")).strip()[:40]
    email = str(data.get("email", "")).strip()[:160]

    consent = data.get("consent_confirmed") is True

    if not name or not (phone or email):

        return jsonify({
            "success": False,
            "message": (
                "Enter a name and at least a phone number or email."
            )
        }), 400

    if not consent:

        return jsonify({
            "success": False,
            "message": (
                "Confirm that this person agreed to be listed "
                "as a trusted contact."
            )
        }), 400

    if email and (
        "@" not in email
        or "." not in email.split("@")[-1]
    ):

        return jsonify({
            "success": False,
            "message": "Enter a valid email address."
        }), 400

    created = datetime.now(timezone.utc).isoformat()

    with get_db_connection() as connection:

        cur = connection.execute(
            """
            INSERT INTO trusted_contacts (
                user_id,
                name,
                phone,
                email,
                consent_confirmed,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                current_user_id(),
                name,
                phone,
                email,
                1,
                created
            )
        )

        contact_id = cur.lastrowid

    return jsonify({
        "success": True,
        "contact": {
            "id": contact_id,
            "name": name,
            "phone": phone,
            "email": email,
            "consent_confirmed": 1,
            "created_at": created
        }
    }), 201


# ---------------------------------------------------------
# DELETE A TRUSTED CONTACT
# ---------------------------------------------------------

@app.route("/api/contacts/<int:contact_id>", methods=["DELETE"])
def delete_contact(contact_id):

    with get_db_connection() as connection:

        cursor = connection.execute(
            """
            DELETE FROM trusted_contacts
            WHERE id = ? AND user_id = ?
            """,
            (contact_id, current_user_id())
        )

        connection.commit()

    if cursor.rowcount == 0:

        return jsonify({
            "success": False,
            "message": "Contact not found."
        }), 404

    return jsonify({
        "success": True,
        "message": "Trusted contact removed."
    })


# =========================================================
# API: RECORD OR RETRIEVE SOS DEMONSTRATIONS
# =========================================================

@app.route("/api/sos", methods=["GET", "POST"])
def sos_api():

    if request.method == "GET":

        with get_db_connection() as connection:

            rows = connection.execute(
                """
                SELECT *
                FROM sos_requests
                WHERE user_id = ?
                ORDER BY id DESC
                LIMIT 50
                """,
                (current_user_id(),)
            ).fetchall()

        return jsonify({
            "success": True,
            "requests": [
                dict(row)
                for row in rows
            ]
        })

    data = request.get_json(silent=True) or {}

    try:

        latitude = float(data.get("latitude"))
        longitude = float(data.get("longitude"))

        accuracy = (
            float(data.get("accuracy_m"))
            if data.get("accuracy_m") is not None
            else None
        )

        if not valid_coordinates(latitude, longitude):
            raise ValueError("Invalid coordinates.")

        if accuracy is not None and (
            not math.isfinite(accuracy)
            or not 0 <= accuracy <= 100000
        ):
            raise ValueError("Invalid GPS accuracy.")

    except (TypeError, ValueError):

        return jsonify({
            "success": False,
            "message": (
                "Valid latitude and longitude are required."
            )
        }), 400

    message = str(
        data.get(
            "message",
            "I may need assistance. Please contact me."
        )
    ).strip()[:500]

    if not data.get("confirm_demo"):

        return jsonify({
            "success": False,
            "message": (
                "Explicit confirmation is required "
                "to record a demo SOS."
            )
        }), 400

    timestamp = datetime.now(timezone.utc).isoformat()

    with get_db_connection() as connection:

        contacts = connection.execute(
            """
            SELECT id, name, phone, email
            FROM trusted_contacts
            WHERE user_id = ?
              AND consent_confirmed = 1
            ORDER BY id
            """,
            (current_user_id(),)
        ).fetchall()

        snapshot = [
            {
                "id": row["id"],
                "name": row["name"],
                "phone": row["phone"],
                "email": row["email"]
            }
            for row in contacts
        ]

        cursor = connection.execute(
            """
            INSERT INTO sos_requests (
                user_id,
                timestamp,
                latitude,
                longitude,
                accuracy_m,
                message,
                status,
                contacts_snapshot
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                current_user_id(),
                timestamp,
                latitude,
                longitude,
                accuracy,
                message,
                "RECORDED_LOCAL_ONLY",
                json.dumps(snapshot)
            )
        )

        sos_id = cursor.lastrowid

        connection.execute(
            """
            INSERT INTO events (
                user_id,
                event_type,
                timestamp,
                latitude,
                longitude,
                radius_m,
                mode,
                description
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                current_user_id(),
                "SOS_DEMO",
                timestamp,
                latitude,
                longitude,
                None,
                "LOCAL_DEMO",
                (
                    f"Local SOS request #{sos_id}; "
                    "no notifications sent."
                )
            )
        )

        connection.commit()

    return jsonify({
        "success": True,
        "request": {
            "id": sos_id,
            "timestamp": timestamp,
            "latitude": latitude,
            "longitude": longitude,
            "accuracy_m": accuracy,
            "message": message,
            "status": "RECORDED_LOCAL_ONLY",
            "contacts_count": len(snapshot)
        },
        "message": (
            "SOS recorded locally. No SMS, email, "
            "or emergency call was sent."
        )
    }), 201


# =========================================================
# SIMULATED EMAIL AND SMS NOTIFICATIONS
# No external notification provider is contacted.
# =========================================================

@app.route("/api/notifications/config", methods=["GET"])
def notifications_config_api():

    return jsonify({
        "success": True,
        "channels": {
            "email": True,
            "sms": True
        },
        "modes": {
            "email": "SIMULATED",
            "sms": "SIMULATED"
        },
        "message": (
            "Both email and SMS are simulated. "
            "No external provider is contacted "
            "and no messages are sent."
        )
    })


# ---------------------------------------------------------
# SIMULATE NOTIFICATION FOR AN SOS REQUEST
# ---------------------------------------------------------

@app.route("/api/sos/<int:sos_id>/notify", methods=["POST"])
def notify_sos(sos_id):

    data = request.get_json(silent=True) or {}

    if data.get("confirm_send") is not True:

        return jsonify({
            "success": False,
            "message": (
                "Please confirm this is a simulated "
                "notification demonstration."
            )
        }), 400

    channel = str(
        data.get("channel", "")
    ).lower()

    if channel not in {"email", "sms", "both"}:

        return jsonify({
            "success": False,
            "message": "Choose email, sms, or both."
        }), 400

    requested_channels = (
        [channel]
        if channel in {"email", "sms"}
        else ["email", "sms"]
    )

    with get_db_connection() as connection:

        sos = connection.execute(
            """
            SELECT *
            FROM sos_requests
            WHERE id = ? AND user_id = ?
            """,
            (sos_id, current_user_id())
        ).fetchone()

    if not sos:

        return jsonify({
            "success": False,
            "message": "SOS record not found."
        }), 404

    contacts = json.loads(
        sos["contacts_snapshot"] or "[]"
    )

    if not contacts:

        return jsonify({
            "success": False,
            "message": (
                "No consented trusted contacts were included "
                "in this SOS snapshot."
            )
        }), 400

    map_link = (
        "https://www.openstreetmap.org/"
        f"?mlat={sos['latitude']}&mlon={sos['longitude']}"
        f"#map=17/{sos['latitude']}/{sos['longitude']}"
    )

    message_body = (
        "SIMULATED AbhayaSetu assistance alert.\n"
        f"Message: {sos['message']}\n"
        f"Coordinates: {sos['latitude']}, {sos['longitude']}\n"
        f"Location map: {map_link}\n"
        f"GPS accuracy reported: {sos['accuracy_m']} metres\n"
        f"Recorded at: {sos['timestamp']}\n"
        "DEMO ONLY: this notification was not transmitted "
        "to any person or emergency service."
    )

    results = []

    for contact in contacts:

        for channel_name in requested_channels:

            destination = (
                contact.get("email")
                if channel_name == "email"
                else contact.get("phone")
            ) or ""

            if destination:

                status = "SIMULATED"

                detail = (
                    f"SIMULATED ONLY: a {channel_name.upper()} "
                    "notification preview was recorded. "
                    "No email/SMS was sent and no external "
                    "provider was contacted."
                )

            else:

                status = "SKIPPED_NO_DESTINATION"

                detail = (
                    f"No {channel_name} destination is saved "
                    "for this contact; no message was sent."
                )

            entry = {
                "contact_name": contact.get("name", "Contact"),
                "channel": channel_name,
                "destination": destination,
                "status": status,
                "detail": detail,
                "preview": message_body
            }

            results.append(entry)

            with get_db_connection() as connection:

                connection.execute(
                    """
                    INSERT INTO notification_logs (
                        sos_id,
                        contact_name,
                        channel,
                        destination,
                        status,
                        detail,
                        created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        sos_id,
                        entry["contact_name"],
                        channel_name,
                        destination,
                        status,
                        detail,
                        datetime.now(timezone.utc).isoformat()
                    )
                )

    overall_status = (
        "SIMULATED"
        if any(
            result["status"] == "SIMULATED"
            for result in results
        )
        else "NO_DESTINATIONS"
    )

    with get_db_connection() as connection:

        connection.execute(
            """
            UPDATE sos_requests
            SET status = ?
            WHERE id = ? AND user_id = ?
            """,
            (
                overall_status,
                sos_id,
                current_user_id()
            )
        )

        connection.commit()

    return jsonify({
        "success": True,
        "sos_id": sos_id,
        "status": overall_status,
        "results": results,
        "message": (
            "Simulation complete. No real email or SMS was sent "
            "and no external provider was contacted."
        )
    }), 200


# ---------------------------------------------------------
# GET NOTIFICATION HISTORY FOR AN SOS REQUEST
# ---------------------------------------------------------

@app.route("/api/sos/<int:sos_id>/notifications", methods=["GET"])
def get_sos_notifications(sos_id):

    with get_db_connection() as connection:

        rows = connection.execute(
            """
            SELECT
                n.id,
                n.contact_name,
                n.channel,
                n.destination,
                n.status,
                n.detail,
                n.created_at
            FROM notification_logs AS n
            JOIN sos_requests AS s
                ON s.id = n.sos_id
            WHERE n.sos_id = ?
              AND s.user_id = ?
            ORDER BY n.id DESC
            """,
            (sos_id, current_user_id())
        ).fetchall()

    return jsonify({
        "success": True,
        "notifications": [
            dict(row)
            for row in rows
        ]
    })


# =========================================================
# START APPLICATION
# =========================================================

if __name__ == "__main__":

    app.run(
        host="127.0.0.1",
        port=5000,
        debug=True
    )