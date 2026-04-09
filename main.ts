// =========================================================
//  INVENTORY TRACKER — Deno Deploy Edition
//  ✅ Upload ไฟล์นี้ที่ deno.com/deploy ได้เลย
//  ✅ ไม่ sleep ฟรีตลอด
//  ✅ KV = Deno KV (built-in ไม่ต้องตั้งค่าเพิ่ม)
//  ✅ Telegram Bot + Mini App + Alert System
// =========================================================

const BOT_TOKEN    = Deno.env.get("BOT_TOKEN") || "8746970065:AAGwhDSRhbxPlz-eVqzBUkxAMUz9u-IVn9k";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const PUBLIC_URL   = Deno.env.get("PUBLIC_URL") || "https://try-sailor-50--main.amnexe524-source.deno.net";
let _kv: Deno.Kv | null = null;
async function getKv() {
  if (!_kv) _kv = await Deno.openKv();
  return _kv;
}

// ── KV Batch Writer (ประหยัด KV writes) ─────────────────
let _pending: Record<string, string> = {};
let _lastFlush = 0;
const BATCH_MS = 30_000;

async function kvSet(key: string, value: string, immediate = false) {
  _pending[key] = value;
  if (immediate || Date.now() - _lastFlush >= BATCH_MS) {
    await kvFlush();
  }
}

async function kvFlush() {
  const keys = Object.keys(_pending);
  if (!keys.length) return;
  const kv = await getKv();
  const tx = kv.atomic();
  for (const k of keys) tx.set([k], _pending[k]);
  await tx.commit();
  _pending   = {};
  _lastFlush = Date.now();
}

async function kvGet(key: string): Promise<string | null> {
  if (_pending[key] !== undefined) return _pending[key];
  const kv = await getKv();
  const r  = await kv.get([key]);
  return r.value as string | null;
}

// ── CORS ─────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
function htmlRes(body: string) {
  return new Response(body, {
    headers: { ...CORS, "Content-Type": "text/html;charset=UTF-8" },
  });
}

// ── Flatten inventory ────────────────────────────────────
function flattenInv(inv: Record<string, unknown>) {
  const flat: Record<string, number> = {};
  for (const items of Object.values(inv || {})) {
    if (items && typeof items === "object") {
      for (const [name, qty] of Object.entries(items as Record<string, number>)) {
        flat[name] = (flat[name] || 0) + (Number(qty) || 0);
      }
    }
  }
  return flat;
}

// ── Telegram helpers ─────────────────────────────────────
async function sendTelegram(chatId: string, text: string) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

async function sendTelegramButtons(chatId: string, text: string, keyboard: unknown[][]) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      chat_id: chatId, text, parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    }),
  });
}

async function answerCallback(id: string) {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ callback_query_id: id }),
  });
}

