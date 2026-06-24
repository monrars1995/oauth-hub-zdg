/* oauth-hub panel logic (multi-app, i18n) — vanilla JS. */
(function () {
  "use strict";

  var TOKEN_KEY = "hub_token";
  var token = localStorage.getItem(TOKEN_KEY) || "";
  var lastEventTs = "";
  var eventsTimer = null;
  var appsCache = [];
  var publicUrl = "";

  var YT_URL = "https://www.youtube.com/channel/UCrPbAoQKz42Gm0mLdWatAEA";

  function $(id) { return document.getElementById(id); }
  function show(el) { el && el.classList.remove("hidden"); }
  function hide(el) { el && el.classList.add("hidden"); }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }
  function t(k, v) { return window.I18N ? window.I18N.t(k, v) : k; }
  function hasKey(k) { return window.I18N && window.I18N.t(k) !== k; }

  var CH_NAME = { waba: "WhatsApp", messenger: "Messenger", instagram: "Instagram" };
  function chName(p) { return CH_NAME[p] || p; }
  function prodLabel(p) { return p === "all" ? t("form.prodAll") : chName(p); }

  var toastTimer = null;
  function toast(msg, isError) {
    var el = $("toast");
    el.textContent = msg;
    el.className = "toast show" + (isError ? " error" : "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = "toast"; }, 3200);
  }

  function translateErr(data) {
    if (!data) return t("err.generic");
    if (data.error) {
      var k = "err." + data.error;
      var base = hasKey(k) ? t(k) : (data.message || data.error);
      return data.detail ? (base + " — " + data.detail) : base;
    }
    return data.message || t("err.generic");
  }

  // Custom confirmation popup (no native alert/confirm). Returns a Promise<boolean>.
  function confirmModal(message, confirmLabel, danger) {
    return new Promise(function (resolve) {
      var prevFocus = document.activeElement;
      var ov = document.createElement("div");
      ov.className = "modal-overlay";
      ov.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">' +
          '<div class="modal-msg">' + esc(message) + "</div>" +
          '<div class="modal-actions">' +
            '<button class="btn ghost" data-c="0">' + esc(t("form.cancel")) + "</button>" +
            '<button class="btn ' + (danger ? "danger" : "") + '" data-c="1">' + esc(confirmLabel || t("form.create")) + "</button>" +
          "</div>" +
        "</div>";
      document.body.appendChild(ov);
      function done(v) { document.removeEventListener("keydown", onKey); ov.remove(); if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) {} } resolve(v); }
      function onKey(e) { if (e.key === "Escape") done(false); }
      ov.addEventListener("click", function (e) {
        if (e.target === ov) return done(false);
        var b = e.target.closest("[data-c]");
        if (b) done(b.getAttribute("data-c") === "1");
      });
      document.addEventListener("keydown", onKey);
      var cb = ov.querySelector('[data-c="1"]'); if (cb) cb.focus();
    });
  }

  // ── Lucide icons (inline SVG) ──────────────────────────────
  var ICONS = {
    plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
    grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    moon: '<path d="M12 3a6.4 6.4 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>'
  };
  function icon(name) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || "") + "</svg>"; }

  function timeAgo(iso) {
    if (!iso) return "";
    var d = Date.parse(iso); if (isNaN(d)) return "";
    var s = Math.floor((Date.now() - d) / 1000);
    if (s < 5) return t("time.now");
    if (s < 60) return t("time.s", { n: s });
    var m = Math.floor(s / 60); if (m < 60) return t("time.m", { n: m });
    var h = Math.floor(m / 60); if (h < 24) return t("time.h", { n: h });
    return t("time.d", { n: Math.floor(h / 24) });
  }
  function fmtAbs(iso) { try { return new Date(iso).toLocaleString(); } catch (e) { return ""; } }

  function skeletonRows(n) {
    var out = "";
    for (var i = 0; i < (n || 3); i++) out += '<div class="skel-row"><div class="skel skel-line" style="width:' + (45 + (i * 13) % 40) + '%"></div><div class="skel skel-line short"></div></div>';
    return out;
  }
  function emptyState(name, title, sub) {
    return '<div class="empty"><div class="empty-ico">' + icon(name) + "</div>" + esc(title) + (sub ? '<br><span class="empty-sub">' + esc(sub) + "</span>" : "") + "</div>";
  }

  // ── i18n glue (promo strings with links, language switcher) ─
  function applyPromo() {
    var community = t("brand.community");
    var ytLink = '<a href="' + YT_URL + '" target="_blank" rel="noopener"><b>' + esc(community) + "</b></a>";
    var ytPlain = '<a href="' + YT_URL + '" target="_blank" rel="noopener">' + esc(community) + "</a>";
    var lf = $("loginFoot"); if (lf) lf.innerHTML = t("login.tool", { zdg: ytLink });
    var ad = $("aboutDesc"); if (ad) ad.innerHTML = t("config.aboutDesc", { zdg: ytLink });
    var fo = $("footerOffered"); if (fo) fo.innerHTML = t("footer.offered", { zdg: ytPlain });
  }
  function buildLangSwitcher() {
    var btn = $("langDDBtn"), cur = $("langDDCur"), menu = $("langDDMenu");
    if (!btn || !menu || !window.I18N) return;
    var active = window.I18N.getLang();
    if (cur) cur.textContent = t("lang." + active);
    menu.innerHTML = window.I18N.langs.map(function (l) {
      return '<li role="option" data-lang="' + l + '"' + (l === active ? ' class="active" aria-selected="true"' : ' aria-selected="false"') + ">" + esc(t("lang." + l)) + "</li>";
    }).join("");
    menu.onclick = function (e) {
      var li = e.target.closest && e.target.closest("[data-lang]"); if (!li) return;
      closeLangMenu(); window.I18N.setLang(li.getAttribute("data-lang"));
    };
    if (!btn._wired) {
      btn._wired = true;
      btn.addEventListener("click", function (e) { e.stopPropagation(); toggleLangMenu(); });
    }
  }
  function toggleLangMenu() {
    var dd = $("langDD"); if (!dd) return;
    var open = dd.classList.toggle("open");
    $("langDDBtn").setAttribute("aria-expanded", open ? "true" : "false");
  }
  function closeLangMenu() {
    var dd = $("langDD");
    if (dd && dd.classList.contains("open")) { dd.classList.remove("open"); $("langDDBtn").setAttribute("aria-expanded", "false"); }
  }

  // ── Video lightbox (guide tutorials play in-page) ──────────
  function ytIdFromHref(href) { var m = (href || "").match(/(?:youtu\.be\/|[?&]v=|embed\/)([A-Za-z0-9_-]{6,})/); return m ? m[1] : ""; }
  function vlKeydown(e) { if (e.key === "Escape") closeVideoLightbox(); }
  function closeVideoLightbox() {
    var ov = $("videoLightbox");
    if (ov) { ov.parentNode.removeChild(ov); document.body.style.overflow = ""; document.removeEventListener("keydown", vlKeydown); }
  }
  function openVideoLightbox(id) {
    closeVideoLightbox();
    var ov = document.createElement("div");
    ov.className = "video-lightbox"; ov.id = "videoLightbox";
    ov.innerHTML =
      '<div class="vl-inner">' +
        '<button class="vl-close" type="button" aria-label="' + escAttr(t("form.close")) + '">' + icon("x") + "</button>" +
        '<div class="vl-frame"><iframe src="https://www.youtube.com/embed/' + encodeURIComponent(id) +
          '?autoplay=1&rel=0&playsinline=1&modestbranding=1" title="" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>' +
        '<a class="vl-yt" href="https://youtu.be/' + encodeURIComponent(id) + '" target="_blank" rel="noopener">' + esc(t("video.watchYoutube")) + "</a>" +
      "</div>";
    document.body.appendChild(ov);
    document.body.style.overflow = "hidden";
    requestAnimationFrame(function () { ov.classList.add("open"); });
    ov.addEventListener("mousedown", function (e) { if (e.target === ov) closeVideoLightbox(); });
    ov.querySelector(".vl-close").addEventListener("click", closeVideoLightbox);
    document.addEventListener("keydown", vlKeydown);
  }
  function initVideoLightbox() {
    document.addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest(".video-list a[href]") : null; if (!a) return;
      var id = ytIdFromHref(a.getAttribute("href")); if (!id) return;
      e.preventDefault(); openVideoLightbox(id);
    });
  }
  // Thumbnail fallback: step down YouTube quality, then show a placeholder.
  var YT_THUMB_Q = ["maxresdefault", "hqdefault", "mqdefault", "sddefault", "default"];
  function ytThumbFallback(img) {
    var m = (img.src || "").match(/\/vi\/([^/]+)\/(\w+)\.jpg/);
    if (m) {
      var id = m[1], idx = YT_THUMB_Q.indexOf(m[2]);
      if (idx >= 0 && idx < YT_THUMB_Q.length - 1) { img.src = "https://img.youtube.com/vi/" + id + "/" + YT_THUMB_Q[idx + 1] + ".jpg"; return; }
    }
    img.onerror = null; img.style.display = "none";
    if (img.parentNode) img.parentNode.classList.add("vthumb-empty");
  }
  function initVideoThumbs() {
    Array.prototype.forEach.call(document.querySelectorAll(".video-list img.vthumb"), function (img) {
      img.addEventListener("error", function () { ytThumbFallback(img); });
      if (img.complete && img.naturalWidth === 0) ytThumbFallback(img); // already failed before listener
    });
  }
  function currentTab() { var a = document.querySelector("[data-tab].active"); return a ? a.getAttribute("data-tab") : "channels"; }
  function setPageTitle() { var el = $("pageTitle"); if (el) el.textContent = t("nav." + currentTab()); }
  function onLangChanged() {
    applyPromo(); buildLangSwitcher(); setPageTitle();
    populateConnectSelector(appsCache); populateEventAppFilter(appsCache); renderApps(appsCache);
    loadChannels(); renderEventsFiltered();
  }

  // ── Theme ──────────────────────────────────────────────────
  function applyTheme(th) {
    if (th === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    var b = $("themeBtn"); if (b) b.innerHTML = icon(th === "dark" ? "sun" : "moon");
  }
  function toggleTheme() {
    var th = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    try { localStorage.setItem("hub_theme", th); } catch (e) {}
    applyTheme(th);
  }

  // ── Stats (overview cards) ─────────────────────────────────
  function setStat(id, v) {
    var el = $(id); if (!el) return;
    var target = Number(v) || 0;
    var start = parseInt(String(el.textContent).replace(/[^0-9]/g, ""), 10); if (isNaN(start)) start = 0;
    if (start === target) { el.textContent = target; return; }
    var t0 = 0, dur = 500;
    function step(now) {
      if (!t0) t0 = now;
      var p = Math.min(1, (now - t0) / dur);
      el.textContent = Math.round(start + (target - start) * p);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function loadStats() {
    api("/api/stats").then(function (s) {
      setStat("statApps", s.apps); setStat("statChannels", s.channels);
      setStat("statEvents", s.eventsLastHour); setStat("statForwards", s.forwardsLastHour);
    }).catch(function () {});
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (opts.body && typeof opts.body !== "string") {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) { doLogout(); throw new Error(t("login.expired")); }
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(translateErr(data));
        return data;
      });
    });
  }

  // ── Auth ───────────────────────────────────────────────────
  function bootstrap() {
    fetch("/api/bootstrap").then(function (r) { return r.json(); }).then(function (d) {
      document.title = d.brandName;
      $("loginBrand").textContent = d.brandName;
      $("brandName").textContent = d.brandName;
      if (!d.adminAuthEnabled) {
        return api("/api/login", { method: "POST", body: { password: "" } }).then(function (res) {
          token = res.token; localStorage.setItem(TOKEN_KEY, token); enterApp();
        });
      }
      if (token) enterApp(); else { show($("login")); $("loginPass").focus(); }
    }).catch(function () { show($("login")); });
  }

  function doLogin() {
    $("loginErr").textContent = "";
    $("loginBtn").disabled = true;
    api("/api/login", { method: "POST", body: { password: $("loginPass").value } })
      .then(function (res) { token = res.token; localStorage.setItem(TOKEN_KEY, token); hide($("login")); enterApp(); })
      .catch(function (e) { $("loginErr").textContent = e.message || t("login.invalid"); })
      .then(function () { $("loginBtn").disabled = false; });
  }

  function doLogout() {
    token = ""; localStorage.removeItem(TOKEN_KEY);
    if (eventsTimer) { clearInterval(eventsTimer); eventsTimer = null; }
    hide($("app")); show($("login")); $("loginPass").value = "";
  }

  function enterApp() {
    hide($("login")); show($("app"));
    loadConfig(); loadStats(); loadApps(); loadChannels(); startEvents();
  }

  // ── Global config (brand) ──────────────────────────────────
  function loadConfig() {
    api("/api/config").then(function (c) {
      $("brandName").textContent = c.brandName; document.title = c.brandName;
      $("cfgBrand").value = c.brandName || "";
      publicUrl = c.publicUrl || "";
      fillGuideUrls();
    }).catch(function (e) { toast(e.message, true); });
  }
  function fillGuideUrls() {
    var base = publicUrl || "";
    var host = base.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    function set(codeId, copyId, val) {
      var c = $(codeId); if (c) c.textContent = val;
      var b = $(copyId); if (b) b.setAttribute("data-copy-text", val);
    }
    set("guideDomain", "copyDomain", host);
    set("guideMsgr", "copyMsgr", base + "/connect/messenger");
    set("guideWaba", "copyWaba", base + "/connect/waba");
    set("guideRedirect", "copyRedirect", base + "/connect/instagram/callback");
    var w = $("guideWebhook"); if (w) w.textContent = base + "/webhook/app/SEU_APP_ID";
  }
  function saveSettings() {
    $("saveSettings").disabled = true;
    api("/api/settings", { method: "POST", body: { brandName: $("cfgBrand").value } })
      .then(function () { toast(t("config.saved")); loadConfig(); })
      .catch(function (e) { toast(e.message, true); })
      .then(function () { $("saveSettings").disabled = false; });
  }

  // ── Apps ───────────────────────────────────────────────────
  var FWD_PRODS = ["all", "waba", "messenger", "instagram"];

  function loadApps() {
    var el = $("appsList");
    if (el && !el.querySelector(".app-card")) el.innerHTML = skeletonRows(2);
    return api("/api/apps").then(function (d) {
      appsCache = d.apps || [];
      renderApps(appsCache);
      populateConnectSelector(appsCache);
      populateEventAppFilter(appsCache);
      var onb = $("onboarding"); if (onb) { if (appsCache.length === 0) show(onb); else hide(onb); }
    }).catch(function (e) { toast(e.message, true); });
  }
  function populateEventAppFilter(apps) {
    var sel = $("evtApp"); if (!sel) return;
    var cur = sel.value;
    sel.innerHTML = '<option value="">' + esc(t("events.allApps")) + "</option>" + apps.map(function (a) { return '<option value="' + escAttr(a.id) + '">' + esc(a.name) + "</option>"; }).join("");
    sel.value = cur;
  }
  function populateConnectSelector(apps) {
    var sel = $("connectApp"); if (!sel) return;
    sel.innerHTML = apps.map(function (a) { return '<option value="' + escAttr(a.id) + '">' + esc(a.name) + "</option>"; }).join("");
    var none = apps.length === 0;
    sel.disabled = none;
    if (none) show($("noAppsHint")); else hide($("noAppsHint"));
    Array.prototype.forEach.call(document.querySelectorAll("[data-connect]"), function (b) { b.disabled = none; });
  }

  var CH_COLOR = { waba: "#25D366", messenger: "#0084FF", instagram: "#E1306C" };
  var CH_IMG = { waba: "/assets/waba.png", messenger: "/assets/messenger.png", instagram: "/assets/instagram.png" };
  function embedUrl(appId, channel) {
    return publicUrl + "/embed/connect?app=" + encodeURIComponent(appId) + "&channel=" + channel + "&lang=" + (window.I18N ? window.I18N.getLang() : "pt");
  }
  function embedSnippet(appId, channel) {
    var url = embedUrl(appId, channel);
    return '<a href="' + url + '" target="_blank" rel="noopener" ' +
      "onclick=\"window.open(this.href,'zdg_connect','width=560,height=740');return false;\" " +
      'style="display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:10px;background:' + CH_COLOR[channel] +
      ';color:#fff;font:600 14px/1 -apple-system,Segoe UI,Roboto,sans-serif;text-decoration:none;">' +
      '<img src="' + publicUrl + CH_IMG[channel] + '" alt="" style="width:18px;height:18px;border-radius:4px" /> ' + t("embed." + channel) + "</a>";
  }
  function embedSection(a) {
    if (!a.embedEnabled) return "";
    var rows = ["waba", "messenger", "instagram"].map(function (ch) {
      var snip = embedSnippet(a.id, ch);
      var url = embedUrl(a.id, ch);
      return '<div class="url-box"><span class="lbl">' + esc(chName(ch)) + "</span>" +
        "<code>" + esc(snip) + "</code>" +
        '<button class="btn secondary copy" data-copy-text="' + escAttr(snip) + '">' + esc(t("embed.copy")) + "</button>" +
        '<button class="btn secondary embed-test" data-embed-test="' + escAttr(url) + '">' + esc(t("embed.test")) + "</button></div>";
    }).join("");
    return '<div class="embed-block"><div class="fwd-title">' + esc(t("embed.title")) + "</div>" +
      '<div class="hint" style="margin-bottom:.5rem">' + t("embed.hint") + "</div>" + rows + "</div>";
  }

  function forwardsSummary(fwds) {
    if (!fwds || !fwds.length) return '<span style="color:var(--muted-2)">' + esc(t("apps.noForward")) + "</span>";
    return fwds.map(function (f) {
      var prod = (f.products || ["all"]).map(prodLabel).join(", ");
      return '<div class="sub">↳ ' + esc(f.url) + ' <span class="badge ' + (f.enabled ? "ok" : "warn") + '">' + esc(f.enabled ? prod : t("apps.inactive")) + "</span></div>";
    }).join("");
  }

  function renderApps(apps) {
    var el = $("appsList"); if (!el) return;
    if (!apps.length) { el.innerHTML = emptyState("grid", t("apps.empty"), t("apps.emptySub")); return; }
    var defined = t("apps.defined"), undef = '<b style="color:var(--amber)">' + esc(t("apps.undefined")) + "</b>";
    el.innerHTML = apps.map(function (a) {
      var modeBadge = a.storeEvents
        ? '<span class="badge ok">' + esc(t("apps.badgeHistory")) + "</span>"
        : '<span class="badge warn" title="' + escAttr(t("apps.badgeTransactionalTitle")) + '">' + esc(t("apps.badgeTransactional")) + "</span>";
      var embedBadge = a.embedEnabled ? ' <span class="badge messenger">' + esc(t("apps.badgeEmbed")) + "</span>" : "";
      return '<div class="app-card">' +
        '<div class="app-head">' +
          '<div><span class="app-name">' + esc(a.name) + '</span> <span class="badge waba">' + a.channelCount + " " + esc(t("apps.channelsSuffix")) + "</span> " + modeBadge + embedBadge + "</div>" +
          '<div style="display:flex;gap:.4rem"><button class="btn secondary" data-editapp="' + escAttr(a.id) + '">' + esc(t("apps.edit")) + "</button>" +
          '<button class="btn danger" data-delapp="' + escAttr(a.id) + '">' + esc(t("apps.remove")) + "</button></div>" +
        "</div>" +
        '<div class="sub">' + esc(t("apps.appId")) + ": " + esc(a.appId) + " · " + esc(t("apps.api")) + " " + esc(a.apiVersion) +
          " · " + esc(t("apps.verifyToken")) + " " + (a.webhookVerifyTokenSet ? esc(defined) : undef) +
          " · " + esc(t("apps.secret")) + " " + (a.hasAppSecret ? esc(defined) : undef) + "</div>" +
        '<div class="url-box"><span class="lbl">' + esc(t("apps.webhook")) + '</span><code>' + esc(a.webhookUrls.unified) + '</code><button class="btn secondary copy" data-copy-text="' + escAttr(a.webhookUrls.unified) + '">' + esc(t("apps.copy")) + "</button></div>" +
        '<div class="url-box"><span class="lbl">' + esc(t("apps.igRedirect")) + '</span><code>' + esc(a.redirectUri) + '</code><button class="btn secondary copy" data-copy-text="' + escAttr(a.redirectUri) + '">' + esc(t("apps.copy")) + "</button></div>" +
        '<div class="fwd-summary">' + forwardsSummary(a.forwards) + "</div>" +
        embedSection(a) +
      "</div>";
    }).join("");

    Array.prototype.forEach.call(el.querySelectorAll("[data-editapp]"), function (b) {
      b.addEventListener("click", function () {
        var a = appsCache.filter(function (x) { return x.id === b.getAttribute("data-editapp"); })[0];
        if (a) openAppForm(a);
      });
    });
    Array.prototype.forEach.call(el.querySelectorAll("[data-delapp]"), function (b) {
      b.addEventListener("click", function () {
        confirmModal(t("apps.removeConfirm"), t("apps.remove"), true).then(function (ok) {
          if (!ok) return;
          api("/api/apps/" + encodeURIComponent(b.getAttribute("data-delapp")), { method: "DELETE" })
            .then(function () { toast(t("apps.removed")); loadApps(); })
            .catch(function (e) { toast(e.message, true); });
        });
      });
    });
  }

  // ── App form (drawer) ──────────────────────────────────────
  function fwdRowHtml(f) {
    f = f || { url: "", products: ["all"], enabled: true };
    var prod = (f.products && f.products.indexOf("all") < 0 && f.products[0]) ? f.products[0] : "all";
    var opts = FWD_PRODS.map(function (p) { return '<option value="' + p + '"' + (p === prod ? " selected" : "") + ">" + esc(prodLabel(p)) + "</option>"; }).join("");
    return '<div class="fwd-row">' +
      '<input class="fwd-url" placeholder="' + escAttr(t("form.fwdUrlPh")) + '" value="' + escAttr(f.url) + '" />' +
      '<select class="fwd-prod">' + opts + "</select>" +
      '<label class="fwd-en"><input type="checkbox"' + (f.enabled !== false ? " checked" : "") + " /> " + esc(t("form.fwdActive")) + "</label>" +
      '<button type="button" class="btn ghost fwd-del" title="' + escAttr(t("apps.remove")) + '">×</button>' +
    "</div>";
  }

  var drawerEl = null;
  var drawerReturnFocus = null;
  function closeDrawer() {
    if (!drawerEl) return;
    var el = drawerEl; drawerEl = null;
    el.classList.remove("open");
    document.removeEventListener("keydown", drawerKeydown);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
    if (drawerReturnFocus && drawerReturnFocus.focus) { try { drawerReturnFocus.focus(); } catch (e) {} }
    drawerReturnFocus = null;
  }
  function drawerKeydown(e) {
    if (!drawerEl) return;
    if (e.key === "Escape") { closeDrawer(); return; }
    if (e.key === "Tab") {
      var f = drawerEl.querySelectorAll('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function field(id, labelKey, value, phKey, type, extraLabel) {
    return '<div class="field"><label for="' + id + '">' + esc(t(labelKey)) + (extraLabel || "") + '</label>' +
      '<input id="' + id + '"' + (type ? ' type="' + type + '"' : "") + (value != null ? ' value="' + escAttr(value) + '"' : "") +
      ' placeholder="' + escAttr(t(phKey)) + '" /></div>';
  }
  function openAppForm(app) {
    closeDrawer();
    drawerReturnFocus = document.activeElement;
    var isEdit = !!app;
    app = app || {};
    var secPh = app.hasAppSecret ? "form.secretKeep" : "form.appSecret";
    var igSecPh = app.hasInstagramAppSecret ? "form.secretKeep" : "form.igSecretPh";
    var verifyPh = app.webhookVerifyTokenSet ? "form.verifyTokenKeep" : "form.verifyTokenPh";
    var title = isEdit ? t("form.editTitle") : t("form.newTitle");
    var fields =
      '<div class="grid2">' +
        field("afName", "form.name", app.name || "", "form.namePh") +
        field("afAppId", "form.appId", app.appId || "", "form.appId") +
      "</div>" +
      '<div class="grid2">' +
        field("afAppSecret", "form.appSecret", null, secPh, "password") +
        field("afApiVersion", "form.apiVersion", app.apiVersion || "", "form.apiVersion") +
      "</div>" +
      '<div class="grid2">' +
        field("afVerify", "form.verifyToken", null, verifyPh) +
        field("afWaba", "form.wabaConfig", app.wabaConfigId || "", "form.wabaConfigPh") +
      "</div>" +
      '<div class="grid2">' +
        field("afMsgr", "form.msgrConfig", app.messengerConfigId || "", "form.msgrConfigPh") +
        field("afIgId", "form.igId", app.instagramAppId || "", "form.igIdPh", null, ' <span class="hint">' + esc(t("form.optional")) + "</span>") +
      "</div>" +
      field("afIgSecret", "form.igSecret", null, igSecPh, "password") +
      '<div class="field"><label for="afMsgrToken">' + esc(t("form.fallbackToken")) + ' <span class="hint">' + esc(t("form.optional")) + "</span></label>" +
        '<input id="afMsgrToken" placeholder="' + escAttr(t(app.hasMessengerFallbackToken ? "form.secretKeep" : "form.fallbackTokenPh")) + '" />' +
        '<div class="hint">' + esc(t("form.fallbackTokenHint")) + "</div></div>" +
      '<div class="mode-block">' +
        '<label class="mode-toggle"><input type="checkbox" id="afStore"' + (app.storeEvents === false ? "" : " checked") + " /> <b>" + esc(t("form.storeToggle")) + "</b></label>" +
        '<div class="hint">' + t("form.storeHint") + "</div>" +
        '<label class="mode-toggle" style="margin-top:.7rem"><input type="checkbox" id="afEmbed"' + (app.embedEnabled ? " checked" : "") + " /> <b>" + esc(t("form.embedToggle")) + "</b></label>" +
        '<div class="hint">' + esc(t("form.embedHint")) + "</div>" +
      "</div>" +
      '<div class="fwd-block">' +
        '<div class="fwd-title">' + esc(t("form.fwdTitle")) + "</div>" +
        '<div class="hint" style="margin-bottom:.5rem">' + esc(t("form.fwdHint")) + "</div>" +
        '<div id="afForwards">' + (app.forwards && app.forwards.length ? app.forwards.map(fwdRowHtml).join("") : "") + "</div>" +
        '<button type="button" class="btn secondary" id="afAddFwd" style="margin-top:.5rem">' + esc(t("form.fwdAdd")) + "</button>" +
      "</div>";

    var ov = document.createElement("div");
    ov.className = "drawer-overlay";
    ov.innerHTML =
      '<div class="drawer" role="dialog" aria-modal="true" aria-label="' + escAttr(title) + '">' +
        '<div class="drawer-head"><h3>' + esc(title) + '</h3><button class="btn ghost icon-btn" id="afClose" aria-label="' + escAttr(t("form.close")) + '">' + icon("x") + "</button></div>" +
        '<div class="drawer-body">' + fields + "</div>" +
        '<div class="drawer-foot"><button class="btn ghost" id="afCancel">' + esc(t("form.cancel")) + '</button><button class="btn" id="afSave">' + esc(isEdit ? t("form.save") : t("form.create")) + "</button></div>" +
      "</div>";
    document.body.appendChild(ov);
    drawerEl = ov;

    ov.addEventListener("mousedown", function (e) { if (e.target === ov) closeDrawer(); });
    $("afClose").addEventListener("click", closeDrawer);
    $("afCancel").addEventListener("click", closeDrawer);
    $("afAddFwd").addEventListener("click", function () { $("afForwards").insertAdjacentHTML("beforeend", fwdRowHtml(null)); wireFwdDeletes(); });
    $("afSave").addEventListener("click", function () { saveApp(isEdit ? app.id : null); });
    wireFwdDeletes();
    document.addEventListener("keydown", drawerKeydown);
    requestAnimationFrame(function () { ov.classList.add("open"); });
    setTimeout(function () { var f = $("afName"); if (f) f.focus(); }, 60);
  }

  function wireFwdDeletes() {
    Array.prototype.forEach.call(document.querySelectorAll(".fwd-del"), function (b) {
      b.onclick = function () { b.parentNode.parentNode.removeChild(b.parentNode); };
    });
  }
  function collectForwards() {
    return Array.prototype.map.call(document.querySelectorAll("#afForwards .fwd-row"), function (row) {
      return {
        url: row.querySelector(".fwd-url").value.trim(),
        products: [row.querySelector(".fwd-prod").value],
        enabled: row.querySelector(".fwd-en input").checked,
      };
    }).filter(function (f) { return f.url; });
  }
  function saveApp(id) {
    var body = {
      name: $("afName").value,
      appId: $("afAppId").value,
      apiVersion: $("afApiVersion").value,
      wabaConfigId: $("afWaba").value,
      messengerConfigId: $("afMsgr").value,
      instagramAppId: $("afIgId").value,
      forwards: collectForwards(),
    };
    var storeEl = $("afStore");
    if (storeEl) body.storeEvents = storeEl.checked;
    var embedEl = $("afEmbed");
    if (embedEl) body.embedEnabled = embedEl.checked;
    if ($("afAppSecret").value) body.appSecret = $("afAppSecret").value;
    if ($("afIgSecret").value) body.instagramAppSecret = $("afIgSecret").value;
    if ($("afMsgrToken") && $("afMsgrToken").value.trim()) body.messengerFallbackToken = $("afMsgrToken").value.trim();
    if ($("afVerify").value) body.webhookVerifyToken = $("afVerify").value;

    if (!body.name.trim()) { toast(t("form.nameRequired"), true); return; }
    if (!body.appId.trim()) { toast(t("form.appIdRequired"), true); return; }

    $("afSave").disabled = true;
    var req = id
      ? api("/api/apps/" + encodeURIComponent(id), { method: "PUT", body: body })
      : api("/api/apps", { method: "POST", body: body });
    req.then(function () { toast(id ? t("apps.updated") : t("apps.created")); closeDrawer(); loadApps(); })
      .catch(function (e) { toast(e.message, true); })
      .then(function () { var s = $("afSave"); if (s) s.disabled = false; });
  }

  // ── Channels ───────────────────────────────────────────────
  var chList = [], chAutoTried = {};
  function loadChannels() {
    var el = $("channelsList");
    if (el && !el.querySelector(".channel")) el.innerHTML = skeletonRows(3);
    api("/api/channels").then(function (d) { chList = d.channels || []; renderChannelsList(); autoRefreshChannels(); }).catch(function (e) { toast(e.message, true); });
  }
  function chHasDetails(c) { return c.meta && (c.meta.avatar || (c.meta.details && c.meta.details.length)); }
  var CH_FLABEL = { quality: "channels.fQuality", tier: "channels.fTier", fans: "channels.fFans", followers: "channels.fFollowers", posts: "channels.fPosts" };
  function chAvatar(c) {
    var init = esc((String(c.name || "?").trim().charAt(0) || "?").toUpperCase());
    var av = c.meta && c.meta.avatar;
    return '<span class="ch-avatar ch-' + esc(c.type) + '" data-initial="' + init + '">' +
      (av ? '<img src="' + escAttr(av) + '" alt="" onerror="this.remove()" />' : "") + "</span>";
  }
  function chDetails(c) {
    var d = c.meta && c.meta.details;
    if (!d || !d.length) return "";
    return '<div class="ch-details">' + d.map(function (f) {
      var lbl = CH_FLABEL[f.k] ? " " + esc(t(CH_FLABEL[f.k])) : "";
      return '<span class="ch-chip">' + esc(f.v) + lbl + "</span>";
    }).join("") + "</div>";
  }
  function renderChannelsList() {
    var el = $("channelsList"); if (!el) return;
    if (!chList.length) { el.innerHTML = emptyState("plug", t("channels.empty"), t("channels.emptySub")); return; }
    el.innerHTML = chList.map(function (c) {
      var sub = c.subscribed ? '<span class="badge ok">' + esc(t("channels.webhookOk")) + "</span>" : '<span class="badge warn" title="' + escAttr(c.subscribeError || "") + '">' + esc(t("channels.webhookPending")) + "</span>";
      var last = c.lastEventAt
        ? t("channels.lastEvent", { t: '<span title="' + escAttr(fmtAbs(c.lastEventAt)) + '">' + esc(timeAgo(c.lastEventAt)) + "</span>" })
        : esc(t("channels.noEvents"));
      return '<div class="channel">' + chAvatar(c) + '<div class="meta">' +
          '<div class="name">' + esc(c.name) + ' <span class="badge ' + c.type + '">' + esc(chName(c.type)) + "</span> " + sub + "</div>" +
          '<div class="sub">' + esc(t("channels.appPrefix")) + ": " + esc(c.appName) + " · " + esc(t("channels.idPrefix")) + ": " + esc(c.externalId) + " · " + last + "</div>" +
          chDetails(c) +
        '</div><div class="ch-actions">' +
          '<button class="btn ghost icon-btn" data-refresh="' + escAttr(c.id) + '" title="' + escAttr(t("channels.refresh")) + '">' + icon("refresh") + "</button>" +
          '<button class="btn danger" data-del="' + escAttr(c.id) + '">' + esc(t("channels.remove")) + "</button>" +
        "</div></div>";
    }).join("");
    Array.prototype.forEach.call(el.querySelectorAll("[data-del]"), function (btn) {
      btn.addEventListener("click", function () {
        confirmModal(t("channels.removeConfirm"), t("channels.remove"), true).then(function (ok) {
          if (!ok) return;
          api("/api/channels/" + encodeURIComponent(btn.getAttribute("data-del")), { method: "DELETE" })
            .then(function () { toast(t("channels.removed")); loadChannels(); loadApps(); })
            .catch(function (e) { toast(e.message, true); });
        });
      });
    });
    Array.prototype.forEach.call(el.querySelectorAll("[data-refresh]"), function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-refresh");
        btn.disabled = true;
        api("/api/channels/" + encodeURIComponent(id) + "/refresh", { method: "POST" })
          .then(function (d) { if (d && d.channel) { patchChannel(d.channel); } toast(t("channels.refreshed")); })
          .catch(function (e) { toast(e.message, true); btn.disabled = false; });
      });
    });
  }
  function patchChannel(ch) {
    var i = chList.findIndex(function (x) { return x.id === ch.id; });
    if (i >= 0) chList[i] = ch; renderChannelsList();
  }
  function autoRefreshChannels() {
    chList.forEach(function (c) {
      if (chHasDetails(c) || chAutoTried[c.id]) return;
      chAutoTried[c.id] = true;
      api("/api/channels/" + encodeURIComponent(c.id) + "/refresh", { method: "POST" })
        .then(function (d) { if (d && d.channel) patchChannel(d.channel); }).catch(function () {});
    });
  }

  function connect(channel) {
    var sel = $("connectApp");
    var appId = sel && sel.value;
    if (!appId) { toast(t("connect.needApp"), true); return; }
    api("/api/connect/" + channel + "/init", { method: "POST", body: { appId: appId, lang: window.I18N ? window.I18N.getLang() : "pt" } })
      .then(function (d) { var w = window.open(d.url, "hub_connect", "width=560,height=740"); if (!w) toast(t("connect.popupBlocked"), true); })
      .catch(function (e) { toast(e.message, true); });
  }

  window.addEventListener("message", function (e) {
    if (e.origin !== window.location.origin) return;
    if (e.data && e.data.type === "hub:connected") {
      toast(e.data.ok ? t("connect.connected") : t("connect.notCompleted"), !e.data.ok);
      loadChannels(); loadApps();
    }
  });

  // ── Events ─────────────────────────────────────────────────
  var eventsBuffer = [];
  var newIds = {};
  function startEvents() {
    fetchEvents(true);
    if (eventsTimer) clearInterval(eventsTimer);
    eventsTimer = setInterval(function () { if ($("autoRefresh").checked) { fetchEvents(false); loadStats(); } }, 3000);
  }
  function fetchEvents(replace) {
    var el = $("eventsList");
    if (replace && el && !el.querySelector(".event")) el.innerHTML = skeletonRows(3);
    var q = (!replace && lastEventTs) ? ("?since=" + encodeURIComponent(lastEventTs)) : "";
    api("/api/events" + q).then(function (d) {
      var evs = d.events || [];
      if (replace) {
        eventsBuffer = evs;
      } else if (evs.length) {
        eventsBuffer = evs.concat(eventsBuffer);
        if (eventsBuffer.length > 400) eventsBuffer = eventsBuffer.slice(0, 400);
        evs.forEach(function (e) { newIds[e.id] = 1; });
        setTimeout(function () { evs.forEach(function (e) { delete newIds[e.id]; }); }, 1600);
      }
      if (eventsBuffer.length) lastEventTs = eventsBuffer[0].ts;
      renderEventsFiltered();
    }).catch(function () {});
  }
  function badgeForProduct(p) {
    var cls = (p === "waba" || p === "messenger" || p === "instagram") ? p : "warn";
    return '<span class="badge ' + cls + '">' + esc(chName(p)) + "</span>";
  }
  function fwdBadges(fwds) {
    if (!fwds || !fwds.length) return "";
    return fwds.map(function (f) {
      var ok = f.status === "pending" ? "warn" : (f.ok ? "ok" : "warn");
      return ' <span class="badge ' + ok + '" title="' + escAttr(f.url) + '">' + esc(String(f.status)) + "</span>";
    }).join("");
  }
  function cleanSummary(s) { return String(s == null ? "" : s).replace(/\[object Object\]/g, "—"); }
  function eventHtml(ev) {
    var sigBadge = ev.signatureValid === false ? ' <span class="badge warn" title="' + escAttr(t("events.sigBadTitle")) + '">' + esc(t("events.sigBad")) + "</span>" : "";
    var isNew = newIds[ev.id] ? " event-new" : "";
    return '<div class="event event-' + esc(ev.product) + isNew + '"><div class="head">' + badgeForProduct(ev.product) +
        '<span class="badge ' + (ev.appId ? "ok" : "warn") + '">' + esc(ev.appName) + "</span>" +
        '<span class="badge ' + (ev.channelId ? "ok" : "warn") + '">' + esc(ev.channelId ? t("events.channel") : t("events.noChannel")) + "</span>" +
        sigBadge + fwdBadges(ev.forwards) +
        '<span class="time" title="' + escAttr(fmtAbs(ev.ts)) + '">' + esc(timeAgo(ev.ts)) + "</span>" +
      '</div><div class="summary">' + esc(cleanSummary(ev.summary)) + "</div>" +
      "<details><summary>" + esc(t("events.payload")) + '</summary><pre>' + esc(JSON.stringify(ev.raw, null, 2)) + "</pre>" +
      '<button class="btn secondary copy" data-copy-text="' + escAttr(JSON.stringify(ev.raw)) + '" style="margin-top:.5rem;font-size:.72rem;padding:.3rem .6rem">' + esc(t("events.copyPayload")) + "</button>" +
      "</details></div>";
  }
  function eventMatches(e) {
    var p = $("evtProduct") ? $("evtProduct").value : "";
    if (p && e.product !== p) return false;
    var a = $("evtApp") ? $("evtApp").value : "";
    if (a && e.appId !== a) return false;
    var q = $("evtSearch") ? $("evtSearch").value.trim().toLowerCase() : "";
    if (q && (e.summary || "").toLowerCase().indexOf(q) < 0 && (e.appName || "").toLowerCase().indexOf(q) < 0) return false;
    return true;
  }
  var EVT_PAGE_SIZE = 20, evtPage = 0;
  function renderEventsFiltered() {
    var el = $("eventsList"); if (!el) return;
    var list = eventsBuffer.filter(eventMatches);
    if (!list.length) {
      el.innerHTML = eventsBuffer.length
        ? emptyState("inbox", t("events.noMatch"), t("events.noMatchSub"))
        : emptyState("inbox", t("events.empty"), t("events.emptySub"));
      return;
    }
    var pages = Math.ceil(list.length / EVT_PAGE_SIZE);
    if (evtPage >= pages) evtPage = pages - 1;
    if (evtPage < 0) evtPage = 0;
    var pageList = list.slice(evtPage * EVT_PAGE_SIZE, (evtPage + 1) * EVT_PAGE_SIZE);
    var pager = pages > 1
      ? '<div class="pager">' +
          '<button class="btn secondary" id="evtPrev"' + (evtPage === 0 ? " disabled" : "") + ">" + esc(t("events.prev")) + "</button>" +
          '<span class="pager-info">' + esc(t("events.pageOf", { cur: evtPage + 1, total: pages })) + "</span>" +
          '<button class="btn secondary" id="evtNext"' + (evtPage >= pages - 1 ? " disabled" : "") + ">" + esc(t("events.next")) + "</button>" +
        "</div>"
      : "";
    el.innerHTML = pageList.map(eventHtml).join("") + pager;
    var pv = $("evtPrev"); if (pv) pv.addEventListener("click", function () { evtPage--; renderEventsFiltered(); window.scrollTo(0, 0); });
    var nx = $("evtNext"); if (nx) nx.addEventListener("click", function () { evtPage++; renderEventsFiltered(); window.scrollTo(0, 0); });
  }
  function onEvtFilter() { evtPage = 0; renderEventsFiltered(); }
  function clearEvents() {
    confirmModal(t("events.clearConfirm"), t("events.clear"), true).then(function (ok) {
      if (!ok) return;
      api("/api/events/clear", { method: "POST" }).then(function () { lastEventTs = ""; eventsBuffer = []; renderEventsFiltered(); toast(t("events.cleared")); }).catch(function (e) { toast(e.message, true); });
    });
  }

  // ── Tabs ───────────────────────────────────────────────────
  function setupTabs() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-tab]"), function (btn) {
      btn.addEventListener("click", function () {
        var tab = btn.getAttribute("data-tab");
        Array.prototype.forEach.call(document.querySelectorAll("[data-tab]"), function (b) { b.classList.remove("active"); b.removeAttribute("aria-current"); });
        btn.classList.add("active");
        btn.setAttribute("aria-current", "page");
        ["channels", "events", "apps", "config", "guide", "evidence"].forEach(function (tt) {
          var sec = $("tab-" + tt);
          if (tt === tab) { show(sec); if (sec) { sec.classList.remove("tab-enter"); void sec.offsetWidth; sec.classList.add("tab-enter"); } }
          else hide(sec);
        });
        setPageTitle();
        if (tab === "channels") { loadChannels(); loadApps(); loadStats(); }
        if (tab === "events") fetchEvents(true);
        if (tab === "apps") loadApps();
        if (tab === "config") loadConfig();
        if (tab === "guide") fillGuideUrls();
        if (tab === "evidence") evidenceOnShow();
      });
    });
  }

  // ── Evidence (App Review) ──────────────────────────────────
  var EV = { loaded: false, suites: [], apps: [], channels: [], lastDoc: "", lastFile: "" };
  function evShow(el, on) { if (el) el.style.display = on ? "" : "none"; }
  function evSuiteByKey(k) { for (var i = 0; i < EV.suites.length; i++) if (EV.suites[i].key === k) return EV.suites[i]; return null; }
  function evidenceOnShow() {
    var run = $("evRun");
    if (run && !run._wired) {
      run._wired = true;
      run.addEventListener("click", evRun);
      $("evDownload").addEventListener("click", evDownloadDoc);
      $("evApp").addEventListener("change", evToggleSource);
      $("evProduct").addEventListener("change", evRenderParams);
      $("evSource").addEventListener("change", evToggleSource);
      $("evWrites").addEventListener("change", evToggleSource);
    }
    var jobs = [api("/api/apps"), api("/api/channels")];
    if (!EV.loaded) jobs.push(api("/api/evidence/suites"));
    Promise.all(jobs).then(function (r) {
      EV.apps = (r[0] && r[0].apps) || [];
      EV.channels = (r[1] && r[1].channels) || [];
      if (!EV.loaded) { EV.suites = (r[2] && r[2].suites) || []; EV.loaded = true; }
      evPopulate();
    }).catch(function (e) { toast(e.message, true); });
  }
  function evPopulate() {
    $("evApp").innerHTML = EV.apps.map(function (a) { return '<option value="' + escAttr(a.id) + '">' + esc(a.name) + "</option>"; }).join("");
    $("evProduct").innerHTML = EV.suites.map(function (s) { return '<option value="' + escAttr(s.key) + '">' + esc(s.label) + "</option>"; }).join("");
    var srcSel = $("evSource");
    if (!srcSel.options.length) {
      srcSel.innerHTML = ["fallback", "channel", "paste"].map(function (v) { return '<option value="' + v + '">' + esc(t("evidence.src." + v)) + "</option>"; }).join("");
    }
    evRenderParams(); evToggleSource();
  }
  function evChannelsForApp() { var id = $("evApp").value; return EV.channels.filter(function (c) { return c.appId === id; }); }
  function evToggleSource() {
    var src = $("evSource").value;
    evShow($("evChannelWrap"), src === "channel");
    evShow($("evTokenWrap"), src === "paste");
    if (src === "channel") {
      $("evChannel").innerHTML = evChannelsForApp().map(function (c) { return '<option value="' + escAttr(c.id) + '">' + esc((c.type || "") + " · " + (c.name || c.externalId)) + "</option>"; }).join("");
    }
    var pv = $("evProduct").value;
    evShow($("evRecipientWrap"), $("evWrites").checked && (pv === "whatsapp" || pv === "messenger"));
  }
  function evRenderParams() {
    var p = evSuiteByKey($("evProduct").value), box = $("evParams");
    if (!p) { box.innerHTML = ""; return; }
    var labels = { waba_id: "WABA ID", phone_number_id: "Phone Number ID", ig_id: "Instagram ID", page_id: "Page ID" };
    box.innerHTML = (p.needs || []).map(function (n) {
      return '<div class="field"><label for="evp_' + n + '">' + esc(labels[n] || n) + '</label><input id="evp_' + n + '" data-param="' + n + '" placeholder="' + escAttr(t("evidence.autoFill")) + '" /></div>';
    }).join("");
    evToggleSource();
  }
  function evCollectParams() {
    var o = {};
    Array.prototype.forEach.call(document.querySelectorAll("#evParams [data-param]"), function (i) { if (i.value.trim()) o[i.getAttribute("data-param")] = i.value.trim(); });
    var r = $("evRecipient"); if (r && r.value.trim()) o.recipient = r.value.trim();
    return o;
  }
  function evRun() {
    var body = { appId: $("evApp").value, product: $("evProduct").value, source: $("evSource").value, allowWrites: $("evWrites").checked, params: evCollectParams() };
    if (body.source === "channel") body.channelId = $("evChannel").value;
    if (body.source === "paste") body.token = $("evToken").value.trim();
    if (!body.appId) { toast(t("evidence.pickApp"), true); return; }
    $("evRun").disabled = true; $("evSummary").textContent = t("common.loading"); $("evResults").innerHTML = ""; $("evDownload").style.display = "none";
    api("/api/evidence/run", { method: "POST", body: body }).then(function (d) {
      EV.lastDoc = d.doc || ""; EV.lastFile = d.filename || "evidencia.txt";
      $("evSummary").textContent = t("evidence.summary", { ok: d.summary.ok, total: d.summary.total, fail: d.summary.fail });
      $("evDownload").style.display = EV.lastDoc ? "inline-flex" : "none";
      evRenderResults(d.records || []);
    }).catch(function (e) { $("evSummary").textContent = ""; toast(e.message, true); })
      .then(function () { $("evRun").disabled = false; });
  }
  function evRenderResults(records) {
    $("evResults").innerHTML = records.map(function (r) {
      var cls = r.skipped ? "warn" : (r.ok ? "ok" : "bad");
      var st = r.skipped ? "—" : "HTTP " + r.status;
      var resp = typeof r.response === "string" ? r.response : JSON.stringify(r.response, null, 2);
      return '<div class="ev-row">' +
        '<div class="ev-head"><span class="ev-badge ' + cls + '">' + esc(st) + "</span> <b>" + esc(r.label) + '</b> <span class="ev-group">' + esc(r.group) + "</span></div>" +
        (r.traceId ? '<div class="ev-trace">trace ' + esc(r.traceId) + (r.requestId ? " · req " + esc(r.requestId) : "") + "</div>" : "") +
        "<details><summary>" + esc(t("events.payload")) + "</summary><pre>" + esc(resp) + "</pre></details>" +
      "</div>";
    }).join("");
  }
  function evDownloadDoc() {
    if (!EV.lastDoc) return;
    var blob = new Blob([EV.lastDoc], { type: "text/plain;charset=utf-8" });
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = EV.lastFile;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  // ── Wire up ────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", function () {
    if (window.I18N) window.I18N.applyI18n(document);
    buildLangSwitcher();
    initVideoLightbox();
    initVideoThumbs();
    document.addEventListener("click", function (e) {
      var dd = $("langDD");
      if (dd && dd.classList.contains("open") && (!e.target.closest || !e.target.closest("#langDD"))) closeLangMenu();
    });
    applyPromo();
    setPageTitle();
    window.addEventListener("i18n:changed", onLangChanged);
    setupTabs();
    applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
    $("loginForm").addEventListener("submit", function (e) { e.preventDefault(); doLogin(); });
    $("logoutBtn").addEventListener("click", doLogout);
    $("themeBtn").addEventListener("click", toggleTheme);
    $("saveSettings").addEventListener("click", saveSettings);
    $("newAppBtn").addEventListener("click", function () { openAppForm(null); });
    var onbBtn = $("onbCreateApp");
    if (onbBtn) onbBtn.addEventListener("click", function () { var tb = document.querySelector('[data-tab="apps"]'); if (tb) tb.click(); openAppForm(null); });
    $("refreshEvents").addEventListener("click", function () { fetchEvents(true); });
    $("clearEvents").addEventListener("click", clearEvents);
    ["evtSearch", "evtApp", "evtProduct"].forEach(function (id) {
      var el = $(id); if (el) { el.addEventListener("input", onEvtFilter); el.addEventListener("change", onEvtFilter); }
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-connect]"), function (btn) {
      btn.addEventListener("click", function () { connect(btn.getAttribute("data-connect")); });
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest) return;
      var tb = e.target.closest("[data-embed-test]");
      if (tb) {
        var w = window.open(tb.getAttribute("data-embed-test"), "zdg_connect", "width=560,height=740");
        if (!w) toast(t("embed.popupBlocked"), true);
        return;
      }
      var b = e.target.closest("[data-copy-text]");
      if (b) {
        navigator.clipboard.writeText(b.getAttribute("data-copy-text")).then(function () { toast(t("toast.copied")); }, function () { toast(t("toast.copyFail"), true); });
      }
    });
    bootstrap();
  });
})();
