/**
 * Salim Channels & Navigation Visual/Motion FX Engine
 * - GPU-friendly, visibility-aware, device-adaptive
 * - 1. Smooth traveling golden energy dock indicator across all bottom nav tabs
 * - 2. Organic golden electric arcs, flashes & sparks transferring randomly across visible channel cards
 * - Zero React re-render overhead, zero layout thrashing, auto-pauses off-screen / hidden / on page leave
 */
(function () {
  'use strict';

  var docEl = document.documentElement;
  var reducedMotionQuery = null;
  try {
    reducedMotionQuery = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  } catch (_) {}

  /* ------------------------------------------------------------------------
   * 1. ADAPTIVE DEVICE PERFORMANCE TIER
   * ------------------------------------------------------------------------ */
  function computePerfTier() {
    var isLegacy = Boolean(window.__samiIsLegacyAndroid) || docEl.classList.contains('sami-legacy-android');
    var prefersReduced = Boolean(reducedMotionQuery && reducedMotionQuery.matches);
    var cores = Number(navigator.hardwareConcurrency) || 4;
    var mem = Number(navigator.deviceMemory) || 4;

    if (isLegacy || prefersReduced || cores <= 2 || mem <= 2) {
      return 'lite';
    }
    if (cores <= 6 || mem <= 4 || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '')) {
      return 'balanced';
    }
    return 'ultra';
  }

  var perfTier = computePerfTier();

  function applyPerfTier(tier) {
    perfTier = tier;
    docEl.dataset.salimFxTier = tier;
    docEl.classList.remove('salim-fx-lite', 'salim-fx-balanced', 'salim-fx-ultra');
    docEl.classList.add('salim-fx-' + tier);
  }

  applyPerfTier(perfTier);

  if (reducedMotionQuery && typeof reducedMotionQuery.addEventListener === 'function') {
    reducedMotionQuery.addEventListener('change', function () {
      applyPerfTier(computePerfTier());
    });
  }

  /* ------------------------------------------------------------------------
   * 2. BOTTOM NAVIGATION TRAVELING GOLDEN ENERGY & SPARK TRANSFER
   * ------------------------------------------------------------------------ */
  var lastNavTabKey = null;
  var navBurstTimer = null;
  var navRafId = 0;

  function updateNavTraveler(forceInstant) {
    var dock = document.querySelector('.salim-nav-dock');
    if (!dock) return;

    var inner = dock.querySelector('.salim-nav-inner');
    var traveler = dock.querySelector('.salim-nav-traveler');
    if (!inner || !traveler) return;

    var activeBtn = inner.querySelector('.salim-nav-tab.is-active');
    if (!activeBtn) {
      traveler.style.opacity = '0';
      return;
    }

    var centerX = activeBtn.offsetLeft + activeBtn.offsetWidth * 0.5;
    var tabKey = activeBtn.getAttribute('data-salim-tab') || String(Math.round(centerX));

    if (forceInstant || lastNavTabKey === null) {
      traveler.classList.add('no-transition');
      traveler.style.transform = 'translate3d(' + centerX.toFixed(1) + 'px, 0, 0)';
      traveler.style.opacity = '1';
      // Force style flush once on initial mount so subsequent clicks animate cleanly
      void traveler.offsetWidth;
      traveler.classList.remove('no-transition');
      lastNavTabKey = tabKey;
      return;
    }

    traveler.style.opacity = '1';
    traveler.style.transform = 'translate3d(' + centerX.toFixed(1) + 'px, 0, 0)';

    if (lastNavTabKey !== tabKey) {
      lastNavTabKey = tabKey;
      traveler.classList.remove('is-traveling');
      void traveler.offsetWidth;
      traveler.classList.add('is-traveling');

      activeBtn.classList.remove('is-just-activated');
      void activeBtn.offsetWidth;
      activeBtn.classList.add('is-just-activated');

      if (navBurstTimer) clearTimeout(navBurstTimer);
      navBurstTimer = setTimeout(function () {
        if (traveler) traveler.classList.remove('is-traveling');
        if (activeBtn) activeBtn.classList.remove('is-just-activated');
      }, 420);
    }
  }

  function scheduleNavUpdate(forceInstant) {
    if (navRafId) cancelAnimationFrame(navRafId);
    navRafId = requestAnimationFrame(function () {
      navRafId = 0;
      updateNavTraveler(forceInstant);
    });
  }

  // Instant visual response on pointerdown/click before even waiting for React MutationObserver
  document.addEventListener(
    'click',
    function (ev) {
      var target = ev.target;
      if (!target || typeof target.closest !== 'function') return;
      var btn = target.closest('.salim-nav-tab');
      if (!btn) return;
      scheduleNavUpdate(false);
    },
    true
  );

  window.addEventListener(
    'resize',
    function () {
      scheduleNavUpdate(true);
    },
    { passive: true }
  );

  /* ------------------------------------------------------------------------
   * 3. ELECTRIC GOLDEN ARCS & SPARKS ENGINE (VISIBLE CHANNEL CARDS ONLY)
   * ------------------------------------------------------------------------ */
  var MAX_SPARKS = 8;
  var visibleCards = new Set();
  var cardObserver = null;
  var gridResizeObserver = null;
  var stagePresent = false;
  var rafLoopId = 0;
  var lastFrameTs = 0;
  var nextTransferAt = 0;

  // Pooled canvas slots (only 2 canvases in DOM at maximum!)
  function createSlotState() {
    var canvas = document.createElement('canvas');
    canvas.className = 'salim-electric-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    var ctx = canvas.getContext('2d', { alpha: true });

    var sparks = [];
    for (var i = 0; i < MAX_SPARKS; i++) {
      sparks.push({
        active: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 1,
        size: 1.5
      });
    }

    return {
      canvas: canvas,
      ctx: ctx,
      card: null,
      w: 0,
      h: 0,
      dpr: 1,
      opacity: 0,
      targetOpacity: 0,
      phase: Math.random() * 100,
      arcOffsetA: Math.random(),
      arcOffsetB: (Math.random() + 0.45) % 1,
      arcSpeedA: 0.085 + Math.random() * 0.05,
      arcSpeedB: -(0.065 + Math.random() * 0.045),
      lastJitterAt: 0,
      jitterSeeds: new Float32Array(32),
      flashAmp: 0,
      sparks: sparks
    };
  }

  var slotPrimary = createSlotState();
  var slotFading = createSlotState();

  function refreshJitterSeeds(slot) {
    for (var i = 0; i < slot.jitterSeeds.length; i++) {
      slot.jitterSeeds[i] = (Math.random() - 0.5) * 2;
    }
    slot.flashAmp = Math.random() < 0.38 ? 0.65 + Math.random() * 0.35 : 0.15 + Math.random() * 0.25;
  }
  refreshJitterSeeds(slotPrimary);
  refreshJitterSeeds(slotFading);

  function syncCanvasSize(slot) {
    if (!slot.card) return false;
    var cw = slot.card.offsetWidth;
    var ch = slot.card.offsetHeight;
    if (!cw || !ch) return false;

    var pad = 10; // matches CSS inset: -10px
    var totalW = cw + pad * 2;
    var totalH = ch + pad * 2;
    var maxDpr = perfTier === 'ultra' ? 2 : 1.5;
    var dpr = Math.min(window.devicePixelRatio || 1, maxDpr);

    if (slot.w !== totalW || slot.h !== totalH || slot.dpr !== dpr) {
      slot.w = totalW;
      slot.h = totalH;
      slot.dpr = dpr;
      slot.canvas.width = Math.round(totalW * dpr);
      slot.canvas.height = Math.round(totalH * dpr);
      if (slot.ctx) {
        slot.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
    return true;
  }

  function detachSlot(slot) {
    if (slot.card) {
      slot.card.classList.remove('salim-ch-card-energized');
    }
    if (slot.canvas.parentNode) {
      slot.canvas.parentNode.removeChild(slot.canvas);
    }
    if (slot.ctx && slot.w && slot.h) {
      slot.ctx.clearRect(0, 0, slot.w, slot.h);
    }
    slot.card = null;
    slot.opacity = 0;
    slot.targetOpacity = 0;
    for (var i = 0; i < slot.sparks.length; i++) {
      slot.sparks[i].active = false;
    }
  }

  function attachSlot(slot, card) {
    if (!card || !card.isConnected) return false;
    var host = card.querySelector('.salim-ch-electric-slot') || card;
    slot.card = card;
    slot.opacity = 0.08;
    slot.targetOpacity = 1;
    slot.arcOffsetA = Math.random();
    slot.arcOffsetB = (slot.arcOffsetA + 0.42 + Math.random() * 0.2) % 1;
    refreshJitterSeeds(slot);
    if (slot.canvas.parentNode !== host) {
      host.appendChild(slot.canvas);
    }
    card.classList.add('salim-ch-card-energized');
    syncCanvasSize(slot);
    return true;
  }

  // Maps normalized perimeter t in [0, 1) to (x, y, nx, ny) on a rounded rectangle
  function sampleRoundedRectPerimeter(t, x, y, w, h, r, out) {
    t = ((t % 1) + 1) % 1;
    var straightW = Math.max(0, w - 2 * r);
    var straightH = Math.max(0, h - 2 * r);
    var arcLen = 0.5 * Math.PI * r;
    var perim = 2 * straightW + 2 * straightH + 4 * arcLen;
    var d = t * perim;

    // 1. Top edge (left -> right)
    if (d < straightW) {
      out.x = x + r + d;
      out.y = y;
      out.nx = 0;
      out.ny = -1;
      return;
    }
    d -= straightW;

    // 2. Top-right corner
    if (d < arcLen) {
      var a = -Math.PI / 2 + (d / arcLen) * (Math.PI / 2);
      var cos = Math.cos(a);
      var sin = Math.sin(a);
      out.x = x + w - r + cos * r;
      out.y = y + r + sin * r;
      out.nx = cos;
      out.ny = sin;
      return;
    }
    d -= arcLen;

    // 3. Right edge (top -> bottom)
    if (d < straightH) {
      out.x = x + w;
      out.y = y + r + d;
      out.nx = 1;
      out.ny = 0;
      return;
    }
    d -= straightH;

    // 4. Bottom-right corner
    if (d < arcLen) {
      var a2 = (d / arcLen) * (Math.PI / 2);
      var cos2 = Math.cos(a2);
      var sin2 = Math.sin(a2);
      out.x = x + w - r + cos2 * r;
      out.y = y + h - r + sin2 * r;
      out.nx = cos2;
      out.ny = sin2;
      return;
    }
    d -= arcLen;

    // 5. Bottom edge (right -> left)
    if (d < straightW) {
      out.x = x + w - r - d;
      out.y = y + h;
      out.nx = 0;
      out.ny = 1;
      return;
    }
    d -= straightW;

    // 6. Bottom-left corner
    if (d < arcLen) {
      var a3 = Math.PI / 2 + (d / arcLen) * (Math.PI / 2);
      var cos3 = Math.cos(a3);
      var sin3 = Math.sin(a3);
      out.x = x + r + cos3 * r;
      out.y = y + h - r + sin3 * r;
      out.nx = cos3;
      out.ny = sin3;
      return;
    }
    d -= arcLen;

    // 7. Left edge (bottom -> top)
    if (d < straightH) {
      out.x = x;
      out.y = y + h - r - d;
      out.nx = -1;
      out.ny = 0;
      return;
    }
    d -= straightH;

    // 8. Top-left corner
    var a4 = Math.PI + (d / arcLen) * (Math.PI / 2);
    var cos4 = Math.cos(a4);
    var sin4 = Math.sin(a4);
    out.x = x + r + cos4 * r;
    out.y = y + r + sin4 * r;
    out.nx = cos4;
    out.ny = sin4;
  }

  var ptScratch = { x: 0, y: 0, nx: 0, ny: 0 };
  var boltPtsX = new Float32Array(28);
  var boltPtsY = new Float32Array(28);

  function drawElectricArcSpan(ctx, slot, rectX, rectY, rectW, rectH, radius, startT, spanT, seedOffset, alpha, spawnSparks) {
    var steps = perfTier === 'ultra' ? 22 : 16;
    var jitterMag = 5.4;

    for (var i = 0; i <= steps; i++) {
      var frac = i / steps;
      var t = startT + frac * spanT;
      sampleRoundedRectPerimeter(t, rectX, rectY, rectW, rectH, radius, ptScratch);

      // Taper displacement at arc endpoints so tips dissolve neatly onto card border
      var edgeFade = Math.sin(frac * Math.PI);
      var seed = slot.jitterSeeds[(i + seedOffset) % slot.jitterSeeds.length];
      var disp = seed * jitterMag * (0.25 + 0.75 * edgeFade);

      boltPtsX[i] = ptScratch.x + ptScratch.nx * disp;
      boltPtsY[i] = ptScratch.y + ptScratch.ny * disp;

      // Occasional spark birth along energized arc
      if (spawnSparks && i > 2 && i < steps - 2 && Math.random() < (perfTier === 'ultra' ? 0.065 : 0.038)) {
        var maxSparkCount = perfTier === 'ultra' ? MAX_SPARKS : 5;
        for (var sIdx = 0; sIdx < maxSparkCount; sIdx++) {
          var sp = slot.sparks[sIdx];
          if (!sp.active) {
            sp.active = true;
            sp.x = boltPtsX[i];
            sp.y = boltPtsY[i];
            var speed = 16 + Math.random() * 26;
            sp.vx = ptScratch.nx * speed + (Math.random() - 0.5) * 18;
            sp.vy = ptScratch.ny * speed + (Math.random() - 0.5) * 18;
            sp.life = 0;
            sp.maxLife = 0.24 + Math.random() * 0.26;
            sp.size = 1.1 + Math.random() * 1.4;
            break;
          }
        }
      }
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Pass 1: Soft outer amber aura (replaces expensive GPU shadowBlur!)
    ctx.beginPath();
    ctx.moveTo(boltPtsX[0], boltPtsY[0]);
    for (var p1 = 1; p1 <= steps; p1++) {
      ctx.lineTo(boltPtsX[p1], boltPtsY[p1]);
    }
    ctx.strokeStyle = 'rgba(245, 158, 11, ' + (0.24 * alpha).toFixed(3) + ')';
    ctx.lineWidth = 6.5;
    ctx.stroke();

    // Pass 2: Vibrant metallic gold body
    ctx.strokeStyle = 'rgba(251, 191, 36, ' + (0.72 * alpha).toFixed(3) + ')';
    ctx.lineWidth = 2.4;
    ctx.stroke();

    // Pass 3: White-gold electric filament core
    ctx.strokeStyle = 'rgba(254, 249, 195, ' + (0.96 * alpha).toFixed(3) + ')';
    ctx.lineWidth = 1.15;
    ctx.stroke();

    // Micro fork branch on strong flash
    if (alpha > 0.45 && slot.flashAmp > 0.55) {
      var forkIdx = Math.floor(steps * 0.48);
      var fx = boltPtsX[forkIdx];
      var fy = boltPtsY[forkIdx];
      var ang = Math.atan2(boltPtsY[forkIdx + 1] - fy, boltPtsX[forkIdx + 1] - fx) + (seedOffset % 2 === 0 ? 0.65 : -0.65);
      var midX = fx + Math.cos(ang) * 7.5;
      var midY = fy + Math.sin(ang) * 7.5;
      var endX = midX + Math.cos(ang + (Math.random() - 0.5) * 0.7) * 6.5;
      var endY = midY + Math.sin(ang + (Math.random() - 0.5) * 0.7) * 6.5;

      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(midX, midY);
      ctx.lineTo(endX, endY);
      ctx.strokeStyle = 'rgba(253, 224, 71, ' + (0.68 * alpha).toFixed(3) + ')';
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
  }

  function renderSlot(slot, dtSec, now) {
    if (!slot.card || !slot.ctx) return false;
    if (!slot.card.isConnected) {
      detachSlot(slot);
      return false;
    }

    // Smooth opacity approach
    var rate = slot.targetOpacity > slot.opacity ? 3.8 : 2.2;
    slot.opacity += (slot.targetOpacity - slot.opacity) * Math.min(1, dtSec * rate);

    if (slot.targetOpacity === 0 && slot.opacity < 0.025) {
      detachSlot(slot);
      return false;
    }

    var ctx = slot.ctx;
    var w = slot.w;
    var h = slot.h;
    if (!w || !h) return true;

    ctx.clearRect(0, 0, w, h);

    // Recompute lightning jitter every 78-105ms for natural crackling cadence
    if (now - slot.lastJitterAt > 86) {
      slot.lastJitterAt = now;
      refreshJitterSeeds(slot);
    }

    slot.arcOffsetA = (slot.arcOffsetA + slot.arcSpeedA * dtSec + 1) % 1;
    slot.arcOffsetB = (slot.arcOffsetB + slot.arcSpeedB * dtSec + 1) % 1;

    var pad = 10;
    var rectX = pad;
    var rectY = pad;
    var rectW = w - pad * 2;
    var rectH = h - pad * 2;
    var radius = 24;

    var flicker = 0.72 + 0.28 * slot.flashAmp;
    var alpha = Math.max(0, Math.min(1, slot.opacity * flicker));

    var allowSparks = slot.targetOpacity > 0.5;
    // Two organic traveling electric arc spans around opposite/staggered sides
    drawElectricArcSpan(ctx, slot, rectX, rectY, rectW, rectH, radius, slot.arcOffsetA, 0.34, 0, alpha, allowSparks);
    drawElectricArcSpan(ctx, slot, rectX, rectY, rectW, rectH, radius, slot.arcOffsetB, 0.26, 11, alpha * 0.88, allowSparks);

    // Occasional 3rd brief micro-flash arc on ultra tier
    if (perfTier === 'ultra' && slot.flashAmp > 0.68) {
      drawElectricArcSpan(
        ctx,
        slot,
        rectX,
        rectY,
        rectW,
        rectH,
        radius,
        (slot.arcOffsetA + 0.62) % 1,
        0.16,
        21,
        alpha * 0.72,
        false
      );
    }

    // Update and render golden sparks
    var maxSparkCount = perfTier === 'ultra' ? MAX_SPARKS : 5;
    for (var i = 0; i < maxSparkCount; i++) {
      var sp = slot.sparks[i];
      if (!sp.active) continue;
      sp.life += dtSec;
      if (sp.life >= sp.maxLife) {
        sp.active = false;
        continue;
      }
      sp.x += sp.vx * dtSec;
      sp.y += sp.vy * dtSec;
      sp.vx *= 0.94;
      sp.vy *= 0.94;

      var lifeRatio = 1 - sp.life / sp.maxLife;
      var sAlpha = lifeRatio * slot.opacity;

      // Outer spark halo
      ctx.fillStyle = 'rgba(251, 191, 36, ' + (0.45 * sAlpha).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, sp.size * 2.2, 0, Math.PI * 2);
      ctx.fill();

      // Hot spark core
      ctx.fillStyle = 'rgba(254, 249, 195, ' + (0.95 * sAlpha).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, sp.size * 0.95, 0, Math.PI * 2);
      ctx.fill();
    }

    return true;
  }

  function pickNextVisibleCard() {
    var candidates = [];
    visibleCards.forEach(function (card) {
      if (card.isConnected) {
        candidates.push(card);
      } else {
        visibleCards.delete(card);
      }
    });

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    var filtered = candidates.filter(function (c) {
      return c !== slotPrimary.card;
    });
    var pool = filtered.length > 0 ? filtered : candidates;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function transferElectricEffect(now) {
    var nextCard = pickNextVisibleCard();
    if (!nextCard) {
      if (slotPrimary.card) {
        slotPrimary.card.classList.remove('salim-ch-card-energized');
        slotPrimary.targetOpacity = 0;
      }
      nextTransferAt = now + 1200;
      return;
    }

    if (nextCard === slotPrimary.card) {
      nextTransferAt = now + 2600 + Math.random() * 1600;
      return;
    }

    // Move previous primary card cleanly into fading slot (if not already fading)
    if (slotPrimary.card && slotPrimary.card.isConnected) {
      detachSlot(slotFading);
      // Swap canvas roles cleanly without recreating DOM nodes
      var temp = slotFading;
      slotFading = slotPrimary;
      slotPrimary = temp;
      slotFading.card.classList.remove('salim-ch-card-energized');
      slotFading.targetOpacity = 0;
    } else {
      detachSlot(slotPrimary);
    }

    if (perfTier === 'lite') {
      // Lite mode: pure CSS energized glow only, no canvas loop
      if (slotFading.card) {
        slotFading.card.classList.remove('salim-ch-card-energized');
        slotFading.card = null;
      }
      slotPrimary.card = nextCard;
      nextCard.classList.add('salim-ch-card-energized');
    } else {
      attachSlot(slotPrimary, nextCard);
    }

    nextTransferAt = now + 2400 + Math.random() * 1900;
  }

  function stopElectricLoop() {
    if (rafLoopId) {
      cancelAnimationFrame(rafLoopId);
      rafLoopId = 0;
    }
    detachSlot(slotPrimary);
    detachSlot(slotFading);
  }

  var liteIntervalId = 0;

  function stopLiteLoop() {
    if (liteIntervalId) {
      clearInterval(liteIntervalId);
      liteIntervalId = 0;
    }
    if (slotPrimary.card) {
      slotPrimary.card.classList.remove('salim-ch-card-energized');
      slotPrimary.card = null;
    }
  }

  function electricTick(now) {
    rafLoopId = 0;
    if (!stagePresent || document.hidden || perfTier === 'lite') {
      stopElectricLoop();
      return;
    }

    var minFrameMs = perfTier === 'ultra' ? 24 : 33; // ~40fps ultra, ~30fps balanced
    if (now - lastFrameTs >= minFrameMs) {
      var dtSec = lastFrameTs ? Math.min(0.08, (now - lastFrameTs) / 1000) : 0.033;
      lastFrameTs = now;

      // If energized card left viewport, immediately pick a visible replacement
      if (slotPrimary.card && !visibleCards.has(slotPrimary.card) && visibleCards.size > 0) {
        transferElectricEffect(now);
      } else if (!slotPrimary.card && visibleCards.size > 0) {
        transferElectricEffect(now);
      } else if (now >= nextTransferAt) {
        transferElectricEffect(now);
      }

      renderSlot(slotFading, dtSec, now);
      renderSlot(slotPrimary, dtSec, now);
    }

    rafLoopId = requestAnimationFrame(electricTick);
  }

  function startElectricEngine() {
    if (!stagePresent || document.hidden) return;

    if (perfTier === 'lite') {
      stopElectricLoop();
      if (!liteIntervalId) {
        transferElectricEffect(performance.now());
        liteIntervalId = setInterval(function () {
          if (stagePresent && !document.hidden) {
            transferElectricEffect(performance.now());
          }
        }, 3200);
      }
      return;
    }

    stopLiteLoop();
    if (!rafLoopId) {
      lastFrameTs = 0;
      if (!nextTransferAt) {
        nextTransferAt = performance.now() + 260;
      }
      rafLoopId = requestAnimationFrame(electricTick);
    }
  }

  function observeVisibleChannelCards() {
    var grid = document.querySelector('.salim-channels-grid');
    if (!grid) {
      visibleCards.clear();
      return;
    }

    if (!cardObserver) {
      cardObserver = new IntersectionObserver(
        function (entries) {
          for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (entry.isIntersecting) {
              visibleCards.add(entry.target);
            } else {
              visibleCards.delete(entry.target);
            }
          }
        },
        { threshold: 0.2 }
      );
    } else {
      cardObserver.disconnect();
      visibleCards.clear();
    }

    var cards = grid.querySelectorAll('.salim-ch-card[data-salim-ch-id]');
    for (var i = 0; i < cards.length; i++) {
      cardObserver.observe(cards[i]);
    }

    if (!gridResizeObserver && typeof ResizeObserver === 'function') {
      gridResizeObserver = new ResizeObserver(function () {
        if (slotPrimary.card) syncCanvasSize(slotPrimary);
        if (slotFading.card) syncCanvasSize(slotFading);
      });
    }
    if (gridResizeObserver) {
      gridResizeObserver.disconnect();
      gridResizeObserver.observe(grid);
    }
  }

  /* ------------------------------------------------------------------------
   * 4. LIFECYCLE SYNC (MOUNT / UNMOUNT / VISIBILITY)
   * ------------------------------------------------------------------------ */
  var syncScheduled = false;

  function syncDomState() {
    syncScheduled = false;
    var stage = document.querySelector('.salim-channels-stage');
    var nextPresent = Boolean(stage);

    if (nextPresent !== stagePresent) {
      stagePresent = nextPresent;
      if (!stagePresent) {
        visibleCards.clear();
        if (cardObserver) cardObserver.disconnect();
        if (gridResizeObserver) gridResizeObserver.disconnect();
        stopElectricLoop();
        stopLiteLoop();
      }
    }

    if (stagePresent) {
      observeVisibleChannelCards();
      startElectricEngine();
    }

    scheduleNavUpdate(false);
  }

  function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    requestAnimationFrame(syncDomState);
  }

  var rootObserver = new MutationObserver(function () {
    scheduleSync();
  });

  function init() {
    var rootEl = document.getElementById('root') || document.body;
    if (rootEl) {
      rootObserver.observe(rootEl, { childList: true, subtree: true });
    }
    syncDomState();
    scheduleNavUpdate(true);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopElectricLoop();
      stopLiteLoop();
    } else if (stagePresent) {
      startElectricEngine();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
