/* Haze Tracker SG - shared logic (runs in both the page and the service worker). */
(function (root) {
  'use strict';

  var API = 'https://api-open.data.gov.sg/v2/real-time/api/';
  var REGIONS = ['central', 'north', 'south', 'east', 'west'];
  var REGION_LABELS = {
    any: 'Singapore (highest region)',
    central: 'Central', north: 'North', south: 'South', east: 'East', west: 'West'
  };
  var METRIC_LABELS = { psi24: '24-hr PSI', psi1: '1-hr PSI (est.)' };

  var PSI_BANDS = [
    { max: 50, key: 'good', label: 'Good', color: '#2e9e5b' },
    { max: 100, key: 'moderate', label: 'Moderate', color: '#2f7fd1' },
    { max: 200, key: 'unhealthy', label: 'Unhealthy', color: '#d99a0b' },
    { max: 300, key: 'very-unhealthy', label: 'Very unhealthy', color: '#e2542b' },
    { max: Infinity, key: 'hazardous', label: 'Hazardous', color: '#9b2c4f' }
  ];
  var PM25_BANDS = [
    { max: 55, label: 'Normal' },
    { max: 150, label: 'Elevated' },
    { max: 250, label: 'High' },
    { max: Infinity, label: 'Very high' }
  ];

  function psiBand(psi) {
    if (psi == null) return null;
    for (var i = 0; i < PSI_BANDS.length; i++) if (psi <= PSI_BANDS[i].max) return PSI_BANDS[i];
    return PSI_BANDS[PSI_BANDS.length - 1];
  }
  function pm25Band(c) {
    if (c == null) return null;
    for (var i = 0; i < PM25_BANDS.length; i++) if (c <= PM25_BANDS[i].max) return PM25_BANDS[i];
    return PM25_BANDS[PM25_BANDS.length - 1];
  }

  // NEA PSI sub-index breakpoints for PM2.5 (ug/m3 -> PSI), linear between points.
  var PM25_BREAKPOINTS = [[0, 0], [12, 50], [55, 100], [150, 200], [250, 300], [350, 400], [500, 500]];
  function pm25ToPsi(c) {
    if (c == null || isNaN(c)) return null;
    if (c <= 0) return 0;
    for (var i = 1; i < PM25_BREAKPOINTS.length; i++) {
      if (c <= PM25_BREAKPOINTS[i][0]) {
        var a = PM25_BREAKPOINTS[i - 1], b = PM25_BREAKPOINTS[i];
        return Math.round(a[1] + (c - a[0]) * (b[1] - a[1]) / (b[0] - a[0]));
      }
    }
    return Math.round(500 + (c - 500));
  }

  /* ---------- NEA data ---------- */
  function latestItem(json) {
    var items = json && json.data && json.data.items;
    if (!items || !items.length) throw new Error('No readings returned');
    return items.reduce(function (a, b) { return (b.timestamp > a.timestamp ? b : a); });
  }

  function fetchJson(name) {
    return fetch(API + name, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (j.code !== 0 && j.code !== undefined) throw new Error(name + ': ' + (j.errorMsg || 'API error'));
      return latestItem(j);
    });
  }

  // Resolves to { psi24, pm25, psi1, psiTimestamp, pm25Timestamp, fetchedAt, errors[] }.
  function fetchData() {
    return Promise.allSettled([fetchJson('psi'), fetchJson('pm25')]).then(function (res) {
      var data = { psi24: null, pm25: null, psi1: null, psiTimestamp: null, pm25Timestamp: null, fetchedAt: Date.now(), errors: [] };
      if (res[0].status === 'fulfilled') {
        data.psi24 = res[0].value.readings.psi_twenty_four_hourly || null;
        data.psiTimestamp = res[0].value.timestamp;
      } else data.errors.push(String(res[0].reason && res[0].reason.message || res[0].reason));
      if (res[1].status === 'fulfilled') {
        data.pm25 = res[1].value.readings.pm25_one_hourly || null;
        data.pm25Timestamp = res[1].value.timestamp;
        if (data.pm25) {
          data.psi1 = {};
          Object.keys(data.pm25).forEach(function (k) { data.psi1[k] = pm25ToPsi(data.pm25[k]); });
        }
      } else data.errors.push(String(res[1].reason && res[1].reason.message || res[1].reason));
      if (!data.psi24 && !data.pm25) throw new Error(data.errors.join('; ') || 'No data');
      return data;
    });
  }

  // metric: 'psi24' | 'psi1'; region: a region name or 'any' (highest across regions)
  function getValue(data, metric, region) {
    var map = data && data[metric];
    if (!map) return null;
    if (region === 'any') {
      var vals = REGIONS.map(function (r) { return map[r]; }).filter(function (v) { return typeof v === 'number'; });
      return vals.length ? Math.max.apply(null, vals) : null;
    }
    return typeof map[region] === 'number' ? map[region] : null;
  }

  /* ---------- Settings & state (IndexedDB so the service worker can read them) ---------- */
  var DEFAULT_SETTINGS = { enabled: false, region: 'any', metric: 'psi24', threshold: 101 };

  function openDb() {
    return new Promise(function (resolve, reject) {
      var r = indexedDB.open('haze-tracker', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function kvGet(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var q = db.transaction('kv').objectStore('kv').get(key);
        q.onsuccess = function () { resolve(q.result); };
        q.onerror = function () { reject(q.error); };
      });
    });
  }
  function kvSet(key, value) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function getSettings() { return kvGet('settings').then(function (s) { return Object.assign({}, DEFAULT_SETTINGS, s || {}); }); }
  function setSettings(s) { return kvSet('settings', s); }
  function getState() { return kvGet('state').then(function (s) { return s || { alerted: false }; }); }
  function setState(s) { return kvSet('state', s); }

  /* ---------- Threshold logic ---------- */
  // Notify once when the value reaches the threshold; re-arm when it drops below.
  function evaluate(data, settings, state) {
    var value = getValue(data, settings.metric, settings.region);
    var next = Object.assign({}, state);
    var notify = false;
    if (value == null) return { value: null, notify: false, state: next };
    var over = value >= settings.threshold;
    if (over && !state.alerted) { notify = true; next.alerted = true; next.lastNotifiedAt = Date.now(); }
    else if (!over && state.alerted) next.alerted = false;
    next.lastValue = value;
    return { value: value, notify: notify, state: next };
  }

  function buildNotification(settings, value) {
    var band = psiBand(value);
    return {
      title: 'Haze alert: PSI ' + value + ' (' + band.label + ')',
      options: {
        body: REGION_LABELS[settings.region] + ' - ' + METRIC_LABELS[settings.metric] + ' is ' + value +
          ', at or above your threshold of ' + settings.threshold + '.',
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        tag: 'haze-alert',
        renotify: true,
        data: { url: './' }
      }
    };
  }

  // Fetch fresh data, evaluate the user's alert rule, and notify via show(title, options).
  function runCheck(show) {
    return Promise.all([getSettings(), getState(), fetchData()]).then(function (r) {
      var settings = r[0], state = r[1], data = r[2];
      var canNotify = !root.Notification || root.Notification.permission === 'granted';
      if (!settings.enabled || !canNotify) return data;
      var ev = evaluate(data, settings, state);
      return setState(ev.state).then(function () {
        if (!ev.notify) return data;
        var n = buildNotification(settings, ev.value);
        return Promise.resolve(show(n.title, n.options)).then(function () { return data; });
      });
    });
  }

  root.Haze = {
    REGIONS: REGIONS, REGION_LABELS: REGION_LABELS, METRIC_LABELS: METRIC_LABELS,
    psiBand: psiBand, pm25Band: pm25Band, pm25ToPsi: pm25ToPsi,
    fetchData: fetchData, getValue: getValue, evaluate: evaluate,
    getSettings: getSettings, setSettings: setSettings, getState: getState, setState: setState,
    runCheck: runCheck, DEFAULT_SETTINGS: DEFAULT_SETTINGS
  };
})(self);
