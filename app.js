/* Haze Tracker SG - UI */
(function () {
  'use strict';

  var H = self.Haze;
  var $ = function (id) { return document.getElementById(id); };
  var REFRESH_MS = 5 * 60 * 1000;

  var settings = H.DEFAULT_SETTINGS;
  var busy = false;
  var lastFetch = 0;
  var lastData = null;
  var deferredInstall = null;
  var bgActive = false;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtTime(ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('en-SG', {
      timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
    });
  }

  /* ---------- notifications ---------- */
  function show(title, options) {
    if ('serviceWorker' in navigator) {
      return navigator.serviceWorker.ready.then(function (reg) { return reg.showNotification(title, options); });
    }
    return Promise.resolve(new Notification(title, options));
  }

  function registerPeriodicSync() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(false);
    return navigator.serviceWorker.ready.then(function (reg) {
      if (!('periodicSync' in reg) || !navigator.permissions) return false;
      return navigator.permissions.query({ name: 'periodic-background-sync' }).then(function (st) {
        if (st.state !== 'granted') return false;
        return reg.periodicSync.register('haze-check', { minInterval: 60 * 60 * 1000 }).then(function () { return true; });
      });
    }).catch(function () { return false; });
  }

  function unregisterPeriodicSync() {
    if (!('serviceWorker' in navigator)) return Promise.resolve();
    return navigator.serviceWorker.ready.then(function (reg) {
      if ('periodicSync' in reg) return reg.periodicSync.unregister('haze-check');
    }).catch(function () {});
  }

  /* ---------- rendering ---------- */
  function metricBlock(label, value, band, sub) {
    var d = el('div', 'metric');
    d.style.setProperty('--c', band ? band.color : 'var(--muted)');
    d.appendChild(el('span', 'm-label', label));
    d.appendChild(el('span', 'm-value', value == null ? '-' : String(value)));
    d.appendChild(el('span', 'm-band', band ? band.label : 'No data'));
    if (sub) d.appendChild(el('span', 'm-sub', sub));
    return d;
  }

  function fillCard(card, data, region) {
    card.replaceChildren(el('h3', null, H.REGION_LABELS[region]));
    var psi24 = H.getValue(data, 'psi24', region);
    var psi1 = H.getValue(data, 'psi1', region);
    var pm = null;
    if (data.pm25) {
      if (region === 'any') {
        var vals = H.REGIONS.map(function (r) { return data.pm25[r]; }).filter(function (v) { return typeof v === 'number'; });
        pm = vals.length ? Math.max.apply(null, vals) : null;
      } else pm = typeof data.pm25[region] === 'number' ? data.pm25[region] : null;
    }
    var pmBand = H.pm25Band(pm);
    var sub = pm == null ? null : 'PM2.5 ' + pm + ' µg/m³ · ' + pmBand.label;
    var wrap = el('div', 'metrics');
    wrap.appendChild(metricBlock('24-hr PSI', psi24, H.psiBand(psi24)));
    wrap.appendChild(metricBlock('1-hr PSI (est.)', psi1, H.psiBand(psi1), sub));
    card.appendChild(wrap);
    return card;
  }

  function render(data) {
    lastData = data;
    fillCard($('overall'), data, 'any');
    var grid = $('regions');
    grid.replaceChildren.apply(grid, H.REGIONS.map(function (r) {
      return fillCard(el('div', 'card region'), data, r);
    }));
    var parts = [];
    if (data.psiTimestamp) parts.push('24-hr PSI as of ' + fmtTime(data.psiTimestamp));
    if (data.pm25Timestamp) parts.push('1-hr PM2.5 as of ' + fmtTime(data.pm25Timestamp));
    $('stamp').textContent = parts.join(' · ');
    updateAlertStatus();
  }

  function banner(msg) {
    var b = $('banner');
    b.hidden = !msg;
    b.textContent = msg || '';
  }

  /* ---------- refresh ---------- */
  function refresh() {
    if (busy) return Promise.resolve();
    busy = true;
    $('refresh').classList.add('spin');
    return H.runCheck(show).then(function (data) {
      lastFetch = Date.now();
      try { localStorage.setItem('haze:last', JSON.stringify(data)); } catch (e) {}
      banner(data.errors.length ? 'Some readings could not be loaded (' + data.errors[0] + ').' : null);
      render(data);
    }).catch(function (err) {
      var cached = null;
      try { cached = JSON.parse(localStorage.getItem('haze:last')); } catch (e) {}
      if (cached) {
        banner('Could not reach NEA (' + err.message + '). Showing the last saved readings.');
        render(cached);
      } else {
        banner('Could not load readings: ' + err.message);
      }
    }).then(function () {
      busy = false;
      $('refresh').classList.remove('spin');
    });
  }

  /* ---------- alert form ---------- */
  function setStatus(msg, kind) {
    var s = $('alertStatus');
    s.textContent = msg;
    s.className = 'status' + (kind ? ' ' + kind : '');
  }

  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }

  function updateAlertStatus() {
    $('disable').hidden = !settings.enabled;
    $('save').textContent = settings.enabled ? 'Update alert' : 'Turn on alerts';
    if (!settings.enabled) return;
    var v = lastData ? H.getValue(lastData, settings.metric, settings.region) : null;
    var rule = H.REGION_LABELS[settings.region] + ' · ' + H.METRIC_LABELS[settings.metric] + ' ≥ ' + settings.threshold;
    var now = v == null ? '' : ' Now: ' + v + ' (' + H.psiBand(v).label + ').';
    var where = bgActive
      ? ' Checked in the background about hourly while the app is installed, and whenever you open it.'
      : ' Checked every few minutes while the app is open.';
    setStatus('Alert on: ' + rule + '.' + now + where, 'ok');
  }

  function populateForm() {
    var region = $('region');
    ['any'].concat(H.REGIONS).forEach(function (r) {
      var o = el('option', null, H.REGION_LABELS[r]);
      o.value = r;
      region.appendChild(o);
    });
    region.value = settings.region;
    $('metric').value = settings.metric;
    $('threshold').value = settings.threshold;
  }

  function onSubmit(e) {
    e.preventDefault();
    var t = Math.round(Number($('threshold').value));
    if (!(t >= 1 && t <= 500)) { setStatus('Enter a PSI threshold between 1 and 500.', 'err'); return; }
    if (!('Notification' in window)) {
      setStatus(isIOS() && !isStandalone()
        ? 'On iPhone, add this app to your Home Screen first (Share > Add to Home Screen), then open it from there to turn on alerts.'
        : 'This browser does not support notifications.', 'err');
      return;
    }
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') {
        setStatus('Notifications are blocked. Allow them for this site in your browser or phone settings, then try again.', 'err');
        return;
      }
      settings = { enabled: true, region: $('region').value, metric: $('metric').value, threshold: t };
      return H.setSettings(settings)
        .then(function () { return H.setState({ alerted: false }); })
        .then(registerPeriodicSync)
        .then(function (ok) { bgActive = ok; return refresh(); })
        .then(updateAlertStatus);
    });
  }

  function onDisable() {
    settings = Object.assign({}, settings, { enabled: false });
    H.setSettings(settings).then(function () { return H.setState({ alerted: false }); })
      .then(unregisterPeriodicSync)
      .then(function () { bgActive = false; updateAlertStatus(); setStatus('Alerts are off.'); });
  }

  function onTest() {
    if (!('Notification' in window)) { setStatus('This browser does not support notifications.', 'err'); return; }
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') { setStatus('Notifications are blocked for this site.', 'err'); return; }
      return show('Haze Tracker SG', {
        body: 'Test notification. Alerts will look like this.',
        icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'haze-test'
      }).then(function () { setStatus('Test notification sent.', 'ok'); });
    }).catch(function (err) { setStatus('Could not show a notification: ' + err.message, 'err'); });
  }

  /* ---------- install ---------- */
  function setupInstall() {
    if (isStandalone()) return;
    var box = $('install');
    var text = $('installText');
    if (isIOS()) {
      text.textContent = 'Tap the Share button in Safari, then "Add to Home Screen". Open the app from your Home Screen to use alerts.';
      box.hidden = false;
    }
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredInstall = e;
      text.textContent = 'Install Haze Tracker SG for one-tap access and background alert checks.';
      $('installBtn').hidden = false;
      box.hidden = false;
    });
    $('installBtn').addEventListener('click', function () {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      deferredInstall.userChoice.then(function () { deferredInstall = null; $('installBtn').hidden = true; box.hidden = true; });
    });
    window.addEventListener('appinstalled', function () { box.hidden = true; });
  }

  /* ---------- init ---------- */
  function init() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
    setupInstall();

    $('refresh').addEventListener('click', refresh);
    $('alertForm').addEventListener('submit', onSubmit);
    $('disable').addEventListener('click', onDisable);
    $('test').addEventListener('click', onTest);
    document.querySelector('.chips').addEventListener('click', function (e) {
      var t = e.target.getAttribute && e.target.getAttribute('data-t');
      if (t) $('threshold').value = t;
    });

    H.getSettings().then(function (s) {
      settings = s;
      populateForm();
      if (s.enabled && 'Notification' in window && Notification.permission !== 'granted') {
        settings = Object.assign({}, s, { enabled: false });
        H.setSettings(settings);
      }
      return s.enabled ? registerPeriodicSync() : false;
    }).then(function (ok) {
      bgActive = !!ok;
      updateAlertStatus();
      return refresh();
    });

    setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && Date.now() - lastFetch > 2 * 60 * 1000) refresh();
    });
  }

  init();
})();