// ════════════════════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  const url    = new URL(req.url);
  const path   = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") return new Response(null, { headers: CORS });

  // ── POST / ← Inventory จาก Lua ──────────────────────
  if (method === "POST" && path === "/") {
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return jsonRes({ error: "invalid json" }, 400); }

    await kvSet("inventory",   JSON.stringify(body));
    await kvSet("inv_updated", new Date().toISOString());
    await kvFlush();

    // Alert check
    const alertsRaw = await kvGet("alerts");
    if (alertsRaw) {
      const alerts  = JSON.parse(alertsRaw);
      const chatId  = await kvGet("chat_id");
      const firedRaw = await kvGet("alerts_fired") || "{}";
      const fired    = JSON.parse(firedRaw);
      const flat     = flattenInv(body);

      for (const alert of alerts) {
        if (!alert.item || !alert.qty || !alert.enabled) continue;
        const current = flat[alert.item] || 0;
        const fireKey = `${alert.item}__${alert.qty}__${alert.mode}`;

        if (alert.mode === "above" && current >= Number(alert.qty)) {
          if (!fired[fireKey] && chatId) {
            await sendTelegram(chatId,
              `🚨 *ITEM ALERT*\n📦 *${alert.item}* ถึง ${current.toLocaleString()} แล้ว!\n_(กำหนดไว้ที่ ≥ ${Number(alert.qty).toLocaleString()})_`
            );
            fired[fireKey] = Date.now();
          }
        } else if (alert.mode === "below" && current <= Number(alert.qty)) {
          if (!fired[fireKey] && chatId) {
            await sendTelegram(chatId,
              `⚠️ *ITEM LOW ALERT*\n📦 *${alert.item}* เหลือแค่ ${current.toLocaleString()}!\n_(กำหนดไว้ที่ ≤ ${Number(alert.qty).toLocaleString()})_`
            );
            fired[fireKey] = Date.now();
          }
        } else {
          delete fired[fireKey];
        }
      }
      await (await getKv()).set(["alerts_fired"], JSON.stringify(fired));
    }
    return jsonRes({ ok: true });
  }

  // ── POST /stats ← Stats+Wave จาก Lua ────────────────
  if (method === "POST" && path === "/stats") {
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return jsonRes({ error: "invalid json" }, 400); }

    await kvSet("stats",         JSON.stringify(body));
    await kvSet("stats_updated", new Date().toISOString());

    const prevWave = await kvGet("last_wave") || "";
    const newWave  = String(body.wave || "").trim();
    if (newWave && newWave !== prevWave && newWave !== "Not in Dungeon") {
      await (await getKv()).set(["last_wave"], newWave);
      const chatId = await kvGet("chat_id");
      if (chatId) await sendTelegram(chatId, `🌊 Wave เปลี่ยนเป็น: *${newWave}*`);
    }

    await kvFlush();
    return jsonRes({ ok: true });
  }

  // ── GET /events ← Polling แทน SSE ───────────────────
  if (method === "GET" && path === "/events") {
    const inv     = await kvGet("inventory");
    const stats   = await kvGet("stats");
    const dungeon = await kvGet("dungeon_runs");
    const icons   = await kvGet("custom_icons");
    const updated = await kvGet("inv_updated");
    return jsonRes({
      type:        "all",
      inventory:   inv     ? JSON.parse(inv)     : null,
      stats:       stats   ? JSON.parse(stats)   : null,
      dungeonRuns: dungeon ? JSON.parse(dungeon) : null,
      icons:       icons   ? JSON.parse(icons)   : {},
      updated,
    });
  }

  // ── POST /dungeon-runs ───────────────────────────────
  if (method === "POST" && path === "/dungeon-runs") {
    let body: unknown;
    try { body = await req.json(); } catch { return jsonRes({ error: "invalid json" }, 400); }
    await kvSet("dungeon_runs", JSON.stringify(body));
    await kvFlush();
    return jsonRes({ ok: true });
  }

  // ── POST|GET /farm-session ───────────────────────────
  if (path === "/farm-session") {
    if (method === "GET") {
      const session = await kvGet("farm_session");
      const active  = await kvGet("farm_session_active");
      const start   = await kvGet("farm_session_start");
      return jsonRes({ session: session ? JSON.parse(session) : null, active: active === "true", startTime: start });
    }
    if (method === "POST") {
      let body: Record<string, unknown>;
      try { body = await req.json(); } catch { return jsonRes({ error: "invalid json" }, 400); }
      if (body.action === "stop") {
        await kvSet("farm_session_active", "false");
      } else if (body.action === "start") {
        await kvSet("farm_session_active", "true");
        await kvSet("farm_session_start", new Date().toISOString());
        if (body.snapshot) await kvSet("farm_snapshot", JSON.stringify(body.snapshot));
      } else {
        await kvSet("farm_session", JSON.stringify(body));
      }
      await kvFlush();
      return jsonRes({ ok: true });
    }
  }

  // ── GET|POST /config ─────────────────────────────────
  if (path === "/config") {
    if (method === "GET") {
      const cfg = await kvGet("ui_config");
      return jsonRes(cfg ? JSON.parse(cfg) : {});
    }
    if (method === "POST") {
      let body: unknown;
      try { body = await req.json(); } catch { return jsonRes({ error: "invalid json" }, 400); }
      await (await getKv()).set(["ui_config"], JSON.stringify(body));
      return jsonRes({ ok: true });
    }
  }

  // ── GET|POST /discord-config ─────────────────────────
  if (path === "/discord-config") {
    if (method === "GET") {
      const cfg = await kvGet("discord_config");
      return jsonRes(cfg ? JSON.parse(cfg) : {});
    }
    if (method === "POST") {
      let body: unknown;
      try { body = await req.json(); } catch { return jsonRes({ error: "invalid json" }, 400); }
      await (await getKv()).set(["discord_config"], JSON.stringify(body));
      return jsonRes({ ok: true });
    }
  }

  // ── GET|POST|DELETE /icons ───────────────────────────
  if (path === "/icons") {
    if (method === "GET") {
      const icons = await kvGet("custom_icons");
      return jsonRes(icons ? JSON.parse(icons) : {});
    }
    if (method === "POST") {
      let body: Record<string, string>;
      try { body = await req.json(); } catch { return jsonRes({ error: "invalid json" }, 400); }
      const existing = JSON.parse(await kvGet("custom_icons") || "{}");
      if (body.name && body.url) existing[body.name] = body.url;
      await (await getKv()).set(["custom_icons"], JSON.stringify(existing));
      return jsonRes({ ok: true });
    }
    if (method === "DELETE") {
      let body: Record<string, string>;
      try { body = await req.json(); } catch { return jsonRes({ error: "invalid json" }, 400); }
      const existing = JSON.parse(await kvGet("custom_icons") || "{}");
      if (body.name) delete existing[body.name];
      await (await getKv()).set(["custom_icons"], JSON.stringify(existing));
      return jsonRes({ ok: true });
    }
  }

  // ── GET|POST /alerts ─────────────────────────────────
  if (path === "/alerts") {
    if (method === "GET") {
      const alerts = await kvGet("alerts");
      return jsonRes(alerts ? JSON.parse(alerts) : []);
    }
    if (method === "POST") {
      let body: unknown;
      try { body = await req.json(); } catch { return jsonRes({ error: "invalid json" }, 400); }
      await (await getKv()).set(["alerts"], JSON.stringify(body));
      await (await getKv()).set(["alerts_fired"], "{}");
      return jsonRes({ ok: true });
    }
  }

  // ── GET /db-stats ────────────────────────────────────
  if (method === "GET" && path === "/db-stats") {
    const inv     = await kvGet("inventory");
    const updated = await kvGet("inv_updated");
    return jsonRes({ updated, inventorySize: inv ? inv.length : 0, pendingWrites: Object.keys(_pending).length });
  }

  // ── POST /webhook ← Telegram Bot ────────────────────
  if (method === "POST" && path === "/webhook") {
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return new Response("OK"); }

    const msg    = (body.message || (body.callback_query as Record<string,unknown>)?.message) as Record<string,unknown> | undefined;
    if (!msg) return new Response("OK");

    const chatId = String((msg.chat as Record<string,unknown>).id);
    await (await getKv()).set(["chat_id"], chatId);

    const text = ((body.message as Record<string,unknown>)?.text as string || "").trim();
    const cbData = (body.callback_query as Record<string,unknown>)?.data as string || "";

    if (text === "/start") {
      await sendTelegramButtons(chatId,
        `👋 *Inventory Tracker* พร้อมใช้งาน!\n\n📦 ติดตาม Inventory realtime จากเกม\n🔔 แจ้งเตือนเมื่อ item ถึงจำนวนที่กำหนด`,
        [
          [{ text: "📦 เปิด Dashboard", web_app: { url: `https://${url.hostname}/app` } }],
          [{ text: "📊 Inventory", callback_data: "cmd_inv" }, { text: "🌊 Wave", callback_data: "cmd_wave" }],
          [{ text: "🔔 Alerts", callback_data: "cmd_alerts" }, { text: "📈 Farm", callback_data: "cmd_farm" }],
        ]
      );

    } else if (text === "/inv" || cbData === "cmd_inv") {
      if (cbData) await answerCallback((body.callback_query as Record<string,unknown>).id as string);
      const invRaw  = await kvGet("inventory");
      const invData = invRaw ? JSON.parse(invRaw) : {};
      const flat    = flattenInv(invData);
      const total   = Object.values(flat).reduce((s, v) => s + v, 0);
      if (!Object.keys(flat).length) {
        await sendTelegram(chatId, "📦 ยังไม่มีข้อมูล Inventory ครับ");
      } else {
        let txt = `📦 *Inventory* (${Object.keys(flat).length} items · ${total.toLocaleString()} qty)\n\n`;
        for (const [cat, items] of Object.entries(invData)) {
          txt += `*── ${cat} ──*\n`;
          for (const [name, qty] of Object.entries(items as Record<string,number>)) {
            txt += `  • ${name}: \`${(qty as number).toLocaleString()}\`\n`;
          }
        }
        await sendTelegram(chatId, txt.slice(0, 4096));
      }

    } else if (text === "/wave" || cbData === "cmd_wave") {
      if (cbData) await answerCallback((body.callback_query as Record<string,unknown>).id as string);
      const statsRaw = await kvGet("stats");
      const statsData = statsRaw ? JSON.parse(statsRaw) : {};
      await sendTelegram(chatId, `🌊 *Wave ปัจจุบัน:* \`${statsData.wave || "ไม่ทราบ"}\``);

    } else if (text === "/farm" || cbData === "cmd_farm") {
      if (cbData) await answerCallback((body.callback_query as Record<string,unknown>).id as string);
      const farmRaw  = await kvGet("farm_session");
      const farmData = farmRaw ? JSON.parse(farmRaw) : null;
      const start    = await kvGet("farm_session_start");
      if (!farmData?.diff) {
        await sendTelegram(chatId, "📈 ยังไม่มีข้อมูล Farm Session ครับ");
      } else {
        const elapsed = start ? (() => {
          const s = Math.floor((Date.now() - new Date(start).getTime()) / 1000);
          return `${String(Math.floor(s/3600)).padStart(2,"0")}:${String(Math.floor(s%3600/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
        })() : "--:--:--";
        const drops = Object.entries(farmData.diff as Record<string,number>).filter(([,v]) => v > 0).sort(([,a],[,b]) => b-a);
        const total  = drops.reduce((s,[,v]) => s+v, 0);
        let txt = `📈 *Farm Session* · \`${elapsed}\`\nTotal: \`${total.toLocaleString()}\`\n\n`;
        for (const [name, qty] of drops.slice(0, 20)) txt += `  • ${name}: \`+${qty.toLocaleString()}\`\n`;
        await sendTelegram(chatId, txt.slice(0, 4096));
      }

    } else if (text === "/alerts" || cbData === "cmd_alerts") {
      if (cbData) await answerCallback((body.callback_query as Record<string,unknown>).id as string);
      const alertsRaw = await kvGet("alerts");
      const alerts = alertsRaw ? JSON.parse(alertsRaw) : [];
      if (!alerts.length) {
        await sendTelegram(chatId, `🔔 ยังไม่มี Alert\n\nตั้งได้ที่ Dashboard → แท็บ ALERTS`);
      } else {
        let txt = `🔔 *Item Alerts* (${alerts.length} รายการ)\n\n`;
        for (const a of alerts) {
          txt += `${a.enabled ? "✅" : "❌"} *${a.item}* ${a.mode === "above" ? "≥" : "≤"} \`${Number(a.qty).toLocaleString()}\`\n`;
        }
        await sendTelegram(chatId, txt);
      }

    } else if (text === "/help") {
      await sendTelegram(chatId,
        `/start — เมนูหลัก\n/inv — Inventory\n/wave — Wave\n/farm — Farm Session\n/alerts — Item Alerts\n/help — คำสั่งทั้งหมด`
      );
    }

    return new Response("OK");
  }

  // ── GET /app ← Dashboard + Telegram Mini App ────────
  if (method === "GET" && path === "/app") {
    return htmlRes(getDashboardHTML(PUBLIC_URL));
  }

  // ── GET / ← redirect ────────────────────────────────
  if (method === "GET" && path === "/") {
    return Response.redirect(`https://${url.hostname}/app`, 302);
  }

  return jsonRes({ error: "not found" }, 404);
});

