/* EvaOS atmosphere clock — browser local time only. Isolated from Ask loop. */
(function () {
  "use strict";

  var root = document.getElementById("eva-clock");
  if (!root) return;

  var hourEl = root.querySelector(".hand-hour");
  var minuteEl = root.querySelector(".hand-minute");
  var secondEl = root.querySelector(".hand-second");
  var dateEl = root.querySelector(".clock-date");
  var tzEl = root.querySelector(".clock-tz");
  if (!hourEl || !minuteEl || !secondEl) return;

  var raf = 0;
  var lastSec = -1;

  function tzLabel() {
    try {
      var parts = new Intl.DateTimeFormat(undefined, {
        timeZoneName: "short",
      }).formatToParts(new Date());
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === "timeZoneName") return parts[i].value;
      }
    } catch (e) {}
    var off = -new Date().getTimezoneOffset();
    var sign = off >= 0 ? "+" : "-";
    var abs = Math.abs(off);
    var hh = String(Math.floor(abs / 60)).padStart(2, "0");
    var mm = String(abs % 60).padStart(2, "0");
    return "UTC" + sign + hh + (mm === "00" ? "" : ":" + mm);
  }

  function sync() {
    var now = new Date();
    var h = now.getHours() % 12;
    var m = now.getMinutes();
    var s = now.getSeconds();
    var ms = now.getMilliseconds();

    /* Continuous second for smooth motion; snap-recover on wake via Date. */
    var secFrac = s + ms / 1000;
    var minFrac = m + secFrac / 60;
    var hourFrac = h + minFrac / 60;

    hourEl.setAttribute("transform", "rotate(" + hourFrac * 30 + " 50 50)");
    minuteEl.setAttribute("transform", "rotate(" + minFrac * 6 + " 50 50)");
    secondEl.setAttribute("transform", "rotate(" + secFrac * 6 + " 50 50)");

    if (dateEl && s !== lastSec) {
      lastSec = s;
      try {
        dateEl.textContent = now.toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
      } catch (e) {
        dateEl.textContent = "";
      }
    }
  }

  function loop() {
    sync();
    raf = requestAnimationFrame(loop);
  }

  function start() {
    if (raf) cancelAnimationFrame(raf);
    sync();
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  if (tzEl) tzEl.textContent = tzLabel();

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") start();
    else stop();
  });
  window.addEventListener("focus", start);
  window.addEventListener("pageshow", start);

  start();
})();
