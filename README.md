# AbhayaSetu
### A Geo-Fenced Emergency Alert and Safety Assistance System for Women Using Artificial Intelligence and GIS

AbhayaSetu is a GIS-based women's safety application designed to support safer travel through geographic information systems, location-aware assistance, nearby emergency facilities, route planning, and emergency alert functionality.

The project focuses on helping users explore their surroundings, identify essential emergency facilities, and access safety-related features during a journey.

## Project Objectives

- Support safer travel through location-aware assistance.
- Display relevant geographic information on an interactive map.
- Help users identify nearby police stations, hospitals, and bus stops.
- Provide route planning and journey-related safety features.
- Support geofence-based safety events.
- Provide an emergency alert interface for requesting assistance.
- Explore the application of AI and GIS in women's safety.

## Key Features

### 1. Interactive GIS Map
Displays geographic information for the Bengaluru study area.

### 2. Route Planning
Allows users to plan journeys and view routes on the map.

### 3. Emergency Facilities
Supports access to geographic information about:
- Police stations
- Hospitals
- Bus stops

### 4. Location-Aware Assistance
Supports location-related functionality for journey planning and safety assistance.

### 5. Geofencing
Includes geofence-related functionality for location-based safety events.

### 6. Emergency Alerts
Provides an emergency alert interface and records SOS events within the application.

**Important:** Actual delivery of emergency alerts to police, hospitals, or trusted contacts depends on the configuration and testing of external messaging services. The application should not be relied upon as a guaranteed emergency-response service.

## Technology Stack

- **Backend:** Python, Flask
- **Frontend:** HTML5, CSS3, JavaScript
- **Database:** SQLite
- **Geospatial processing:** GeoPandas, Shapely
- **Data analysis:** Pandas
- **Mapping and GIS:** Geographic datasets and map-based visualization

## Project Structure

```text
web_demo/
├── app.py
├── requirements.txt
├── .gitignore
├── README.md
├── Datasets/
│   └── Bengaluru_Study_Area/
│       ├── bengaluru_grid_accessibility_review.csv
│       ├── bengaluru_grid_infrastructure.geojson
│       ├── bengaluru_urban_boundary.geojson
│       ├── bengaluru_urban_bus_stops.geojson
│       ├── bengaluru_urban_hospitals.geojson
│       └── bengaluru_urban_police.geojson
├── static/
│   ├── app.js
│   └── style.css
└── templates/
    └── index.html