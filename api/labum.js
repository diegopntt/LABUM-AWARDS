// LABUM Awards — API (Vercel Serverless Function, Node.js)
// Banco: Upstash Redis pelo Marketplace da Vercel (variáveis KV_REST_API_URL / KV_REST_API_TOKEN
// ou UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN, injetadas automaticamente).
// Login do criador: variáveis ADMIN_USER e ADMIN_PASSWORD definidas no painel da Vercel.
const crypto = require("crypto");

const EDITION = "labum-2025";                   // mesmo valor de CONFIG.id no index.html
const SESSION_TTL = 60 * 60 * 12;                // 12 horas
const K = s => `${EDITION}:${s}`;

function env(names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  const k = Object.keys(process.env).find(k => names.some(n => k.endsWith(n)));
  return k ? process.env[k] : "";
}
const R_URL = () => env(["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"]).replace(/\/$/, "");
const R_TOKEN = () => env(["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"]);

async function redis(...cmd) {
  const r = await fetch(R_URL(), { method: "POST", headers: { Authorization: `Bearer ${R_TOKEN()}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("redis: " + (j.error || r.status));
  return j.result;
}

const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const safeEq = (a, b) => { const x = Buffer.from(sha(a)), y = Buffer.from(sha(b)); return crypto.timingSafeEqual(x, y); };
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const hashPass = (pass, salt) => crypto.pbkdf2Sync(String(pass), salt, 120000, 32, "sha256").toString("hex");
function randomPass() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  return [...crypto.randomBytes(10)].map(b => A[b % A.length]).join("");
}
function slug(name) {
  return norm(name).replace(/[^a-z0-9]+/g, "").slice(0, 14) || "admin";
}
const parse = s => { try { return JSON.parse(s); } catch { return null; } };

function cleanVote(v, src) {
  if (!v || typeof v !== "object" || v.e !== EDITION) return null;
  const n = typeof v.n === "string" ? v.n.trim().slice(0, 40) : "";
  if (!n || typeof v.a !== "object" || !v.a || Array.isArray(v.a)) return null;
  const a = {};
  for (const [k, val] of Object.entries(v.a).slice(0, 80)) {
    if (!/^[a-z0-9-]{1,30}$/.test(k)) continue;
    if (typeof val === "string") a[k] = val.slice(0, 2000);
    else if (Number.isInteger(val) && val >= 1 && val <= 10) a[k] = val;
    else if (Array.isArray(val)) a[k] = val.filter(x => typeof x === "string").slice(0, 10).map(x => x.slice(0, 200));
  }
  return { e: EDITION, n, t: Number(v.t) || Date.now(), a, src };
}

async function session(req) {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!tok || tok.length < 20) return null;
  const s = parse(await redis("GET", K("sess:" + sha(tok))));
  if (!s) return null;
  if (s.role === "co" && !(await redis("HEXISTS", K("admins"), s.user))) return null; // admin removido
  return s;
}
async function settings() { return parse(await redis("GET", K("settings"))) || { closed: false }; }

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const send = (code, obj) => res.status(code).json(obj);
  const a = (req.query && req.query.a) || "";
  const body = (req.body && typeof req.body === "object") ? req.body : (parse(req.body) || {});

  if (!R_URL() || !R_TOKEN()) return send(a === "status" ? 200 : 503, { ok: false, configured: false, error: "banco_nao_configurado" });

  try {
    if (a === "status") {
      const st = await settings();
      return send(200, { ok: true, configured: true, closed: !!st.closed, ownerReady: !!(process.env.ADMIN_USER && process.env.ADMIN_PASSWORD) });
    }

    // ---------- voto (público) ----------
    if (a === "vote" && req.method === "POST") {
      if ((await settings()).closed) return send(403, { error: "encerrada" });
      if (JSON.stringify(body).length > 40000) return send(413, { error: "grande_demais" });
      const devTok = String(body.device || "");
      if (devTok.length < 20) return send(400, { error: "aparelho_invalido" });
      const v = cleanVote(body.vote, "site");
      if (!v) return send(400, { error: "voto_invalido" });
      const key = norm(v.n);
      const prev = parse(await redis("HGET", K("votes"), key));
      if (prev && prev.dev !== sha(devTok)) return send(409, { error: "nome_em_uso" });
      v.t = Date.now(); v.dev = sha(devTok);
      await redis("HSET", K("votes"), key, JSON.stringify(v));
      return send(200, { ok: true, t: v.t });
    }

    // ---------- login ----------
    if (a === "login" && req.method === "POST") {
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x";
      const lk = K("try:" + sha(ip));
      const tries = await redis("INCR", lk);
      if (tries === 1) await redis("EXPIRE", lk, 600);
      if (tries > 10) return send(429, { error: "muitas_tentativas" });
      const user = String(body.user || "").trim().toLowerCase().slice(0, 40), pass = String(body.pass || "");
      let s = null;
      if (process.env.ADMIN_USER && process.env.ADMIN_PASSWORD && safeEq(user, process.env.ADMIN_USER.trim().toLowerCase()) && safeEq(pass, process.env.ADMIN_PASSWORD)) {
        s = { role: "owner", user, name: process.env.ADMIN_USER };
      } else {
        const ad = parse(await redis("HGET", K("admins"), user));
        if (ad && safeEq(hashPass(pass, ad.salt), ad.hash)) s = { role: "co", user, name: ad.name };
      }
      if (!s) return send(401, { error: "login_invalido" });
      await redis("DEL", lk);
      const tok = crypto.randomBytes(24).toString("hex");
      await redis("SET", K("sess:" + sha(tok)), JSON.stringify(s), "EX", SESSION_TTL);
      return send(200, { token: tok, role: s.role, name: s.name, user: s.user });
    }

    const s = await session(req);
    if (!s) return send(401, { error: "sessao" });

    if (a === "logout" && req.method === "POST") {
      await redis("DEL", K("sess:" + sha((req.headers.authorization || "").slice(7))));
      return send(200, { ok: true });
    }

    // ---------- dados (criador: com nomes; admin: anônimos) ----------
    if (a === "data") {
      const [all, st] = await Promise.all([redis("HGETALL", K("votes")), settings()]);
      const votes = [];
      for (let i = 0; i < (all || []).length; i += 2) { const v = parse(all[i + 1]); if (v) votes.push({ key: all[i], ...v }); }
      if (s.role === "owner") {
        const adm = await redis("HGETALL", K("admins")); const admins = [];
        for (let i = 0; i < (adm || []).length; i += 2) { const x = parse(adm[i + 1]); if (x) admins.push({ user: adm[i], name: x.name, t: x.t }); }
        return send(200, { role: s.role, name: s.name, closed: !!st.closed, admins, votes: votes.map(({ dev, ...v }) => v) });
      }
      const anon = votes.map(v => [sha(EDITION + v.key), v.a]).sort((x, y) => x[0] < y[0] ? -1 : 1).map(x => ({ a: x[1] }));
      return send(200, { role: s.role, name: s.name, closed: !!st.closed, votes: anon });
    }

    if (s.role !== "owner") return send(403, { error: "so_criador" });

    if (a === "import" && req.method === "POST") {
      let novos = 0, atual = 0, ign = 0;
      for (const raw of (Array.isArray(body.votes) ? body.votes : []).slice(0, 200)) {
        const v = cleanVote(raw, "código"); if (!v) { ign++; continue; }
        const key = norm(v.n);
        const prev = parse(await redis("HGET", K("votes"), key));
        if (prev && (prev.t || 0) >= v.t) { ign++; continue; }
        if (prev && prev.dev) v.dev = prev.dev;
        await redis("HSET", K("votes"), key, JSON.stringify(v));
        prev ? atual++ : novos++;
      }
      return send(200, { novos, atual, ign });
    }
    if (a === "delvote" && req.method === "POST") { await redis("HDEL", K("votes"), String(body.key || "")); return send(200, { ok: true }); }
    if (a === "settings" && req.method === "POST") { await redis("SET", K("settings"), JSON.stringify({ closed: !!body.closed })); return send(200, { ok: true, closed: !!body.closed }); }
    if (a === "addadmin" && req.method === "POST") {
      const name = String(body.name || "").trim().slice(0, 40);
      if (!name) return send(400, { error: "nome" });
      let user = slug(name) + ".adm";
      while (await redis("HEXISTS", K("admins"), user)) user = slug(name) + (Math.floor(Math.random() * 90) + 10) + ".adm";
      const pass = randomPass(), salt = crypto.randomBytes(16).toString("hex");
      await redis("HSET", K("admins"), user, JSON.stringify({ name, salt, hash: hashPass(pass, salt), t: Date.now() }));
      return send(200, { user, pass, name });
    }
    if (a === "resetadmin" && req.method === "POST") {
      const user = String(body.user || "");
      const ad = parse(await redis("HGET", K("admins"), user));
      if (!ad) return send(404, { error: "nao_existe" });
      const pass = randomPass(); ad.salt = crypto.randomBytes(16).toString("hex"); ad.hash = hashPass(pass, ad.salt);
      await redis("HSET", K("admins"), user, JSON.stringify(ad));
      return send(200, { user, pass, name: ad.name });
    }
    if (a === "deladmin" && req.method === "POST") { await redis("HDEL", K("admins"), String(body.user || "")); return send(200, { ok: true }); }

    return send(404, { error: "acao_desconhecida" });
  } catch (e) {
    console.error(e);
    return send(500, { error: "erro_interno" });
  }
};
