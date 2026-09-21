import { useState, useEffect, useRef, useMemo } from "react";

/* ============================================================
   REVALUATION — a 365-day Nietzschean journal
   Single-file React app. No dependencies beyond React + Google Fonts.
   ============================================================ */

const SYSTEM_PROMPT =
  "You are a Nietzschean philosophical interlocutor. You engage through the lens of Nietzsche's actual philosophy: Will to Power, Amor Fati, self-overcoming, eternal recurrence, the death of God, the creation of new values. You do not comfort or validate. You challenge, provoke, and illuminate. Reference Nietzsche's actual works with titles. Be demanding, not cruel. The goal is to push the person deeper into their own becoming.";

const QUARTERS = [
  {
    n: 1, start: 1, end: 91,
    title: "Self-Overcoming & Will to Power",
    works: "Thus Spoke Zarathustra; Beyond Good and Evil; The Gay Science",
    line: "Man is something that shall be overcome.",
  },
  {
    n: 2, start: 92, end: 182,
    title: "Amor Fati & Eternal Recurrence",
    works: "The Gay Science §276, §341; Ecce Homo; Zarathustra III",
    line: "Not merely bear what is necessary — love it.",
  },
  {
    n: 3, start: 183, end: 273,
    title: "Nihilism, Creation & New Values",
    works: "On the Genealogy of Morality; The Gay Science §125; Twilight of the Idols",
    line: "The highest values devalue themselves. Who will create?",
  },
  {
    n: 4, start: 274, end: 365,
    title: "The Übermensch & Perspectivism",
    works: "Zarathustra Prologue; Beyond Good and Evil; Genealogy III §12",
    line: "There is only a perspectival seeing, only a perspectival knowing.",
  },
];

const INVENTORY = [
  { q: "What did I obey today that I did not choose?", note: "Trace the command back to its source. Habit, fear, and inherited custom all give orders in a voice that sounds like your own." },
  { q: "Where did I call a weakness a virtue?", note: "The Genealogy's first essay: impotence renamed goodness. Find today's instance in yourself, not in others." },
  { q: "Which value did I act on, and who gave it to me?", note: "Every value has a history. Name the giver — a parent, a class, a church, a market — and ask what it was for." },
  { q: "What in me would have to die for me to become what I am?", note: "Self-overcoming is not improvement. Something is spent. Say what." },
];