// ════════════════════════════════════════════════════════
// DASHBOARD HTML
// ════════════════════════════════════════════════════════
function getDashboardHTML(baseUrl: string): string {
  const API = baseUrl;
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>INVENTORY VIEWER</title>
<link rel="icon" type="image/jpeg" href="https://i.postimg.cc/kg8SjvdT/Screenshot-20260330-011203.jpg">
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&family=Teko:wght@400;500;600&display=swap" rel="stylesheet">
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:#080809;--bg2:#0f0f12;--panel:#111114;--panel2:#18181e;--border:#1e1e26;--border2:#2e1520;--border3:#4a1a28;--red:#b91c1c;--red2:#ef4444;--red3:#ff6b6b;--redglow:rgba(185,28,28,0.45);--redglow2:rgba(239,68,68,0.10);--text:#f0e8e0;--text2:#8a7a6a;--text3:#504030;--gold:#d4a843;--green:#22c55e}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:'Rajdhani',sans-serif;min-height:100vh;overflow-x:hidden}
body::after{content:'';position:fixed;inset:0;pointer-events:none;z-index:9999;background:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(185,28,28,.015) 3px,rgba(185,28,28,.015) 4px)}
header{position:sticky;top:0;z-index:50;background:rgba(8,8,9,.95);backdrop-filter:blur(12px);border-bottom:1px solid var(--border3);box-shadow:0 1px 30px var(--redglow2);padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.logo-text{font-family:'Teko',sans-serif;font-size:22px;font-weight:600;letter-spacing:4px}.logo-text em{color:var(--red2);font-style:normal}
.status-pill{display:flex;align-items:center;gap:6px;font-family:'Share Tech Mono',monospace;font-size:10px;color:var(--text2)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 10px var(--green);animation:blink 2s infinite}.dot.off{background:var(--red);box-shadow:0 0 10px var(--red);animation:none}.dot.warn{background:#f59e0b;box-shadow:0 0 10px #f59e0b}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}
.ts{font-family:'Share Tech Mono',monospace;font-size:10px;color:var(--red2)}
.nav-tabs{display:flex;background:var(--panel);border-bottom:1px solid var(--border);overflow-x:auto;scrollbar-width:none}.nav-tabs::-webkit-scrollbar{display:none}
.ntab{flex:0 0 auto;padding:10px 16px;font-family:'Teko',sans-serif;font-size:15px;letter-spacing:2px;color:var(--text3);cursor:pointer;border-bottom:2px solid transparent;transition:all .2s;white-space:nowrap}.ntab.active{color:var(--red2);border-bottom-color:var(--red2)}.ntab:hover{color:var(--text2)}
.page{display:none;padding:12px;max-width:1200px;margin:0 auto}.page.active{display:block}
.wave-card{background:linear-gradient(135deg,#1a0a0a,#2a0f0f);border:1px solid var(--border3);padding:14px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}
.wave-num{font-size:48px;font-weight:900;color:var(--red2);font-family:'Teko',sans-serif;text-shadow:0 0 20px rgba(239,68,68,.5);line-height:1}
.wave-lbl{font-size:10px;color:var(--text3);letter-spacing:3px;margin-bottom:2px}.wave-sub{font-size:11px;color:var(--text2);font-family:'Share Tech Mono',monospace}
.statsbar{display:flex;gap:8px;overflow-x:auto;margin-bottom:12px;padding-bottom:4px;scrollbar-width:none}.statsbar::-webkit-scrollbar{display:none}
.stat-item{flex:0 0 auto;background:var(--panel);border:1px solid var(--border);padding:6px 12px;text-align:center}.stat-lbl{font-size:9px;color:var(--text3);letter-spacing:2px}.stat-val{font-size:16px;font-weight:700;color:var(--text);font-family:'Teko',sans-serif}.stat-item.total .stat-val{color:var(--red2)}
.filter-row{display:flex;gap:6px;margin-bottom:10px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}.filter-row::-webkit-scrollbar{display:none}
.ftab{flex:0 0 auto;padding:5px 12px;background:var(--panel);border:1px solid var(--border);color:var(--text3);font-family:'Rajdhani',sans-serif;font-size:12px;letter-spacing:1px;cursor:pointer;transition:all .15s}.ftab.active{background:var(--red);border-color:var(--red);color:#fff}.ftab:hover:not(.active){border-color:var(--red2);color:var(--text2)}
.search-wrap{position:relative;margin-bottom:10px}.search-input{width:100%;background:var(--panel);border:1px solid var(--border);color:var(--text);font-family:'Rajdhani',sans-serif;font-size:14px;padding:8px 12px;outline:none;transition:border-color .2s}.search-input::placeholder{color:var(--text3)}.search-input:focus{border-color:var(--red);box-shadow:0 0 0 1px var(--red)}
.cat-sec{margin-bottom:16px}.cat-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--border3)}.cat-name{font-family:'Teko',sans-serif;font-size:16px;letter-spacing:3px;color:var(--gold)}.cat-count{font-size:10px;color:var(--text3);font-family:'Share Tech Mono',monospace}
.item-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px}
.card{background:var(--panel);border:1px solid var(--border);padding:8px;cursor:default;transition:border-color .15s,box-shadow .15s;animation:fadeUp .3s ease both}.card:hover{border-color:var(--red2);box-shadow:0 0 12px var(--redglow2)}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.img-wrap{width:100%;aspect-ratio:1;display:flex;align-items:center;justify-content:center;margin-bottom:6px;background:var(--panel2);overflow:hidden}.item-img{width:100%;height:100%;object-fit:contain}.no-img{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:18px}
.iname{font-size:11px;color:var(--text);line-height:1.2;margin-bottom:3px;word-break:break-word}.iextra{font-size:9px;color:var(--gold);font-family:'Share Tech Mono',monospace}.iqty{font-size:14px;font-weight:700;color:var(--red2);font-family:'Teko',sans-serif}
.empty{text-align:center;padding:48px 16px;color:var(--text3)}.empty-title{font-family:'Teko',sans-serif;font-size:22px;letter-spacing:3px;margin-bottom:6px}.empty-sub{font-size:12px;color:var(--text3)}
.dungeon-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
.run-panel{background:var(--panel);border:1px solid var(--border);padding:10px}.run-panel-header{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-family:'Share Tech Mono',monospace;font-size:10px;color:var(--text3);letter-spacing:2px}
.run-live-dot{width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);animation:blink 1s infinite;flex-shrink:0}
.run-chips{display:flex;flex-wrap:wrap;gap:4px;min-height:32px}.diff-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 7px;font-size:11px;font-family:'Share Tech Mono',monospace;animation:chipPop .3s ease both}.diff-chip.pos{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:#22c55e}.diff-chip.neg{background:rgba(239,68,68,.10);border:1px solid rgba(239,68,68,.25);color:var(--red2)}
@keyframes chipPop{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:none}}
.run-empty{font-size:11px;color:var(--text3);font-family:'Share Tech Mono',monospace}
.farm-block{background:var(--panel);border:1px solid var(--border2);padding:12px;margin-bottom:12px}.farm-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.farm-title{font-family:'Teko',sans-serif;font-size:16px;letter-spacing:3px;color:var(--gold)}.farm-timer{font-family:'Share Tech Mono',monospace;font-size:13px;color:var(--red2)}.farm-chips{display:flex;flex-wrap:wrap;gap:4px;min-height:28px}
.alert-panel{background:var(--panel);border:1px solid var(--border);padding:12px;margin-bottom:12px}.alert-title{font-family:'Teko',sans-serif;font-size:16px;letter-spacing:3px;color:var(--red2);margin-bottom:10px;display:flex;align-items:center;justify-content:space-between}
.alert-list{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}.alert-row{display:flex;align-items:center;gap:8px;background:var(--panel2);border:1px solid var(--border);padding:8px 10px}.alert-row-item{flex:1;font-size:13px;font-family:'Rajdhani',sans-serif;color:var(--text)}.alert-row-qty{font-size:12px;font-family:'Share Tech Mono',monospace;color:var(--red2)}.alert-row-mode{font-size:10px;color:var(--text3);letter-spacing:1px}
.alert-toggle{margin-left:auto;cursor:pointer;width:32px;height:18px;border-radius:9px;background:var(--border);border:none;position:relative;transition:background .2s;flex-shrink:0}.alert-toggle.on{background:var(--green)}.alert-toggle::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .2s}.alert-toggle.on::after{left:16px}
.alert-del{background:none;border:none;color:var(--red2);cursor:pointer;font-size:14px;padding:0 4px;opacity:.6}.alert-del:hover{opacity:1}
.add-alert-form{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--border);padding-top:10px}.form-row{display:flex;gap:6px}
.form-input{flex:1;background:var(--panel2);border:1px solid var(--border);color:var(--text);font-family:'Rajdhani',sans-serif;font-size:13px;padding:7px 10px;outline:none}.form-input:focus{border-color:var(--red)}
.form-select{background:var(--panel2);border:1px solid var(--border);color:var(--text);font-family:'Rajdhani',sans-serif;font-size:13px;padding:7px 8px;outline:none;cursor:pointer}
.btn{padding:8px 16px;background:var(--red);border:none;color:#fff;font-family:'Teko',sans-serif;font-size:15px;letter-spacing:2px;cursor:pointer;transition:background .15s}.btn:hover{background:var(--red2)}.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text2)}.btn-outline:hover{border-color:var(--red2);color:var(--text)}.btn-sm{padding:5px 10px;font-size:13px}
.sp-card{background:var(--panel);border:1px solid var(--border);padding:10px;margin-bottom:8px}.sp-cat{font-size:10px;color:var(--text3);letter-spacing:2px;margin-bottom:4px}.sp-name{font-size:15px;font-family:'Teko',sans-serif;letter-spacing:1px}.sp-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}.sp-tag{font-size:10px;padding:2px 7px;font-family:'Share Tech Mono',monospace;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);color:var(--red3)}
#toastContainer{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9998;display:flex;flex-direction:column;gap:6px;pointer-events:none;width:90%;max-width:320px}
.toast{background:var(--panel2);border:1px solid var(--border3);color:var(--text);font-family:'Share Tech Mono',monospace;font-size:11px;padding:8px 14px;animation:toastIn .25s ease both}.toast.ok{border-color:var(--green);color:var(--green)}.toast.err{border-color:var(--red2);color:var(--red2)}
@keyframes toastIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
#offlineOverlay{display:none;position:fixed;inset:0;background:rgba(8,8,9,.92);z-index:9000;align-items:center;justify-content:center;flex-direction:column;gap:8px;text-align:center}
#offlineOverlay.visible{display:flex}.offline-title{font-family:'Teko',sans-serif;font-size:28px;letter-spacing:4px;color:var(--red2)}.offline-sub{font-size:12px;color:var(--text3);font-family:'Share Tech Mono',monospace}
</style>
</head>
<body>
<header>
  <div class="logo-text">INV<em>IEWƏR</em></div>
  <div style="display:flex;align-items:center;gap:10px">
    <div class="status-pill"><div class="dot off" id="statusDot"></div><span id="statusTxt">NOT CONNECTED</span></div>
    <div class="ts" id="tsClock"></div>
  </div>
