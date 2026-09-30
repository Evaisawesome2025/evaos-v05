/* EvaOS v0.5 — local snapshot Q&A + in-product Ask via Worker. No secrets in source. */
(function () {
  "use strict";

  var ANSWERS = {
    working: {
      q: "What are you working on?",
      html:
        "<p><strong>Doing now</strong></p>" +
        "<ul>" +
        "<li>Passive watch on ListingLift through about Oct 13 — partner reply if any, the emails that already arrived, whether anyone pays $39.</li>" +
        "<li>Keeping the public page and checkout up.</li>" +
        "<li>Searching for the next honest business bet in the background. That search did not pause when ListingLift parked.</li>" +
        "</ul>" +
        "<p><strong>Not doing</strong></p>" +
        "<ul>" +
        "<li>No new cold email. No second channel invented to rescue ListingLift. No spend.</li>" +
        "</ul>"
    },
    money: {
      q: "Why no money yet?",
      html:
        "<p>Collected from strangers: <strong>$0</strong>. Customers: <strong>0</strong>. First goal is $100. Not there.</p>" +
        "<p>ListingLift is live at $39 with <strong>0</strong> paid orders. Cold email mostly failed delivery (spam / send limits), so that wave was not a clean demand test. A Reddit post was removed by Reddit. One partner soft-intro was sent this morning — still waiting on a reply, a share, or silence.</p>" +
        "<p>We do not invent a forecast or a “time to $100” chart. Strangers paying is the evidence. Until then the honest number is zero.</p>"
    },
    park: {
      q: "Why park ListingLift?",
      html:
        "<p>After one last cheap, approved test (a soft partner introduction, sent 2026-09-30), active investment stopped. Park means: keep the page and checkout up, watch quietly, do not invent new channels, do not spend to “save” it.</p>" +
        "<p>It is <strong>not</strong> a kill yet. Killing needs a clearer “nobody wants this” signal than we have. Acquisition failure (mail not landing, post removed) is not the same as demand failure.</p>" +
        "<p>Window for passive watch runs to about Oct 13.</p>"
    },
    approve: {
      q: "What if I approve?",
      html:
        "<p>Right now there is <strong>nothing waiting for a yes or no</strong> on the online business. If an approval card appeared, it would say: what Eva wants to do, why, max cost, risk, and what happens if you approve.</p>" +
        "<p><strong>If you approved:</strong> Eva would do that one consequential thing. You would not operate the tools. The card’s “if approved” line is the promise.</p>" +
        "<p><strong>On this page:</strong> Approve / Reject buttons are sample-only. They do not execute. Real decisions still happen with Eva until this surface is wired.</p>" +
        "<p>Last real yes: one soft partner introduction for ListingLift ($0). Sent 2026-09-30. Done.</p>"
    },
    risks: {
      q: "What are the risks right now?",
      html:
        "<ul>" +
        "<li><strong>Zero revenue:</strong> still $0 stranger cash. The business has not proven strangers will pay.</li>" +
        "<li><strong>Confusing delivery with demand:</strong> counting spam or removed posts as “market said no” would kill the wrong thing.</li>" +
        "<li><strong>Rescue theater:</strong> inventing new ListingLift channels or spending to force a win would burn attention that should find the next honest bet.</li>" +
        "<li><strong>Wrong checkout:</strong> already caught once (working link, wrong product). Independent checks stay mandatory before consequential sends.</li>" +
        "</ul>" +
        "<p>Nothing on this page needs your decision today. The quiet risk is over-managing a parked bet.</p>"
    },
    next: {
      q: "What’s next?",
      html:
        "<p>Passive watch on ListingLift to about <strong>Oct 13</strong>. Read the partner note honestly. Watch for a $39 purchase. Keep searching for the next business in the background.</p>" +
        "<p>On the shelf (not started): help small food manufacturers assemble audit paperwork — records check, not food-safety advice. No contact. No spend. Waits until ListingLift’s window is read honestly.</p>" +
        "<p>You do not need to do anything for the online business unless something here turns amber.</p>"
    },
    kill: {
      q: "Why kill those earlier ideas?",
      html:
        "<p>Several ideas were stopped because <strong>category spend ≠ people paying us</strong>, or the beachhead was too weak to burn outreach:</p>" +
        "<ul>" +
        "<li>Contractor quote-follow-up — killed before outreach (weak beachhead).</li>" +
        "<li>Backer-update pack, escape-room weekday pack, bid-watch PDF — killed (category WTP ≠ our SKU).</li>" +
        "<li>Free Gmail as the stranger channel — killed as a capability (not a product).</li>" +
        "<li>ListingLift cold — parked for delivery, not killed for demand.</li>" +
        "</ul>" +
        "<p>Kill early when evidence says so. Do not polish a thin wrapper hoping strangers will appear.</p>"
    },
    needme: {
      q: "Do you need me?",
      html:
        "<p><strong>For the online business: no.</strong> Nothing needs an owner yes/no right now.</p>" +
        "<p>Eva keeps watching ListingLift and searching for the next bet. Come back for the next Catch Me Up, or when an approval card appears.</p>" +
        "<p>Older items still blank in the approval file (VA hiring, small sandbox credit, deferred tools) are behind the “More detail” section — they are the file, not a fresh ask about today’s online bet. This page is not asking you to spend.</p>"
    },
    catchup: {
      q: "Catch me up",
      html:
        "<p>Scroll to the letter above — that is the full Catch Me Up. Short version:</p>" +
        "<ul>" +
        "<li>Partner soft-intro for ListingLift <strong>sent</strong> this morning.</li>" +
        "<li>Active ListingLift investment <strong>parked</strong>; page + $39 checkout stay up.</li>" +
        "<li>Still <strong>$0</strong> from strangers. Searching for the next honest bet continues.</li>" +
        "<li>You are clear — nothing needs you on the online business right now.</li>" +
        "</ul>"
    },
    direction: {
      q: "I don’t like this direction",
      html:
        "<p>This page cannot change course. It only explains the current snapshot.</p>" +
        "<p>If you want a different direction — pause the search, un-park cold, kill ListingLift, or start the shelf idea — say so to Eva the usual way. That becomes an owner decision with a clear packet (what / why / cost / risk), not a chat guess on a public page.</p>" +
        "<p>Right now Eva’s operating assumption is: park ListingLift after the partner note, watch to ~Oct 13, keep Opportunity Intelligence running, spend $0.</p>"
    },
    spend: {
      q: "Spend / caps",
      html:
        "<p>Ads spent: <strong>$0</strong>. Refunds: <strong>$0</strong>. Last consequential yes cost <strong>$0</strong> (partner note).</p>" +
        "<p>This page does not spend money and is not asking you to. Nonessential purchases were paused Sep 29. Caps and Pay gates stay with you and Eva — not with this static site.</p>"
    }
  };

  var KEYWORDS = [
    { keys: ["catch", "catch me up", "summary", "brief", "what happened"], id: "catchup" },
    { keys: ["working", "doing", "what are you", "activity", "busy"], id: "working" },
    { keys: ["money", "revenue", "paid", "customers", "sales", "$0", "cash", "why no"], id: "money" },
    { keys: ["park", "listinglift", "listing lift", "why park", "paused"], id: "park" },
    { keys: ["approve", "approval", "what if", "reject", "yes or no"], id: "approve" },
    { keys: ["risk", "risks", "danger", "worry", "afraid"], id: "risks" },
    { keys: ["next", "what next", "then", "upcoming", "plan"], id: "next" },
    { keys: ["kill", "killed", "stop", "graveyard", "earlier ideas"], id: "kill" },
    { keys: ["need me", "need you", "do i", "anything", "clear"], id: "needme" },
    { keys: ["direction", "don't like", "dont like", "hate", "wrong", "another"], id: "direction" },
    { keys: ["spend", "cap", "budget", "ads", "cost", "pay"], id: "spend" }
  ];

  function matchIntent(text) {
    var t = (text || "").toLowerCase().trim();
    if (!t) return null;
    for (var i = 0; i < KEYWORDS.length; i++) {
      var row = KEYWORDS[i];
      for (var j = 0; j < row.keys.length; j++) {
        if (t.indexOf(row.keys[j]) !== -1) return row.id;
      }
    }
    return null;
  }

  function showAnswer(id) {
    var entry = ANSWERS[id];
    if (!entry) return;
    var box = document.getElementById("answer");
    document.getElementById("answer-q").textContent = entry.q;
    document.getElementById("answer-a").innerHTML = entry.html;
    box.classList.add("show");
    document.querySelectorAll(".chip").forEach(function (c) {
      c.classList.toggle("active", c.getAttribute("data-intent") === id);
    });
    if (id === "catchup") {
      var letter = document.getElementById("catch-me-up");
      if (letter) letter.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function showUnknown(raw) {
    var box = document.getElementById("answer");
    document.getElementById("answer-q").textContent = raw ? ("About: " + raw.slice(0, 80)) : "No match";
    document.getElementById("answer-a").innerHTML =
      "<p>I only answer from this snapshot’s facts. Try a chip above, or ask about: what Eva is doing, money, why park, approvals, risks, what’s next, kills, or whether you are needed.</p>" +
      "<p>This local box is not live Eva. For a real reply, use <strong>Ask Eva (real)</strong> Submit above (stays on EvaOS).</p>";
    box.classList.add("show");
    document.querySelectorAll(".chip").forEach(function (c) {
      c.classList.remove("active");
    });
  }

  document.querySelectorAll(".chip").forEach(function (btn) {
    btn.addEventListener("click", function () {
      showAnswer(btn.getAttribute("data-intent"));
    });
  });

  var form = document.getElementById("ask-form");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var input = document.getElementById("ask-input");
    var raw = (input.value || "").trim();
    var id = matchIntent(raw);
    if (id) showAnswer(id);
    else showUnknown(raw);
  });



  /* --- Real Ask: POST to Cloudflare Worker (bearer in localStorage only) --- */
  // Worker URL is public (not a secret). Bearer never belongs in this file.
  var WORKER_URL = (window.EVAOS_WORKER_URL || "https://evaos-v05-ask.stump-lawyer-880.workers.dev");
  var OUTBOX_URL = "outbox/threads.json";
  var TOKEN_KEY = "evaos_v05_owner_bearer";
  var PENDING_KEY = "evaos_v05_pending";

  function getToken() {
    try {
      return (localStorage.getItem(TOKEN_KEY) || "").trim();
    } catch (e) {
      return "";
    }
  }

  function setToken(v) {
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  function loadPending() {
    try {
      return JSON.parse(localStorage.getItem(PENDING_KEY) || "[]");
    } catch (e) {
      return [];
    }
  }

  function savePending(list) {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(0, 20)));
    } catch (e) {}
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function updateTokenStatus() {
    var el = document.getElementById("token-status");
    var setup = document.getElementById("token-setup");
    if (!el) return;
    if (getToken()) {
      el.textContent = "Token saved in this browser (localStorage). Ready to Submit.";
      if (setup) setup.open = false;
    } else {
      el.textContent = "No token yet — expand and paste before Submit.";
      if (setup) setup.open = true;
    }
  }

  var tokenForm = document.getElementById("token-form");
  if (tokenForm) {
    tokenForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = document.getElementById("owner-token-input");
      var v = (input && input.value || "").trim();
      if (!v || v.length < 16) {
        var st = document.getElementById("token-status");
        if (st) st.textContent = "Token looks too short. Paste the full OWNER_BEARER value.";
        return;
      }
      setToken(v);
      if (input) input.value = "";
      updateTokenStatus();
    });
  }
  var clearBtn = document.getElementById("clear-token");
  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      setToken("");
      updateTokenStatus();
      var st = document.getElementById("token-status");
      if (st) st.textContent = "Token cleared from this browser.";
    });
  }
  updateTokenStatus();

  function setAskStatus(text, cls) {
    var el = document.getElementById("ask-status");
    if (!el) return;
    el.textContent = text || "";
    el.className = "ask-status" + (cls ? " " + cls : "");
  }

  function renderPending() {
    var root = document.getElementById("pending");
    if (!root) return;
    var list = loadPending();
    if (!list.length) {
      root.innerHTML = "";
      return;
    }
    var html = "";
    list.forEach(function (p) {
      html +=
        '<article class="pend">' +
        '<p class="st">' +
        esc(p.status || "SENT") +
        (p.kind === "selftest" ? " · SELFTEST" : "") +
        (p.at ? " · " + esc(p.at) : "") +
        "</p>" +
        '<p class="q">' +
        esc(p.question || "") +
        "</p>" +
        (p.error
          ? '<p class="hint">' + esc(p.error) + "</p>"
          : p.status === "PROCESSING"
            ? '<p class="hint">Waiting for Eva to process and publish outbox…</p>'
            : p.status === "SENT"
              ? '<p class="hint">Accepted by trusted ingress. Eva will process on the box.</p>'
              : "") +
        "</article>";
    });
    root.innerHTML = html;
  }

  function upsertPending(entry) {
    var list = loadPending().filter(function (p) {
      return p.intent_id !== entry.intent_id;
    });
    list.unshift(entry);
    savePending(list);
    renderPending();
  }

  function removePending(intentId) {
    savePending(
      loadPending().filter(function (p) {
        return p.intent_id !== intentId;
      })
    );
    renderPending();
  }

  var realForm = document.getElementById("real-ask-form");
  var realInput = document.getElementById("real-ask-input");
  var submitBtn = document.getElementById("ask-submit");
  if (realForm && realInput) {
    realForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var q = (realInput.value || "").trim();
      if (!q) return;
      var token = getToken();
      if (!token) {
        setAskStatus("Paste owner token first (expand “Owner token” above).", "failed");
        var setup = document.getElementById("token-setup");
        if (setup) setup.open = true;
        return;
      }
      if (submitBtn) submitBtn.disabled = true;
      setAskStatus("Sending…", "sent");

      fetch(WORKER_URL.replace(/\/$/, "") + "/intent", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ type: "ask", body: q }),
      })
        .then(function (r) {
          return r.json().then(function (data) {
            return { ok: r.ok, status: r.status, data: data };
          });
        })
        .then(function (res) {
          if (!res.ok || !res.data || res.data.status === "FAILED") {
            var err =
              (res.data && (res.data.message || res.data.error)) ||
              "request_failed";
            setAskStatus("FAILED — " + err, "failed");
            upsertPending({
              intent_id: (res.data && res.data.intent_id) || "local-" + Date.now(),
              question: q,
              status: "FAILED",
              error: String(err),
              at: new Date().toLocaleString(),
            });
            return;
          }
          var intentId = res.data.intent_id;
          realInput.value = "";
          setAskStatus("SENT — Ask accepted. Waiting for Eva…", "sent");
          upsertPending({
            intent_id: intentId,
            question: q,
            status: "SENT",
            kind: res.data.kind,
            at: new Date().toLocaleString(),
          });
          // Flip to PROCESSING after a beat (honest: accepted, not yet answered)
          setTimeout(function () {
            var list = loadPending();
            list.forEach(function (p) {
              if (p.intent_id === intentId && p.status === "SENT") p.status = "PROCESSING";
            });
            savePending(list);
            renderPending();
            setAskStatus("PROCESSING — Eva has not published a reply yet.", "processing");
          }, 800);
          // Start polling outbox sooner
          pollOutbox(true);
        })
        .catch(function () {
          setAskStatus("FAILED — network or Worker unreachable.", "failed");
          upsertPending({
            intent_id: "local-" + Date.now(),
            question: q,
            status: "FAILED",
            error: "network_or_worker_unreachable",
            at: new Date().toLocaleString(),
          });
        })
        .finally(function () {
          if (submitBtn) submitBtn.disabled = false;
        });
    });
  }

  function renderThreads(data) {
    var root = document.getElementById("threads");
    if (!root) return;
    var threads = (data && data.threads) || [];
    // Match pending → ANSWERED
    var pending = loadPending();
    var answeredIds = {};
    threads.forEach(function (t) {
      if (t.intent_id) answeredIds[t.intent_id] = true;
    });
    var still = [];
    pending.forEach(function (p) {
      if (p.intent_id && answeredIds[p.intent_id]) {
        /* drop — shown in threads as ANSWERED */
      } else if (p.status === "FAILED") {
        still.push(p);
      } else {
        if (p.status === "SENT") p.status = "PROCESSING";
        still.push(p);
      }
    });
    savePending(still);
    renderPending();
    if (still.some(function (p) { return p.status === "PROCESSING" || p.status === "SENT"; })) {
      setAskStatus("PROCESSING — waiting for Eva outbox…", "processing");
    } else if (Object.keys(answeredIds).length && pending.length && still.length < pending.length) {
      setAskStatus("ANSWERED — reply below.", "answered");
    }

    if (!threads.length) {
      root.innerHTML =
        '<p class="threads-empty" id="threads-empty">No real replies yet. Submit an Ask above — you stay on EvaOS.</p>';
      return;
    }
    var html = "";
    threads.forEach(function (t) {
      var kind = t.kind === "selftest" ? " · SELFTEST (not owner)" : "";
      var st = " · " + esc(t.status || "ANSWERED");
      var answerHtml = (t.answer_html || esc(t.answer_text || "")).trim();
      html +=
        '<article class="thread">' +
        '<p class="meta">' +
        esc(t.answered_ct || "") +
        st +
        kind +
        "</p>" +
        '<p class="q">' +
        esc(t.question || "") +
        "</p>" +
        '<div class="a">' +
        answerHtml +
        "</div>" +
        "</article>";
    });
    root.innerHTML = html;
  }

  var pollTimer = null;
  function pollOutbox(once) {
    fetch(OUTBOX_URL + "?t=" + Date.now())
      .then(function (r) {
        if (!r.ok) throw new Error("outbox " + r.status);
        return r.json();
      })
      .then(renderThreads)
      .catch(function () {
        var root = document.getElementById("threads");
        if (root && !root.querySelector(".thread")) {
          root.innerHTML =
            '<p class="threads-empty">Could not load outbox yet (Pages may still be building). Refresh in a minute.</p>';
        }
      });
    var need =
      loadPending().some(function (p) {
        return p.status === "SENT" || p.status === "PROCESSING";
      });
    if (need && !pollTimer) {
      pollTimer = setInterval(function () {
        pollOutbox(true);
        if (
          !loadPending().some(function (p) {
            return p.status === "SENT" || p.status === "PROCESSING";
          })
        ) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }, 8000);
    }
  }

  renderPending();
  pollOutbox(true);

})();