const PROVIDERS = {
  anthropic: {
    label: "Anthropic", model: "claude-sonnet-4-6",
    endpoint: "https://api.anthropic.com/v1/messages",
    headers: (key) => ({
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    }),
    body: (model, system, user) => ({ model, max_tokens: 1400, system, messages: [{ role: "user", content: user }] }),
    parse: (d) => (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n"),
  },
  openai: {
    label: "OpenAI", model: "gpt-4o-mini",
    endpoint: "https://api.openai.com/v1/chat/completions",
    headers: (key) => ({ "Content-Type": "application/json", Authorization: `Bearer ${key}` }),
    // Newer OpenAI models (the o-series, gpt-5.x) reject the legacy `max_tokens` field
    // and require `max_completion_tokens` instead; the field also works fine on gpt-4o-mini.
    body: (model, system, user) => ({ model, max_completion_tokens: 1400, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    parse: (d) => d.choices?.[0]?.message?.content || "",
  },
  deepseek: {
    label: "DeepSeek", model: "deepseek-chat",
    endpoint: "https://api.deepseek.com/chat/completions",
    headers: (key) => ({ "Content-Type": "application/json", Authorization: `Bearer ${key}` }),
    body: (model, system, user) => ({ model, max_tokens: 1400, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    parse: (d) => d.choices?.[0]?.message?.content || "",
  },
  groq: {
    label: "Groq", model: "llama-3.3-70b-versatile",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    headers: (key) => ({ "Content-Type": "application/json", Authorization: `Bearer ${key}` }),
    body: (model, system, user) => ({ model, max_tokens: 1400, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    parse: (d) => d.choices?.[0]?.message?.content || "",
  },
};

/* ---------- storage: localStorage with in-memory fallback ---------- */
const mem = {};
const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(k);
      if (v != null) return JSON.parse(v);
    } catch (_) {}
    return k in mem ? mem[k] : fallback;
  },
  set(k, v) {
    mem[k] = v;
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {}
  },
};

/* ---------- date helpers ---------- */
function dayOfYear(d = new Date()) {
  const n = Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 86400000);
  return Math.min(Math.max(n, 1), 365);
}
function dateKey(d = new Date()) {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function quarterFor(day) {
  return QUARTERS.find((q) => day >= q.start && day <= q.end) || QUARTERS[3];
}
function computeStreak(entries) {
  const days = new Set(entries.map((e) => e.dateKey));
  const cur = new Date();
  if (!days.has(dateKey(cur))) cur.setDate(cur.getDate() - 1);
  let streak = 0;
  while (days.has(dateKey(cur))) { streak++; cur.setDate(cur.getDate() - 1); }
  return streak;
}

/* ---------- AI call ---------- */
async function callAI(cfg, userPrompt) {
  const p = PROVIDERS[cfg.provider];
  if (!p) throw new Error("No provider configured.");
  const res = await fetch(p.endpoint, {
    method: "POST",
    headers: p.headers(cfg.key),
    body: JSON.stringify(p.body(cfg.model || p.model, SYSTEM_PROMPT, userPrompt)),
  });
  if (!res.ok) {
    let msg = `${p.label} returned ${res.status}`;
    try { const j = await res.json(); msg += ": " + (j.error?.message || j.message || JSON.stringify(j)).slice(0, 300); } catch (_) {}
    throw new Error(msg);
  }
  const data = await res.json();
  const text = p.parse(data);
  if (!text) throw new Error("Empty response from " + p.label);
  return text;
}
function extractJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
  return JSON.parse(clean.slice(a, b + 1));
}

/* ---------- styles ---------- */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=EB+Garamond:ital,wght@0,400;0,500;1,400&display=swap');
html, body { margin: 0; background: #0d0c0a; }
* { box-sizing: border-box; }
.nz { min-height: 100vh; background: #0d0c0a; color: #e8e0d0; font-family: 'EB Garamond', Georgia, serif; font-size: 19px; line-height: 1.55; position: relative; }
.nz-grain { position: fixed; inset: 0; pointer-events: none; opacity: 0.09; z-index: 50; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
.nz-progress { position: fixed; top: 0; left: 0; height: 2px; background: #8b6914; box-shadow: 0 0 8px rgba(139,105,20,.7); z-index: 60; transition: width 1s ease; }
.nz-wrap { max-width: 720px; margin: 0 auto; padding: 48px 24px 96px; }
.nz-head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 1px solid #2a2418; padding-bottom: 20px; margin-bottom: 8px; }
.nz-brand { font-family: 'Cinzel', serif; font-weight: 700; letter-spacing: .32em; font-size: 15px; color: #8b6914; }
.nz-day { font-family: 'Cinzel', serif; font-size: 34px; line-height: 1; margin-top: 10px; color: #e8e0d0; }
.nz-day small { display:block; font-family: 'EB Garamond', serif; font-style: italic; font-size: 17px; color: #9a9080; margin-top: 8px; letter-spacing: 0; }
.nz-streak { text-align: right; }
.nz-streak b { font-family: 'Cinzel', serif; font-size: 30px; display: block; color: #e8e0d0; font-weight: 400; line-height: 1; }
.nz-streak span { font-style: italic; color: #9a9080; font-size: 16px; }
.nz-gear { background: none; border: none; color: #6a6050; cursor: pointer; font-family: 'EB Garamond', serif; font-size: 16px; font-style: italic; padding: 0; margin-top: 6px; }
.nz-gear:hover, .nz-gear:focus-visible { color: #8b6914; outline: none; }
.nz-tabs { display: flex; gap: 4px; flex-wrap: wrap; margin: 20px 0 36px; }
.nz-tab { font-family: 'Cinzel', serif; font-size: 12px; letter-spacing: .18em; padding: 10px 14px; background: none; border: none; border-bottom: 1px solid transparent; color: #7d7462; cursor: pointer; transition: color .2s, border-color .2s; }
.nz-tab:hover { color: #e8e0d0; }
.nz-tab:focus-visible { outline: 1px solid #8b6914; outline-offset: 2px; }
.nz-tab.on { color: #e8e0d0; border-bottom-color: #8b6914; }
@keyframes nzFade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.nz-pane { animation: nzFade .45s ease both; }
.nz-h { font-family: 'Cinzel', serif; font-weight: 400; font-size: 22px; letter-spacing: .06em; margin: 0 0 18px; color: #e8e0d0; }
.nz-quote { font-size: 28px; line-height: 1.35; font-style: italic; margin: 0 0 14px; color: #e8e0d0; border-left: 2px solid #8b6914; padding-left: 22px; }
.nz-src { font-family: 'Cinzel', serif; font-size: 12px; letter-spacing: .16em; color: #8b6914; margin-bottom: 30px; padding-left: 24px; }
.nz-p { margin: 0 0 18px; }
.nz-dim { color: #9a9080; font-style: italic; }
.nz-rule { border: none; border-top: 1px solid #2a2418; margin: 34px 0; }
.nz-block { border: 1px solid #2a2418; padding: 24px 26px; margin: 0 0 18px; background: rgba(139,105,20,.03); }
.nz-block h4 { font-family: 'Cinzel', serif; font-weight: 400; font-size: 17px; letter-spacing: .04em; margin: 0 0 10px; }
.nz-block p { margin: 0; color: #b5ab99; font-size: 17px; }
textarea.nz-ta, input.nz-in { width: 100%; background: #12110e; color: #e8e0d0; border: 1px solid #2a2418; padding: 16px 18px; font-family: 'EB Garamond', serif; font-size: 19px; line-height: 1.5; resize: vertical; }
textarea.nz-ta:focus, input.nz-in:focus { outline: none; border-color: #8b6914; }
.nz-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-top: 14px; }
.nz-btn { font-family: 'Cinzel', serif; font-size: 12px; letter-spacing: .2em; padding: 13px 22px; background: none; border: 1px solid #8b6914; color: #e8e0d0; cursor: pointer; transition: background .2s, color .2s; }
.nz-btn:hover:not(:disabled) { background: #8b6914; color: #0d0c0a; }
.nz-btn:focus-visible { outline: 1px solid #e8e0d0; outline-offset: 3px; }
.nz-btn:disabled { opacity: .4; cursor: default; }
.nz-btn.ghost { border-color: #2a2418; color: #9a9080; }
.nz-btn.ghost:hover:not(:disabled) { background: #2a2418; color: #e8e0d0; }
.nz-err { border-left: 2px solid #7a2a1a; padding: 10px 16px; color: #c9b8a8; margin-top: 16px; font-size: 17px; }
.nz-resp { margin-top: 30px; padding: 26px 28px; border: 1px solid #8b6914; border-width: 1px 0; white-space: pre-wrap; }
.nz-resp::before { content: 'The interlocutor'; display: block; font-family: 'Cinzel', serif; font-size: 12px; letter-spacing: .2em; color: #8b6914; margin-bottom: 14px; }
.nz-entry { border-top: 1px solid #2a2418; padding: 22px 0; }
.nz-entry:last-child { border-bottom: 1px solid #2a2418; }
.nz-entry .d { font-family: 'Cinzel', serif; font-size: 12px; letter-spacing: .18em; color: #8b6914; }
.nz-entry .q { font-style: italic; color: #9a9080; font-size: 17px; margin: 6px 0 10px; }
.nz-entry .t { margin: 0 0 8px; }
.nz-entry .r { color: #b5ab99; font-size: 17px; margin: 0; padding-left: 14px; border-left: 1px solid #2a2418; }
.nz-entry-btn { display: block; width: 100%; text-align: left; background: none; border: none; border-top: 1px solid #2a2418; cursor: pointer; font-family: inherit; color: inherit; transition: background .15s ease; }
.nz-entry-btn:last-child { border-bottom: 1px solid #2a2418; }
.nz-entry-btn:hover, .nz-entry-btn:focus-visible { background: rgba(139,105,20,.06); outline: none; }
.nz-setup { max-width: 560px; margin: 0 auto; padding: 80px 24px; }
.nz-prov { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 18px 0 26px; }
.nz-prov button { text-align: left; background: none; border: 1px solid #2a2418; color: #9a9080; padding: 14px 16px; cursor: pointer; font-family: 'EB Garamond', serif; font-size: 18px; }
.nz-prov button.on { border-color: #8b6914; color: #e8e0d0; }
.nz-prov button small { display: block; font-size: 14px; color: #6a6050; font-style: italic; }
.nz-lbl { font-family: 'Cinzel', serif; font-size: 12px; letter-spacing: .18em; color: #8b6914; margin: 22px 0 8px; }
/* the ritual of return */
.nz-ritual { max-width: 620px; }
.nz-round-label { font-family: 'Cinzel', serif; font-size: 12px; letter-spacing: .24em; color: #8b6914; margin-bottom: 18px; }
.nz-ritual-round { animation: nzWeightIn .4s ease both; }
@keyframes nzWeightIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
.nz-weight-quote { font-style: italic; color: #e8e0d0; border-left: 2px solid #8b6914; padding: 2px 0 2px 22px; margin: 0 0 28px; transition: font-size .3s ease, border-left-width .3s ease, padding-left .3s ease; }
.nz-question { font-family: 'Cinzel', serif; font-weight: 400; font-size: 21px; line-height: 1.4; margin: 0 0 18px; }
.nz-dots { display: flex; gap: 8px; margin-bottom: 22px; }
.nz-dot { width: 7px; height: 7px; border-radius: 50%; background: #2a2418; }
.nz-dot.done { background: #8b6914; }
.nz-work-preview { white-space: pre-wrap; border-left: 1px solid #8b6914; padding: 4px 0 4px 20px; margin: 18px 0; color: #b5ab99; }
@media (prefers-reduced-motion: reduce) { .nz-pane { animation: none; } .nz-ritual-round { animation: none; } }
@media (max-width: 560px) { .nz { font-size: 18px; } .nz-day { font-size: 26px; } .nz-quote { font-size: 23px; } .nz-prov { grid-template-columns: 1fr; } .nz-wrap { padding: 36px 18px 80px; } }
`;

/* ============================================================ */
export default function NietzscheJournal() {
  const today = useMemo(() => new Date(), []);
  const day = dayOfYear(today);
  const dkey = dateKey(today);
  const quarter = quarterFor(day);
  const qProgress = ((day - quarter.start + 1) / (quarter.end - quarter.start + 1)) * 100;

  const [cfg, setCfg] = useState(() => store.get("nz_cfg", null));
  const [showSetup, setShowSetup] = useState(() => !store.get("nz_cfg", null));
  const [tab, setTab] = useState("day");
  const [daily, setDaily] = useState(() => store.get(`nz_daily_${dkey}`, null));
  const [dailyErr, setDailyErr] = useState("");
  const [loadingDaily, setLoadingDaily] = useState(false);
  const [archive, setArchive] = useState(() => store.get("nz_archive", []));
  const streak = useMemo(() => computeStreak(archive), [archive]);

  useEffect(() => { store.set("nz_archive", archive); }, [archive]);

  /* ---- daily generation (once per day, cached) ---- */
  const generateDaily = async (force = false) => {
    if (!cfg) return;
    if (daily && !force) return;
    setLoadingDaily(true); setDailyErr("");
    const prompt = `Today is day ${day} of 365. Quarter ${quarter.n}: "${quarter.title}". Relevant works: ${quarter.works}.
Return ONLY a JSON object, no prose, no markdown fences, with these keys:
"quote": a genuine passage from Nietzsche's published works or notebooks fitting this quarter's theme. Use wording you are certain of; a shorter exact passage is better than a longer uncertain one. Do not invent or embellish.
"source": the work title and section/aphorism number (e.g. "The Gay Science, §341").
"context": exactly three sentences of philosophical context — what the passage argues, what it is against, and where it sits in Nietzsche's project.
"prompt": one journaling prompt, one or two sentences, that demands self-examination rather than reflection on Nietzsche.
"exercise": one concrete exercise for today, three to five sentences, that the person performs in their actual life (an action, an observation, a refusal), fitting the quarter's theme.`;
    try {
      const text = await callAI(cfg, prompt);
      const obj = extractJSON(text);
      const d = { quote: obj.quote || "", source: obj.source || "", context: obj.context || "", prompt: obj.prompt || "", exercise: obj.exercise || "", day, generatedAt: Date.now() };
      setDaily(d); store.set(`nz_daily_${dkey}`, d);
    } catch (e) {
      setDailyErr(e.message || String(e));
    } finally { setLoadingDaily(false); }
  };
  useEffect(() => { if (cfg && !daily) generateDaily(); /* eslint-disable-line */ }, [cfg]);

  const saveEntry = (entry) => {
    setArchive((prev) => [entry, ...prev.filter((e) => e.id !== entry.id)].slice(0, 60));
  };

  if (showSetup || !cfg) {
    return (
      <div className="nz">
        <style>{CSS}</style>
        <div className="nz-grain" />
        <Setup initial={cfg} onDone={(c) => { store.set("nz_cfg", c); setCfg(c); setShowSetup(false); }} onCancel={cfg ? () => setShowSetup(false) : null} />
      </div>
    );
  }

  const TABS = [["day", "Today"], ["journal", "Journal"], ["breath", "Recurrence"], ["exercise", "Exercise"], ["archive", "Archive"]];

  return (
    <div className="nz">
      <style>{CSS}</style>
      <div className="nz-grain" />
      <div className="nz-progress" style={{ width: `${qProgress}%` }} title={`Quarter ${quarter.n}: ${Math.round(qProgress)}%`} />
      <div className="nz-wrap">
        <header className="nz-head">
          <div>
            <div className="nz-brand">REVALUATION</div>
            <div className="nz-day">Day {day}<small>Quarter {quarter.n} — {quarter.title}</small></div>
          </div>
          <div className="nz-streak">
            <b>{streak}</b>
            <span>{streak === 1 ? "day" : "days"} unbroken</span>
            <div><button className="nz-gear" onClick={() => setShowSetup(true)}>{PROVIDERS[cfg.provider].label} · change</button></div>
          </div>
        </header>

        <nav className="nz-tabs">
          {TABS.map(([id, label]) => (
            <button key={id} className={`nz-tab${tab === id ? " on" : ""}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>

        <div className="nz-pane" key={tab}>
          {tab === "day" && <DailyView daily={daily} loading={loadingDaily} err={dailyErr} quarter={quarter} onRetry={() => generateDaily(true)} onJournal={() => setTab("journal")} />}
          {tab === "journal" && <JournalView cfg={cfg} daily={daily} quarter={quarter} day={day} dkey={dkey} archive={archive} saveEntry={saveEntry} />}
          {tab === "breath" && <RecurrenceView dkey={dkey} day={day} quarter={quarter} saveEntry={saveEntry} />}
          {tab === "exercise" && <ExerciseView daily={daily} loading={loadingDaily} quarter={quarter} />}
          {tab === "archive" && <ArchiveView archive={archive} />}
        </div>
      </div>
    </div>
  );
}

/* ---------- Setup ---------- */
function Setup({ initial, onDone, onCancel }) {
  const [provider, setProvider] = useState(initial?.provider || "anthropic");
  const [key, setKey] = useState(initial?.key || "");
  const [model, setModel] = useState(initial?.model || "");
  const p = PROVIDERS[provider];
  return (
    <div className="nz-setup">
      <div className="nz-brand">REVALUATION</div>
      <h1 className="nz-h" style={{ fontSize: 30, marginTop: 14 }}>A year against yourself.</h1>
      <p className="nz-p nz-dim">365 days through Nietzsche, in four movements: self-overcoming, amor fati, the creation of values, the Übermensch. Each day a passage, a demand, and a page you must write.</p>
      <p className="nz-p">This app calls an AI provider directly from your browser. Your key is stored only in this browser's local storage and sent only to the provider you choose.</p>
      <div className="nz-lbl">Provider</div>
      <div className="nz-prov">
        {Object.entries(PROVIDERS).map(([id, pr]) => (
          <button key={id} className={provider === id ? "on" : ""} onClick={() => { setProvider(id); setModel(""); }}>
            {pr.label}<small>{pr.model}</small>
          </button>
        ))}
      </div>
      <div className="nz-lbl">API key</div>
      <input className="nz-in" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={`${p.label} key`} autoComplete="off" />
      <div className="nz-lbl">Model (optional override)</div>
      <input className="nz-in" value={model} onChange={(e) => setModel(e.target.value)} placeholder={p.model} />
      <div className="nz-row">
        <button className="nz-btn" disabled={!key.trim()} onClick={() => onDone({ provider, key: key.trim(), model: model.trim() })}>Begin</button>
        {onCancel && <button className="nz-btn ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

/* ---------- Daily ---------- */
function DailyView({ daily, loading, err, quarter, onRetry, onJournal }) {
  if (loading) return <p className="nz-dim">Consulting the text for day {daily?.day || ""}…</p>;
  if (err) return (
    <div>
      <p className="nz-p">Today's passage could not be generated.</p>
      <div className="nz-err">{err}</div>
      <p className="nz-dim" style={{ fontSize: 16 }}>If this is a network or CORS error, the environment running this page is blocking direct browser calls to the provider. Run the file locally or on your own host.</p>
      <div className="nz-row"><button className="nz-btn" onClick={onRetry}>Try again</button></div>
    </div>
  );
  if (!daily) return <div className="nz-row"><button className="nz-btn" onClick={onRetry}>Generate today</button></div>;
  return (
    <div>
      <p className="nz-quote">{daily.quote}</p>
      <div className="nz-src">{daily.source}</div>
      <p className="nz-p">{daily.context}</p>
      <hr className="nz-rule" />
      <h3 className="nz-h">Today's demand</h3>
      <p className="nz-p" style={{ fontSize: 22 }}>{daily.prompt}</p>
      <div className="nz-row">
        <button className="nz-btn" onClick={onJournal}>Write</button>
        <button className="nz-btn ghost" onClick={onRetry}>Regenerate</button>
      </div>
      <hr className="nz-rule" />
      <p className="nz-dim" style={{ fontSize: 16 }}>Quarter {quarter.n} draws on: {quarter.works}. Quotations are AI-retrieved; verify the source before citing it.</p>
    </div>
  );
}

/* ---------- Journal ---------- */
function JournalView({ cfg, daily, quarter, day, dkey, archive, saveEntry }) {
  const existing = archive.find((e) => e.dateKey === dkey);
  const [text, setText] = useState(existing?.text || "");
  const [resp, setResp] = useState(existing?.response || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);

  const buildEntry = (response) => ({
    id: existing?.id || `${dkey}-${Date.now()}`,
    dateKey: dkey, day, quarter: quarter.n,
    quote: daily?.quote || "", source: daily?.source || "",
    text, response,
    savedAt: Date.now(),
  });
  const save = () => { saveEntry(buildEntry(resp)); setSaved(true); setTimeout(() => setSaved(false), 1600); };

  const challenge = async () => {
    setBusy(true); setErr("");
    const prompt = `Day ${day} of 365. Quarter ${quarter.n}: "${quarter.title}".
Today's passage: "${daily?.quote || "(none)"}" — ${daily?.source || ""}
Journaling prompt: ${daily?.prompt || "(none)"}

The person wrote:
"""
${text}
"""

Respond as the interlocutor. Do not summarize what they wrote back to them. Identify the one assumption, evasion, or inherited value at the center of the entry and press on it. Ask at most two questions. Cite at least one specific work of Nietzsche by title. Under 220 words. No headings, no lists.`;
    try {
      const r = await callAI(cfg, prompt);
      setResp(r);
      saveEntry(buildEntry(r));
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div>
      {daily && <p className="nz-dim" style={{ marginTop: 0 }}>{daily.prompt}</p>}
      <textarea className="nz-ta" rows={11} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write. Not what you feel — what you did, what you avoided, what you wanted." />
      <div className="nz-row">
        <button className="nz-btn" disabled={busy || text.trim().length < 20} onClick={challenge}>{busy ? "Reading…" : "Challenge me"}</button>
        <button className="nz-btn ghost" disabled={!text.trim()} onClick={save}>{saved ? "Saved" : "Save entry"}</button>
        {text.trim().length < 20 && text.length > 0 && <span className="nz-dim" style={{ fontSize: 15 }}>Write more before asking to be challenged.</span>}
      </div>
      {err && <div className="nz-err">{err}</div>}
      {resp && <div className="nz-resp">{resp}</div>}
    </div>
  );
}

/* ---------- Recurrence: the ritual of return ---------- */
const RITUAL_ROUNDS = 3;

const ROUND_COPY = [
  {
    question: "Would you choose to live this again — exactly this, nothing added or removed, infinitely?",
    placeholder: "Answer without flinching. Yes or no, and why.",
  },
  {
    question: "Say it again. Does it still hold, now that you have heard yourself answer once?",
    placeholder: "Do not repeat your first answer out of convenience. Test it.",
  },
  {
    question: "One more time. This is the last asking.",
    placeholder: "This is the answer that has to stand.",
  },
];

function emptyRitual() {
  return { event: "", confirmations: [], story: "" };
}

function RecurrenceView({ dkey, day, quarter, saveEntry }) {
  const [saved0] = useState(() => store.get(`nz_rec_${dkey}`, emptyRitual()));
  const [phase, setPhase] = useState(saved0.story ? "done" : "idle"); // idle | write | repeat | story | done
  const [event, setEvent] = useState(saved0.event || "");
  const [round, setRound] = useState(0);
  const [roundAnswer, setRoundAnswer] = useState("");
  const [confirmations, setConfirmations] = useState(saved0.confirmations || []);
  const [story, setStory] = useState(saved0.story || "");

  const persist = (patch) => {
    const data = { event, confirmations, story, ...patch };
    store.set(`nz_rec_${dkey}`, data);
  };

  const confirmEvent = () => {
    if (event.trim().length < 15) return;
    persist({ event: event.trim() });
    setRound(0);
    setRoundAnswer("");
    setPhase("repeat");
  };

  const answerRound = () => {
    if (roundAnswer.trim().length < 8) return;
    const next = [...confirmations, roundAnswer.trim()];
    setConfirmations(next);
    persist({ confirmations: next });
    setRoundAnswer("");
    if (round + 1 >= RITUAL_ROUNDS) setPhase("story");
    else setRound(round + 1);
  };

  const saveStory = () => {
    if (story.trim().length < 30) return;
    const trimmed = story.trim();
    persist({ story: trimmed });
    if (saveEntry) {
      saveEntry({
        id: `${dkey}-ritual`,
        dateKey: dkey, day, quarter: quarter.n,
        type: "ritual",
        quote: event, source: "The Return — eternal recurrence ritual",
        text: trimmed,
        savedAt: Date.now(),
      });
    }
    setPhase("done");
  };

  const startOver = () => {
    store.set(`nz_rec_${dkey}`, emptyRitual());
    setEvent(""); setRound(0); setRoundAnswer(""); setConfirmations([]); setStory("");
    setPhase("idle");
  };

  const cut = (s, n) => (s && s.length > n ? s.slice(0, n).trimEnd() + "…" : s);

  return (
    <div className="nz-ritual">
      {phase === "idle" && (
        <div>
          <h3 className="nz-h">The greatest weight</h3>
          <p className="nz-p">The Gay Science §341 imagines a demon telling you that this life, as you now live it, you will have to live once more and innumerable times more — every event, without addition or subtraction, in the same succession. Not life in general. One event. Choose one that actually weighs something — not a triumph, not a pleasant afternoon. Something that hurt.</p>
          <div className="nz-row">
            <button className="nz-btn" onClick={() => setPhase("write")}>Name it</button>
          </div>
        </div>
      )}

      {phase === "write" && (
        <div>
          <h3 className="nz-h">Name the event</h3>
          <p className="nz-dim">One thing that happened — today, or unfinished from before — that you would not call good. Be specific. Not "a hard conversation," but what was said.</p>
          <textarea className="nz-ta" rows={6} value={event} onChange={(e) => setEvent(e.target.value)} placeholder="What happened." />
          <div className="nz-row">
            <button className="nz-btn" disabled={event.trim().length < 15} onClick={confirmEvent}>Set it down</button>
            <button className="nz-btn ghost" onClick={() => setPhase("idle")}>Back</button>
          </div>
        </div>
      )}

      {phase === "repeat" && (
        <div className="nz-ritual-round" key={round}>
          <div className="nz-round-label">THE RETURN — {round + 1} OF {RITUAL_ROUNDS}</div>
          <div className="nz-dots">
            {Array.from({ length: RITUAL_ROUNDS }).map((_, i) => (
              <div key={i} className={`nz-dot${i < round ? " done" : ""}`} />
            ))}
          </div>
          <p className="nz-weight-quote" style={{ fontSize: 18 + round * 2, borderLeftWidth: 2 + round, paddingLeft: 22 + round * 3 }}>{event}</p>
          <p className="nz-question">{ROUND_COPY[round].question}</p>
          <textarea className="nz-ta" rows={5} value={roundAnswer} onChange={(e) => setRoundAnswer(e.target.value)} placeholder={ROUND_COPY[round].placeholder} />
          <div className="nz-row">
            <button className="nz-btn" disabled={roundAnswer.trim().length < 8} onClick={answerRound}>Answer</button>
            <button className="nz-btn ghost" onClick={() => setPhase("idle")}>Stop here</button>
          </div>
        </div>
      )}

      {phase === "story" && (
        <div>
          <h3 className="nz-h">Make something of it</h3>
          <p className="nz-p">Ecce Homo: "My formula for greatness in a human being is amor fati: that one wants nothing to be other than it is... not merely to bear what is necessary, but to love it." What you cannot undo, you can still shape. Write a short piece — a page, a paragraph, a few lines — that takes this event as its material. Not a confession. A work.</p>
          <textarea className="nz-ta" rows={10} value={story} onChange={(e) => setStory(e.target.value)} placeholder="Begin." />
          <div className="nz-row">
            <button className="nz-btn" disabled={story.trim().length < 30} onClick={saveStory}>Complete the ritual</button>
          </div>
        </div>
      )}

      {phase === "done" && (
        <div>
          <h3 className="nz-h">Recorded</h3>
          <p className="nz-dim">Today's return is complete — named, confirmed three times, and made into a work.</p>
          <hr className="nz-rule" />
          <div className="nz-src">THE EVENT</div>
          <p className="nz-p">{cut(event, 220)}</p>
          <div className="nz-src">THE WORK</div>
          <div className="nz-work-preview">{story}</div>
          <div className="nz-row">
            <button className="nz-btn ghost" onClick={startOver}>Begin again</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Exercise ---------- */
function ExerciseView({ daily, loading, quarter }) {
  return (
    <div>
      <h3 className="nz-h">Today's exercise</h3>
      {loading && <p className="nz-dim">Generating…</p>}
      {!loading && daily?.exercise && <p className="nz-p" style={{ fontSize: 21 }}>{daily.exercise}</p>}
      {!loading && !daily?.exercise && <p className="nz-dim">No exercise yet. Generate today's passage first.</p>}
      <hr className="nz-rule" />
      <h3 className="nz-h">Self-overcoming inventory</h3>
      <p className="nz-dim" style={{ marginTop: -6 }}>Four questions, every day, regardless of the quarter. Answer them in the journal or not at all — but read them.</p>
      {INVENTORY.map((c, i) => (
        <div className="nz-block" key={i}>
          <h4>{c.q}</h4>
          <p>{c.note}</p>
        </div>
      ))}
      <p className="nz-dim" style={{ fontSize: 16 }}>Quarter {quarter.n}: {quarter.line}</p>
    </div>
  );
}

/* ---------- Archive ---------- */
function ArchiveView({ archive }) {
  const [openId, setOpenId] = useState(null);
  if (!archive.length) return <p className="nz-dim">Nothing yet. The archive holds your last sixty entries.</p>;

  const selected = openId ? archive.find((e) => e.id === openId) : null;
  if (selected) return <ArchiveDetail entry={selected} onBack={() => setOpenId(null)} />;

  const cut = (s, n) => (s && s.length > n ? s.slice(0, n).trimEnd() + "…" : s);
  return (
    <div>
      <p className="nz-dim" style={{ marginTop: 0 }}>{archive.length} of 60 entries kept. Select one to read it in full.</p>
      {archive.map((e) => (
        <button className="nz-entry nz-entry-btn" key={e.id} onClick={() => setOpenId(e.id)}>
          <div className="d">{e.dateKey} — Day {e.day}, Q{e.quarter}{e.type === "ritual" ? " · A WORK, FROM THE RETURN" : ""}</div>
          {e.quote && <div className="q">“{cut(e.quote, 140)}” {e.source && <span>({e.source})</span>}</div>}
          <p className="t">{cut(e.text, 260)}</p>
          {e.response && <p className="r">{cut(e.response, 220)}</p>}
        </button>
      ))}
    </div>
  );
}

function ArchiveDetail({ entry: e, onBack }) {
  return (
    <div>
      <button className="nz-btn ghost" onClick={onBack}>← Back to archive</button>
      <div className="d" style={{ marginTop: 24 }}>{e.dateKey} — Day {e.day}, Q{e.quarter}{e.type === "ritual" ? " · A WORK, FROM THE RETURN" : ""}</div>
      {e.quote && (
        <div>
          <p className="nz-quote" style={{ marginTop: 18 }}>{e.quote}</p>
          {e.source && <div className="nz-src">{e.source}</div>}
        </div>
      )}
      <div className="nz-src" style={{ marginTop: e.quote ? 0 : 24 }}>{e.type === "ritual" ? "THE WORK" : "THE ENTRY"}</div>
      <p className="nz-p" style={{ whiteSpace: "pre-wrap" }}>{e.text}</p>
      {e.response && (
        <div className="nz-resp">{e.response}</div>
      )}
    </div>
  );
}
