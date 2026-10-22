// Общая логика свободных окошек. Один и тот же код работает на сайте (booking.js)
// и на сервере (apps-script.gs) — копируется туда без изменений.
//
// settings: { step: 30, capacity: 1, hours: { 0: null | ["09:00","21:00"], 1: [...], ... 6: [...] } }
//           (ключ — день недели JS: 0 = воскресенье)
// bookings: [{ d: "2026-10-23", t: "10:00", dur: 60 }]  — только не отменённые
// Возвращает [{ t: "09:00", free: true/false }] для даты и нужной длительности.

var Slots = (function () {
  function toMin(hhmm) { var p = String(hhmm).split(":"); return +p[0] * 60 + +p[1]; }
  function toHHMM(m) { var h = Math.floor(m / 60), mm = m % 60; return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm; }
  function weekday(dateStr) { var p = dateStr.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]).getDay(); }

  // Сколько машин/компаний занято в каждую минуту-отметку шага.
  function load(dateStr, settings, bookings) {
    var map = {};
    bookings.forEach(function (b) {
      if (b.d !== dateStr) return;
      var s = toMin(b.t), e = s + (+b.dur || settings.step);
      for (var m = s; m < e; m += settings.step) map[m] = (map[m] || 0) + 1;
    });
    return map;
  }

  // nowMin — для сегодняшнего дня: окошки раньше «сейчас + запас» недоступны.
  function day(dateStr, dur, settings, bookings, nowMin) {
    var hours = settings.hours[weekday(dateStr)];
    if (!hours) return [];
    var open = toMin(hours[0]), close = toMin(hours[1]) || 24 * 60, step = settings.step, cap = settings.capacity || 1;
    if (close <= open) close += 24 * 60;
    var busy = load(dateStr, settings, bookings), out = [];
    for (var s = open; s + step <= close; s += step) {
      var fits = s + dur <= close && (nowMin == null || s >= nowMin);
      for (var m = s; fits && m < s + dur; m += step) if ((busy[m] || 0) >= cap) fits = false;
      out.push({ t: toHHMM(s % (24 * 60)), free: fits, full: (busy[s] || 0) >= cap });
    }
    return out;
  }

  function isFree(dateStr, time, dur, settings, bookings, nowMin) {
    return day(dateStr, dur, settings, bookings, nowMin).some(function (x) { return x.t === time && x.free; });
  }

  return { day: day, isFree: isFree, toMin: toMin, toHHMM: toHHMM, weekday: weekday };
})();


/* Виджет онлайн-записи с сеткой свободного времени.
   Подключение на сайте:
     <div id="booking"></div>
     <script>window.BOOKING = { endpoint: "https://script.google.com/macros/s/…/exec", wa: "79242235757", name: "Драйв Бум", kind: "tyre" };</script>
     <script src="booking.js"></script>
   Без endpoint (или demo: true) работает в демо-режиме: занятость придумана, записи хранятся только в этом браузере.
   Цвета берутся из CSS-переменных сайта: --bk-accent, --bk-on-accent, --bk-bg, --bk-card, --bk-text, --bk-dim, --bk-line. */
