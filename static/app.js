"use strict";

const $ = id => document.getElementById(id);
const statusMessage=$("statusMessage"), selectedLocation=$("selectedLocation"), assessmentDetails=$("assessmentDetails");
const locateButton=$("locateButton"), demoButton=$("demoButton"), sosButton=$("sosButton");
const radiusSelect=$("radiusSelect"), createGeofenceButton=$("createGeofenceButton"), startMovementButton=$("startMovementButton"), stopMovementButton=$("stopMovementButton"), resetGeofenceButton=$("resetGeofenceButton");
const geofenceStatus=$("geofenceStatus"), movementStatus=$("movementStatus"), eventCount=$("eventCount"), geofenceMessage=$("geofenceMessage"), eventTableBody=$("eventTableBody"), clearEventsButton=$("clearEventsButton");
const findFacilitiesButton=$("findFacilitiesButton"), clearFacilitiesButton=$("clearFacilitiesButton"), facilityStatusMessage=$("facilityStatusMessage"), facilitySummary=$("facilitySummary"), facilityResults=$("facilityResults");
const filterCheckboxes={police:$("showPoliceCheckbox"),hospitals:$("showHospitalsCheckbox"),bus_stops:$("showBusStopsCheckbox")};
const CATEGORY={police:{label:"Police",color:"#2563eb"},hospitals:{label:"Hospitals",color:"#dc2626"},bus_stops:{label:"Bus stops",color:"#7c3aed"}};
const map=L.map("map").setView([12.9716,77.5946],12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"&copy; OpenStreetMap contributors"}).addTo(map);
let locationMarker=null,selectedCellLayer=null,boundaryLayer=null,selectedPosition=null;
const facilityLayers={police:L.layerGroup().addTo(map),hospitals:L.layerGroup().addTo(map),bus_stops:L.layerGroup().addTo(map)};
let facilityData={police:[],hospitals:[],bus_stops:[]};
let geofence=null,geofenceCircle=null,simulatedMarker=null,movementTimer=null,movementRoute=[],movementIndex=0,previousInsideState=null,movementRunId=0,events=[],locationRequestId=0;
function setStatus(message){statusMessage.textContent=message} function setGeofenceMessage(message){geofenceMessage.textContent=message}
async function apiRequest(url,options={}){const response=await fetch(url,options);let result;try{result=await response.json()}catch{throw new Error(`The server returned an invalid response (${response.status}).`)}if(!response.ok||result.success===false)throw new Error(result.message||`Request failed (${response.status}).`);return result}
function distanceMetres(a,b){const r=6371000,rad=x=>x*Math.PI/180,dLat=rad(b.lat-a.lat),dLon=rad(b.lng-a.lng),x=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;return 2*r*Math.atan2(Math.sqrt(x),Math.sqrt(1-x))}
function escapeHTML(value){return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]))}
function addMetric(title,value,note=""){const card=document.createElement("div");card.className="metric-card";const t=document.createElement("div");t.className="metric-title";t.textContent=title;const v=document.createElement("div");v.className="metric-value";v.textContent=value;const n=document.createElement("div");n.className="metric-note";n.textContent=note;card.append(t,v,n);assessmentDetails.appendChild(card)}
let currentAssessment = null;
function displayAssessment(data){
  currentAssessment = data;
  assessmentDetails.replaceChildren();
  const id = data.grid_id ?? data.cell_id ?? "—";
  addMetric("Grid cell", String(id), "500 m × 500 m grid");

  const rawRoads = data.road_length_km ?? data.total_road_length_km;
  const roads = Number(rawRoads);
  addMetric("Road length",
    rawRoads == null || !Number.isFinite(roads) ? "—" : `${roads.toFixed(3)} km`,
    "Mapped road geometry within cell");

  const density = data.road_density_km_per_km2 ?? data.road_density;
  addMetric("Road density",
    density == null || !Number.isFinite(Number(density)) ? "—" : `${Number(density).toFixed(2)} km/km²`,
    "Mapped road length per square kilometre");

  const counts = data.infrastructure_counts ?? data.counts ?? {};
  let any = false;
  for (const [key, label] of [["police","Police features"],["hospitals","Hospital features"],["bus_stops","Bus-stop features"]]) {
    if (counts[key] !== undefined) {
      addMetric(label, String(counts[key]), "Mapped feature representations");
      any = true;
    }
  }
  if (!any) {
    for (const [key, label] of [["police_count","Police features"],["hospital_count","Hospital features"],["bus_stop_count","Bus-stop features"]]) {
      if (data[key] !== undefined) addMetric(label, String(data[key]), "Mapped feature representations");
    }
  }
  renderInfrastructureSupport();
  renderAccessibilityMetrics(data);
}

