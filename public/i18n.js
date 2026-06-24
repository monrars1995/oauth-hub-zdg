/* oauth-hub — client i18n runtime. Consumes window.HUB_LOCALES (from /i18n-data.js). */
(function () {
  "use strict";
  var LANGS = window.HUB_LANGS || ["pt"];
  var DICT = window.HUB_LOCALES || {};
  var KEY = "hub_lang";

  function detect() {
    try { var s = localStorage.getItem(KEY); if (s && DICT[s]) return s; } catch (e) {}
    var navs = navigator.languages || [navigator.language || "pt"];
    for (var i = 0; i < navs.length; i++) {
      var p = String(navs[i] || "").toLowerCase().split("-")[0];
      if (DICT[p]) return p;
    }
    return DICT.pt ? "pt" : LANGS[0];
  }

  var current = detect();

  function t(key, vars) {
    var d = DICT[current] || {};
    var s = key in d ? d[key] : (DICT.pt && DICT.pt[key]) || key;
    if (vars) for (var k in vars) s = s.split("{" + k + "}").join(String(vars[k]));
    return s;
  }
  function getLang() { return current; }
  function setLang(l) {
    if (!DICT[l]) return;
    current = l;
    try { localStorage.setItem(KEY, l); } catch (e) {}
    document.documentElement.setAttribute("lang", l);
    applyI18n(document);
    try { window.dispatchEvent(new CustomEvent("i18n:changed", { detail: l })); } catch (e) {}
  }

  function applyI18n(root) {
    root = root || document;
    var set = function (sel, fn) {
      var ns = root.querySelectorAll(sel);
      for (var i = 0; i < ns.length; i++) fn(ns[i], ns[i].getAttribute(sel.slice(1, -1)));
    };
    set("[data-i18n]", function (n, k) { n.textContent = t(k); });
    set("[data-i18n-html]", function (n, k) { n.innerHTML = t(k); });
    set("[data-i18n-ph]", function (n, k) { n.setAttribute("placeholder", t(k)); });
    set("[data-i18n-aria]", function (n, k) { n.setAttribute("aria-label", t(k)); });
    set("[data-i18n-title]", function (n, k) { n.setAttribute("title", t(k)); });
  }

  window.I18N = { t: t, getLang: getLang, setLang: setLang, applyI18n: applyI18n, langs: LANGS };
  document.documentElement.setAttribute("lang", current);
})();
