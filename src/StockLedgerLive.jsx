import { useState, useRef, useEffect } from "react";
import { Camera, Mic, Square, Loader2, Check, X, TrendingUp, Package, Smartphone, RotateCcw } from "lucide-react";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY;
const DEALER_ID = "11111111-1111-1111-1111-111111111111"; // Duncan's dealer record

const STATUSES = [
  { key: "available", label: "Available", pub: true, dot: "#6B8F71", bg: "#EAF0E9" },
  { key: "reserved", label: "Reserved", pub: false, dot: "#B5651D", bg: "#F5E9DC" },
  { key: "sold_unpaid", label: "Sold — Unpaid", pub: false, dot: "#A8452F", bg: "#F3E1DC" },
  { key: "sold_paid", label: "Sold — Paid", pub: false, dot: "#3A5A5E", bg: "#E2EAEA" },
  { key: "waiting_parts", label: "Waiting for Parts", pub: false, dot: "#8A7B5C", bg: "#EFEAE0" },
];

const EXPENSE_CATEGORIES = [
  { key: "shipping", label: "Shipping" },
  { key: "repairs", label: "Repairs" },
  { key: "accessories", label: "Accessories" },
  { key: "labour", label: "Labour" },
  { key: "petrol", label: "Petrol / Courier" },
  { key: "sundry", label: "Sundry / Other" },
];

const blankDraft = { model: "", storage: "", color: "", cost_price: "", price: "", warranty_months: "", bought_from: "", imei_full: "", condition_score: "", expenses: {} };

// --- Supabase REST helpers (direct fetch, no client library needed) ---
async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: options.method === "POST" ? "return=representation" : "return=minimal",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase error ${res.status}: ${errText}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

const getListings = () => sbFetch("listings?is_archived=eq.false&select=*,expenses(category,amount)&order=created_at.desc");
const createListing = (data) => sbFetch("listings", { method: "POST", body: JSON.stringify(data) });
const createExpense = (data) => sbFetch("expenses", { method: "POST", body: JSON.stringify(data) });
const updateListingStatus = (id, status) =>
  sbFetch(`listings?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status, updated_at: new Date().toISOString() }) });
const archiveListing = (id) =>
  sbFetch(`listings?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ is_archived: true }) });

