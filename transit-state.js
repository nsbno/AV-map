class AvLocalStore {
  constructor() {
    this.memory = new Map();
    this.ready = new Promise(resolve => {
      try {
        const request = indexedDB.open('av-analysis-data', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('entries');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }

  async get(key, maxAge) {
    let entry = this.memory.get(key);
    if (!entry) {
      const database = await this.ready;
      if (database) entry = await new Promise(resolve => {
        const request = database.transaction('entries').objectStore('entries').get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
      if (entry) this.memory.set(key, entry);
    }
    return entry && Date.now() - entry.at < maxAge ? entry.value : null;
  }

  async set(key, value) {
    const entry = { at: Date.now(), value };
    this.memory.set(key, entry);
    if (this.memory.size > 150) this.memory.delete(this.memory.keys().next().value);
    const database = await this.ready;
    if (!database) return;
    try {
      await new Promise(resolve => {
        const transaction = database.transaction('entries', 'readwrite');
        const store = transaction.objectStore('entries');
        store.put(entry, key);
        const request = store.openCursor();
        const entries = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) { entries.push({ key: cursor.key, at: cursor.value.at }); cursor.continue(); }
          else entries.sort((first, second) => second.at - first.at).slice(150).forEach(item => store.delete(item.key));
        };
        transaction.oncomplete = resolve;
        transaction.onerror = resolve;
        transaction.onabort = resolve;
      });
    } catch {}
  }
}

class AvTransitMotion {
  constructor() {
    this.tracks = new Map();
    this.journeys = new Map();
    this.horizonMs = 5 * 60 * 1000;
  }

  key(vehicle) { return (vehicle.line?.lineRef || '') + '|' + vehicle.vehicleId; }

  update(vehicles) {
    const present = new Set();
    vehicles.forEach(vehicle => {
      const key = this.key(vehicle);
      present.add(key);
      const previous = this.tracks.get(key);
      if (previous && previous.vehicle.lastUpdated === vehicle.lastUpdated && previous.vehicle.serviceJourney?.id === vehicle.serviceJourney?.id) return;
      const track = { vehicle, observedAt: Date.parse(vehicle.lastUpdated), measuredKmPerMs: null };
      if (!Number.isFinite(track.observedAt)) return;
      if (previous?.vehicle.serviceJourney?.id === vehicle.serviceJourney?.id) {
        const elapsed = track.observedAt - previous.observedAt;
        const distance = turf.distance([previous.vehicle.location.longitude, previous.vehicle.location.latitude], [vehicle.location.longitude, vehicle.location.latitude]);
        if (elapsed >= 5000 && elapsed <= 180000 && distance / elapsed * 3600000 <= 90) track.measuredKmPerMs = distance / elapsed;
      }
      this.prepare(track);
      this.tracks.set(key, track);
    });
    this.tracks.forEach((track, key) => { if (!present.has(key)) this.tracks.delete(key); });
  }

  setJourney(id, journey) {
    this.journeys.set(id, journey);
    this.tracks.forEach(track => { if (track.vehicle.serviceJourney?.id === id) this.prepare(track); });
  }

  prepare(track) {
    track.route = null;
    track.timeline = [];
    const journey = this.journeys.get(track.vehicle.serviceJourney?.id);
    if (!journey?.geometry) return;
    const route = journey.geometry;
    const anchor = turf.nearestPointOnLine(route, [track.vehicle.location.longitude, track.vehicle.location.latitude]);
    if (anchor.properties.dist > 0.05) return;
    const location = anchor.properties.location;
    const length = turf.length(route);
    const direction = turf.bearing(turf.along(route, Math.max(0, location - 0.01)), turf.along(route, Math.min(length, location + 0.01)));
    if (Number.isFinite(track.vehicle.bearing) && Math.abs(((direction - track.vehicle.bearing + 540) % 360) - 180) > 100) return;
    track.route = route;
    track.location = location;
    track.length = length;
    const timeline = [{ at: track.observedAt, location }];
    (journey.calls || []).forEach(call => {
      if (!Number.isFinite(call.quay?.longitude) || !Number.isFinite(call.quay?.latitude)) return;
      const stop = turf.nearestPointOnLine(route, [call.quay.longitude, call.quay.latitude]);
      if (stop.properties.dist > 0.08) return;
      const stopLocation = stop.properties.location;
      const arrival = Date.parse(call.expectedArrivalTime || call.expectedDepartureTime);
      const departure = Date.parse(call.expectedDepartureTime || call.expectedArrivalTime);
      let last = timeline.at(-1);
      if (stopLocation < last.location - 0.015) return;
      if (Math.abs(stopLocation - location) <= 0.015 && arrival <= track.observedAt && departure > track.observedAt) {
        timeline.push({ at: departure, location });
        return;
      }
      if (arrival > last.at && stopLocation >= last.location) {
        const speed = (stopLocation - last.location) / (arrival - last.at) * 3600000;
        if (speed > 90) return;
        timeline.push({ at: arrival, location: stopLocation });
      }
      last = timeline.at(-1);
      if (Math.abs(last.location - stopLocation) < 0.015 && departure > last.at) timeline.push({ at: departure, location: last.location });
    });
    track.timeline = timeline;
  }

  sample(now = Date.now()) {
    return [...this.tracks.values()].map(track => {
      const vehicle = structuredClone(track.vehicle);
      const age = Math.max(0, now - track.observedAt);
      const at = Math.min(now, track.observedAt + this.horizonMs);
      vehicle.positionKind = age >= this.horizonMs ? 'stale' : 'observed';
      vehicle.estimationMethod = 'Siste rapporterte GPS-posisjon';
      if (!track.route || age <= 1000) return vehicle;
      let location = track.location;
      let method = null;
      const timeline = track.timeline;
      if (timeline.length > 1) {
        const next = timeline.findIndex(point => point.at >= at);
        if (next > 0) {
          const before = timeline[next - 1], after = timeline[next];
          const progress = Math.max(0, Math.min(1, (at - before.at) / (after.at - before.at)));
          location = before.location + (after.location - before.location) * progress;
        } else location = timeline.at(-1).location;
        method = 'Estimert langs reisens trasé fra siste GPS og Enturs stoppetider';
      } else if (track.measuredKmPerMs !== null) {
        location = Math.min(track.length, track.location + track.measuredKmPerMs * Math.max(0, at - track.observedAt));
        method = 'Estimert langs reisens trasé fra to rapporterte GPS-posisjoner';
      }
      if (!method) return vehicle;
      const point = turf.along(track.route, location);
      vehicle.location = { longitude: point.geometry.coordinates[0], latitude: point.geometry.coordinates[1] };
      vehicle.bearing = (turf.bearing(turf.along(track.route, Math.max(0, location - 0.005)), turf.along(track.route, Math.min(track.length, location + 0.005))) + 360) % 360;
      vehicle.positionKind = age >= this.horizonMs ? 'stale' : 'estimated';
      vehicle.estimationMethod = method;
      return vehicle;
    });
  }
}