</header>
<div class="nav-tabs">
  <div class="ntab active" onclick="switchTab('inventory',this)">INVENTORY</div>
  <div class="ntab" onclick="switchTab('dungeon',this)">DUNGEON</div>
  <div class="ntab" onclick="switchTab('farm',this)">FARM</div>
  <div class="ntab" onclick="switchTab('stats',this)">STATS</div>
  <div class="ntab" onclick="switchTab('alerts',this)">🔔 ALERTS</div>
</div>
<div class="page active" id="tab-inventory">
  <div style="padding:12px;padding-bottom:0">
    <div class="statsbar">
      <div class="stat-item total"><div class="stat-lbl">ITEMS</div><div class="stat-val" id="sItems">0</div></div>
      <div class="stat-item total"><div class="stat-lbl">QTY</div><div class="stat-val" id="sQty">0</div></div>
    </div>
    <div class="filter-row" id="filterTabs"><button class="ftab active" onclick="setFilter('all',this)">ALL</button></div>
    <div class="search-wrap"><input class="search-input" id="searchInput" placeholder="ค้นหา item..." oninput="render()"></div>
  </div>
  <div style="padding:0 12px 80px" id="main">
    <div class="empty"><div class="empty-title">รอข้อมูลจาก Lua</div><div class="empty-sub">Run Lua script ในเกมก่อนนะ</div></div>
  </div>
