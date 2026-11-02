class AvMapEngine {
  constructor(container) {
    this.boundIds = new Set();
    this.map = new maplibregl.Map({
      container,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [10.7522, 59.9139],
      zoom: 15.2,
      pitch: 0,
      bearing: 0,
      maxPitch: 75,
      antialias: true,
      attributionControl: false
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    this.ready = new Promise((resolve, reject) => {
      let fallbackStarted = false;
      let settled = false;
      let startupTimer;
      const failStartup = error => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        this.map.off('error', failed);
        this.map.off('load', loaded);
        reject(error);
      };
      const fallbackStyle = {
        version: 8,
        sources: {
          'av-fallback': {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '&copy; OpenStreetMap contributors'
          }
        },
        layers: [{ id: 'av-fallback', type: 'raster', source: 'av-fallback' }]
      };
      const useFallback = error => {
        if (fallbackStarted) {
          failStartup(error);
          return;
        }
        fallbackStarted = true;
        this.fallbackUsed = true;
        console.warn('Vektorkart kunne ikke lastes; bruker reservekart.', error);
        this.map.getContainer().dispatchEvent(new CustomEvent('av-map-fallback'));
        clearTimeout(startupTimer);
        startupTimer = setTimeout(() => failStartup(new Error('Bakgrunnskartet kunne ikke lastes. Kontroller nettforbindelsen og last siden på nytt.')), 15000);
        try { this.map.setStyle(fallbackStyle); }
        catch (fallbackError) { failStartup(fallbackError); }
      };
      const failed = event => {
        if (settled) return;
        if (!fallbackStarted) useFallback(event.error || new Error('Vektorkartet rapporterte en oppstartsfeil.'));
        else console.warn('Reservekartressurs:', event.error?.message);
      };
      const loaded = () => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        this.map.off('error', failed);
        try {
          if (this.map.getLayer('building-3d')) {
            this.map.setPaintProperty('building-3d', 'fill-extrusion-height', ['coalesce', ['get', 'render_height'], 5]);
            this.map.setPaintProperty('building-3d', 'fill-extrusion-base', ['coalesce', ['get', 'render_min_height'], 0]);
          }
          this.map.setLight({ anchor: 'viewport', color: '#fff9ed', intensity: 0.4, position: [1.5, 180, 45] });
        } catch (error) { console.warn('Terreng kunne ikke aktiveres; bakgrunnskartet vises likevel.', error); }
        try {
          MapboxDraw.constants.classes.CANVAS = 'maplibregl-canvas';
          MapboxDraw.constants.classes.CONTROL_BASE = 'maplibregl-ctrl';
          MapboxDraw.constants.classes.CONTROL_PREFIX = 'maplibregl-ctrl-';
          MapboxDraw.constants.classes.CONTROL_GROUP = 'maplibregl-ctrl-group';
          MapboxDraw.constants.classes.ATTRIBUTION = 'maplibregl-ctrl-attrib';
          const lockedSelection = {
            ...MapboxDraw.modes.simple_select,
            onMouseDown() {}, onTouchStart() {}, onDrag() {}, onTouchMove() {}, clickOnVertex() {},
            clickOnFeature(state, event) { this.setSelected([event.featureTarget.properties.id]); },
            toDisplayFeatures(state, feature, display) {
              feature.properties.active = this.isSelected(feature.properties.id) ? 'true' : 'false';
              display(feature);
            }
          };
          const clickOnlyPolygon = {
            ...MapboxDraw.modes.draw_polygon,
            onMouseMove() {},
            onTouchMove() {}
          };
          this.draw = new MapboxDraw({ displayControlsDefault: false, controls: {}, userProperties: true,
            modes: { ...MapboxDraw.modes, simple_select: lockedSelection, draw_polygon: clickOnlyPolygon }, styles: [
            { id: 'av-draw-area', type: 'fill', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#12826c', 'fill-opacity': 0.12 } },
            { id: 'av-draw-line', type: 'line', filter: ['!=', '$type', 'Point'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#12826c', 'line-width': 3 } },
            { id: 'av-draw-vertex', type: 'circle', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#12826c', 'circle-stroke-width': 2 } }
          ] });
          this.map.addControl(this.draw);
        } catch (error) { console.warn('Tegneverktøy kunne ikke aktiveres.', error); }
        this.map.on('webglcontextlost', () => {
          this.map.getContainer().dispatchEvent(new CustomEvent('av-map-error', { detail: 'WebGL ble avbrutt. Last siden pa nytt.' }));
        });
        resolve(this);
      };
      this.map.on('error', failed);
      this.map.once('load', loaded);
      startupTimer = setTimeout(() => useFallback(new Error('Tidsavbrudd ved lasting av vektorkartet.')), 15000);
    });
  }

  setGeoJSON(id, features, color = '#117e68', kind = 'mixed') {
    const data = { type: 'FeatureCollection', features };
    if (this.map.getSource(id)) {
      this.map.getSource(id).setData(data);
      return;
    }
    this.map.addSource(id, { type: 'geojson', data });
    if (kind === 'vehicles') {
      this.map.addLayer({ id: id + '-body', type: 'fill-extrusion', source: id, paint: {
        'fill-extrusion-color': color, 'fill-extrusion-height': 3.2, 'fill-extrusion-base': 0.3, 'fill-extrusion-opacity': 0.95
      } });
      return;
    }
    if (kind === 'accident-grid') {
      this.map.addLayer({ id: id + '-area', type: 'fill', source: id, maxzoom: 13.2, paint: {
        'fill-color': ['interpolate', ['linear'], ['get', 'annualAverage'], 0.1, '#f4c76d', 0.3, '#ed8b3b', 0.7, '#d34f3f', 1.5, '#8e2935'],
        'fill-opacity': 0.55
      } });
      this.map.addLayer({ id: id + '-line', type: 'line', source: id, maxzoom: 13.2, layout: { 'line-join': 'round' }, paint: {
        'line-color': '#8e2935', 'line-width': 0.5, 'line-opacity': 0.45
      } });
      return;
    }
    if (kind === 'accident-points') {
      this.map.addLayer({ id: id + '-point', type: 'circle', source: id, minzoom: 13.2, paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 3, 17, 6], 'circle-color': color,
        'circle-stroke-width': 1.5, 'circle-stroke-color': '#ffffff', 'circle-opacity': 0.9
      } });
      return;
    }
    if (kind === 'complexity') {
      const featureColor = ['coalesce', ['get', 'color'], color];
      this.map.addLayer({ id: id + '-area', type: 'fill', source: id, filter: ['==', '$type', 'Polygon'], maxzoom: 14.2, paint: {
        'fill-color': featureColor, 'fill-opacity': 0.46, 'fill-outline-color': '#ffffff'
      } });
      this.map.addLayer({ id: id + '-line', type: 'line', source: id, filter: ['==', '$type', 'LineString'], minzoom: 14.2, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
        'line-color': featureColor, 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 3, 17, 6], 'line-opacity': 0.92
      } });
      return;
    }
    if (kind === 'waymo-coverage') {
      this.map.addLayer({ id: id + '-area', type: 'fill', source: id, filter: ['==', '$type', 'Polygon'], paint: {
        'fill-color': '#6db69a', 'fill-opacity': 0.1,
        'fill-outline-color': ['coalesce', ['get', 'complexityColor'], '#485d65']
      } });
      this.map.addLayer({ id: id + '-line', type: 'line', source: id, filter: ['==', '$type', 'Polygon'], layout: { 'line-join': 'round' }, paint: {
        'line-color': ['coalesce', ['get', 'complexityColor'], '#485d65'], 'line-width': 3, 'line-opacity': 0.95
      } });
      return;
    }
    if (kind === 'waymo') {
      this.map.addLayer({ id: id + '-area', type: 'fill', source: id, filter: ['==', '$type', 'Polygon'], paint: {
        'fill-color': ['coalesce', ['get', 'milesColor'], '#6db69a'], 'fill-opacity': 0.3,
        'fill-outline-color': ['coalesce', ['get', 'complexityColor'], '#718087']
      } });
      this.map.addLayer({ id: id + '-line', type: 'line', source: id, filter: ['==', '$type', 'Polygon'], layout: { 'line-join': 'round' }, paint: {
        'line-color': ['coalesce', ['get', 'complexityColor'], '#718087'], 'line-width': 1.2, 'line-opacity': 0.9
      } });
      return;
    }
    this.map.addLayer({ id: id + '-area', type: 'fill', source: id, filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': color, 'fill-opacity': 0.12 } });
    this.map.addLayer({ id: id + '-line', type: 'line', source: id, filter: ['!=', '$type', 'Point'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
      'line-color': ['coalesce', ['get', 'color'], color], 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2, 15, 5], 'line-opacity': 0.9
    } });
    this.map.addLayer({ id: id + '-point', type: 'circle', source: id, filter: ['==', '$type', 'Point'], paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 8], 'circle-color': color, 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff'
    } });
  }

  clear(id) {
    ['-area', '-line', '-point', '-body'].forEach(suffix => {
      if (this.map.getLayer(id + suffix)) this.map.removeLayer(id + suffix);
    });
    if (this.map.getSource(id)) this.map.removeSource(id);
  }

  setVehicleModels(vehicles) {
    if (!globalThis.THREE) return false;
    if (!this.busLayer) {
      const engine = this;
      const template = this.createBusModel();
      const layer = {
        id: 'av-bus-models', type: 'custom', renderingMode: '3d', models: new Map(),
        onAdd(map, gl) {
          this.map = map;
          this.camera = new THREE.Camera();
          this.scene = new THREE.Scene();
          this.scene.add(new THREE.AmbientLight(0xffffff, 2));
          const sunlight = new THREE.DirectionalLight(0xfff5df, 2.5);
          sunlight.position.set(-50, 30, 100);
          this.scene.add(sunlight);
          this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
          this.renderer.autoClear = false;
        },
        render(gl, args) {
          if (!this.origin || !this.models.size) return;
          const matrix = args.defaultProjectionData?.mainMatrix || args;
          const transform = new THREE.Matrix4().makeTranslation(this.origin.x, this.origin.y, 0)
            .scale(new THREE.Vector3(this.meterScale, -this.meterScale, this.meterScale));
          this.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(transform);
          this.models.forEach(entry => {
            entry.model.position.z = engine.map.getTerrain() ? engine.map.queryTerrainElevation(entry.coordinates) || 0 : 0;
          });
          this.renderer.resetState();
          this.renderer.render(this.scene, this.camera);
        },
        onRemove() {
          const resources = new Set();
          template.traverse(object => {
            if (object.geometry) resources.add(object.geometry);
            if (object.material) resources.add(object.material);
          });
          resources.forEach(resource => resource.dispose());
          this.renderer.dispose();
        }
      };
      this.busLayer = layer;
      this.map.addLayer(layer);
      this.busTemplate = template;
    }
    const layer = this.busLayer;
    const ids = new Set();
    vehicles.forEach(vehicle => {
      const id = (vehicle.line?.lineRef || '') + '|' + vehicle.vehicleId;
      ids.add(id);
      const coordinates = [vehicle.location.longitude, vehicle.location.latitude];
      const position = maplibregl.MercatorCoordinate.fromLngLat(coordinates);
      if (!layer.origin) {
        layer.origin = position;
        layer.meterScale = position.meterInMercatorCoordinateUnits();
      }
      let entry = layer.models.get(id);
      if (!entry) {
        entry = { model: this.busTemplate.clone(true), coordinates };
        layer.models.set(id, entry);
        layer.scene.add(entry.model);
      }
      entry.coordinates = coordinates;
      entry.model.position.set((position.x - layer.origin.x) / layer.meterScale, -(position.y - layer.origin.y) / layer.meterScale, 0);
      if (Number.isFinite(vehicle.bearing)) entry.model.rotation.z = -vehicle.bearing * Math.PI / 180;
    });
    layer.models.forEach((entry, id) => {
      if (!ids.has(id)) { layer.scene.remove(entry.model); layer.models.delete(id); }
    });
    this.map.triggerRepaint();
    return true;
  }

  createBusModel() {
    const model = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({ color: '#198c79', roughness: 0.45, metalness: 0.15 });
    const roof = new THREE.MeshStandardMaterial({ color: '#e7eeeb', roughness: 0.65 });
    const glass = new THREE.MeshStandardMaterial({ color: '#203f51', roughness: 0.18, metalness: 0.35 });
    const rubber = new THREE.MeshStandardMaterial({ color: '#202629', roughness: 0.9 });
    const metal = new THREE.MeshStandardMaterial({ color: '#a6b3b7', roughness: 0.3, metalness: 0.7 });
    const headlight = new THREE.MeshStandardMaterial({ color: '#fff9da', emissive: '#fff0b0', emissiveIntensity: 0.6 });
    const taillight = new THREE.MeshStandardMaterial({ color: '#c52a34', emissive: '#9d1420', emissiveIntensity: 0.5 });
    const box = (width, length, height, position, material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, length, height), material);
      mesh.position.set(...position);
      model.add(mesh);
    };
    box(2.5, 11.9, 1.6, [0, 0, 1.35], paint);
    box(2.45, 11.8, 0.95, [0, 0, 2.55], paint);
    box(2.55, 12, 0.18, [0, 0, 3.1], roof);
    box(1.35, 2.5, 0.25, [0, -1, 3.31], roof);
    box(2.2, 0.04, 0.95, [0, 5.96, 2.43], glass);
    box(1.9, 0.04, 0.8, [0, -5.96, 2.4], glass);
    [-1, 1].forEach(side => {
      [-4.4, -3, -1.6, -0.2, 1.2, 2.6, 4].forEach(offset => {
        box(0.04, 1.15, 0.8, [side * 1.235, offset, 2.5], glass);
      });
      box(0.28, 0.35, 0.45, [side * 1.48, 5.3, 2.35], glass);
      box(0.1, 0.55, 0.1, [side * 1.32, 5.25, 2.6], metal);
      [-3.9, 3.8].forEach(offset => {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.23, 16), rubber);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(side * 1.2, offset, 0.5);
        model.add(wheel);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.245, 12), metal);
        hub.rotation.z = Math.PI / 2;
        hub.position.copy(wheel.position);
        model.add(hub);
      });
      box(0.38, 0.05, 0.2, [side * 0.85, 5.98, 0.97], headlight);
      box(0.2, 0.05, 0.45, [side * 1.02, -5.98, 1.15], taillight);
    });
    [-1.1, 3.8].forEach(offset => {
      box(0.055, 1.05, 1.95, [1.26, offset, 1.72], rubber);
      box(0.06, 0.42, 1.65, [1.29, offset - 0.25, 1.78], glass);
      box(0.06, 0.42, 1.65, [1.29, offset + 0.25, 1.78], glass);
    });
    return model;
  }

  visible(id, visible) {
    if (id === 'vehicles' && this.map.getLayer('av-bus-models')) this.map.setLayoutProperty('av-bus-models', 'visibility', visible ? 'visible' : 'none');
    ['-area', '-line', '-point', '-body'].forEach(suffix => {
      if (this.map.getLayer(id + suffix)) this.map.setLayoutProperty(id + suffix, 'visibility', visible ? 'visible' : 'none');
    });
  }

  onFeature(id, callback) {
    if (this.boundIds.has(id)) return;
    this.boundIds.add(id);
    ['-area', '-line', '-point', '-body'].forEach(suffix => {
      const layerId = id + suffix;
      if (!this.map.getLayer(layerId)) return;
      this.map.on('click', layerId, event => {
        if (this.draw.getMode() !== 'simple_select' || this.waypointMode) return;
        if (event.features.length) callback(event.features[0], event.lngLat);
      });
      this.map.on('mouseenter', layerId, () => { this.map.getCanvas().style.cursor = 'pointer'; });
      this.map.on('mouseleave', layerId, () => { this.map.getCanvas().style.cursor = ''; });
    });
  }

  fit(feature) {
    const bounds = turf.bbox(feature);
    this.map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 65, maxZoom: 16, duration: 900 });
  }

  view3d(enabled) {
    this.map.easeTo({ pitch: enabled ? 55 : 0, bearing: enabled ? -18 : 0, duration: 800 });
    this.map.setLayoutProperty('building-3d', 'visibility', enabled ? 'visible' : 'none');
  }

  terrain(enabled) {
    if (enabled && !this.map.getSource('av-terrain')) {
      const terrain = { type: 'raster-dem', tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'], tileSize: 512, maxzoom: 12, encoding: 'terrarium', attribution: '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>' };
      this.map.addSource('av-terrain', terrain);
      const hillshade = { id: 'av-hillshade', source: 'av-terrain', type: 'hillshade', layout: { visibility: 'visible' }, paint: { 'hillshade-exaggeration': 0.18 } };
      if (this.map.getLayer('building')) this.map.addLayer(hillshade, 'building');
      else this.map.addLayer(hillshade);
    }
    this.map.setTerrain(enabled ? { source: 'av-terrain', exaggeration: 1 } : null);
    if (this.map.getLayer('av-hillshade')) this.map.setLayoutProperty('av-hillshade', 'visibility', enabled ? 'visible' : 'none');
  }

  popup(coordinates, content) {
    if (this.activePopup) this.activePopup.remove();
    this.activePopup = new maplibregl.Popup({ maxWidth: '320px' }).setLngLat(coordinates).setDOMContent(content).addTo(this.map);
  }
}