(function () {
  "use strict";
  var C = window.BOOKING || {};
  var root = document.querySelector(C.el || "#booking");
  if (!root) return;
  root.style.minWidth = "0"; root.style.maxWidth = "100%";
  var DEMO = !C.endpoint || C.demo;
  var WD = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"], MON = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  var KINDS = {
    tyre: [{ n: "car", l: "Машина", type: "text", ph: "Toyota Camry", req: true },
           { n: "radius", l: "Радиус", type: "select", opts: ["R13", "R14", "R15", "R16", "R17", "R18", "R19", "R20", "R21", "R22", "Не знаю"], def: "R16" }],
    banya: [{ n: "guests", l: "Гостей", type: "select", opts: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10+"], def: "2" }]
  };
  var FIELDS = C.fields || KINDS[C.kind || "tyre"] || [];
  var S = { settings: null, services: [], busy: [], today: null, now: null, date: null, time: null, service: null, hours: null, sending: false };

  /* ---------- стили ---------- */
  var css = "\
.bk{--a:var(--bk-accent,#ffd60a);--oa:var(--bk-on-accent,#141414);--bg:var(--bk-bg,#111);--card:var(--bk-card,#1c1d1f);--tx:var(--bk-text,#f3f3ef);--dim:var(--bk-dim,#9a9a95);--ln:var(--bk-line,rgba(255,255,255,.14));color:var(--tx);font:inherit}\
.bk *{box-sizing:border-box}\
.bk,.bk-card{min-width:0;max-width:100%}\
.bk-card{background:var(--card);border:1px solid var(--ln);border-radius:20px;padding:22px}\
.bk-step{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);font-weight:700;margin:24px 0 10px}\
.bk-card>.bk-step:first-child{margin-top:0}\
.bk select,.bk input,.bk textarea{font:inherit;font-size:16px;color:var(--tx);background:var(--bg);border:2px solid transparent;border-radius:10px;padding:12px 14px;width:100%;outline:none;color-scheme:dark}\
.bk select:focus,.bk input:focus,.bk textarea:focus{border-color:var(--a)}\
.bk-days{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;scrollbar-width:thin}\
.bk-day{flex:none;min-width:64px;padding:10px 8px;border-radius:12px;border:2px solid var(--ln);background:transparent;color:var(--tx);cursor:pointer;text-align:center;font:inherit}\
.bk-day b{display:block;font-size:20px;line-height:1.1}.bk-day small{display:block;font-size:12px;color:var(--dim);margin-top:2px}\
.bk-day[aria-pressed=true]{background:var(--a);border-color:var(--a);color:var(--oa)}.bk-day[aria-pressed=true] small{color:var(--oa);opacity:.75}\
.bk-day:disabled{opacity:.35;cursor:not-allowed}\
.bk-times{display:grid;grid-template-columns:repeat(auto-fill,minmax(74px,1fr));gap:8px}\
.bk-t{padding:11px 4px;border-radius:10px;border:2px solid var(--ln);background:transparent;color:var(--tx);font:inherit;font-weight:700;cursor:pointer;font-variant-numeric:tabular-nums}\
.bk-t:hover:not(:disabled){border-color:var(--a)}\
.bk-t[aria-pressed=true]{background:var(--a);border-color:var(--a);color:var(--oa)}\
.bk-t:disabled{cursor:not-allowed;color:var(--dim);border-style:dashed;text-decoration:line-through;opacity:.55}\
.bk-legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;font-size:13px;color:var(--dim)}\
.bk-legend i{display:inline-block;width:12px;height:12px;border-radius:3px;border:2px solid var(--ln);margin-right:6px;vertical-align:-1px}\
.bk-legend .x{border-style:dashed;opacity:.6}.bk-legend .s{background:var(--a);border-color:var(--a)}\
.bk-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}\
.bk-grid label{display:flex;flex-direction:column;gap:6px;font-size:14px;color:var(--dim)}\
.bk-grid .w{grid-column:1/-1}\
.bk-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;margin-top:18px;padding:17px 20px;border:0;border-radius:12px;background:var(--a);color:var(--oa);font:inherit;font-weight:800;font-size:16px;letter-spacing:.03em;text-transform:uppercase;cursor:pointer;text-decoration:none;text-align:center}\
.bk-btn:disabled{opacity:.5;cursor:wait}\
.bk-btn.ln{background:transparent;color:var(--tx);border:2px solid var(--ln)}\
.bk-sum{margin-top:16px;padding:12px 14px;border-radius:12px;background:var(--bg);font-size:15px;color:var(--tx)}\
.bk-sum b{color:var(--a)}\
.bk-msg{margin-top:12px;font-weight:600;color:var(--a);min-height:1.2em}\
.bk-note{margin-top:10px;font-size:12px;color:var(--dim);line-height:1.5}\
.bk-empty{padding:14px;border-radius:12px;background:var(--bg);color:var(--dim);font-size:15px}\
.bk-ok{text-align:center;padding:10px 4px}\
.bk-ok .ic{width:64px;height:64px;border-radius:50%;margin:0 auto 14px;display:grid;place-items:center;background:var(--a);color:var(--oa);font-size:34px;font-weight:900}\
.bk-ok h3{font-size:24px;margin:0 0 6px}.bk-ok p{color:var(--dim);margin:0}\
.bk-demo{margin-top:12px;font-size:12px;color:var(--dim);text-align:center}\
.bk-hp{position:absolute;left:-9999px;opacity:0}\
@media(max-width:480px){.bk-card{padding:16px}.bk-times{grid-template-columns:repeat(4,1fr)}}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  /* ---------- данные ---------- */
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function add(dateStr, n) { var p = dateStr.split("-"); return iso(new Date(+p[0], +p[1] - 1, +p[2] + n)); }
  function human(dateStr) { var p = dateStr.split("-"), d = new Date(+p[0], +p[1] - 1, +p[2]); return WD[d.getDay()] + ", " + +p[2] + " " + MON[+p[1] - 1]; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function jsonp(url) {
    return new Promise(function (res, rej) {
      var cb = "bk_cb_" + Math.random().toString(36).slice(2), s = document.createElement("script");
      var to = setTimeout(function () { clean(); rej(new Error("timeout")); }, 15000);
      function clean() { clearTimeout(to); delete window[cb]; s.remove(); }
      window[cb] = function (d) { clean(); res(d); };
      s.onerror = function () { clean(); rej(new Error("load")); };
      s.src = url + (url.indexOf("?") < 0 ? "?" : "&") + "callback=" + cb + "&_=" + Date.now();
      document.head.appendChild(s);
    });
  }

  // Демо: правдоподобная занятость, записи — в localStorage этого браузера
  function demoData() {
    var today = iso(new Date()), now = new Date(), h = C.demoHours || ["09:00", "21:00"], hours = {};
    for (var i = 0; i < 7; i++) hours[i] = h;
    var busy = [], seed = 7;
    function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    for (var d = 0; d < 14; d++) {
      var ds = add(today, d), n = d === 0 ? 4 : 3 + Math.floor(rnd() * 5);
      for (var k = 0; k < n; k++) { var m = 9 * 60 + Math.floor(rnd() * 22) * 30; busy.push({ d: ds, t: pad(Math.floor(m / 60)) + ":" + pad(m % 60), dur: rnd() > .5 ? 60 : 30 }); }
    }
    try { (JSON.parse(localStorage.getItem("bk_demo") || "[]")).forEach(function (b) { busy.push(b); }); } catch (e) {}
    return { ok: true, today: today, now: now.getHours() * 60 + now.getMinutes(),
      settings: { name: C.name || "", step: 30, capacity: 1, days: 14, lead: 30, hours: hours },
      services: C.services || [{ name: "Сезонная переобувка", dur: 60 }, { name: "Шиномонтаж + балансировка", dur: 60 }, { name: "Ремонт прокола / пореза", dur: 30 }, { name: "Правка диска", dur: 60 }],
      busy: busy };
  }

  function load() {
    var p = DEMO ? Promise.resolve(demoData()) : jsonp(C.endpoint);
    return p.then(function (d) {
      if (!d || !d.ok) throw new Error("bad");
      S.settings = d.settings; S.services = d.services || []; S.busy = d.busy || []; S.today = d.today; S.now = d.now;
      if (!S.service && S.services.length) S.service = S.services[0];
    });
  }

  function post(body) {
    if (DEMO) {
      return new Promise(function (res) {
        setTimeout(function () {
          if (!Slots.isFree(body.d, body.t, body.dur, S.settings, S.busy, body.d === S.today ? S.now + S.settings.lead : null))
            return res({ ok: false, error: "Это время только что заняли — выберите другое", taken: true });
          try { var a = JSON.parse(localStorage.getItem("bk_demo") || "[]"); a.push({ d: body.d, t: body.t, dur: body.dur }); localStorage.setItem("bk_demo", JSON.stringify(a)); } catch (e) {}
          res({ ok: true, id: "demo" });
        }, 500);
      });
    }
    return fetch(C.endpoint, { method: "POST", body: JSON.stringify(body) }).then(function (r) { return r.json(); });
  }

  function dur() {
    if (C.durationField) { var v = parseFloat(field(C.durationField)); return Math.round((isNaN(v) ? 1 : v) * 60); }
    return S.service ? S.service.dur : S.settings.step;
  }
  function field(n) { var el = root.querySelector('[name="bk_' + n + '"]'); return el ? el.value.trim() : ""; }

  /* ---------- отрисовка ---------- */
  function render() {
    var st = S.settings, html = '<div class="bk"><div class="bk-card">';
    if (S.services.length > 1 && !C.durationField) {
      html += '<p class="bk-step">1. Что нужно</p><select name="bk_service">' + S.services.map(function (s, i) {
        return '<option value="' + i + '"' + (S.service === s ? " selected" : "") + ">" + esc(s.name) + "</option>";
      }).join("") + "</select>";
    }
    if (C.durationField) {
      var df = FIELDS.filter(function (f) { return f.n === C.durationField; })[0];
      if (df) html += '<p class="bk-step">1. ' + esc(df.l) + '</p>' + input(df);
    }
    html += '<p class="bk-step">2. День</p><div class="bk-days">';
    for (var i = 0; i <= st.days; i++) {
      var ds = add(S.today, i), p = ds.split("-"), wd = Slots.weekday(ds), open = !!st.hours[wd];
      if (!S.date && open && freeCount(ds) > 0) S.date = ds;
      html += '<button type="button" class="bk-day" data-d="' + ds + '" aria-pressed="' + (S.date === ds) + '"' + (open ? "" : " disabled") + '>' +
        '<small>' + (i === 0 ? "сегодня" : i === 1 ? "завтра" : WD[wd]) + '</small><b>' + +p[2] + '</b><small>' + MON[+p[1] - 1] + "</small></button>";
    }
    html += '</div><p class="bk-step">3. Время</p>';
    var slots = S.date ? Slots.day(S.date, dur(), st, S.busy, S.date === S.today ? S.now + st.lead : null) : [];
    if (!slots.some(function (x) { return x.free; })) html += '<div class="bk-empty">На этот день свободного времени нет — выберите другой день.</div>';
    else {
      html += '<div class="bk-times">' + slots.map(function (x) {
        return '<button type="button" class="bk-t" data-t="' + x.t + '"' + (x.free ? "" : " disabled") + ' aria-pressed="' + (S.time === x.t) + '">' + x.t + "</button>";
      }).join("") + '</div><div class="bk-legend"><span><i></i>свободно</span><span><i class="x"></i>занято</span><span><i class="s"></i>ваш выбор</span></div>';
    }
    html += '<p class="bk-step">4. Ваши данные</p><div class="bk-grid">' +
      FIELDS.filter(function (f) { return f.n !== C.durationField; }).map(function (f) { return '<label' + (f.wide ? ' class="w"' : "") + ">" + esc(f.l) + input(f) + "</label>"; }).join("") +
      '<label>Имя<input name="bk_name" autocomplete="given-name" value="' + esc(S.v_name || "") + '"></label>' +
      '<label>Телефон<input name="bk_phone" type="tel" autocomplete="tel" placeholder="+7" value="' + esc(S.v_phone || "") + '"></label>' +
      '<label class="w">Комментарий<input name="bk_comment" placeholder="' + esc(C.commentPh || "Например: приеду на кроссовере") + '" value="' + esc(S.v_comment || "") + '"></label>' +
      '<input class="bk-hp" name="bk_website" tabindex="-1" autocomplete="off" aria-hidden="true"></div>';
    if (S.date && S.time) html += '<div class="bk-sum">Вы выбрали: <b>' + human(S.date) + ", " + S.time + "</b>" + (S.service && !C.durationField ? " · " + esc(S.service.name) : "") + "</div>";
    html += '<button type="button" class="bk-btn" data-go' + (S.sending ? " disabled" : "") + ">" + (S.sending ? "Записываем…" : "Записаться") + "</button>" +
      '<p class="bk-msg" role="status">' + esc(S.msg || "") + "</p>" +
      '<p class="bk-note">Нажимая кнопку, вы соглашаетесь на обработку имени и телефона для записи.</p>' +
      (DEMO ? '<p class="bk-demo">Демо-режим: занятость для примера, запись никуда не отправляется.</p>' : "") + "</div></div>";
    var keep = {}; FIELDS.forEach(function (f) { keep[f.n] = field(f.n); });
    root.innerHTML = html;
    FIELDS.forEach(function (f) { var el = root.querySelector('[name="bk_' + f.n + '"]'); if (el && keep[f.n]) el.value = keep[f.n]; });
  }
  function input(f) {
    if (f.type === "select") return '<select name="bk_' + f.n + '">' + f.opts.map(function (o) { return "<option" + (o === f.def ? " selected" : "") + ">" + esc(o) + "</option>"; }).join("") + "</select>";
    return '<input name="bk_' + f.n + '" placeholder="' + esc(f.ph || "") + '">';
  }
  function freeCount(ds) {
    return Slots.day(ds, dur(), S.settings, S.busy, ds === S.today ? S.now + S.settings.lead : null).filter(function (x) { return x.free; }).length;
  }
  function remember() { S.v_name = field("name"); S.v_phone = field("phone"); S.v_comment = field("comment"); }

  function done(id) {
    var lines = [(C.waIntro || "Здравствуйте! Я записался через сайт" + (C.name ? " «" + C.name + "»" : "")) + ".",
      "Когда: " + human(S.date) + ", " + S.time];
    if (S.service && !C.durationField) lines.push("Услуга: " + S.service.name);
    FIELDS.forEach(function (f) { var v = field(f.n); if (v) lines.push(f.l + ": " + v); });
    lines.push("Имя: " + field("name"), "Телефон: " + field("phone"));
    if (field("comment")) lines.push("Комментарий: " + field("comment"));
    var wa = C.wa ? "https://wa.me/" + C.wa + "?text=" + encodeURIComponent(lines.join("\n")) : "";
    root.innerHTML = '<div class="bk"><div class="bk-card bk-ok"><div class="ic">✓</div><h3>Вы записаны</h3><p>' + human(S.date) + ", " + S.time + "</p>" +
      (wa ? '<a class="bk-btn" href="' + wa + '" target="_blank" rel="noopener">Отправить подтверждение в WhatsApp</a>' : "") +
      '<button type="button" class="bk-btn ln" data-again>Записать ещё одну машину</button>' +
      (DEMO ? '<p class="bk-demo">Демо-режим: на настоящем сайте запись сразу появится у владельца в расписании.</p>' : "") + "</div></div>";
  }

  root.addEventListener("click", function (e) {
    var b = e.target.closest("button,a"); if (!b || !root.contains(b)) return;
    if (b.dataset.d) { remember(); S.date = b.dataset.d; S.time = null; S.msg = ""; render(); }
    else if (b.dataset.t) { remember(); S.time = b.dataset.t; S.msg = ""; render(); }
    else if (b.hasAttribute("data-again")) { S.time = null; S.msg = ""; load().then(render); }
    else if (b.hasAttribute("data-go")) submit();
  });
  root.addEventListener("change", function (e) {
    if (e.target.name === "bk_service") { remember(); S.service = S.services[+e.target.value]; S.time = null; render(); }
    if (C.durationField && e.target.name === "bk_" + C.durationField) { remember(); S.time = null; render(); }
  });

  function submit() {
    remember();
    var miss = [];
    if (!S.date || !S.time) miss.push("время");
    FIELDS.forEach(function (f) { if (f.req && !field(f.n)) miss.push(f.l.toLowerCase()); });
    if (!field("name")) miss.push("имя");
    if (field("phone").replace(/\D/g, "").length < 10) miss.push("телефон");
    if (miss.length) { S.msg = "Укажите: " + miss.join(", ") + "."; render(); return; }
    var details = FIELDS.filter(function (f) { return f.n !== C.durationField; }).map(function (f) { var v = field(f.n); return v ? f.l + ": " + v : ""; }).filter(Boolean).join(", ");
    var body = { action: "book", d: S.date, t: S.time, dur: dur(), service: C.durationField ? field(C.durationField) + " ч" : (S.service ? S.service.name : ""),
      details: details, name: field("name"), phone: field("phone"), comment: field("comment"), website: field("website") };
    S.sending = true; S.msg = ""; render();
    post(body).then(function (r) {
      S.sending = false;
      if (r && r.ok) return done(r.id);
      S.msg = (r && r.error) || "Не получилось записаться. Попробуйте ещё раз или позвоните.";
      if (r && r.taken) { S.time = null; return load().then(render); }
      render();
    }).catch(function () { S.sending = false; S.msg = "Нет связи. Попробуйте ещё раз или позвоните."; render(); });
  }

  root.innerHTML = '<div class="bk"><div class="bk-card"><div class="bk-empty">Загружаем свободное время…</div></div></div>';
  load().then(render).catch(function () {
    root.innerHTML = '<div class="bk"><div class="bk-card"><div class="bk-empty">Не удалось загрузить расписание. ' +
      (C.wa ? '<a href="https://wa.me/' + C.wa + '" style="color:var(--a)">Напишите нам в WhatsApp</a>' : "Позвоните нам") + ".</div></div></div>";
  });
})();