</div>
<div class="page" id="tab-dungeon">
  <div style="padding:12px 12px 80px">
    <div class="wave-card" style="margin-bottom:12px">
      <div><div class="wave-lbl">CURRENT WAVE</div><div class="wave-num" id="waveDisplay">—</div><div class="wave-sub" id="waveSub">NOT IN DUNGEON</div></div>
      <div style="text-align:right;font-size:11px;color:var(--text3);font-family:'Share Tech Mono',monospace" id="statsUpdated"></div>
    </div>
    <div class="dungeon-row">
      <div class="run-panel"><div class="run-panel-header">LAST RUN</div><div class="run-chips" id="dungeonPrevChips"><span class="run-empty">—</span></div></div>
      <div class="run-panel" id="dungeonCurrPanel"><div class="run-panel-header">THIS RUN</div><div class="run-chips" id="dungeonCurrChips"><span class="run-empty">NOT IN DUNGEON</span></div></div>
    </div>
  </div>
</div>
<div class="page" id="tab-farm">
  <div style="padding:12px 12px 80px">
    <div class="farm-block">
      <div class="farm-header"><div class="farm-title">FARM SESSION</div><div class="farm-timer" id="farmTimerVal">00:00:00</div></div>
      <div style="font-size:10px;color:var(--text3);font-family:'Share Tech Mono',monospace;margin-bottom:6px">DROPS THIS SESSION</div>
      <div class="farm-chips" id="farmLootChips"><span class="run-empty">No drops recorded yet...</span></div>
    </div>
    <button class="btn btn-outline btn-sm" onclick="resetFarm()">RESET SESSION</button>
  </div>
