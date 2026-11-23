/*
 * Talk journey map.
 *
 * Draws an illustrated map from the talks listed in the page (#talkmap-data),
 * then flies a small plane from stop to stop in date order. The map frames
 * itself around the talk locations, so new talks only need lat/lng in their
 * front matter. Uses d3-geo and topojson-client (loaded before this file).
 */
(function () {
  'use strict';

  var root = document.getElementById('talkmap');
  if (!root) { return; }

  var stage = root.querySelector('.tm-stage');
  var svg = root.querySelector('.tm-svg');
  var caption = root.querySelector('.tm-caption');
  var replayBtn = root.querySelector('.tm-replay');
  var tip = root.querySelector('.tm-tip');
  var d3 = window.d3;
  var topojson = window.topojson;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var PIN_SHAPE = 'M0,0 C-4,-8 -11,-13 -11,-22 A11,11 0 1 1 11,-22 C11,-13 4,-8 0,0 Z';
  var PLANE_SHAPE = 'M12,0 C12,-1.6 10,-2.3 8,-2.3 L2.5,-2.3 L-3,-10.5 L-5.8,-10.5 L-2.8,-2.3 L-7.5,-2.3 ' +
    'L-9.6,-5.4 L-11.6,-5.4 L-10.5,0 L-11.6,5.4 L-9.6,5.4 L-7.5,2.3 L-2.8,2.3 L-5.8,10.5 L-3,10.5 ' +
    'L2.5,2.3 L8,2.3 C10,2.3 12,1.6 12,0 Z';
  var BOAT_HULL = 'M-11,4 L11,4 L7,10 L-7,10 Z';
  var BOAT_SAILS = 'M1.5,-14 L1.5,2 L11,2 Z M-1.5,-9 L-1.5,2 L-9,2 Z';
  var CLOUD_SHAPE = 'M14,32 a11,11 0 0 1 1,-22 a17,17 0 0 1 32,-6 a14,14 0 0 1 25,8 a10.5,10.5 0 0 1 2,20 z';

  function giveUp() { root.hidden = true; }

  if (!stage || !svg || !d3 || !d3.geoPath || !topojson || !window.fetch) { giveUp(); return; }

  var stops;
  try {
    stops = JSON.parse(document.getElementById('talkmap-data').textContent);
  } catch (err) { giveUp(); return; }
  stops = (stops || []).filter(function (s) {
    return s && typeof s.lat === 'number' && typeof s.lng === 'number' && isFinite(s.lat) && isFinite(s.lng);
  });
  if (!stops.length) { giveUp(); return; }
  stops.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.n - b.n; });

  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var geo = null;          // parsed map data
  var scene = null;        // elements and geometry of the current rendering
  var runId = 0;           // bumping this cancels a running animation
  var renderedWidth = 0;
  var hasPlayed = false;

  function el(name, attrs, parent) {
    var node = document.createElementNS(SVGNS, name);
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) { node.setAttribute(key, attrs[key]); }
    }
    if (parent) { parent.appendChild(node); }
    return node;
  }

  function fmt(v) { return Math.round(v * 10) / 10; }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function cardFor(stop) { return document.getElementById(stop.id); }

  /* ---- projection: frame the map around the talk locations ---- */

  function makeProjection(w, h, u) {
    var lons = stops.map(function (s) { return s.lng; });
    var lats = stops.map(function (s) { return s.lat; });
    var lon0 = Math.min.apply(null, lons), lon1 = Math.max.apply(null, lons);
    var lat0 = Math.min.apply(null, lats), lat1 = Math.max.apply(null, lats);
    var proj;
    var regional = (lon1 - lon0) <= 120;

    if (!regional) {
      // Talks spread across the globe: show the whole world.
      proj = d3.geoEqualEarth();
      proj.fitExtent([[8, 14], [w - 8, h - 14]], { type: 'Sphere' });
    } else {
      var midLat = (lat0 + lat1) / 2;
      var half = Math.max((lat1 - lat0) / 3, 5);
      var midLon = (lon0 + lon1) / 2;
      // Room for a whole pin above the northernmost stop and a label under the southernmost.
      var padX = Math.max(w < 420 ? 38 : 56, w * 0.07);   // side room for a city name beside the outermost pins
      var padTop = 36 * u + 12;
      var padBottom = 22;
      proj = d3.geoConicEqualArea()
        .parallels([clamp(midLat - half, -80, 80), clamp(midLat + half, -80, 80)])
        .rotate([-midLon, 0]);
      proj.fitExtent([[padX, padTop], [w - padX, h - padBottom]], {
        type: 'MultiPoint',
        coordinates: stops.map(function (s) { return [s.lng, s.lat]; })
      });
      // Never zoom in closer than roughly a few states across.
      var cap = w * 3.2;
      if (!isFinite(proj.scale()) || proj.scale() > cap) {
        proj.scale(cap).translate([0, 0]);
        var c = proj([midLon, midLat]);
        proj.translate([w / 2 - c[0], (padTop + h - padBottom) / 2 - c[1]]);
      }
    }
    proj.clipExtent([[-40, -40], [w + 40, h + 40]]).precision(0.4);
    proj.isRegional = regional;
    return proj;
  }

  /* ---- drawing ---- */

  function render() {
    runId++;
    var w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h || !geo) { return; }
    renderedWidth = w;

    var k = clamp(w / 860, 0.62, 1);            // detail scale: a smaller map gets smaller decorations
    var u = Math.max(k, 0.7) * 1.14;            // size factor for pins and labels (kept legible on small maps)
    var proj = makeProjection(w, h, u);
    var path = d3.geoPath(proj);

    while (svg.firstChild) { svg.removeChild(svg.firstChild); }
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.style.setProperty('--tm-w', w + 'px');
    svg.classList.toggle('tm-small', w < 620);

    var defs = el('defs', {}, svg);
    var blur = el('filter', { id: 'tm-blur', x: '-10%', y: '-10%', width: '120%', height: '120%' }, defs);
    el('feGaussianBlur', { stdDeviation: fmt(7 * k) }, blur);

    var backdrop = el('g', { 'aria-hidden': 'true' }, svg);
    var landD = path(geo.land) || '';
    el('path', { 'class': 'tm-graticule', d: path(d3.geoGraticule10()) || '' }, backdrop);
    el('path', { 'class': 'tm-halo', d: landD, filter: 'url(#tm-blur)' }, backdrop);
    el('path', { 'class': 'tm-depth', d: landD, transform: 'translate(0,' + fmt(4.5 * u) + ')' }, backdrop);
    el('path', { 'class': 'tm-land', d: landD }, backdrop);
    el('path', { 'class': 'tm-borders', d: path(geo.borders) || '' }, backdrop);
    if (proj.isRegional) {
      el('path', { 'class': 'tm-states', d: path(geo.states) || '' }, backdrop);
    }
    el('path', { 'class': 'tm-lakes', d: path(geo.lakes) || '' }, backdrop);

    // Pixel positions; talks at the same place sit side by side.
    var groups = [];
    var byPlace = {};
    stops.forEach(function (s) {
      var xy = proj([s.lng, s.lat]) || [w / 2, h / 2];
      s.x = xy[0];
      s.y = xy[1];
      var key = s.lat.toFixed(1) + ',' + s.lng.toFixed(1);
      if (!byPlace[key]) { byPlace[key] = { stops: [], city: s.city }; groups.push(byPlace[key]); }
      byPlace[key].stops.push(s);
      s.group = byPlace[key];
    });
    groups.forEach(function (g) {
      var k = g.stops.length;
      g.x = g.stops[0].x;
      g.y = g.stops[0].y;
      g.stops.forEach(function (s, j) { s.x += (j - (k - 1) / 2) * 20 * u; });
      g.halfWidth = ((k - 1) * 20 * u) / 2 + 12 * u;
    });

    var onLand = landTester(landD);
    var boat = drawBoat(backdrop, onLand, w, h, k);
    drawWaves(backdrop, onLand, boat, w, h, k);
    drawCompass(backdrop, w, h, k);
    drawClouds(backdrop, w, h, k);

    // Flight legs between consecutive stops.
    var routesG = el('g', { 'aria-hidden': 'true' }, svg);
    var legs = [];
    for (var i = 1; i < stops.length; i++) {
      var a = stops[i - 1], b = stops[i];
      var dx = b.x - a.x, dy = b.y - a.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var leg = { a: a, b: b, dist: dist, glow: null, line: null };
      if (dist >= 4) {
        // Bend every leg upward a little, like a flight arc.
        var nx = -dy / dist, ny = dx / dist;
        if (ny > 0) { nx = -nx; ny = -ny; }
        var bend = Math.min(dist * 0.2, 70);
        leg.cx = (a.x + b.x) / 2 + nx * bend;
        leg.cy = (a.y + b.y) / 2 + ny * bend;
        leg.glow = el('path', { 'class': 'tm-route-glow' }, routesG);
        leg.line = el('path', { 'class': 'tm-route' }, routesG);
      }
      legs.push(leg);
    }

    var labelsG = el('g', { 'aria-hidden': 'true' }, svg);
    var pinsG = el('g', {}, svg);

    // Pins, drawn north to south so nearer ones overlap farther ones.
    stops.slice().sort(function (p, q) { return p.y - q.y; }).forEach(function (s) {
      var label = 'Stop ' + s.n + ': ' + (s.short || s.title) + ', ' + s.place + ', ' + s.dateLabel;
      var a = el('g', {
        'class': 'tm-pin', role: 'button', tabindex: 0, 'aria-label': label,
        transform: 'translate(' + fmt(s.x) + ',' + fmt(s.y) + ')'
      }, pinsG);
      el('ellipse', { 'class': 'tm-pin-shadow', rx: fmt(7 * u), ry: fmt(2.6 * u) }, a);
      el('circle', { 'class': 'tm-pin-ring', r: 6 }, a);
      var body = el('g', { 'class': 'tm-pin-body' }, a);
      var scaled = el('g', { transform: 'scale(' + u + ')' }, body);
      el('path', { 'class': 'tm-pin-shape', d: PIN_SHAPE }, scaled);
      var num = el('text', { 'class': 'tm-pin-num', y: -18 }, scaled);
      num.textContent = s.n;
      if (String(s.n).length > 1) { num.setAttribute('style', 'font-size:10px'); }
      s.pin = a;

      a.addEventListener('mouseenter', function () { setActive(s, true); showTip(s, w, h, u); });
      a.addEventListener('mouseleave', function () { setActive(s, false); hideTip(); });
      a.addEventListener('focus', function () { setActive(s, true); showTip(s, w, h, u); });
      a.addEventListener('blur', function () { setActive(s, false); hideTip(); });
      a.addEventListener('click', function () { goToCard(s); });
      a.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); goToCard(s); }
      });
    });

    placeLabels(labelsG, groups, w, h, u);

    var plane = el('g', { 'class': 'tm-plane', 'aria-hidden': 'true' }, svg);
    el('path', { d: PLANE_SHAPE, transform: 'scale(' + fmt(1.15 * u) + ')' }, plane);

    scene = { w: w, h: h, u: u, legs: legs, groups: groups, plane: plane };
  }

  function landTester(landD) {
    try {
      var ctx = document.createElement('canvas').getContext('2d');
      var shape = new Path2D(landD);
      return function (x, y) { return ctx.isPointInPath(shape, x, y); };
    } catch (err) {
      return null;   // decorations that need open water are skipped
    }
  }

  function nearStop(x, y, r) {
    return stops.some(function (s) { return Math.abs(s.x - x) < r && Math.abs(s.y - y) < r; });
  }

  /* A small sailboat in the first stretch of open water that is free. */
  function drawBoat(parent, onLand, w, h, k) {
    if (!onLand) { return null; }
    var spots = [[0.9, 0.72], [0.93, 0.5], [0.07, 0.7], [0.08, 0.42], [0.62, 0.92], [0.4, 0.93]];
    for (var i = 0; i < spots.length; i++) {
      var x = spots[i][0] * w, y = spots[i][1] * h;
      var r = 26 * k;
      var byCompass = x > w - 80 * k && y > h - 80 * k;
      var wet = !onLand(x, y) && !onLand(x - r, y) && !onLand(x + r, y) && !onLand(x, y - r) && !onLand(x, y + r);
      if (byCompass || !wet || nearStop(x, y, 56 * k)) { continue; }
      var holder = el('g', { transform: 'translate(' + fmt(x) + ',' + fmt(y) + ') scale(' + fmt(k) + ')' }, parent);
      var boat = el('g', { 'class': 'tm-boat' }, holder);
      el('path', { 'class': 'tm-boat-sails', d: BOAT_SAILS }, boat);
      el('path', { 'class': 'tm-boat-hull', d: BOAT_HULL }, boat);
      el('path', { 'class': 'tm-wave', d: 'M-17,13 q4.5,-4 9,0 t9,0 t9,0 t7,0' }, holder);
      return { x: x, y: y };
    }
    return null;
  }

  function drawWaves(parent, onLand, boat, w, h, k) {
    if (!onLand) { return; }
    var seed = 11;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    var cols = Math.max(3, Math.round(w / (120 * k))), rows = Math.max(2, Math.round(h / (92 * k)));
    var g = el('g', {}, parent);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var x = (c + 0.2 + rnd() * 0.6) * w / cols;
        var y = (r + 0.25 + rnd() * 0.5) * h / rows;
        var dx = 16 * k, dy = 12 * k;
        if (onLand(x, y) || onLand(x - dx, y) || onLand(x + dx, y) || onLand(x, y - dy) || onLand(x, y + dy)) { continue; }
        if (nearStop(x, y, 46 * k)) { continue; }
        if (boat && Math.abs(boat.x - x) < 44 * k && Math.abs(boat.y - y) < 34 * k) { continue; }
        el('path', {
          'class': 'tm-wave', d: 'M-9,0 q4.5,-5 9,0 t9,0',
          transform: 'translate(' + fmt(x) + ',' + fmt(y) + ') scale(' + fmt(k) + ')'
        }, g);
      }
    }
  }

  function drawCompass(parent, w, h, k) {
    if (w < 360) { return; }
    var g = el('g', {
      'class': 'tm-compass',
      transform: 'translate(' + fmt(w - 12 - 19 * k) + ',' + fmt(h - 10 - 19 * k) + ') scale(' + fmt(k) + ')'
    }, parent);
    el('circle', { r: 19 }, g);
    el('path', { 'class': 'tm-compass-n', d: 'M0,-13 L3.6,0 L-3.6,0 Z' }, g);
    el('path', { d: 'M0,13 L3.6,0 L-3.6,0 Z' }, g);
    el('path', { d: 'M-13,0 L0,-2.6 L0,2.6 Z M13,0 L0,-2.6 L0,2.6 Z', 'fill-opacity': 0.3 }, g);
    var n = el('text', { y: -21 }, g);
    n.textContent = 'N';
  }

  function drawClouds(parent, w, h, k) {
    var specs = [
      { y: 0.07, s: 0.95, dur: 110, delay: -18 },
      { y: 0.33, s: 0.62, dur: 150, delay: -95 },
      { y: 0.66, s: 0.78, dur: 128, delay: -60 }
    ];
    specs.forEach(function (c) {
      var s = c.s * k;
      var holder = el('g', { transform: 'translate(0,' + fmt(h * c.y) + ') scale(' + fmt(s) + ')' }, parent);
      el('path', {
        'class': 'tm-cloud', d: CLOUD_SHAPE,
        style: '--dur:' + c.dur + 's;--delay:' + c.delay + 's;--tm-w:' + Math.round(w / s) + 'px'
      }, holder);
    });
  }

  /* City labels: try a few positions around each pin and keep the first that is free. */
  function placeLabels(parent, groups, w, h, u) {
    var size = Math.max(10, 13 * u);
    var k = clamp(w / 860, 0.62, 1);
    var lineH = size * 1.2;
    var taken = [];
    function box(x0, y0, x1, y1) { return [x0, y0, x1, y1]; }
    function hits(b) {
      for (var i = 0; i < taken.length; i++) {
        var t = taken[i];
        if (b[0] < t[2] && b[2] > t[0] && b[1] < t[3] && b[3] > t[1]) { return true; }
      }
      return false;
    }
    stops.forEach(function (s) { taken.push(box(s.x - 12 * u, s.y - 35 * u, s.x + 12 * u, s.y + 4)); });
    if (w >= 360) { taken.push(box(w - 16 - 40 * k, h - 14 - 52 * k, w, h)); }   // compass

    groups.slice().sort(function (a, b) { return a.y - b.y; }).forEach(function (g) {
      var text = el('text', { 'class': 'tm-label', 'font-size': fmt(size) }, parent);
      text.textContent = g.city;
      g.label = text;
      var tw = text.getComputedTextLength ? text.getComputedTextLength() : g.city.length * size * 0.56;
      var headY = g.y - 22 * u;
      var right = [g.x + g.halfWidth + 5, headY - lineH / 2];
      var left = [g.x - g.halfWidth - 5 - tw, headY - lineH / 2];
      var below = [g.x - tw / 2, g.y + 7];
      var above = [g.x - tw / 2, g.y - 36 * u - lineH - 1];
      var lowRight = [g.x + 5, g.y + 3];
      var lowLeft = [g.x - 5 - tw, g.y + 3];
      var highRight = [g.x + g.halfWidth - 2, g.y - 37 * u - lineH * 0.7];
      var highLeft = [g.x - g.halfWidth + 2 - tw, g.y - 37 * u - lineH * 0.7];
      var order = g.x > w / 2
        ? [right, left, below, above, lowRight, lowLeft, highRight, highLeft]
        : [left, right, below, above, lowLeft, lowRight, highLeft, highRight];
      var spot = null;
      for (var i = 0; i < order.length && !spot; i++) {
        var b = box(order[i][0] - 2, order[i][1] - 1, order[i][0] + tw + 2, order[i][1] + lineH + 1);
        if (b[0] >= 4 && b[2] <= w - 4 && b[1] >= 4 && b[3] <= h - 4 && !hits(b)) { spot = b; }
      }
      if (!spot) { parent.removeChild(text); g.label = null; return; }
      taken.push(spot);
      text.setAttribute('x', fmt(spot[0] + 2));
      text.setAttribute('y', fmt(spot[1] + 1 + lineH * 0.78));
    });
  }

  /* ---- hover card ---- */

  function showTip(s, w, h, u) {
    if (!tip) { return; }
    tip.innerHTML = '';
    if (s.photo) {
      var img = document.createElement('img');
      img.src = s.photo;
      img.alt = '';
      tip.appendChild(img);
    }
    var strong = document.createElement('strong');
    strong.textContent = s.short || s.title;
    var meta = document.createElement('span');
    meta.textContent = s.dateLabel + ' · ' + s.place;
    tip.appendChild(strong);
    tip.appendChild(meta);
    tip.hidden = false;
    // The card may spill over the edge of a small map: above the pin when the window has room, else below.
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var left = clamp(s.x - tw / 2, 0, Math.max(0, w - tw));
    var top = s.y - 40 * u - th - 6;
    if (stage.getBoundingClientRect().top + top < 8) { top = s.y + 12; }
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
  }

  function hideTip() { if (tip) { tip.hidden = true; } }

  function goToCard(s) {
    var card = cardFor(s);
    if (!card) { return; }
    hideTip();
    card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    card.classList.remove('is-flash');
    void card.offsetWidth;
    card.classList.add('is-flash');
  }

  function setActive(s, on) {
    if (s.pin) { s.pin.classList.toggle('is-active', on); }
    var card = cardFor(s);
    if (card) { card.classList.toggle('is-active', on); }
  }

  /* ---- journey animation ---- */

  function legPath(leg, t) {
    // Quadratic curve from a to b, cut at t (0..1).
    var ax = leg.a.x, ay = leg.a.y;
    var qx = ax + (leg.cx - ax) * t, qy = ay + (leg.cy - ay) * t;
    var rx = leg.cx + (leg.b.x - leg.cx) * t, ry = leg.cy + (leg.b.y - leg.cy) * t;
    var ex = qx + (rx - qx) * t, ey = qy + (ry - qy) * t;
    return {
      d: 'M' + fmt(ax) + ',' + fmt(ay) + ' Q' + fmt(qx) + ',' + fmt(qy) + ' ' + fmt(ex) + ',' + fmt(ey),
      x: ex, y: ey, angle: Math.atan2(ry - qy, rx - qx) * 180 / Math.PI
    };
  }

  function setLeg(leg, t) {
    if (!leg.line) { return null; }
    if (t <= 0) {
      leg.line.setAttribute('d', '');
      leg.glow.setAttribute('d', '');
      return null;
    }
    var p = legPath(leg, t);
    leg.line.setAttribute('d', p.d);
    leg.glow.setAttribute('d', p.d);
    return p;
  }

  function setCaption(n, title, sub) {
    if (!caption) { return; }
    caption.innerHTML = '';
    [['tm-cap-n', n], ['tm-cap-t', title], ['tm-cap-s', sub]].forEach(function (part) {
      if (part[1] === null || part[1] === '') { return; }
      var span = document.createElement('span');
      span.className = part[0];
      span.textContent = part[1];
      caption.appendChild(span);
    });
  }

  function summaryCaption() {
    var first = stops[0].date.slice(0, 4), last = stops[stops.length - 1].date.slice(0, 4);
    var cities = scene ? scene.groups.length : stops.length;
    var text = stops.length + (stops.length === 1 ? ' talk' : ' talks') + ' · ' +
      cities + (cities === 1 ? ' city' : ' cities');
    setCaption(null, text, first === last ? first : first + ' – ' + last);
  }

  function arrive(s, animate) {
    s.pin.classList.add('is-in');
    if (animate) {
      s.pin.classList.remove('is-landing');
      void s.pin.getBoundingClientRect();
      s.pin.classList.add('is-landing');
    }
    if (s.group.label) { s.group.label.classList.add('is-in'); }
  }

  function showFinal() {
    runId++;
    if (!scene) { return; }
    scene.legs.forEach(function (leg) { setLeg(leg, 1); });
    stops.forEach(function (s) { arrive(s, false); });
    scene.plane.classList.remove('is-on');
    summaryCaption();
  }

  function showStart() {
    if (!scene) { return; }
    scene.legs.forEach(function (leg) { setLeg(leg, 0); });
    stops.forEach(function (s) {
      s.pin.classList.remove('is-in', 'is-landing');
      if (s.group.label) { s.group.label.classList.remove('is-in'); }
    });
    scene.plane.classList.remove('is-on');
    setCaption(null, '', '');
  }

  function wait(ms, id) {
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(id === runId); }, ms);
    });
  }

  function fly(leg, id) {
    return new Promise(function (resolve) {
      if (!leg.line) { resolve(id === runId); return; }
      var duration = clamp(280 + leg.dist * 2.1, 480, 1300);
      var start = null;
      var plane = scene.plane;
      function frame(now) {
        if (id !== runId) { resolve(false); return; }
        if (start === null) { start = now; }
        var k = clamp((now - start) / duration, 0, 1);
        var eased = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        var p = setLeg(leg, Math.max(eased, 0.001));
        plane.setAttribute('transform', 'translate(' + fmt(p.x) + ',' + fmt(p.y) + ') rotate(' + fmt(p.angle) + ')');
        plane.classList.add('is-on');
        if (k < 1) { requestAnimationFrame(frame); } else { resolve(true); }
      }
      requestAnimationFrame(frame);
    });
  }

  function play() {
    if (!scene) { return; }
    if (reduceMotion) { showFinal(); return; }
    var id = ++runId;
    hasPlayed = true;
    hideTip();
    showStart();

    var i = 0;
    function step(ok) {
      if (!ok || id !== runId) { return; }
      if (i >= stops.length) {
        scene.plane.classList.remove('is-on');
        wait(900, id).then(function (still) { if (still) { summaryCaption(); } });
        return;
      }
      var s = stops[i];
      var travel = i === 0 ? Promise.resolve(true) : fly(scene.legs[i - 1], id);
      travel.then(function (still) {
        if (!still) { return; }
        arrive(s, true);
        setCaption(s.n, s.short || s.title, s.city + ' · ' + s.monthLabel);
        i++;
        wait(i === 1 ? 600 : 440, id).then(step);
      });
    }
    wait(450, id).then(step);
  }

  /* ---- start-up ---- */

  function rewind(feature) {
    // d3 expects clockwise outer rings; flip any polygon that covers "everything but itself".
    if (d3.geoArea(feature) > 2 * Math.PI) {
      feature.geometry.coordinates.forEach(function (poly) {
        poly.forEach(function (ring) { ring.reverse(); });
      });
    }
    return feature;
  }

  function loadJSON(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) { throw new Error('Could not load ' + url); }
      return res.json();
    });
  }

  var base = root.getAttribute('data-assets') || '';
  Promise.all([
    loadJSON(base + '/countries-50m.json'),
    loadJSON(base + '/states-10m.json'),
    loadJSON(base + '/lakes.json')
  ]).then(function (files) {
    var world = files[0], us = files[1], lakes = files[2];
    geo = {
      land: topojson.feature(world, world.objects.land),
      borders: topojson.mesh(world, world.objects.countries, function (a, b) { return a !== b; }),
      states: topojson.mesh(us, us.objects.states, function (a, b) { return a !== b; }),
      lakes: { type: 'FeatureCollection', features: lakes.features.map(rewind) }
    };

    render();
    if (!scene) { giveUp(); return; }

    if (reduceMotion) {
      showFinal();
    } else {
      showStart();
      if ('IntersectionObserver' in window) {
        var seen = new IntersectionObserver(function (entries) {
          if (entries.some(function (e) { return e.isIntersecting; })) {
            seen.disconnect();
            play();
          }
        }, { threshold: 0.3 });
        seen.observe(stage);
      } else {
        play();
      }
    }

    if (replayBtn) { replayBtn.addEventListener('click', play); }

    // Hovering a card highlights its pin.
    stops.forEach(function (s) {
      var card = cardFor(s);
      if (!card) { return; }
      card.addEventListener('mouseenter', function () { setActive(s, true); });
      card.addEventListener('mouseleave', function () { setActive(s, false); });
      card.addEventListener('focusin', function () { setActive(s, true); });
      card.addEventListener('focusout', function () { setActive(s, false); });
    });

    // Redraw when the width changes (rotation, window resize).
    var timer = null;
    function onResize() {
      if (Math.abs(stage.clientWidth - renderedWidth) < 2) { return; }
      clearTimeout(timer);
      timer = setTimeout(function () {
        render();
        if (hasPlayed || reduceMotion) { showFinal(); } else { showStart(); }
      }, 160);
    }
    if ('ResizeObserver' in window) { new ResizeObserver(onResize).observe(stage); }
    else { window.addEventListener('resize', onResize); }
  }).catch(function () { giveUp(); });
})();