// --- Claude API helper (unchanged from prototype) ---
async function askClaude(content) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 500, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error("AI request failed");
  const data = await res.json();
  const text = data.content.find((b) => b.type === "text")?.text || "{}";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function StockLedgerLive() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState("all");
  const [step, setStep] = useState("idle");
  const [draft, setDraft] = useState(blankDraft);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [recording, setRecording] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [error, setError] = useState("");
  const [typedNote, setTypedNote] = useState("");
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef(null);
  const recognitionRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const refresh = async () => {
    try {
      setLoadError("");
      const data = await getListings();
      setItems(data || []);
    } catch (err) {
      setLoadError("Couldn't load stock from the database. Check the trial RLS policy has been run.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const parseNote = async (transcript) => {
    setVoiceTranscript(transcript);
    setVoiceStatus("thinking");
    try {
      const result = await askClaude([
        { type: "text", text: `A phone dealer said this out loud while logging stock: "${transcript}". Extract whatever's mentioned into JSON. Respond ONLY with raw JSON, no markdown, in this exact shape: {"model": "", "storage": "", "color": "", "cost_price": "", "price": "", "bought_from": "", "condition_score": "", "warranty_months": ""}. cost_price and price should be numbers only (no "R" or commas), as strings. Leave anything not mentioned as an empty string.` },
      ]);
      setDraft((d) => ({ ...d, ...Object.fromEntries(Object.entries(result).filter(([, v]) => v !== "")) }));
      setStep("review");
    } catch (err) {
      setError("Had trouble understanding that — check the fields below.");
      setStep("review");
    } finally {
      setVoiceStatus("");
      setRecording(false);
    }
  };

  const handlePhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    setStep("photo-loading");
    try {
      const base64 = await fileToBase64(file);
      setPhotoPreview(`data:${file.type};base64,${base64}`);
      const result = await askClaude([
        { type: "image", source: { type: "base64", media_type: file.type, data: base64 } },
        { type: "text", text: 'Read any visible IMEI number, model, storage capacity, and color from this photo. Respond ONLY with raw JSON: {"model": "", "storage": "", "color": "", "imei_full": ""}. Empty string if not visible.' },
      ]);
      setDraft((d) => ({ ...d, ...result }));
      setStep("review");
    } catch (err) {
      setError("Couldn't read that photo clearly — fill fields in manually below.");
      setStep("review");
    }
  };

  const startVoice = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setVoiceStatus("thinking");
        try {
          const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
          const formData = new FormData();
          formData.append("audio", audioBlob, "recording.webm");
          const res = await fetch("/api/transcribe", { method: "POST", body: formData });
          const data = await res.json();
          if (!res.ok || data.error) throw new Error(data.error || "Transcription failed");
          await parseNote(data.transcript);
        } catch (err) {
          setError("Couldn't transcribe that — try again, or type it instead.");
          setVoiceStatus("");
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setVoiceStatus("listening");
    } catch (err) {
      setError("Couldn't access the microphone — check permissions, or type it instead.");
    }
  };

  const stopVoice = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };
  const openManual = () => { setDraft(blankDraft); setPhotoPreview(null); setVoiceTranscript(""); setError(""); setStep("review"); };
  const reset = () => { setStep("idle"); setDraft(blankDraft); setPhotoPreview(null); setVoiceTranscript(""); setError(""); };

  const saveDraft = async () => {
    if (!draft.model) return;
    setSaving(true);
    setError("");
    try {
      const created = await createListing({
        dealer_id: DEALER_ID,
        model: draft.model,
        storage: draft.storage || null,
        color: draft.color || null,
        cost_price: draft.cost_price ? Number(draft.cost_price) : null,
        price: Number(draft.price) || 0,
        bought_from: draft.bought_from || null,
        imei_full: draft.imei_full || null,
        condition_score: draft.condition_score ? Number(draft.condition_score) : null,
        warranty_months: draft.warranty_months ? Number(draft.warranty_months) : null,
        stock_type: "pre_owned",
        status: "available",
      });
      const newListingId = created?.[0]?.id;
      const expenseEntries = Object.entries(draft.expenses || {}).filter(([, v]) => v && Number(v) > 0);
      if (newListingId && expenseEntries.length > 0) {
        await Promise.all(
          expenseEntries.map(([category, amount]) =>
            createExpense({ dealer_id: DEALER_ID, listing_id: newListingId, category, amount: Number(amount) })
          )
        );
      }
      await refresh();
      reset();
    } catch (err) {
      setError("Couldn't save to the database — " + err.message);
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (id, status) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status } : i))); // optimistic
    try {
      await updateListingStatus(id, status);
    } catch (err) {
      setLoadError("Status update failed to save — refresh to check.");
    }
  };

  const removeItem = async (id) => {
    setItems((prev) => prev.filter((i) => i.id !== id)); // optimistic
    try {
      await archiveListing(id);
    } catch (err) {
      setLoadError("Archive failed to save — refresh to check.");
    }
  };

  const visible = filter === "all" ? items : items.filter((i) => i.status === filter);
  const totalStock = items.filter((i) => i.status !== "sold_paid").length;
  const expensesTotal = (item) => (item.expenses || []).reduce((s, e) => s + Number(e.amount || 0), 0);
  const grossProfit = items
    .filter((i) => i.status === "sold_paid")
    .reduce((s, i) => s + ((i.price || 0) - (i.cost_price || 0) - expensesTotal(i)), 0);
  const publicCount = items.filter((i) => STATUSES.find((s) => s.key === i.status)?.pub).length;

  return (
    <div style={{ fontFamily: "'Source Sans Pro', ui-sans-serif, system-ui", background: "#F2EFE7", minHeight: "100%", color: "#1C1B19" }} className="w-full p-5 md:p-8">
      <div className="flex items-start justify-between mb-6 border-b-2 pb-4" style={{ borderColor: "#1C1B19" }}>
        <div>
          <h1 style={{ fontFamily: "'Roboto Slab', serif", letterSpacing: "-0.01em" }} className="text-2xl md:text-3xl font-bold">Stock Ledger</h1>
          <p className="text-sm mt-1" style={{ color: "#6B6555" }}>Connected to CertiFone live database</p>
        </div>
      </div>

      {loadError && (
        <div className="border rounded-sm p-3 mb-4 text-sm" style={{ borderColor: "#A8452F", background: "#F3E1DC", color: "#A8452F" }}>
          {loadError}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="border rounded-sm p-3 md:p-4" style={{ borderColor: "#D8D2C2", background: "#FBFAF6" }}>
          <div className="flex items-center gap-1.5 text-xs mb-1" style={{ color: "#6B6555" }}><Package size={13} /> In stock</div>
          <div style={{ fontFamily: "'Roboto Slab', serif" }} className="text-xl md:text-2xl font-bold">{loading ? "…" : totalStock}</div>
        </div>
        <div className="border rounded-sm p-3 md:p-4" style={{ borderColor: "#D8D2C2", background: "#FBFAF6" }}>
          <div className="flex items-center gap-1.5 text-xs mb-1" style={{ color: "#6B6555" }}><TrendingUp size={13} /> Gross profit (paid)</div>
          <div style={{ fontFamily: "'Roboto Slab', serif", color: "#3A5A5E" }} className="text-xl md:text-2xl font-bold">{loading ? "…" : `R${grossProfit.toLocaleString()}`}</div>
        </div>
        <div className="border rounded-sm p-3 md:p-4" style={{ borderColor: "#D8D2C2", background: "#FBFAF6" }}>
          <div className="flex items-center gap-1.5 text-xs mb-1" style={{ color: "#6B6555" }}><Smartphone size={13} /> Live on marketplace</div>
          <div style={{ fontFamily: "'Roboto Slab', serif" }} className="text-xl md:text-2xl font-bold">{loading ? "…" : publicCount}</div>
        </div>
      </div>

      {step === "idle" && (
        <div className="border-2 rounded-sm p-5 mb-6 text-center" style={{ borderColor: "#1C1B19", background: "#FBFAF6" }}>
          <p className="text-xs uppercase tracking-wide mb-4" style={{ color: "#6B6555" }}>Add stock — snap it, say it</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button onClick={() => fileInputRef.current?.click()} className="flex items-center justify-center gap-2 text-white text-sm font-medium px-5 py-3 rounded-sm hover:opacity-90" style={{ background: "#1C1B19" }}>
              <Camera size={16} /> Photo of box / IMEI
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={handlePhoto} className="hidden" />
            <button onClick={recording ? stopVoice : startVoice} className="flex items-center justify-center gap-2 text-white text-sm font-medium px-5 py-3 rounded-sm hover:opacity-90" style={{ background: recording ? "#A8452F" : "#3A5A5E" }}>
              {recording ? <Square size={15} /> : <Mic size={16} />} {recording ? "Stop & process" : "Voice note"}
            </button>
            <button onClick={openManual} className="text-sm font-medium px-5 py-3 rounded-sm border" style={{ borderColor: "#D8D2C2", color: "#6B6555" }}>
              Type manually
            </button>
          </div>
          {voiceStatus === "listening" && <p className="text-xs mt-3 animate-pulse" style={{ color: "#A8452F" }}>Listening…</p>}
          {voiceStatus === "thinking" && <p className="text-xs mt-3 flex items-center justify-center gap-1.5" style={{ color: "#6B6555" }}><Loader2 size={12} className="animate-spin" /> Reading that back…</p>}
          {error && <p className="text-xs mt-3" style={{ color: "#A8452F" }}>{error}</p>}

          <div className="mt-4 pt-4 border-t" style={{ borderColor: "#D8D2C2" }}>
            <p className="text-xs mb-2" style={{ color: "#8A8272" }}>Mic not working on this device? Type what you'd say instead:</p>
            <div className="flex flex-col sm:flex-row gap-2">
              <input value={typedNote} onChange={(e) => setTypedNote(e.target.value)} placeholder='e.g. "iPhone 12 128 black, bought from UCF for 3500, selling for 5800"' className="border px-3 py-2 text-sm rounded-sm flex-1" style={{ borderColor: "#D8D2C2" }} />
              <button onClick={() => typedNote.trim() && parseNote(typedNote.trim())} className="text-sm font-medium px-4 py-2 rounded-sm text-white hover:opacity-90" style={{ background: "#3A5A5E" }}>
                Parse it
              </button>
            </div>
          </div>
        </div>
      )}

      {step === "photo-loading" && (
        <div className="border-2 rounded-sm p-6 mb-6 flex items-center gap-4" style={{ borderColor: "#1C1B19", background: "#FBFAF6" }}>
          {photoPreview && <img src={photoPreview} alt="captured" className="w-16 h-16 object-cover rounded-sm border" style={{ borderColor: "#D8D2C2" }} />}
          <p className="text-sm flex items-center gap-2" style={{ color: "#6B6555" }}><Loader2 size={16} className="animate-spin" /> Reading the IMEI and model off that photo…</p>
        </div>
      )}

      {step === "review" && (
        <div className="border-2 rounded-sm p-4 mb-6" style={{ borderColor: "#1C1B19", background: "#FBFAF6" }}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs uppercase tracking-wide" style={{ color: "#6B6555" }}>Confirm before saving</p>
            <button onClick={reset} className="text-xs flex items-center gap-1" style={{ color: "#8A8272" }}><RotateCcw size={12} /> Start over</button>
          </div>
          {photoPreview && <img src={photoPreview} alt="captured" className="w-20 h-20 object-cover rounded-sm border mb-3" style={{ borderColor: "#D8D2C2" }} />}
          {voiceTranscript && <p className="text-xs italic mb-3 px-2.5 py-2 rounded-sm" style={{ background: "#EFEAE0", color: "#6B6555" }}>"{voiceTranscript}"</p>}
          {error && <p className="text-xs mb-3" style={{ color: "#A8452F" }}>{error}</p>}

          <button
            onClick={recording ? stopVoice : startVoice}
            className="mb-3 text-xs font-medium px-3 py-2 rounded-sm text-white hover:opacity-90 flex items-center gap-1.5"
            style={{ background: recording ? "#A8452F" : "#3A5A5E" }}
          >
            {recording ? <Square size={12} /> : <Mic size={12} />} {recording ? "Stop & add to this phone" : "Add a voice note (cost, price, notes…)"}
          </button>
          {voiceStatus === "listening" && <p className="text-xs mb-3 animate-pulse" style={{ color: "#A8452F" }}>Listening…</p>}
          {voiceStatus === "thinking" && <p className="text-xs mb-3 flex items-center gap-1.5" style={{ color: "#6B6555" }}><Loader2 size={12} className="animate-spin" /> Adding that in…</p>}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            <input placeholder="Model" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} className="border px-2.5 py-2 text-sm rounded-sm col-span-2 md:col-span-1" style={{ borderColor: "#D8D2C2" }} />
            <input placeholder="Storage" value={draft.storage} onChange={(e) => setDraft({ ...draft, storage: e.target.value })} className="border px-2.5 py-2 text-sm rounded-sm" style={{ borderColor: "#D8D2C2" }} />
            <input placeholder="Color" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} className="border px-2.5 py-2 text-sm rounded-sm" style={{ borderColor: "#D8D2C2" }} />
            <input placeholder="IMEI" value={draft.imei_full} onChange={(e) => setDraft({ ...draft, imei_full: e.target.value })} className="border px-2.5 py-2 text-sm rounded-sm" style={{ borderColor: "#D8D2C2" }} />
            <input placeholder="Bought from" value={draft.bought_from} onChange={(e) => setDraft({ ...draft, bought_from: e.target.value })} className="border px-2.5 py-2 text-sm rounded-sm col-span-2" style={{ borderColor: "#D8D2C2" }} />
            <input placeholder="Cost price" type="number" value={draft.cost_price} onChange={(e) => setDraft({ ...draft, cost_price: e.target.value })} className="border px-2.5 py-2 text-sm rounded-sm" style={{ borderColor: "#D8D2C2" }} />
            <input placeholder="Selling price" type="number" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} className="border px-2.5 py-2 text-sm rounded-sm" style={{ borderColor: "#D8D2C2" }} />
            <input placeholder="Warranty (months)" type="number" value={draft.warranty_months} onChange={(e) => setDraft({ ...draft, warranty_months: e.target.value })} className="border px-2.5 py-2 text-sm rounded-sm col-span-2 md:col-span-1" style={{ borderColor: "#D8D2C2" }} />
          </div>

          <p className="text-xs uppercase tracking-wide mt-4 mb-2" style={{ color: "#6B6555" }}>Expenses for this phone (optional)</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5">
            {EXPENSE_CATEGORIES.map((cat) => (
              <div key={cat.key} className="flex items-center gap-2">
                <label className="text-xs w-24 flex-shrink-0" style={{ color: "#6B6555" }}>{cat.label}</label>
                <input
                  type="number"
                  placeholder="R0"
                  value={draft.expenses[cat.key] || ""}
                  onChange={(e) => setDraft({ ...draft, expenses: { ...draft.expenses, [cat.key]: e.target.value } })}
                  className="border px-2 py-1.5 text-sm rounded-sm flex-1 w-full"
                  style={{ borderColor: "#D8D2C2" }}
                />
              </div>
            ))}
          </div>
          <button onClick={saveDraft} disabled={saving} className="mt-3 text-white text-sm font-medium px-4 py-2 rounded-sm hover:opacity-90 flex items-center gap-2 disabled:opacity-50" style={{ background: "#3A5A5E" }}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {saving ? "Saving…" : "Confirm & save to ledger"}
          </button>
        </div>
      )}

      <div className="flex gap-1.5 mb-3 flex-wrap">
        <button onClick={() => setFilter("all")} className="text-xs px-3 py-1.5 rounded-sm border font-medium" style={{ borderColor: filter === "all" ? "#1C1B19" : "#D8D2C2", background: filter === "all" ? "#1C1B19" : "transparent", color: filter === "all" ? "#fff" : "#1C1B19" }}>
          All ({items.length})
        </button>
        {STATUSES.map((s) => (
          <button key={s.key} onClick={() => setFilter(s.key)} className="text-xs px-3 py-1.5 rounded-sm border font-medium" style={{ borderColor: filter === s.key ? "#1C1B19" : "#D8D2C2", background: filter === s.key ? "#1C1B19" : "transparent", color: filter === s.key ? "#fff" : "#1C1B19" }}>
            {s.label} ({items.filter((i) => i.status === s.key).length})
          </button>
        ))}
      </div>

      <div className="border-t" style={{ borderColor: "#D8D2C2" }}>
        {loading && <p className="text-sm py-8 text-center" style={{ color: "#6B6555" }}>Loading your stock…</p>}
        {!loading && visible.length === 0 && <p className="text-sm py-8 text-center" style={{ color: "#6B6555" }}>Nothing here yet — add your first phone above.</p>}
        {visible.map((item) => {
          const st = STATUSES.find((s) => s.key === item.status) || STATUSES[0];
          return (
            <div key={item.id} className="border-b py-3 flex flex-wrap items-center gap-3 md:gap-4" style={{ borderColor: "#D8D2C2" }}>
              <div className="min-w-[140px] flex-1">
                <div className="font-semibold text-sm">{item.model} <span className="font-normal" style={{ color: "#6B6555" }}>{item.storage} · {item.color}</span></div>
                <div className="text-xs mt-0.5" style={{ color: "#8A8272" }}>
                  IMEI ···{item.imei_last4 || "—"} · from {item.bought_from || "—"}
                  {expensesTotal(item) > 0 && <> · expenses R{expensesTotal(item).toLocaleString()}</>}
                </div>
              </div>
              <div style={{ fontFamily: "'Roboto Slab', serif" }} className="text-sm font-bold w-20 text-right">R{Number(item.price || 0).toLocaleString()}</div>
              <select value={item.status} onChange={(e) => setStatus(item.id, e.target.value)} className="text-xs px-2.5 py-1.5 rounded-sm border-none font-medium cursor-pointer" style={{ background: st.bg, color: st.dot }}>
                {STATUSES.map((s) => (<option key={s.key} value={s.key}>{s.label}</option>))}
              </select>
              {item.status === "sold_unpaid" && (
                <button
                  onClick={() => setStatus(item.id, "sold_paid")}
                  className="text-xs px-2.5 py-1.5 rounded-sm font-medium text-white hover:opacity-90 flex items-center gap-1"
                  style={{ background: "#3A5A5E" }}
                >
                  <Check size={12} /> Mark Paid
                </button>
              )}
              <button onClick={() => removeItem(item.id)} className="p-1.5 hover:opacity-60" style={{ color: "#8A8272" }}><X size={15} /></button>
            </div>
          );
        })}
      </div>

      <p className="text-xs mt-6 pt-4 border-t" style={{ color: "#8A8272", borderColor: "#D8D2C2" }}>
        This is now reading and writing to the real CertiFone Supabase database — anything added here persists and will still be here next time you open it.
      </p>
    </div>
  );
}