</div>
<div class="page" id="tab-stats">
  <div style="padding:12px 12px 80px" id="statsPanel">
    <div class="empty"><div class="empty-title">รอข้อมูล Stats</div><div class="empty-sub">ข้อมูลจะปรากฏเมื่อ Lua ส่งมา</div></div>
  </div>
</div>
<div class="page" id="tab-alerts">
  <div style="padding:12px 12px 80px">
    <div class="alert-panel">
      <div class="alert-title">🔔 ITEM ALERTS<span style="font-size:11px;color:var(--text3);font-family:'Share Tech Mono',monospace">แจ้งเตือนผ่าน Telegram</span></div>
      <div class="alert-list" id="alertList"></div>
      <div class="add-alert-form">
        <div style="font-size:11px;color:var(--text3);letter-spacing:2px;font-family:'Share Tech Mono',monospace">เพิ่ม ALERT ใหม่</div>
        <input class="form-input" id="alertItem" placeholder="ชื่อ item (เช่น Health Potion)">
        <div class="form-row">
          <input class="form-input" id="alertQty" type="number" placeholder="จำนวน" style="max-width:120px">
          <select class="form-select" id="alertMode"><option value="above">≥ มากกว่าเท่ากับ</option><option value="below">≤ น้อยกว่าเท่ากับ</option></select>
        </div>
        <button class="btn btn-sm" onclick="addAlert()">+ เพิ่ม ALERT</button>
      </div>
    </div>
    <div style="font-size:10px;color:var(--text3);font-family:'Share Tech Mono',monospace;line-height:1.8">
      💡 Alert จะส่งแจ้งเตือนผ่าน Telegram ทันทีที่ item ถึงจำนวนที่กำหนด<br>
      🔄 Reset fired state อัตโนมัติเมื่อ item กลับออกจาก threshold
    </div>
  </div>