function renderAccessibilityMetrics(data) {
  const existing = $("accessibilityMetricsCard");
  if (existing) existing.remove();

  const card = document.createElement("section");
  card.id = "accessibilityMetricsCard";
  card.className = "infrastructure-support-card";

  const heading = document.createElement("h3");
  heading.textContent = "Infrastructure Accessibility Assessment";
  card.appendChild(heading);

  const intro = document.createElement("p");
  intro.className = "infrastructure-support-muted";
  intro.textContent = "GIS measurements for the selected 500 m grid cell. These are infrastructure proximity indicators, not a crime-risk prediction.";
  card.appendChild(intro);

  function formatDistance(value) {
    if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "Unavailable";
    const metres = Number(value);
    return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${Math.round(metres)} m`;
  }

  const distanceGrid = document.createElement("div");
  distanceGrid.className = "accessibility-distance-grid";
  const metrics = [
    ["Nearest police point", "nearest_police_distance_m"],
    ["Nearest police geometry", "nearest_police_geometry_distance_m"],
    ["Nearest hospital", "nearest_hospital_distance_m"],
    ["Nearest bus stop", "nearest_bus_stop_distance_m"]
  ];

  for (const [label, key] of metrics) {
    const box = document.createElement("div");
    box.className = "accessibility-distance-item";
    const name = document.createElement("span");
    name.className = "accessibility-distance-label";
    name.textContent = label;
    const value = document.createElement("strong");
    value.className = "accessibility-distance-value";
    value.textContent = formatDistance(data[key]);
    box.append(name, value);
    distanceGrid.appendChild(box);
  }
  card.appendChild(distanceGrid);

  const rawFlags = data.number_of_accessibility_review_flags;
  const flags = Number(rawFlags);
  const flagSummary = document.createElement("p");
  flagSummary.className = "infrastructure-support-status";
  flagSummary.textContent =
    rawFlags === null || rawFlags === undefined || rawFlags === "" || !Number.isFinite(flags)
      ? "Preliminary review flags: Unavailable"
      : `Preliminary review flags: ${Math.max(0, Math.min(4, flags))} / 4`;
  card.appendChild(flagSummary);

  const criteria = [
    ["police_over_3km", "Nearest police geometry is more than 3 km away"],
    ["hospital_over_3km", "Nearest hospital is more than 3 km away"],
    ["bus_stop_over_1km", "Nearest bus stop is more than 1 km away"],
    ["low_road_density_review", "Road density is below 5 km/km²"]
  ];
  for (const [key, label] of criteria) {
    const row = document.createElement("p");
    const value = data[key];
    const result = value === true || value === 1 || value === "True"
      ? "Review threshold triggered"
      : value === false || value === 0 || value === "False"
        ? "Review threshold not triggered"
        : "Status unavailable";
    row.textContent = `${label}: ${result}.`;
    card.appendChild(row);
  }

  const note = document.createElement("p");
  note.className = "infrastructure-support-muted";
  note.textContent = "Distances are straight-line distances to mapped features, not road-travel distances or confirmed facility availability. Map records may be incomplete or outdated. Review flags are preliminary screening indicators; they do not predict crime or prove an area is safe or unsafe.";
  card.appendChild(note);
  assessmentDetails.appendChild(card);
}

function installInfrastructureStyles(){
  if($("infrastructureSupportStyles")) return;
  const style=document.createElement("style");
  style.id="infrastructureSupportStyles";
  style.textContent=`
    .infrastructure-support-card{grid-column:1/-1;border:1px solid #cbd5e1;border-radius:12px;padding:14px;background:#f8fafc}
    .infrastructure-support-card h3{margin:0 0 8px;font-size:1rem;color:#0f172a}
    .infrastructure-support-card p{margin:6px 0;line-height:1.45}
    .infrastructure-support-status{font-weight:700}
    .infrastructure-support-alert{margin-top:10px;padding:10px 12px;border-radius:8px;background:#fff7ed;color:#9a3412;border:1px solid #fed7aa}
    .infrastructure-support-good{background:#ecfdf5;color:#065f46;border-color:#a7f3d0}
    .infrastructure-support-muted{color:#475569;font-size:.88rem}
    .accessibility-distance-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:12px 0}
    .accessibility-distance-item{display:flex;flex-direction:column;gap:5px;padding:10px;border:1px solid #dbe3ec;border-radius:8px;background:#fff}
    .accessibility-distance-label{font-size:.82rem;color:#475569}
    .accessibility-distance-value{font-size:1.05rem;color:#0f172a;overflow-wrap:anywhere}
    @media(max-width:520px){.accessibility-distance-grid{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
}

function renderInfrastructureSupport(){if(!assessmentDetails||!currentAssessment)return;installInfrastructureStyles();const old=$("infrastructureSupportCard");if(old)old.remove();const card=document.createElement("section");card.id="infrastructureSupportCard";card.className="infrastructure-support-card";const heading=document.createElement("h3");heading.textContent="Mapped Infrastructure Support (1 km radius)";const status=document.createElement("p");status.className="infrastructure-support-status";const detail=document.createElement("p");const alert=document.createElement("p");alert.className="infrastructure-support-alert";const note=document.createElement("p");note.className="infrastructure-support-muted";const labels=[["police","Police"],["hospitals","Hospitals"],["bus_stops","Bus stops"]];const present=labels.filter(([key])=>(facilityData[key]||[]).length>0);const countText=labels.map(([key,label])=>`${label}: ${(facilityData[key]||[]).length} mapped records`).join(" · ");if(present.length===3){status.textContent="Multiple mapped support categories found";alert.textContent="Mapped records for police, hospitals and bus stops were returned. Confirm that locations are current and operational.";alert.classList.add("infrastructure-support-good")}else if(present.length===2){status.textContent="Some mapped support categories found";alert.textContent="Only two of the three mapped categories were returned within 1 km. Check nearby options and verify information independently."}else if(present.length===1){status.textContent="Limited mapped support categories found";alert.textContent="Only one mapped category was returned within 1 km. This may reflect incomplete map data; it does not mean the area is unsafe."}else{status.textContent="No mapped support categories returned";alert.textContent="No police, hospital or bus-stop records were returned within 1 km. This may reflect missing or incomplete data; it is not a danger prediction."}detail.textContent=countText;note.textContent="This is a transparent GIS coverage summary based on mapped feature records, not a crime/safety-risk score. Records may be duplicated or incomplete; distances are straight-line estimates.";card.append(heading,status,detail,alert,note);const ai=document.createElement("p");ai.className="infrastructure-support-muted";ai.textContent="AI incident-risk prediction: not enabled because no validated historical incident dataset is connected.";card.appendChild(ai);assessmentDetails.appendChild(card)}
async function loadBoundary(){try{const data=await apiRequest("/api/boundary");const geo=data.feature??data.boundary??data;if(boundaryLayer)map.removeLayer(boundaryLayer);boundaryLayer=L.geoJSON(geo,{style:{color:"#2563eb",weight:3,fillColor:"#93c5fd",fillOpacity:.06}}).addTo(map);map.fitBounds(boundaryLayer.getBounds(),{padding:[15,15]});setStatus("Study boundary loaded. Select a point on the map.")}catch(error){console.error(error);setStatus(`Could not load boundary: ${error.message}`)}}
async function checkLocation(lat,lon){const requestId=++locationRequestId;selectedPosition={lat:Number(lat),lng:Number(lon)};selectedLocation.textContent=`Latitude: ${lat.toFixed(6)}, Longitude: ${lon.toFixed(6)}`;if(locationMarker)map.removeLayer(locationMarker);locationMarker=L.marker([lat,lon]).addTo(map).bindPopup("Selected location").openPopup();setStatus("Checking selected location…");try{const q=`lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;const assessed=await apiRequest(`/api/assess?${q}`);if(requestId!==locationRequestId)return;displayAssessment(assessed.assessment??assessed);const cell=await apiRequest(`/api/grid-cell?${q}`);if(requestId!==locationRequestId)return;if(selectedCellLayer)map.removeLayer(selectedCellLayer);selectedCellLayer=L.geoJSON(cell.feature,{style:{color:"#dc2626",weight:3,fillColor:"#f87171",fillOpacity:.22}}).addTo(map);selectedCellLayer.bindPopup(`Selected grid: ${escapeHTML((assessed.assessment??assessed).grid_id??"—")}`);setStatus("Location assessment loaded.");await loadNearbyFacilities()}catch(error){if(requestId!==locationRequestId)return;console.error(error);if(selectedCellLayer){map.removeLayer(selectedCellLayer);selectedCellLayer=null}assessmentDetails.replaceChildren();const p=document.createElement("p");p.className="empty-state";p.textContent=error.message;assessmentDetails.appendChild(p);setStatus(error.message);facilityStatusMessage.textContent="Choose a valid location inside the study area to search facilities."}}
map.on("click",e=>checkLocation(e.latlng.lat,e.latlng.lng));
locateButton.addEventListener("click",()=>{if(!navigator.geolocation){setStatus("Geolocation is not supported by this browser.");return}setStatus("Requesting browser location permission…");navigator.geolocation.getCurrentPosition(p=>{const {latitude,longitude}=p.coords;map.setView([latitude,longitude],15);checkLocation(latitude,longitude)},e=>setStatus(`Could not obtain location: ${e.message}`),{enableHighAccuracy:true,timeout:10000,maximumAge:30000})});
demoButton.addEventListener("click", async () => {   reviewerDemoMode = true;    const latitude = 12.9716;   const longitude = 77.5946;    selectedRouteOrigin = {     lat: latitude,     lng: longitude,     label: "Bengaluru Reviewer Demo Location"   };    selectedPosition = {     lat: latitude,     lng: longitude   };    map.setView([latitude, longitude], 16);    setStatus("Loading Bengaluru demo location and analysing mapped infrastructure...");    try {     await checkLocation(latitude, longitude);      installRoutePlanner();      $("routeOriginStatus").textContent =       `Starting point: predefined Bengaluru demo location (${latitude.toFixed(5)}, ${longitude.toFixed(5)}).`;      $("routePlannerStatus").textContent =       "Demo location loaded. Enter a Bengaluru destination to compare available driving routes.";      $("routeDestination").placeholder = "Example: Bengaluru City Railway Station";      document.getElementById("routePlannerPanel").scrollIntoView({       behavior: "smooth",       block: "start"     });   } catch (error) {     setStatus("Demo location loaded, but the infrastructure assessment failed. Please retry.");     console.error(error);   } });
function facilityName(item){return item.attributes?.name||item.attributes?.operator||`${CATEGORY[item.category]?.label||"Facility"} mapped feature`}
function renderFacilityResults(){facilityResults.replaceChildren();facilitySummary.replaceChildren();let total=0;for(const key of Object.keys(CATEGORY)){const items=facilityData[key]||[];total+=items.length;const chip=document.createElement("span");chip.className="summary-chip";chip.textContent=`${CATEGORY[key].label}: ${items.length}`;facilitySummary.appendChild(chip);const card=document.createElement("div");card.className="facility-category";const heading=document.createElement("h3");heading.textContent=`${CATEGORY[key].label} (${items.length})`;card.appendChild(heading);if(!items.length){const empty=document.createElement("p");empty.className="small-note";empty.textContent="No mapped results in this radius.";card.appendChild(empty)}items.forEach(item=>{const row=document.createElement("div");row.className="facility-item";const name=document.createElement("div");name.className="facility-item-name";name.textContent=facilityName(item);const distance=document.createElement("div");distance.className="facility-distance";distance.textContent=`${Number(item.route_distance_m ?? item.distance_m ?? 0).toFixed(0)} m from route · ${item.geometry_type||"Mapped feature"}`;const actions=document.createElement("div");actions.className="facility-item-actions";const show=document.createElement("button");show.className="secondary-button";show.textContent="Show on map";show.addEventListener("click",()=>{map.setView([Number(item.latitude),Number(item.longitude)],17);const marker=facilityLayers[key]._layers;for(const layerId in marker){const layer=marker[layerId];if(layer._facilityItem===item){layer.openPopup();break}}});actions.appendChild(show);row.append(name,distance,actions);card.appendChild(row)});facilityResults.appendChild(card)}if(total===0){const empty=document.createElement("div");empty.className="empty-state";empty.textContent="No mapped facilities were returned for this search.";facilityResults.appendChild(empty)}}
function clearFacilityLayers(){Object.values(facilityLayers).forEach(layer=>layer.clearLayers())}

let facilitiesRouteGeometry = null;

function sampleRoutePoints(geometry, spacingMeters = 650, maxSamples = 55) {
  const coords = geometry?.coordinates || [];
  if (coords.length < 2) return [];
  const toRad = v => v * Math.PI / 180;
  const distance = (a, b) => {
    const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(Math.max(0, 1 - s)));
  };
  const samples = [{ lat: Number(coords[0][1]), lng: Number(coords[0][0]) }];
  let distanceSinceSample = 0;
  for (let i = 1; i < coords.length && samples.length < maxSamples - 1; i++) {
    const a = coords[i - 1], b = coords[i];
    const segmentLength = distance(a, b);
    if (!Number.isFinite(segmentLength) || segmentLength <= 0) continue;
    let travelled = spacingMeters - distanceSinceSample;
    while (travelled <= segmentLength && samples.length < maxSamples - 1) {
      const t = travelled / segmentLength;
      samples.push({
        lat: Number(a[1] + (b[1] - a[1]) * t),
        lng: Number(a[0] + (b[0] - a[0]) * t)
      });
      travelled += spacingMeters;
    }
    distanceSinceSample = (distanceSinceSample + segmentLength) % spacingMeters;
  }
  const end = coords[coords.length - 1];
  samples.push({ lat: Number(end[1]), lng: Number(end[0]) });
  return samples.slice(0, maxSamples);
}

async function fetchFacilitiesAlongRoute(geometry) {
  // Fixed 500 m corridor; there is no kilometre-wise/local-radius mode.
  const corridorMeters = 500;
  const points = sampleRoutePoints(geometry);
  if (!points.length) throw new Error("This route has no usable geometry to search for facilities.");
  const route = { geometry };
  const merged = { police: [], hospitals: [], bus_stops: [] };
  const seen = new Set();
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < points.length) {
      const i = nextIndex++;
      const p = points[i];
      const data = await apiRequest(`/api/nearby-facilities?lat=${encodeURIComponent(p.lat)}&lon=${encodeURIComponent(p.lng)}&radius=${corridorMeters}`);
      for (const key of Object.keys(merged)) {
        for (const item of (data.results || {})[key] || []) {
          const lat = Number(item.latitude), lng = Number(item.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
          // Exact point-to-route distance filter removes facilities merely near a sample point.
          const distanceToRoute = routeDistanceFromPointMetres({ lat, lng }, route);
          if (!Number.isFinite(distanceToRoute) || distanceToRoute > corridorMeters) continue;
          const identity = `${key}:${lat.toFixed(6)}:${lng.toFixed(6)}:${facilityName(item)}`;
          const previous = merged[key].find(x => `${key}:${Number(x.latitude).toFixed(6)}:${Number(x.longitude).toFixed(6)}:${facilityName(x)}` === identity);
          if (previous) {
            if (distanceToRoute < Number(previous.route_distance_m ?? Infinity)) {
              previous.route_distance_m = Math.round(distanceToRoute);
              previous.distance_m = Math.round(distanceToRoute);
            }
            continue;
          }
          if (seen.has(identity)) continue;
          seen.add(identity);
          merged[key].push({ ...item, distance_m: Math.round(distanceToRoute), route_distance_m: Math.round(distanceToRoute), route_search_point: i });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, points.length) }, () => worker()));
  for (const key of Object.keys(merged)) merged[key].sort((a,b) => a.distance_m - b.distance_m);
  return { results: merged, message: `Found facilities within ${corridorMeters} m of the selected route using ${points.length} route points.` };
}

function findFacilitiesOnRoute(route) {
  if (!route?.geometry) { setRouteStatus("Select a calculated route first.", true); return; }
  facilitiesRouteGeometry = route.geometry;
  const mapNavLink = document.querySelector('.side-nav .nav-link[href="#mapSection"]');
  if (mapNavLink) mapNavLink.click();
  else { location.hash = "#mapSection"; document.getElementById("mapSection")?.scrollIntoView({behavior:"smooth"}); }
  setTimeout(() => {
    if (map && typeof map.invalidateSize === "function") map.invalidateSize();
    const routeLayer = routeLayers.find(layer => layer?.feature?.properties?.routeId === route.id) || null;
    if (routeLayer && typeof routeLayer.getBounds === "function" && routeLayer.getBounds().isValid()) {
      map.fitBounds(routeLayer.getBounds(), { padding: [35, 35] });
      routeLayer.bringToFront();
    } else {
      const bounds = L.geoJSON(route).getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, {padding:[35,35]});
    }
    loadNearbyFacilities();
  }, 220);
}

async function loadNearbyFacilities() {
  if (!facilitiesRouteGeometry) {
    facilityStatusMessage.textContent = "Calculate a route and click “Show this route” or “Find facilities along this route”. Facilities are now route-only.";
    return;
  }
  facilityStatusMessage.textContent = "Searching police stations, hospitals and bus stops within 500 m of the selected route…";
  findFacilitiesButton.disabled = true;
  try {
    const data = await fetchFacilitiesAlongRoute(facilitiesRouteGeometry);
    facilityData = data.results || {police:[], hospitals:[], bus_stops:[]};
    renderInfrastructureSupport();
    clearFacilityLayers();
    for (const key of Object.keys(CATEGORY)) {
      for (const item of facilityData[key] || []) {
        if (!Number.isFinite(Number(item.latitude)) || !Number.isFinite(Number(item.longitude))) continue;
        const marker = L.circleMarker([Number(item.latitude), Number(item.longitude)], {
          radius: 7, color: CATEGORY[key].color, weight: 2, fillColor: CATEGORY[key].color, fillOpacity: .85
        });
        marker.bindPopup(`<div class="facility-marker-popup"><strong>${escapeHTML(facilityName(item))}</strong><br>${escapeHTML(CATEGORY[key].label)}<br>${Number(item.route_distance_m ?? item.distance_m ?? 0).toFixed(0)} m from route</div>`);
        marker._facilityItem = item;
        facilityLayers[key].addLayer(marker);
      }
      if (filterCheckboxes[key].checked) map.addLayer(facilityLayers[key]);
      else map.removeLayer(facilityLayers[key]);
    }
    renderFacilityResults();
    facilityStatusMessage.textContent = `${data.message} Only facilities within the 500 m route corridor are included.`;
  } catch (error) {
    console.error(error);
    facilityStatusMessage.textContent = `Could not load route facilities: ${error.message}`;
    facilityData = {police:[], hospitals:[], bus_stops:[]};
    renderInfrastructureSupport(); clearFacilityLayers(); renderFacilityResults();
  } finally { findFacilitiesButton.disabled = false; }
}
findFacilitiesButton.addEventListener("click",loadNearbyFacilities);clearFacilitiesButton.addEventListener("click",()=>{facilityData={police:[],hospitals:[],bus_stops:[]};facilitiesRouteGeometry=null;clearFacilityLayers();renderFacilityResults();facilityStatusMessage.textContent="Facility results cleared. Calculate a route and click Show this route to reload facilities along that route."});for(const key of Object.keys(filterCheckboxes)){filterCheckboxes[key].addEventListener("change",()=>{if(filterCheckboxes[key].checked)map.addLayer(facilityLayers[key]);else map.removeLayer(facilityLayers[key])})}
async function recordEvent(type,position,mode="SIMULATED",description="Geofence demonstration event"){const event={event_type:type,latitude:position.lat,longitude:position.lng,radius_m:geofence?geofence.radius:null,mode,description};try{const result=await apiRequest("/api/events",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(event)});events.unshift({id:result.event_id,event_type:type,timestamp:result.timestamp,latitude:position.lat,longitude:position.lng,radius_m:event.radius_m,mode:event.mode,description:event.description});events=events.slice(0,100);updateEventTable();setGeofenceMessage(`${type}: event saved to SQLite.`);return true}catch(error){console.error(error);setGeofenceMessage(`${type} detected, but saving failed: ${error.message}`);return false}}
async function loadSavedEvents(){try{const result=await apiRequest("/api/events?limit=100");events=result.events||[];updateEventTable()}catch(error){console.error(error);setGeofenceMessage(`Could not load event history: ${error.message}`)}}
function updateEventTable(){eventTableBody.replaceChildren();if(!events.length){const row=document.createElement("tr"),cell=document.createElement("td");cell.colSpan=5;cell.className="empty-table";cell.textContent="No events recorded yet.";row.appendChild(cell);eventTableBody.appendChild(row)}else events.forEach(event=>{const row=document.createElement("tr");const lat=event.latitude??event.lat,lon=event.longitude??event.lng;const time=event.timestamp?new Date(event.timestamp).toLocaleString():event.time??"—";[time,event.event_type??event.type??"—",lat==null?"—":Number(lat).toFixed(6),lon==null?"—":Number(lon).toFixed(6),event.mode??"—"].forEach(value=>{const cell=document.createElement("td");cell.textContent=String(value);row.appendChild(cell)});eventTableBody.appendChild(row)});eventCount.textContent=String(events.length)}
function destinationPoint(lat,lon,metres,bearing){const R=6371000,b=bearing*Math.PI/180,φ1=lat*Math.PI/180,λ1=lon*Math.PI/180,δ=metres/R;const φ2=Math.asin(Math.sin(φ1)*Math.cos(δ)+Math.cos(φ1)*Math.sin(δ)*Math.cos(b));const λ2=λ1+Math.atan2(Math.sin(b)*Math.sin(δ)*Math.cos(φ1),Math.cos(δ)-Math.sin(φ1)*Math.sin(φ2));return L.latLng(φ2*180/Math.PI,((λ2*180/Math.PI+540)%360)-180)}
function createGeofence(){liveGeofenceState=null;liveCandidateState=null;liveCandidateCount=0;if(!selectedPosition){setGeofenceMessage("Select a location on the map first.");return}stopMovement();geofence={center:L.latLng(selectedPosition.lat,selectedPosition.lng),radius:Number(radiusSelect.value)};if(geofenceCircle)map.removeLayer(geofenceCircle);geofenceCircle=L.circle(geofence.center,{radius:geofence.radius,color:"#16a34a",weight:3,fillColor:"#4ade80",fillOpacity:.15}).addTo(map);if(simulatedMarker)map.removeLayer(simulatedMarker);const outside=destinationPoint(geofence.center.lat,geofence.center.lng,geofence.radius*1.6,270);simulatedMarker=L.circleMarker(outside,{radius:8,color:"#c2410c",weight:2,fillColor:"#f97316",fillOpacity:1}).addTo(map).bindPopup("Simulated user");movementRoute=[outside,destinationPoint(geofence.center.lat,geofence.center.lng,geofence.radius*.65,270),geofence.center,destinationPoint(geofence.center.lat,geofence.center.lng,geofence.radius*.65,90),destinationPoint(geofence.center.lat,geofence.center.lng,geofence.radius*1.6,90)];movementIndex=0;previousInsideState=false;geofenceStatus.textContent=`Created · ${geofence.radius} m`;movementStatus.textContent="Ready";startMovementButton.disabled=false;stopMovementButton.disabled=true;map.fitBounds(geofenceCircle.getBounds(),{padding:[70,70]});setGeofenceMessage("Geofence created. Start movement to simulate entering and leaving the boundary.")}
async function processSimulatedPosition(pos,runId){if(runId!==movementRunId||!geofence)return;simulatedMarker.setLatLng(pos);const inside=distanceMetres(geofence.center,pos)<=geofence.radius;if(previousInsideState!==null&&inside!==previousInsideState)await recordEvent(inside?"ENTERED_GEOFENCE":"EXITED_GEOFENCE",pos);previousInsideState=inside;movementStatus.textContent=inside?"Inside geofence":"Outside geofence";map.panTo(pos,{animate:true,duration:.35})}
function startMovement(){if(!geofence||!simulatedMarker){setGeofenceMessage("Create a geofence first.");return}stopMovement(false);const runId=++movementRunId;movementIndex=0;previousInsideState=distanceMetres(geofence.center,simulatedMarker.getLatLng())<=geofence.radius;movementStatus.textContent="Moving";startMovementButton.disabled=true;stopMovementButton.disabled=false;setGeofenceMessage("Simulated movement running. Entry and exit events are saved to SQLite.");movementTimer=setInterval(async()=>{if(runId!==movementRunId)return;if(movementIndex>=movementRoute.length){stopMovement();return}await processSimulatedPosition(movementRoute[movementIndex++],runId)},1200)}
function stopMovement(updateMessage=true){if(movementTimer){clearInterval(movementTimer);movementTimer=null}movementRunId++;if(geofence){startMovementButton.disabled=false;stopMovementButton.disabled=true;if(movementStatus.textContent==="Moving")movementStatus.textContent="Stopped"}if(updateMessage)setGeofenceMessage("Simulated movement stopped.")}
function resetGeofence(){liveGeofenceState=null;liveCandidateState=null;liveCandidateCount=0;liveEventInProgress=false;stopMovement(false);if(geofenceCircle)map.removeLayer(geofenceCircle);if(simulatedMarker)map.removeLayer(simulatedMarker);geofence=geofenceCircle=simulatedMarker=null;movementRoute=[];movementIndex=0;previousInsideState=null;geofenceStatus.textContent="Not created";movementStatus.textContent="Stopped";startMovementButton.disabled=true;stopMovementButton.disabled=true;setGeofenceMessage("Geofence reset. Select a location and create another geofence.")}
createGeofenceButton.addEventListener("click",createGeofence);startMovementButton.addEventListener("click",startMovement);stopMovementButton.addEventListener("click",()=>stopMovement());resetGeofenceButton.addEventListener("click",resetGeofence);

// Phase 4: consent-based trusted contacts and local-only SOS workflow.
function installSOSPanel(){
  if(document.getElementById("sosWorkflowPanel")) return;
  const panel=document.createElement("section"); panel.id="sosWorkflowPanel"; panel.className="sos-workflow-panel";
  panel.innerHTML=`<h3>Emergency SOS — Local Demo</h3><p class="sos-note">This prototype records SOS details locally. Email and SMS notifications are simulated only; nothing is transmitted. This does not contact emergency services.</p>
  <div id="voiceSOSPanel" class="voice-sos-panel"><h4>Voice-Activated SOS (browser demo)</h4><p>After you tick the acknowledgement, Start Journey can automatically start listening—no SOS-button press is needed at the moment of distress. Saying <strong>“help”</strong>, <strong>“help me”</strong>, <strong>“emergency”</strong>, or <strong>“save me”</strong> triggers a local SOS record and simulated notification preview. Keep this page open with microphone permission enabled. Real police/hospital dispatch and real email/SMS are not connected in this prototype.</p><label class="sos-consent"><input id="voiceSOSArm" type="checkbox"> I understand this is a demo, may mishear speech, and will NOT contact police, hospitals, or send real messages.</label><button id="voiceSOSStart" type="button">Arm &amp; start listening</button><button id="voiceSOSStop" type="button" disabled>Stop listening</button><p id="voiceSOSStatus" role="status" aria-live="polite">Voice SOS is off.</p></div>
  <form id="trustedContactForm"><h4>Trusted contacts (with their consent)</h4><div class="sos-form-grid"><label>Name<input id="contactName" maxlength="100" required></label><label>Phone<input id="contactPhone" maxlength="40" type="tel" placeholder="Optional if email provided"></label><label>Email<input id="contactEmail" maxlength="160" type="email" placeholder="Optional if phone provided"></label></div><label class="sos-consent"><input id="contactConsent" type="checkbox" required> This person has agreed to be listed as a trusted contact.</label><button type="submit">Save contact locally</button></form><div id="trustedContactList" aria-live="polite">Loading contacts…</div>
  <label for="sosMessage">SOS message</label><textarea id="sosMessage" maxlength="500">I may need assistance. Please contact me.</textarea><label class="sos-consent"><input id="sosConfirm" type="checkbox"> I understand this records a demo SOS; notifications are a separate step.</label><button id="recordLocalSOS" type="button" class="sos-record-button">Record SOS locally</button><div class="sos-notify-controls"><label for="sosNotifyChannel">Notification channel</label><select id="sosNotifyChannel"><option value="email">Email</option><option value="sms">SMS</option><option value="both">Both email and SMS</option></select><label class="sos-consent"><input id="sosNotifyConfirm" type="checkbox"> I understand this is a simulated notification preview; no email or SMS will be transmitted.</label><button id="sendSOSNotifications" type="button">Send notifications for latest SOS</button><p id="notificationConfigStatus">Checking notification configuration…</p></div><p id="sosWorkflowStatus" role="status" aria-live="polite"></p><div id="sosHistory"></div>`;
  const anchor=sosButton.closest("section, .card, .panel")||sosButton.parentElement; anchor.insertAdjacentElement("afterend",panel);
  const style=document.createElement("style");style.textContent=`.sos-notify-controls{border-top:1px solid #fecaca;margin-top:14px;padding-top:12px}.sos-notify-controls select{padding:8px;margin:6px}.sos-workflow-panel{margin:18px 0;padding:18px;border:1px solid #fecaca;border-radius:14px;background:#fffafa;color:#1f2937}.sos-workflow-panel h3{margin-top:0}.voice-sos-panel{border:1px solid #f59e0b;background:#fffbeb;border-radius:10px;padding:12px;margin:14px 0}.voice-sos-panel p{line-height:1.45}.voice-sos-panel button{border-radius:7px}.sos-note{padding:10px;background:#fff1f2;border-radius:8px;font-size:.92rem}.sos-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}.sos-workflow-panel label{display:block;margin:10px 0;font-weight:600}.sos-workflow-panel input:not([type=checkbox]),.sos-workflow-panel textarea{display:block;width:100%;box-sizing:border-box;padding:9px;margin-top:5px;border:1px solid #cbd5e1;border-radius:7px}.sos-consent{display:flex!important;align-items:flex-start;gap:8px;font-weight:400!important}.sos-workflow-panel button{padding:9px 13px;margin:6px 6px 6px 0;cursor:pointer}.sos-record-button{background:#b91c1c;color:white;border:0;border-radius:8px;font-weight:700}.contact-row,.sos-history-row{padding:9px;border-bottom:1px solid #e5e7eb}.sos-remove{margin-left:8px}`;document.head.appendChild(style);
  document.getElementById("trustedContactForm").addEventListener("submit",saveTrustedContact);
  document.getElementById("recordLocalSOS").addEventListener("click",recordLocalSOS);
  document.getElementById("sendSOSNotifications").addEventListener("click",sendSOSNotifications);
  document.getElementById("voiceSOSStart").addEventListener("click",startVoiceSOS);
  document.getElementById("voiceSOSStop").addEventListener("click",stopVoiceSOS);
  refreshNotificationConfig();
  refreshSOSPanel();
}
// Voice SOS uses the browser Web Speech API. It works only while this page is open and listening.
let voiceSOSRecognition = null;
let voiceSOSArmed = false;
let voiceSOSTriggerBusy = false;
let voiceSOSLastTriggerAt = 0;
function voiceSOSStatus(message){const el=document.getElementById("voiceSOSStatus");if(el)el.textContent=message}
function startVoiceSOS(){
  const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!document.getElementById("voiceSOSArm").checked){voiceSOSStatus("Tick the demo acknowledgement before starting.");return}
  if(!SpeechRecognition){voiceSOSStatus("Speech recognition is not supported by this browser. Try a current Chrome-based browser over HTTPS or localhost.");return}
  if(!latestLivePosition && liveWatchId === null){voiceSOSStatus("Live GPS tracking is starting. Wait for the first location reading, then start voice listening.");return}
  if(voiceSOSRecognition){try{voiceSOSRecognition.stop()}catch{} voiceSOSRecognition=null}
  voiceSOSArmed=true;
  const recognition=new SpeechRecognition();voiceSOSRecognition=recognition;recognition.lang="en-IN";recognition.continuous=true;recognition.interimResults=false;recognition.maxAlternatives=3;
  recognition.onstart=()=>{voiceSOSStatus('Listening for “help”, “help me”, or “emergency”. Keep this page open.');document.getElementById("voiceSOSStart").disabled=true;document.getElementById("voiceSOSStop").disabled=false};
  recognition.onresult=(event)=>{for(let i=event.resultIndex;i<event.results.length;i++){if(!event.results[i].isFinal)continue;const transcript=Array.from(event.results[i]).map(x=>x.transcript).join(" ").toLowerCase().trim();voiceSOSStatus(`Heard: “${transcript}”`);if(/\b(help|help me|emergency|save me)\b/.test(transcript)){triggerVoiceSOS(transcript);break}}};
  recognition.onerror=(event)=>{voiceSOSStatus(`Speech recognition error: ${event.error}. Check microphone permission and browser support.`);if(event.error==="not-allowed"||event.error==="service-not-allowed")stopVoiceSOS()};
  recognition.onend=()=>{if(voiceSOSArmed&&voiceSOSRecognition===recognition){try{recognition.start()}catch{}}else{document.getElementById("voiceSOSStart").disabled=false;document.getElementById("voiceSOSStop").disabled=true}};
  try{recognition.start()}catch(e){voiceSOSArmed=false;voiceSOSRecognition=null;voiceSOSStatus(`Could not start speech recognition: ${e.message}`)}
}
function stopVoiceSOS(){voiceSOSArmed=false;const r=voiceSOSRecognition;voiceSOSRecognition=null;if(r){r.onend=null;try{r.stop()}catch{}}const start=document.getElementById("voiceSOSStart"),stop=document.getElementById("voiceSOSStop");if(start)start.disabled=false;if(stop)stop.disabled=true;voiceSOSStatus("Voice SOS stopped.")}
async function triggerVoiceSOS(transcript){
  const now=Date.now();if(!voiceSOSArmed||voiceSOSTriggerBusy||now-voiceSOSLastTriggerAt<30000)return;
  voiceSOSLastTriggerAt=now;voiceSOSTriggerBusy=true;voiceSOSStatus(`Voice trigger detected (“${transcript}”). Recording demo SOS…`);
  try{
    if(!latestLivePosition) {
      const waitUntil = Date.now() + 15000;
      while (!latestLivePosition && Date.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 300));
    }
    if(!latestLivePosition)throw new Error("Live GPS position is unavailable. No SOS record was created.");
    const message=`VOICE-TRIGGERED DEMO SOS. Recognized phrase: ${transcript}. Please check on me. This is a prototype; notifications are simulated.`;
    const result=await apiRequest("/api/sos",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({latitude:latestLivePosition.lat,longitude:latestLivePosition.lng,accuracy_m:latestLivePosition.accuracy,message,confirm_demo:true})});
    window.latestSOSRequestId=result.request.id;await loadSavedEvents();await refreshSOSPanel();
    let notifyMessage="Local SOS recorded.";
    try{const n=await apiRequest(`/api/sos/${result.request.id}/notify`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({channel:"both",confirm_send:true})});notifyMessage+=` Simulated notification result: ${n.status||"processed"}.`}
    catch(e){notifyMessage+=` Notification preview could not be generated: ${e.message}.`}
    voiceSOSStatus(`${notifyMessage} SOS #${result.request.id}. NO real SMS/email was sent and emergency services were NOT contacted. Check the SOS panel for details.`);
  }catch(e){voiceSOSStatus(`Voice SOS demo failed: ${e.message}`)}finally{voiceSOSTriggerBusy=false}
}

async function refreshSOSPanel(){try{const data=await apiRequest("/api/contacts");const list=document.getElementById("trustedContactList");list.replaceChildren();if(!data.contacts.length){list.textContent="No trusted contacts saved."}else data.contacts.forEach(c=>{const row=document.createElement("div");row.className="contact-row";const info=document.createElement("span");info.textContent=`${c.name} · ${[c.phone,c.email].filter(Boolean).join(" · ")}`;const del=document.createElement("button");del.className="sos-remove";del.textContent="Remove";del.addEventListener("click",async()=>{if(!confirm(`Remove ${c.name} from trusted contacts?`))return;try{await apiRequest(`/api/contacts/${c.id}`,{method:"DELETE"});refreshSOSPanel()}catch(e){sosWorkflowMessage(e.message)}});row.append(info,del);list.appendChild(row)});const history=await apiRequest("/api/sos");const target=document.getElementById("sosHistory");target.replaceChildren();if(history.requests.length){const h=document.createElement("h4");h.textContent="Recent local SOS records";target.appendChild(h);history.requests.forEach(r=>{const row=document.createElement("div");row.className="sos-history-row";row.textContent=`#${r.id} · ${new Date(r.timestamp).toLocaleString()} · ${Number(r.latitude).toFixed(5)}, ${Number(r.longitude).toFixed(5)} · ${r.status} · ${JSON.parse(r.contacts_snapshot||"[]").length} contact(s) on record`;target.appendChild(row)})}}catch(e){sosWorkflowMessage(`Could not load SOS workflow: ${e.message}`)}}
function sosWorkflowMessage(m){const el=document.getElementById("sosWorkflowStatus");if(el)el.textContent=m}
async function saveTrustedContact(event){event.preventDefault();const body={name:document.getElementById("contactName").value.trim(),phone:document.getElementById("contactPhone").value.trim(),email:document.getElementById("contactEmail").value.trim(),consent_confirmed:document.getElementById("contactConsent").checked};try{await apiRequest("/api/contacts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});event.target.reset();sosWorkflowMessage("Trusted contact saved locally. No message was sent.");await refreshSOSPanel()}catch(e){sosWorkflowMessage(e.message)}}
async function recordLocalSOS(){if(!document.getElementById("sosConfirm").checked){sosWorkflowMessage("Please confirm this is a local-only demo before recording.");return}const pos=latestLivePosition||selectedPosition;if(!pos){sosWorkflowMessage("No coordinates available. Select a map point or start live tracking first.");return}if(!confirm("Record an SOS demo with these coordinates? This will NOT send SMS/email or contact emergency services."))return;const button=document.getElementById("recordLocalSOS");button.disabled=true;try{const result=await apiRequest("/api/sos",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({latitude:pos.lat,longitude:pos.lng,accuracy_m:latestLivePosition?latestLivePosition.accuracy:null,message:document.getElementById("sosMessage").value.trim(),confirm_demo:true})});sosWorkflowMessage(`${result.message} Record #${result.request.id}; status: ${result.request.status}; ${result.request.contacts_count} consented contact(s) stored in the snapshot.`);window.latestSOSRequestId=result.request.id;await loadSavedEvents();await refreshSOSPanel()}catch(e){sosWorkflowMessage(`SOS record failed: ${e.message}`)}finally{button.disabled=false}}
async function refreshNotificationConfig(){try{const r=await apiRequest("/api/notifications/config");const el=document.getElementById("notificationConfigStatus");el.textContent=`Email: SIMULATED · SMS: SIMULATED. Checking status sends no messages.`}catch(e){const el=document.getElementById("notificationConfigStatus");if(el)el.textContent=`Could not check provider configuration: ${e.message}`}}
async function sendSOSNotifications(){const id=window.latestSOSRequestId;if(!id){sosWorkflowMessage("Record a new SOS first in this browser session, then choose a notification channel.");return}if(!document.getElementById("sosNotifyConfirm").checked){sosWorkflowMessage("Explicit confirmation is required before sending notifications.");return}const channel=document.getElementById("sosNotifyChannel").value;if(!confirm(`Process SOS #${id} via ${channel.toUpperCase()} for consented contacts? Both email and SMS are simulated previews; nothing will be transmitted.`))return;const button=document.getElementById("sendSOSNotifications");button.disabled=true;try{const r=await apiRequest(`/api/sos/${id}/notify`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({channel,confirm_send:true})});sosWorkflowMessage(`${r.message} Overall status: ${r.status}. SMS is simulated; no external provider was contacted.`);const target=document.getElementById("sosHistory");const block=document.createElement("pre");block.style.whiteSpace="pre-wrap";block.textContent=JSON.stringify(r.results,null,2);target.prepend(block);await refreshSOSPanel()}catch(e){sosWorkflowMessage(`Notification not sent or partially configured: ${e.message}`)}finally{button.disabled=false;document.getElementById("sosNotifyConfirm").checked=false}}
sosButton.addEventListener("click",()=>{installSOSPanel();document.getElementById("sosWorkflowPanel").scrollIntoView({behavior:"smooth",block:"center"});sosWorkflowMessage("SOS workflow ready. Review the local-only notice before recording.")});

clearEventsButton.addEventListener("click",async()=>{if(!confirm("Delete all locally stored prototype events? This cannot be undone."))return;try{await apiRequest("/api/events",{method:"DELETE"});events=[];updateEventTable();setGeofenceMessage("Stored demo events cleared.")}catch(error){setGeofenceMessage(`Could not clear events: ${error.message}`)}});

// ============================================================
// LIVE GPS TRACKING (BROWSER LOCATION; NO CONTINUOUS BACKEND UPLOAD)
// ============================================================
const startLiveTrackingButton = $("startLiveTrackingButton");
const stopLiveTrackingButton = $("stopLiveTrackingButton");
const centreLiveLocationButton = $("centreLiveLocationButton");
const trackingModeBadge = $("trackingModeBadge");
const liveLatitude = $("liveLatitude");
const liveLongitude = $("liveLongitude");
const liveAccuracy = $("liveAccuracy");
const liveTimestamp = $("liveTimestamp");
const liveTrackingStatus = $("liveTrackingStatus");
let liveWatchId = null;
let liveMarker = null;
let lastDisplayedLivePoint = null;
let liveAccuracyCircle = null;
let latestLivePosition = null;
let lastLiveAssessmentAt = 0;
let liveAssessmentInProgress = false;
let liveGeofenceState = null;
let liveCandidateState = null;
let liveCandidateCount = 0;
let liveEventInProgress = false;

function setLiveStatus(message, type = "") {
  liveTrackingStatus.textContent = message;
  liveTrackingStatus.classList.remove("status-error", "status-success");
  if (type) liveTrackingStatus.classList.add(`status-${type}`);
}

function stopLiveTracking(showMessage = true) {
  if (liveWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(liveWatchId);
  }
  liveWatchId = null;
  startLiveTrackingButton.disabled = false;
  stopLiveTrackingButton.disabled = true;
  centreLiveLocationButton.disabled = !latestLivePosition;
  trackingModeBadge.textContent = "Tracking stopped";
  trackingModeBadge.classList.remove("is-live");
  if (showMessage) setLiveStatus("Live tracking stopped. Your last reported position remains on the map.");
}

// Use the reported accuracy radius as an uncertainty estimate. A point is
// classified only when its uncertainty circle is fully inside or outside the fence.
// Two consecutive confident readings are required to reduce GPS-jitter events.
async function processLiveGeofence(position) {
  if (!geofence) return;
  const accuracy = Number(position.accuracy);
  if (!Number.isFinite(accuracy) || accuracy < 0) {
    setGeofenceMessage("Live geofence is waiting for a valid GPS accuracy estimate.");
    return;
  }
  const distance = distanceMetres(geofence.center, L.latLng(position.lat, position.lng));
  const hysteresis = Math.max(5, Math.min(20, accuracy * 0.25));
  const clearlyInside = distance + accuracy <= geofence.radius - hysteresis;
  const clearlyOutside = distance - accuracy > geofence.radius + hysteresis;
  if (!clearlyInside && !clearlyOutside) {
    liveCandidateState = null;
    liveCandidateCount = 0;
    movementStatus.textContent = "Near boundary / GPS uncertainty";
    setGeofenceMessage(`Live GPS is within the boundary uncertainty zone (distance ${Math.round(distance)} m; accuracy ±${Math.round(accuracy)} m). No transition recorded.`);
    return;
  }
  const candidate = clearlyInside;
  if (candidate === liveCandidateState) liveCandidateCount += 1;
  else { liveCandidateState = candidate; liveCandidateCount = 1; }
  movementStatus.textContent = candidate ? "Live GPS: inside (confirming)" : "Live GPS: outside (confirming)";
  if (liveCandidateCount < 2 || liveEventInProgress) return;
  if (liveGeofenceState === null) {
    liveGeofenceState = candidate;
    movementStatus.textContent = candidate ? "Live GPS: inside geofence" : "Live GPS: outside geofence";
    await recordEvent(candidate ? "STARTED_INSIDE" : "STARTED_OUTSIDE", L.latLng(position.lat, position.lng), "LIVE_GPS", "Initial live GPS state; browser-reported accuracy ±" + Math.round(accuracy) + " m");
    return;
  }
  if (candidate === liveGeofenceState) {
    movementStatus.textContent = candidate ? "Live GPS: inside geofence" : "Live GPS: outside geofence";
    return;
  }
  liveEventInProgress = true;
  try {
    const type = candidate ? "ENTERED_GEOFENCE" : "EXITED_GEOFENCE";
    const saved = await recordEvent(type, L.latLng(position.lat, position.lng), "LIVE_GPS", "Live GPS geofence transition; browser-reported accuracy ±" + Math.round(accuracy) + " m");
    if (saved) {
      liveGeofenceState = candidate;
      movementStatus.textContent = candidate ? "Live GPS: inside geofence" : "Live GPS: outside geofence";
    }
  } finally { liveEventInProgress = false; }
}

function handleLivePosition(position) {
  const { latitude, longitude, accuracy } = position.coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    setLiveStatus("The browser returned invalid coordinates.", "error");
    return;
  }
  latestLivePosition = { lat: latitude, lng: longitude, accuracy: Number(accuracy), timestamp: position.timestamp };
  monitorJourneyPosition(latestLivePosition).catch(error => console.warn("Journey monitor error", error));
  processLiveGeofence({ lat: latitude, lng: longitude, accuracy: Number(accuracy) }).catch(error => { console.error(error); setGeofenceMessage("Live geofence processing failed: " + error.message); });
  liveLatitude.textContent = latitude.toFixed(6);
  liveLongitude.textContent = longitude.toFixed(6);
  liveAccuracy.textContent = Number.isFinite(Number(accuracy)) ? `± ${Math.round(accuracy)} m` : "Not reported";
  liveTimestamp.textContent = new Date(position.timestamp || Date.now()).toLocaleTimeString();
  // Keep the raw coordinates above, but avoid redrawing the green marker for
  // tiny GPS fluctuations. This is display filtering, not a change to GPS data.
  const reportedPoint = L.latLng(latitude, longitude);
  const displayThreshold = Math.max(3, Math.min(12, (Number(accuracy) || 0) * 0.2));
  if (!liveMarker) {
    liveMarker = L.circleMarker(reportedPoint, {
      radius: 9, color: "#064e3b", weight: 3, fillColor: "#22c55e", fillOpacity: 0.95
    }).addTo(map).bindPopup("Live device location (display-filtered)");
    lastDisplayedLivePoint = reportedPoint;
  } else if (!lastDisplayedLivePoint || distanceMetres(lastDisplayedLivePoint, reportedPoint) >= displayThreshold) {
    liveMarker.setLatLng(reportedPoint);
    lastDisplayedLivePoint = reportedPoint;
  }
  if (!liveAccuracyCircle) {
    liveAccuracyCircle = L.circle([latitude, longitude], {
      radius: Math.max(accuracy || 0, 1), color: "#16a34a", weight: 1, fillColor: "#22c55e", fillOpacity: 0.10
    }).addTo(map);
  } else {
    liveAccuracyCircle.setLatLng([latitude, longitude]);
    liveAccuracyCircle.setRadius(Math.max(Number(accuracy) || 0, 1));
  }
  centreLiveLocationButton.disabled = false;
  trackingModeBadge.textContent = "Live tracking active";
  trackingModeBadge.classList.add("is-live");
  setLiveStatus("Location updated. Coordinates show the latest browser reading; the green marker filters small GPS fluctuations.", "success");

  // Refresh grid/facility assessment at most once every 15 seconds to avoid
  // sending API requests for every GPS reading. Tracking itself remains live.
  const now = Date.now();
  if (!liveAssessmentInProgress && now - lastLiveAssessmentAt >= 15000) {
    lastLiveAssessmentAt = now;
    liveAssessmentInProgress = true;
    checkLocation(latitude, longitude).catch(console.error).finally(() => {
      liveAssessmentInProgress = false;
    });
  }
}

function handleLiveLocationError(error) {
  let message = "Unable to read the current location.";
  if (error.code === error.PERMISSION_DENIED) message = "Location permission was denied. Allow location access in your browser settings and try again.";
  else if (error.code === error.POSITION_UNAVAILABLE) message = "The device could not determine a location. Check Windows location services or try again outdoors.";
  else if (error.code === error.TIMEOUT) message = "The location request timed out. Try again or check the device's location services.";
  setLiveStatus(message, "error");
  setStatus(message);
  if (error.code === error.PERMISSION_DENIED) stopLiveTracking(false);
}

startLiveTrackingButton.addEventListener("click", () => {
  if (!navigator.geolocation) {
    setLiveStatus("This browser does not support geolocation.", "error");
    return;
  }
  if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    setLiveStatus("Browser location usually requires HTTPS or localhost. Open this app at http://127.0.0.1:5000 on this laptop.", "error");
    return;
  }
  if (liveWatchId !== null) return;
  startLiveTrackingButton.disabled = true;
  stopLiveTrackingButton.disabled = false;
  trackingModeBadge.textContent = "Requesting permission…";
  setLiveStatus("Requesting location permission. Please respond to your browser's prompt.");
  liveWatchId = navigator.geolocation.watchPosition(
    handleLivePosition,
    handleLiveLocationError,
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 3000 }
  );
});

stopLiveTrackingButton.addEventListener("click", () => stopLiveTracking());
centreLiveLocationButton.addEventListener("click", () => {
  if (!latestLivePosition) return;
  map.setView([latestLivePosition.lat, latestLivePosition.lng], 17);
  if (liveMarker) liveMarker.openPopup();
});




// ============================================================
// PHASE 1 UPGRADE: destination search and alternative routes
// Routes come from public OSRM/OpenStreetMap services. The current
// GIS backend covers Bengaluru only. Infrastructure indicators are
// not a verified crime/safety prediction.
// ============================================================
let routeLayers = [];
let routePanelInstalled = false;
let routeChoices = [];

let selectedRouteOrigin = null;
let activeJourney = null;
let journeyPersonMarker = null;
let deviationCandidateCount = 0;
let lastDeviationEventAt = 0;
let journeyStatusElement = null;
let rerouteLayers = [];
let rerouteInProgress = false;
function installRoutePlanner() {
  if (routePanelInstalled) return;
  routePanelInstalled = true;
  const panel = document.createElement("section");
  panel.id = "routePlannerPanel";
  panel.className = "route-planner-panel";
  panel.innerHTML = `
    <h3>Plan a Journey</h3>
    <p class="route-note">Your starting point is taken automatically from your current live GPS location. Start Live GPS Tracking first, then enter only your destination. Route lines and infrastructure indicators are not a verified safety prediction.</p>
    <p id="routeOriginStatus" role="status" aria-live="polite">Starting point: waiting for live GPS.</p>
    <label for="routeDestination">Destination</label>
    <input id="routeDestination" type="text" maxlength="180" placeholder="Enter destination in Bengaluru" autocomplete="street-address">
    <div class="route-actions"><button id="findRoutesButton" type="button">Find alternative routes</button><button id="clearRoutesButton" type="button" class="secondary-button">Clear routes</button></div>
    <p id="routePlannerStatus" role="status" aria-live="polite">Choose a starting point and destination to calculate routes.</p>
    <div id="journeyMonitorStatus" class="journey-monitor-status" role="status" aria-live="polite">No active journey.</div>
    <div id="routeResults"></div>`;
  const style = document.createElement("style");
  style.textContent = `
    .route-planner-panel{margin:18px 0;padding:18px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;color:#1f2937}
    .route-planner-panel h3{margin-top:0}.route-planner-panel label{display:block;font-weight:600;margin:10px 0 5px}
    .route-planner-panel input{box-sizing:border-box;width:100%;padding:11px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}
    .route-note{padding:10px;border-radius:8px;background:#fffbeb;color:#92400e;font-size:.92rem}
    .route-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.route-actions button,.route-choice button{padding:10px 13px;border:0;border-radius:8px;cursor:pointer}
    .route-actions button:first-child{background:#0f766e;color:white}.route-actions .secondary-button{background:#e2e8f0;color:#0f172a}
    .route-choice{border:1px solid #cbd5e1;border-radius:10px;padding:12px;margin:10px 0}.route-choice h4{margin:0 0 8px}
    .route-choice button{background:#0f766e;color:white;margin-top:8px}.route-choice p{margin:5px 0}.route-status-error{color:#b91c1c}.journey-monitor-status{padding:10px;margin:10px 0;border-radius:8px;background:#ecfdf5;color:#065f46}.journey-monitor-status.is-warning{background:#fff7ed;color:#9a3412}.journey-monitor-status button{margin-left:10px}.route-risk-disclaimer{padding:9px;border-radius:7px;background:#fff7ed;color:#9a3412;font-size:.9rem}.journey-person-icon-wrap{background:transparent;border:0}.journey-person-icon{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border:3px solid white;border-radius:50%;background:#0f766e;color:white;font-size:21px;line-height:1;box-shadow:0 1px 5px #0006}.reroute-panel{border:1px solid #fdba74;background:#fff7ed;padding:12px;border-radius:10px;margin:12px 0}.reroute-panel h4{margin:0 0 6px}.reroute-option{border-top:1px solid #fed7aa;padding:10px 0}.reroute-option button{background:#0f766e;color:white;border:0;border-radius:7px;padding:9px 12px;cursor:pointer}
  `;
  document.head.appendChild(style);
  const anchor = sosButton.closest("section, .card, .panel") || sosButton.parentElement;
  anchor.insertAdjacentElement("beforebegin", panel);
  $("findRoutesButton").addEventListener("click", findAlternativeRoutes);
  $("routeDestination").addEventListener("keydown", e => { if (e.key === "Enter") findAlternativeRoutes(); });
  // Starting point is always the latest live GPS position; no typed start field.
  if (latestLivePosition) {
    selectedRouteOrigin = {lat: latestLivePosition.lat, lng: latestLivePosition.lng, label: "Current live GPS location"};
    $("routeOriginStatus").textContent = `Starting point: live GPS (${selectedRouteOrigin.lat.toFixed(5)}, ${selectedRouteOrigin.lng.toFixed(5)}).`;
  }

  $("clearRoutesButton").addEventListener("click", clearRouteLayers);
}

function setRouteStatus(message, isError = false) {
  const el = $("routePlannerStatus");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("route-status-error", isError);
}

function clearRouteLayers() {
  routeLayers.forEach(layer => map.removeLayer(layer));
  routeLayers = [];
  routeChoices = [];
  const results = $("routeResults");
  if (results) results.replaceChildren();
  setRouteStatus("Route lines cleared. Your selected location and GPS tracking are unchanged.");
}

async function geocodePlace(query, placeType) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&viewbox=77.32553,13.23468,77.83696,12.65849&bounded=0&q=${encodeURIComponent(query + ", Bengaluru, Karnataka, India")}`;
  const response = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!response.ok) throw new Error(`${placeType} search is temporarily unavailable. Try again shortly.`);
  const matches = await response.json();
  if (!matches.length) throw new Error(`${placeType} not found. Try a more specific Bengaluru address or place name.`);
  return { lat: Number(matches[0].lat), lng: Number(matches[0].lon), label: matches[0].display_name };
}

function routeMetricValue(properties, keys) {
  for (const key of keys) {
    const value = Number(properties?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

async function assessRouteInfrastructure(route) {
  const coordinates = route.geometry?.coordinates || [];
  if (!coordinates.length) return { sampled: 0, covered: 0, police: 0, hospitals: 0, busStops: 0, coverage: "No route geometry" };
  const targetSamples = Math.min(7, Math.max(3, Math.ceil(route.distance / 1500)));
  const points = [];
  for (let i = 0; i < targetSamples; i++) {
    const index = Math.round(i * (coordinates.length - 1) / Math.max(1, targetSamples - 1));
    const c = coordinates[index];
    if (c && !points.some(p => p[0] === c[0] && p[1] === c[1])) points.push(c);
  }
  let covered = 0, police = 0, hospitals = 0, busStops = 0;
  for (const c of points) {
    try {
      const data = await apiRequest(`/api/assess?lat=${encodeURIComponent(c[1])}&lon=${encodeURIComponent(c[0])}`);
      const a = data.assessment || data;
      covered++;
      // Support both flat fields and nested infrastructure_counts/counts.
      const counts = a.infrastructure_counts || a.counts || {};
      police += routeMetricValue(a, ["police_count", "police_features"]) ?? routeMetricValue(counts, ["police", "police_count", "police_features"]) ?? 0;
      hospitals += routeMetricValue(a, ["hospital_count", "hospitals_count", "hospital_features"]) ?? routeMetricValue(counts, ["hospitals", "hospital", "hospital_count", "hospital_features"]) ?? 0;
      busStops += routeMetricValue(a, ["bus_stop_count", "bus_stops_count", "bus_stop_features"]) ?? routeMetricValue(counts, ["bus_stops", "bus_stop", "bus_stop_count", "bus_stop_features"]) ?? 0;
    } catch (_) {
      // Outside the currently loaded Bengaluru study area or no grid data.
    }
  }
  const coverageRatio = points.length ? covered / points.length : 0;
  const coverageLevel = coverageRatio >= 0.8 ? "Good GIS coverage" : coverageRatio >= 0.4 ? "Partial GIS coverage" : "Limited GIS coverage";
  return { sampled: points.length, covered, police, hospitals, busStops, coverageRatio, coverageLevel,
    coverage: covered === 0 ? "GIS coverage unavailable for sampled points" : `${covered}/${points.length} sampled points covered by Bengaluru GIS` };
}

function formatRouteDistance(metres) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}
function formatRouteDuration(seconds) {
  const mins = Math.round(seconds / 60);
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} hr ${mins % 60} min`;
}

async function findAlternativeRoutes() {
  installRoutePlanner();
  const destinationText = $("routeDestination").value.trim();
  if (!latestLivePosition) {
    setRouteStatus("Start Live GPS Tracking first. The starting point is taken automatically from your current location.", true);
    $("routeOriginStatus").textContent = "Starting point: live GPS is not available yet.";
    return;
  }
  const origin = {lat: latestLivePosition.lat, lng: latestLivePosition.lng, label: "Current live GPS location"};
  selectedRouteOrigin = origin;
  $("routeOriginStatus").textContent = `Starting point: live GPS (${origin.lat.toFixed(5)}, ${origin.lng.toFixed(5)}).`;
  if (!destinationText) { setRouteStatus("Enter a destination first.", true); $("routeDestination").focus(); return; }
  const button = $("findRoutesButton");
  button.disabled = true;
  clearRouteLayers();
  setRouteStatus("Using your current live GPS location and finding alternative routes…");
  try {
    const destination = await geocodePlace(destinationText, "Destination");
    const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson&alternatives=3&steps=false`;
    const response = await fetch(url);
    if (!response.ok) throw new Error("The routing service is temporarily unavailable. Please try again.");
    const routeData = await response.json();
    if (routeData.code !== "Ok" || !routeData.routes?.length) throw new Error("No driving route was found between these points.");
    const results = $("routeResults");
    results.replaceChildren();
    setRouteStatus("Routes found. Checking how much of each route is covered by the current GIS dataset…");
    const colors = ["#0f766e", "#d97706", "#2563eb"];
    for (let i = 0; i < routeData.routes.length; i++) {
      const route = routeData.routes[i];
      const layer = L.geoJSON({ type: "Feature", properties: {}, geometry: route.geometry }, {
        style: { color: colors[i % colors.length], weight: i === 0 ? 6 : 4, opacity: i === 0 ? .9 : .75, dashArray: i === 0 ? null : "8 7" }
      }).addTo(map);
      routeLayers.push(layer);
      const coverage = await assessRouteInfrastructure(route);
      routeChoices.push({ route, coverage, layer, index: i });
      const card = document.createElement("article");
      card.className = "route-choice";
      const heading = document.createElement("h4");
      heading.textContent = `${i === 0 ? "Suggested starting option" : `Alternative ${i}`} · ${formatRouteDistance(route.distance)} · ${formatRouteDuration(route.duration)}`;
      const originLine = document.createElement("p"); originLine.textContent = `Start: ${origin.label || `${origin.lat.toFixed(5)}, ${origin.lng.toFixed(5)}`}`;
      const dest = document.createElement("p"); dest.textContent = `Destination: ${destination.label}`;
      const cov = document.createElement("p"); cov.textContent = `${coverage.coverageLevel}: ${coverage.coverage}`;
      const fac = document.createElement("p"); fac.textContent = `Mapped features across covered sample cells — police: ${coverage.police}, hospitals: ${coverage.hospitals}, bus stops: ${coverage.busStops}. These are grid feature counts, not confirmed nearby response availability.`;
      const risk = document.createElement("p");
      risk.className = "route-risk-disclaimer";
      risk.textContent = "Reported-incident risk: NOT ASSESSED. This project does not yet have a connected, validated incident dataset. Infrastructure counts and GIS coverage must not be interpreted as a safe/unsafe score.";
      const show = document.createElement("button"); show.type = "button"; show.textContent = "Show this route";
      show.addEventListener("click", () => {
        const mapNavLink = document.querySelector('.side-nav .nav-link[href="#mapSection"]');
        if (mapNavLink) mapNavLink.click();
        else { location.hash = "#mapSection"; document.getElementById("mapSection")?.scrollIntoView({behavior:"smooth"}); }
        setTimeout(() => {
          if (map && typeof map.invalidateSize === "function") map.invalidateSize();
          const bounds = layer.getBounds();
          if (bounds.isValid()) map.fitBounds(bounds, { padding: [35, 35] });
          layer.bringToFront();
          facilitiesRouteGeometry = route.geometry;
          loadNearbyFacilities();
        }, 220);
      });
      const routeFacilities = document.createElement("button"); routeFacilities.type = "button"; routeFacilities.textContent = "Find facilities along this route"; routeFacilities.style.marginLeft = "8px";
      routeFacilities.addEventListener("click", () => { findFacilitiesOnRoute(route); });
      const start = document.createElement("button"); start.type = "button"; start.textContent = "Start journey on this route"; start.style.marginLeft = "8px";
      start.addEventListener("click", () => startJourney(routeChoices.find(choice => choice.route === route)));
      card.append(heading, originLine, dest, cov, fac, risk, show, routeFacilities, start); results.appendChild(card);
    }
    const allBounds = L.featureGroup(routeLayers).getBounds();
    if (allBounds.isValid()) map.fitBounds(allBounds, { padding: [30, 30] });
    setRouteStatus("Route options are displayed with GIS coverage indicators. Reported-incident risk is not assessed; do not treat infrastructure counts as proof of safety.");
  } catch (error) {
    console.error(error);
    setRouteStatus(error.message || "Could not calculate routes.", true);
  } finally { button.disabled = false; }
}


// Phase 3: client-side journey monitoring. GPS remains in this browser; only
// journey events are saved to the local SQLite event history.
function routeDistanceFromPointMetres(position, route) {
  const coords = route?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return Infinity;
  const lat0 = position.lat * Math.PI / 180;
  const scaleX = 111320 * Math.cos(lat0), scaleY = 110540;
  const px = position.lng * scaleX, py = position.lat * scaleY;
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const ax = coords[i-1][0] * scaleX, ay = coords[i-1][1] * scaleY;
    const bx = coords[i][0] * scaleX, by = coords[i][1] * scaleY;
    const dx = bx - ax, dy = by - ay;
    const denom = dx*dx + dy*dy;
    const t = denom ? Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy)/denom)) : 0;
    best = Math.min(best, Math.hypot(px-(ax+t*dx), py-(ay+t*dy)));
  }
  return best;
}

function updateJourneyStatus(message, warning=false) {
  journeyStatusElement = $("journeyMonitorStatus");
  if (!journeyStatusElement) return;
  journeyStatusElement.replaceChildren(document.createTextNode(message));
  journeyStatusElement.classList.toggle("is-warning", warning);
  if (activeJourney) {
    const end = document.createElement("button"); end.type = "button"; end.textContent = "End journey";
    end.addEventListener("click", endJourney); journeyStatusElement.appendChild(end);
  }
}

function createJourneyPersonIcon() {
  return L.divIcon({
    className: "journey-person-icon-wrap",
    html: '<div class="journey-person-icon" aria-label="Your journey location" title="Your journey location">👤</div>',
    iconSize: [38, 38],
    iconAnchor: [19, 30]
  });
}

function showJourneyPerson(position, centerMap = false) {
  if (!position || !Number.isFinite(Number(position.lat)) || !Number.isFinite(Number(position.lng))) return;
  const point = L.latLng(Number(position.lat), Number(position.lng));
  if (!journeyPersonMarker) {
    journeyPersonMarker = L.marker(point, { icon: createJourneyPersonIcon(), zIndexOffset: 1200, keyboard: true })
      .addTo(map).bindPopup("You are here · journey in progress");
  } else {
    journeyPersonMarker.setLatLng(point);
    if (!map.hasLayer(journeyPersonMarker)) journeyPersonMarker.addTo(map);
  }
  if (centerMap) map.setView(point, Math.max(map.getZoom(), 16));
}

function activateJourneyGeofence(center) {
  if (!center || !Number.isFinite(Number(center.lat)) || !Number.isFinite(Number(center.lng))) {
    setGeofenceMessage("Journey started, but a geofence could not be placed because the route start is unavailable.");
    return;
  }
  liveGeofenceState = null; liveCandidateState = null; liveCandidateCount = 0; liveEventInProgress = false;
  stopMovement(false);
  const radius = Number(radiusSelect?.value || 250);
  geofence = { center: L.latLng(Number(center.lat), Number(center.lng)), radius };
  if (geofenceCircle) map.removeLayer(geofenceCircle);
  geofenceCircle = L.circle(geofence.center, { radius, color:"#16a34a", weight:3, fillColor:"#4ade80", fillOpacity:.12 }).addTo(map);
  if (simulatedMarker) { map.removeLayer(simulatedMarker); simulatedMarker = null; }
  movementRoute = []; movementIndex = 0; previousInsideState = null;
  geofenceStatus.textContent = `Journey geofence active · ${radius} m`;
  movementStatus.textContent = "Waiting for live GPS";
  startMovementButton.disabled = true; stopMovementButton.disabled = true;
  setGeofenceMessage("Journey geofence activated automatically. Live GPS readings will be checked for boundary transitions.");
}

async function startJourney(choice) {
  if (!choice?.route) { setRouteStatus("Select a calculated route first.", true); return; }
  if (activeJourney) { setRouteStatus("End the current journey before starting another.", true); return; }

  const firstCoordinate = choice.route.geometry?.coordinates?.[0];
  const routeStart = Array.isArray(firstCoordinate) && firstCoordinate.length >= 2
    ? { lat: Number(firstCoordinate[1]), lng: Number(firstCoordinate[0]) }
    : (latestLivePosition || selectedPosition);
  activeJourney = { route: choice.route, startedAt: Date.now(), deviationCount: 0, maxDeviationM: 0 };
  deviationCandidateCount = 0;
  lastDeviationEventAt = 0;

  // IMPORTANT: the route planner lives on Overview while the map is a separate
  // navigation view. Switch to the map view before trying to centre Leaflet.
  const mapNavLink = document.querySelector('.side-nav .nav-link[href="#mapSection"]');
  if (mapNavLink) mapNavLink.click();
  else location.hash = "#mapSection";

  // Request GPS immediately (do not wait for the event API); browser permission
  // prompts must be triggered by this user action and the map should appear first.
  if (liveWatchId === null && startLiveTrackingButton) startLiveTrackingButton.click();

  // Automatically activate a LIVE geofence around the journey origin; do not start fake movement.
  activateJourneyGeofence(latestLivePosition || routeStart);
  // The selected route is the only source for facility results and map markers.
  facilitiesRouteGeometry = choice.route.geometry;
  loadNearbyFacilities().catch(error => console.warn("Route facilities could not load", error));
  // Voice listening is opt-in: if the user previously acknowledged the demo consent,
  // starting a journey starts listening without needing to press the SOS button.
  installSOSPanel();
  setTimeout(() => {
    const consent = document.getElementById("voiceSOSArm");
    if (consent?.checked && !voiceSOSArmed) startVoiceSOS();
  }, 350);

  // Wait for the navigation code to reveal the map, then refresh Leaflet's size,
  // show the journey marker and frame the selected route on the map.
  setTimeout(() => {
    if (map && typeof map.invalidateSize === "function") map.invalidateSize();
    if (routeStart) showJourneyPerson(latestLivePosition || routeStart, true);
    if (choice.layer && typeof choice.layer.getBounds === "function") {
      const bounds = choice.layer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [35, 35] });
    } else if (routeStart) {
      map.setView([routeStart.lat, routeStart.lng], Math.max(map.getZoom(), 15));
    }
    if (choice.layer && map.hasLayer(choice.layer)) choice.layer.bringToFront();
  }, 220);

  updateJourneyStatus("Journey started. The map is opening and live GPS tracking is being requested. Allow browser location permission when prompted.");
  try {
    await apiRequest("/api/events", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({event_type:"JOURNEY_STARTED", latitude:(latestLivePosition?.lat ?? routeStart?.lat ?? null), longitude:(latestLivePosition?.lng ?? routeStart?.lng ?? null), mode:"LIVE_GPS", description:"Journey monitoring started in browser; route deviation threshold 100 m."})});
    await loadSavedEvents();
  } catch (e) { console.warn("Journey start event could not be saved", e); }
  updateJourneyStatus("Journey active. The map displays your selected route; live GPS tracking is requested. Route deviation threshold is 100 m. This is not a danger prediction.");
}

async function monitorJourneyPosition(position) {
  if (!activeJourney) return;
  showJourneyPerson(position, false);
  const deviation = routeDistanceFromPointMetres(position, activeJourney.route);
  if (!Number.isFinite(deviation)) return;
  activeJourney.maxDeviationM = Math.max(activeJourney.maxDeviationM, deviation);
  if (deviation > 100) deviationCandidateCount += 1; else deviationCandidateCount = 0;
  if (deviationCandidateCount >= 2 && Date.now() - lastDeviationEventAt > 30000) {
    lastDeviationEventAt = Date.now(); activeJourney.deviationCount += 1; deviationCandidateCount = 0;
    updateJourneyStatus(`Route deviation detected: about ${Math.round(deviation)} m from the planned route. This is not a danger prediction. You can request a new route to the original destination.`, true);
    addRerouteButton(position);
    try {
      await apiRequest("/api/events", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({event_type:"ROUTE_DEVIATION", latitude:position.lat, longitude:position.lng, mode:"LIVE_GPS", description:`Browser route deviation estimate ${Math.round(deviation)} m; two consecutive readings over 100 m. Not a danger alert.`})});
      await loadSavedEvents();
    } catch (e) { console.warn("Could not save route deviation event", e); }
  } else if (deviation <= 100) {
    updateJourneyStatus(`Journey active. Approximately ${Math.round(deviation)} m from the planned route; max observed ${Math.round(activeJourney.maxDeviationM)} m.`);
  }
}

function addRerouteButton(position) {
  if (!journeyStatusElement || !activeJourney || rerouteInProgress) return;
  if (journeyStatusElement.querySelector("#requestRerouteButton")) return;
  const button = document.createElement("button");
  button.id = "requestRerouteButton";
  button.type = "button";
  button.textContent = "Find alternative routes";
  button.addEventListener("click", () => findJourneyAlternatives(position));
  journeyStatusElement.appendChild(button);
}

async function findJourneyAlternatives(position) {
  if (!activeJourney || rerouteInProgress) return;
  const oldRoute = activeJourney.route;
  const coords = oldRoute?.geometry?.coordinates || [];
  if (coords.length < 2) { updateJourneyStatus("Cannot calculate a new route because the current route has no destination geometry.", true); return; }
  const destination = coords[coords.length - 1];
  rerouteInProgress = true;
  const status = journeyStatusElement;
  const trigger = status?.querySelector("#requestRerouteButton");
  if (trigger) { trigger.disabled = true; trigger.textContent = "Finding routes…"; }
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${position.lng},${position.lat};${destination[0]},${destination[1]}?overview=full&geometries=geojson&alternatives=3&steps=false`;
    const response = await fetch(url);
    if (!response.ok) throw new Error("The routing service is temporarily unavailable.");
    const data = await response.json();
    if (data.code !== "Ok" || !Array.isArray(data.routes) || !data.routes.length) throw new Error("No alternative driving route was found from your current location.");
    const results = $("routeResults");
    let panel = $("journeyRerouteResults");
    if (!panel) { panel = document.createElement("section"); panel.id = "journeyRerouteResults"; panel.className = "reroute-panel"; results.prepend(panel); }
    panel.replaceChildren();
    const title = document.createElement("h4"); title.textContent = "Alternative routes from your current location"; panel.appendChild(title);
    const note = document.createElement("p"); note.textContent = "Choose a route to update journey monitoring. These are ordinary driving routes; incident-based safety risk is not assessed."; panel.appendChild(note);
    const colors = ["#7c3aed", "#2563eb", "#b45309"];
    data.routes.forEach((route, index) => {
      const layer = L.geoJSON({type:"Feature", properties:{}, geometry:route.geometry}, {style:{color:colors[index % colors.length],weight: index === 0 ? 6 : 4,opacity:.9,dashArray:index===0?null:"7 6"}}).addTo(map);
      rerouteLayers.push(layer);
      const option = document.createElement("div"); option.className = "reroute-option";
      const detail = document.createElement("p"); detail.textContent = `${index === 0 ? "Suggested route" : `Alternative ${index}`} · ${formatRouteDistance(route.distance)} · ${formatRouteDuration(route.duration)}`;
      const show = document.createElement("button"); show.type="button"; show.textContent="Show route"; show.addEventListener("click",()=>map.fitBounds(layer.getBounds(),{padding:[30,30]}));
      const choose = document.createElement("button"); choose.type="button"; choose.textContent="Use this route"; choose.style.marginLeft="8px";
      choose.addEventListener("click", async () => {
        if (!activeJourney) { setRouteStatus("This journey has ended. Start a journey before selecting a reroute.", true); return; }
        activeJourney.route = route;
        activeJourney.rerouteCount = (activeJourney.rerouteCount || 0) + 1;
        deviationCandidateCount = 0;
        routeLayers.forEach(l => { try { l.setStyle({opacity:.35,weight:3}); } catch (_) {} });
        layer.setStyle({color:"#0f766e",weight:7,opacity:1,dashArray:null});
        map.fitBounds(layer.getBounds(),{padding:[35,35]});
        panel.replaceChildren();
        updateJourneyStatus(`Alternative route selected (${formatRouteDistance(route.distance)}, ${formatRouteDuration(route.duration)}). Journey monitoring continues on the updated route.`);
        try {
          await apiRequest("/api/events", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({event_type:"ROUTE_REPLANNED",latitude:position.lat,longitude:position.lng,mode:"LIVE_GPS",description:`User selected an alternative route during journey; route distance ${Math.round(route.distance)} m and estimated duration ${Math.round(route.duration)} seconds. No incident-risk assessment was used.`})});
          await loadSavedEvents();
        } catch (e) { console.warn("Could not save reroute event",e); }
      });
      option.append(detail,show,choose); panel.appendChild(option);
    });
    map.fitBounds(L.featureGroup(rerouteLayers.slice(-data.routes.length)).getBounds(),{padding:[30,30]});
    setRouteStatus("Alternative routes are available. Select Use this route to update active journey monitoring.");
  } catch (error) {
    updateJourneyStatus(`Could not calculate alternative routes: ${error.message}`, true);
  } finally {
    rerouteInProgress = false;
    const current = journeyStatusElement?.querySelector("#requestRerouteButton");
    if (current) { current.disabled = false; current.textContent = "Find alternative routes"; }
  }
}

async function endJourney() {
  if (!activeJourney) return;
  const journey = activeJourney; activeJourney = null; deviationCandidateCount = 0;
  const elapsed = Math.max(0, Math.round((Date.now() - journey.startedAt)/1000));
  updateJourneyStatus(`Journey ended. Duration: ${Math.floor(elapsed/60)} min ${elapsed%60} sec; deviation events: ${journey.deviationCount}; maximum observed deviation: ${Math.round(journey.maxDeviationM)} m. Live GPS tracking remains on until you stop it.`);
  try {
    await apiRequest("/api/events", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({event_type:"JOURNEY_COMPLETED", latitude:latestLivePosition?.lat ?? null, longitude:latestLivePosition?.lng ?? null, mode:"LIVE_GPS", description:`Journey ended; duration ${elapsed} seconds; ${journey.deviationCount} deviation event(s); ${journey.rerouteCount || 0} reroute(s); maximum observed deviation ${Math.round(journey.maxDeviationM)} m.`})});
    await loadSavedEvents();
  } catch (e) { console.warn("Could not save journey completion", e); }
}

async function initializeApplication(){installRoutePlanner();await loadBoundary();await loadSavedEvents();if(selectedPosition===null){selectedPosition={lat:12.9716,lng:77.5946};selectedLocation.textContent="Demo point ready: 12.971600, 77.594600. Click the map or choose a location to assess."}console.log("AbhayaSetu frontend initialized.")}
window.startAbhayaSetu = initializeApplication;