</div>
<div id="offlineOverlay"><div class="offline-title">LUA OFFLINE</div><div class="offline-sub">ไม่ได้รับข้อมูลมากกว่า 90 วินาที</div><div class="offline-sub" id="offlineElapsed" style="color:var(--red2)">00:00</div></div>
<div id="toastContainer"></div>
<script>
const API_BASE='${API}',POLL_MS=3000;
let data={},prevData={},activeFilter='all',alerts=[],farmStartTime=null,farmDiffAccum={},farmTimerIntvl=null,offlineTimer=null,offlineElapsed=0,offlineTick=null,customIcons={};
setInterval(()=>{document.getElementById('tsClock').textContent=new Date().toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',second:'2-digit'})},1000);
async function poll(){try{const r=await fetch(API_BASE+'/events'),j=await r.json();if(j.inventory&&Object.keys(j.inventory).length){const nd=parseRaw(j.inventory);if(JSON.stringify(nd)!==JSON.stringify(prevData)){data=nd;prevData=nd;render();checkAlerts(nd)}if(j.updated){const d=new Date(j.updated);document.getElementById('statsUpdated').textContent='LAST: '+d.toLocaleTimeString('th-TH')}setStatus('ok','ONLINE');markRcv()}if(j.stats)processStats(j.stats);if(j.dungeonRuns?.thisRun)restoreDungeon(j.dungeonRuns);if(j.icons)Object.assign(customIcons,j.icons)}catch{setStatus('warn','POLLING...')}}
setInterval(poll,POLL_MS);poll();
function setStatus(s,t){const d=document.getElementById('statusDot');d.className='dot'+(s==='ok'?'':s==='warn'?' warn':' off');document.getElementById('statusTxt').textContent=t}
function markRcv(){clearTimeout(offlineTimer);clearInterval(offlineTick);offlineElapsed=0;document.getElementById('offlineOverlay').classList.remove('visible');offlineTimer=setTimeout(()=>{document.getElementById('offlineOverlay').classList.add('visible');setStatus('off','LUA OFFLINE');offlineElapsed=0;offlineTick=setInterval(()=>{offlineElapsed++;const m=String(Math.floor(offlineElapsed/60)).padStart(2,'0'),s=String(offlineElapsed%60).padStart(2,'0');document.getElementById('offlineElapsed').textContent=m+':'+s},1000)},90000)}
function switchTab(n,el){document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));document.querySelectorAll('.ntab').forEach(t=>t.classList.remove('active'));document.getElementById('tab-'+n).classList.add('active');el.classList.add('active')}
function parseRaw(j){const o={};for(const[c,v]of Object.entries(j)){if(Array.isArray(v))o[c]=v;else if(v&&typeof v==='object')o[c]=Object.entries(v).map(([n,q])=>({Name:n,Quantity:typeof q==='number'?q:1,Extra:''}))}return o}
function flattenData(d){const o={};for(const items of Object.values(d))(items||[]).forEach(i=>{o[i.Name]=(o[i.Name]||0)+i.Quantity});return o}
function rebuildFilters(){const t=document.getElementById('filterTabs');t.innerHTML='<button class="ftab '+(activeFilter==='all'?'active':'')+'" onclick="setFilter(\'all\',this)">ALL</button>';Object.keys(data).forEach(c=>{const b=document.createElement('button');b.className='ftab'+(activeFilter===c?' active':'');b.textContent=c.toUpperCase();b.onclick=function(){setFilter(c,this)};t.appendChild(b)})}
function setFilter(c,el){activeFilter=c;document.querySelectorAll('.ftab').forEach(b=>b.classList.remove('active'));el.classList.add('active');render()}
function render(){rebuildFilters();const search=document.getElementById('searchInput').value.toLowerCase(),main=document.getElementById('main');main.innerHTML='';const cats=activeFilter==='all'?Object.keys(data):[activeFilter];let ti=0,tq=0,has=false;cats.forEach(cat=>{let items=(data[cat]||[]).filter(i=>!search||i.Name.toLowerCase().includes(search));if(!items.length)return;items.sort((a,b)=>b.Quantity-a.Quantity);has=true;ti+=items.length;tq+=items.reduce((s,i)=>s+i.Quantity,0);const sec=document.createElement('div');sec.className='cat-sec';sec.innerHTML='<div class="cat-hdr"><span class="cat-name">'+cat+'</span><span class="cat-count">'+items.length+' items</span></div><div class="item-grid" id="g'+cat.replace(/\\W/g,'_')+'"></div>';main.appendChild(sec);const grid=sec.querySelector('.item-grid');items.forEach((item,i)=>{const card=document.createElement('div');card.className='card';const url=customIcons[item.Name]||null;const img=url?'<img class="item-img" src="'+url+'" alt="'+item.Name+'" loading="lazy" onerror="this.parentElement.innerHTML=\'<div class=\\\'no-img\\\'>?</div>\'">':'<div class="no-img">?</div>';card.innerHTML='<div class="img-wrap">'+img+'</div><div class="iname">'+item.Name+'</div>'+(item.Extra?'<div class="iextra">'+item.Extra+'</div>':'')+'<div class="iqty">×'+item.Quantity.toLocaleString()+'</div>';card.style.animationDelay=(i*.02)+'s';grid.appendChild(card)})});if(!has)main.innerHTML='<div class="empty"><div class="empty-title">'+(Object.keys(data).length?'ไม่พบไอเทม':'รอข้อมูลจาก Lua')+'</div><div class="empty-sub">'+(Object.keys(data).length?'ลองค้นหาคำอื่น':'Run Lua script ในเกมก่อนนะ')+'</div></div>';document.getElementById('sItems').textContent=ti;document.getElementById('sQty').textContent=tq.toLocaleString()}
function startFarmTimer(st){clearInterval(farmTimerIntvl);farmTimerIntvl=setInterval(()=>{const s=Math.floor((Date.now()-new Date(st))/1000),h=String(Math.floor(s/3600)).padStart(2,'0'),m=String(Math.floor(s%3600/60)).padStart(2,'0'),sc=String(s%60).padStart(2,'0');document.getElementById('farmTimerVal').textContent=h+':'+m+':'+sc},1000)}
function updateFarmLoot(diff){const drops=Object.entries(diff).filter(([,v])=>v>0).sort(([,a],[,b])=>b-a),el=document.getElementById('farmLootChips');if(!drops.length){el.innerHTML='<span class="run-empty">No drops recorded yet...</span>';return}el.innerHTML=drops.map(([n,q])=>'<span class="diff-chip pos">'+n+' +'+q.toLocaleString()+'</span>').join('')}
function resetFarm(){farmDiffAccum={};farmStartTime=new Date().toISOString();startFarmTimer(farmStartTime);updateFarmLoot({});fetch(API_BASE+'/farm-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'start'})}).catch(()=>{});showToast('Farm session reset!','ok')}
function restoreDungeon(runs){if(runs.thisRun)document.getElementById('dungeonCurrChips').innerHTML=buildChips(runs.thisRun);if(runs.lastRun)document.getElementById('dungeonPrevChips').innerHTML=buildChips(runs.lastRun)}
function buildChips(diff){const e=Object.entries(diff).filter(([,v])=>v!==0);if(!e.length)return'<span class="run-empty">—</span>';return e.sort((a,b)=>b[1]-a[1]).map(([n,d])=>'<span class="diff-chip '+(d>0?'pos':'neg')+'">'+n+' '+(d>0?'+':'')+d.toLocaleString()+'</span>').join('')}
function processStats(s){const wave=String(s.wave||'').trim(),wm=wave.match(/(\\d+)\\s*\\/\\s*(\\d+)/),wm1=!wm&&/\\d/.test(wave)?wave.match(/(\\d+)/):null;document.getElementById('waveDisplay').textContent=wm?wm[1]+' / '+wm[2]:wm1?wm1[1]:wave||'—';document.getElementById('waveSub').textContent=wm?'IN DUNGEON':wm1?'INFINITE TOWER':'NOT IN DUNGEON';if(s.stats){const panel=document.getElementById('statsPanel'),lines=s.stats.split('\\n').map(l=>l.trim()).filter(Boolean);const secs=[];let cur=null;for(const line of lines){const ci=line.indexOf(':');if(ci<0)continue;const key=line.slice(0,ci).trim(),val=line.slice(ci+1).trim();if(key==='StatName'){cur={name:val,stats:[]};secs.push(cur)}else if(/^Stat\\d+$/.test(key)&&cur&&val&&val!=='Stat Text')cur.stats.push(val)}if(secs.length)panel.innerHTML=secs.map(s=>'<div class="sp-card"><div class="sp-cat">'+(s.name.split(':')[0]||'').toUpperCase()+'</div><div class="sp-name">'+(s.name.split(':')[1]||s.name).trim()+'</div>'+(s.stats.length?'<div class="sp-tags">'+s.stats.map(t=>'<span class="sp-tag">'+t+'</span>').join('')+'</div>':'')+'</div>').join('')}}
async function loadAlerts(){try{const r=await fetch(API_BASE+'/alerts');alerts=await r.json();renderAlerts()}catch{alerts=[]}}
function renderAlerts(){const list=document.getElementById('alertList');if(!alerts.length){list.innerHTML='<div style="color:var(--text3);font-size:12px;font-family:Share Tech Mono,monospace;padding:8px 0">ยังไม่มี Alert เพิ่มได้ด้านล่าง</div>';return}list.innerHTML=alerts.map((a,i)=>'<div class="alert-row"><div><div class="alert-row-item">'+a.item+'</div><div style="display:flex;gap:6px;align-items:center"><span class="alert-row-mode">'+(a.mode==='above'?'≥':'≤')+'</span><span class="alert-row-qty">'+Number(a.qty).toLocaleString()+'</span></div></div><button class="alert-toggle'+(a.enabled?' on':'')+'" onclick="toggleAlert('+i+')" title="เปิด/ปิด"></button><button class="alert-del" onclick="deleteAlert('+i+')" title="ลบ">✕</button></div>').join('')}
async function saveAlerts(){await fetch(API_BASE+'/alerts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(alerts)})}
function addAlert(){const item=document.getElementById('alertItem').value.trim(),qty=document.getElementById('alertQty').value.trim(),mode=document.getElementById('alertMode').value;if(!item||!qty){showToast('กรุณาใส่ชื่อ item และจำนวน','err');return}alerts.push({item,qty:Number(qty),mode,enabled:true});renderAlerts();saveAlerts();document.getElementById('alertItem').value='';document.getElementById('alertQty').value='';showToast('เพิ่ม Alert สำเร็จ!','ok')}
function toggleAlert(i){alerts[i].enabled=!alerts[i].enabled;renderAlerts();saveAlerts()}
function deleteAlert(i){alerts.splice(i,1);renderAlerts();saveAlerts();showToast('ลบ Alert แล้ว','ok')}
function checkAlerts(nd){if(!alerts.length)return;const flat=flattenData(nd);for(const a of alerts){if(!a.enabled)continue;const qty=flat[a.item]||0;if(a.mode==='above'&&qty>=a.qty)showToast('🚨 '+a.item+' ถึง '+qty.toLocaleString()+' แล้ว!','ok');else if(a.mode==='below'&&qty<=a.qty)showToast('⚠️ '+a.item+' เหลือแค่ '+qty.toLocaleString(),'err')}}
function showToast(msg,type='ok'){const c=document.getElementById('toastContainer'),t=document.createElement('div');t.className='toast '+type;t.textContent=msg;c.appendChild(t);setTimeout(()=>t.remove(),3000)}
if(window.Telegram?.WebApp){Telegram.WebApp.ready();Telegram.WebApp.expand()}
loadAlerts();setStatus('off','NOT CONNECTED');
fetch(API_BASE+'/farm-session').then(r=>r.json()).then(d=>{if(d.active&&d.startTime){farmStartTime=d.startTime;startFarmTimer(farmStartTime)}if(d.session?.diff){farmDiffAccum=d.session.diff;updateFarmLoot(farmDiffAccum)}}).catch(()=>{});
</script>
</body>
</html>`;
}
