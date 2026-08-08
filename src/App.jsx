import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabaseClient";

// ---------- Design tokens ----------
const COLORS = {
  bg: "#0B1220",
  bgElevated: "#131C2E",
  card: "#1B2740",
  cardBorder: "#2A3B5C",
  gold: "#E8B84B",
  goldDim: "#8A6E2F",
  crimson: "#D64545",
  text: "#EDEFF5",
  textDim: "#8E97AC",
  slotEmpty: "#182238",
};

const PAGE_SIZE_OPTIONS = [
  { label: "3×3", rows: 3, cols: 3 },
  { label: "4×3", rows: 4, cols: 3 },
  { label: "4×4", rows: 4, cols: 4 },
];

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function emptyPage(rows, cols) {
  return {
    id: uid(),
    rows,
    cols,
    slots: Array.from({ length: rows * cols }, () => null),
  };
}

function emptyBinder(name) {
  return {
    id: uid(),
    name: name || "Mein Binder",
    pages: [emptyPage(3, 3)],
  };
}

// ---- Sets- und Namens-Cache bleiben lokal auf dem Gerät (kein Nutzerbezug nötig) ----
const localCache = {
  get(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? { value: raw } : null;
    } catch (e) {
      return null;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  },
};

// Compress an uploaded image to keep storage small
function fileToCompressedDataUrl(file, maxDim = 480, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---- Set list cache (for the "Set" filter) ----
async function fetchAllSets() {
  const resp = await fetch("https://api.pokemontcg.io/v2/sets?orderBy=-releaseDate");
  if (!resp.ok) throw new Error("Sets konnten nicht geladen werden");
  const data = await resp.json();
  return (data.data || []).map((s) => ({ id: s.id, name: s.name, series: s.series }));
}

// ---- German <-> English Pokémon name map (built once from PokeAPI, then cached) ----
async function buildGermanNameMap(onProgress) {
  const listResp = await fetch("https://pokeapi.co/api/v2/pokemon-species?limit=1025");
  if (!listResp.ok) throw new Error("Artenliste konnte nicht geladen werden");
  const listData = await listResp.json();
  const species = listData.results || [];
  const map = {}; // germanName (lowercase) -> { en: englishName, dex: number }
  const concurrency = 25;
  let completed = 0;

  for (let i = 0; i < species.length; i += concurrency) {
    const batch = species.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (s) => {
        try {
          const r = await fetch(s.url);
          const d = await r.json();
          const deName = (d.names || []).find((n) => n.language.name === "de");
          const enName = (d.names || []).find((n) => n.language.name === "en");
          if (deName) {
            map[deName.name.toLowerCase()] = {
              en: enName ? enName.name : s.name,
              dex: d.id,
            };
          }
        } catch (e) {
          // skip failed entries, non-fatal
        } finally {
          completed += 1;
          if (onProgress) onProgress(completed, species.length);
        }
      })
    );
  }
  return map;
}

// Migrate legacy save format (flat array of pages, no binders) into binder format
function normalizeLoadedData(parsed) {
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const looksLikeBinders = parsed[0] && Array.isArray(parsed[0].pages);
  if (looksLikeBinders) return parsed;
  const looksLikePages = parsed[0] && Array.isArray(parsed[0].slots);
  if (looksLikePages) {
    return [{ id: uid(), name: "Mein Binder", pages: parsed }];
  }
  return null;
}

export default function App() {
  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authMode, setAuthMode] = useState("login"); // login | signup
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  const [binders, setBinders] = useState([emptyBinder("Mein Binder")]);
  const [binderIndex, setBinderIndex] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState(null); // {slotIdx} for swap-mode, within current page
  const [modal, setModal] = useState(null); // {slotIdx} target slot for add flow
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [sheet, setSheet] = useState(null); // "newpage" | "binders" | "renameBinder" | "newBinder"
  const [renameValue, setRenameValue] = useState("");
  const fileInputRef = useRef(null);

  // ---- Advanced search state ----
  const [searchMode, setSearchMode] = useState("simple"); // simple | advanced
  const [advName, setAdvName] = useState("");
  const [advSet, setAdvSet] = useState("");
  const [advArtist, setAdvArtist] = useState("");
  const [advNumber, setAdvNumber] = useState("");
  const [setsList, setSetsList] = useState(null); // null=not loaded, [] loading state via setsLoading
  const [setsLoading, setSetsLoading] = useState(false);
  const [germanMap, setGermanMap] = useState(null); // null | map object
  const [germanMapLoading, setGermanMapLoading] = useState(false);
  const [germanMapProgress, setGermanMapProgress] = useState(null); // {done, total}

  // ---- Auth: watch Supabase session ----
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthChecked(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  async function handleAuthSubmit() {
    setAuthError("");
    if (!authEmail.trim() || !authPassword.trim()) {
      setAuthError("Bitte E-Mail und Passwort eingeben.");
      return;
    }
    setAuthBusy(true);
    try {
      if (authMode === "signup") {
        const { error } = await supabase.auth.signUp({
          email: authEmail.trim(),
          password: authPassword,
        });
        if (error) throw error;
        setAuthError("Konto erstellt. Falls E-Mail-Bestätigung aktiv ist, prüfe dein Postfach, dann einloggen.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: authEmail.trim(),
          password: authPassword,
        });
        if (error) throw error;
      }
    } catch (e) {
      setAuthError(e.message || "Etwas ist schiefgelaufen.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setBinders([emptyBinder("Mein Binder")]);
    setLoaded(false);
  }

  // ---- Load binders from Supabase once logged in ----
  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const { data, error } = await supabase
          .from("user_binders")
          .select("data")
          .eq("user_id", session.user.id)
          .maybeSingle();
        if (error) throw error;
        if (data && data.data) {
          const normalized = normalizeLoadedData(data.data);
          if (normalized) setBinders(normalized);
        } else {
          // first login: create the row with a default binder
          const initial = [emptyBinder("Mein Binder")];
          setBinders(initial);
          await supabase.from("user_binders").insert({
            user_id: session.user.id,
            data: initial,
          });
        }
      } catch (e) {
        console.error("Laden fehlgeschlagen", e);
      } finally {
        setLoaded(true);
      }
    })();
  }, [session]);

  // ---- Persist to Supabase on change (debounced) ----
  useEffect(() => {
    if (!loaded || !session) return;
    setSaving(true);
    const t = setTimeout(async () => {
      try {
        await supabase
          .from("user_binders")
          .update({ data: binders, updated_at: new Date().toISOString() })
          .eq("user_id", session.user.id);
      } catch (e) {
        console.error("Speichern fehlgeschlagen", e);
      } finally {
        setSaving(false);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [binders, loaded, session]);

  // ---- Load cached sets / German name map (if previously built) ----
  useEffect(() => {
    (async () => {
      try {
        const res = localCache.get("tcg-sets-cache");
        if (res && res.value) setSetsList(JSON.parse(res.value));
      } catch (e) {
        /* not cached yet */
      }
      try {
        const res = localCache.get("german-name-map");
        if (res && res.value) setGermanMap(JSON.parse(res.value));
      } catch (e) {
        /* not cached yet */
      }
    })();
  }, []);

  async function ensureSetsLoaded() {
    if (setsList || setsLoading) return;
    setSetsLoading(true);
    try {
      const sets = await fetchAllSets();
      setSetsList(sets);
      localCache.set("tcg-sets-cache", JSON.stringify(sets));
    } catch (e) {
      // silently ignore - set filter just stays a free-text field
    } finally {
      setSetsLoading(false);
    }
  }

  async function loadGermanMap() {
    if (germanMap || germanMapLoading) return;
    setGermanMapLoading(true);
    setGermanMapProgress({ done: 0, total: 1025 });
    try {
      const map = await buildGermanNameMap((done, total) =>
        setGermanMapProgress({ done, total })
      );
      setGermanMap(map);
      localCache.set("german-name-map", JSON.stringify(map));
    } catch (e) {
      setSearchError("Deutsche Namen konnten nicht geladen werden.");
    } finally {
      setGermanMapLoading(false);
    }
  }

  const currentBinder = binders[binderIndex];
  const currentPage = currentBinder.pages[pageIndex];

  const updateSlot = useCallback(
    (sIdx, value) => {
      setBinders((prev) => {
        const next = prev.map((b) => ({ ...b, pages: b.pages.map((p) => ({ ...p, slots: [...p.slots] })) }));
        next[binderIndex].pages[pageIndex].slots[sIdx] = value;
        return next;
      });
    },
    [binderIndex, pageIndex]
  );

  function handleSlotTap(sIdx) {
    const slotVal = currentPage.slots[sIdx];

    if (selected) {
      if (selected.slotIdx === sIdx) {
        setSelected(null);
        return;
      }
      setBinders((prev) => {
        const next = prev.map((b) => ({ ...b, pages: b.pages.map((p) => ({ ...p, slots: [...p.slots] })) }));
        const slots = next[binderIndex].pages[pageIndex].slots;
        const a = slots[selected.slotIdx];
        const b = slots[sIdx];
        slots[selected.slotIdx] = b;
        slots[sIdx] = a;
        return next;
      });
      setSelected(null);
      return;
    }

    if (slotVal) {
      setSelected({ slotIdx: sIdx });
    } else {
      setModal({ slotIdx: sIdx });
      setSearchQuery("");
      setAdvName("");
      setAdvSet("");
      setAdvArtist("");
      setAdvNumber("");
      setSearchResults([]);
      setSearchError("");
      ensureSetsLoaded();
    }
  }

  function clearSelectedSlot() {
    if (!selected) return;
    updateSlot(selected.slotIdx, null);
    setSelected(null);
  }

  async function runSearch(q) {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError("");
    try {
      const url = `https://api.pokemontcg.io/v2/cards?q=name:${encodeURIComponent(
        q.trim()
      )}*&pageSize=20&orderBy=-set.releaseDate`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("API antwortet nicht");
      const data = await resp.json();
      setSearchResults(data.data || []);
      if (!data.data || data.data.length === 0) {
        setSearchError("Keine Karten gefunden.");
      }
    } catch (e) {
      setSearchError("Suche fehlgeschlagen. Prüfe deine Verbindung.");
    } finally {
      setSearching(false);
    }
  }

  async function runAdvancedSearch() {
    const clauses = [];

    if (advName.trim()) {
      let englishName = advName.trim();
      const lower = englishName.toLowerCase();
      if (germanMap && germanMap[lower]) {
        englishName = germanMap[lower].en; // resolved German -> English
      }
      clauses.push(`name:"${englishName}*"`);
    }
    if (advSet.trim()) {
      clauses.push(`set.name:"${advSet.trim()}"`);
    }
    if (advArtist.trim()) {
      clauses.push(`artist:"${advArtist.trim()}*"`);
    }
    if (advNumber.trim()) {
      clauses.push(`number:${advNumber.trim()}`);
    }

    if (clauses.length === 0) {
      setSearchError("Bitte mindestens ein Feld ausfüllen.");
      return;
    }

    setSearching(true);
    setSearchError("");
    try {
      const q = clauses.join(" AND ");
      const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(
        q
      )}&pageSize=30&orderBy=-set.releaseDate`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("API antwortet nicht");
      const data = await resp.json();
      setSearchResults(data.data || []);
      if (!data.data || data.data.length === 0) {
        setSearchError("Keine Karten gefunden.");
      }
    } catch (e) {
      setSearchError("Suche fehlgeschlagen. Prüfe deine Verbindung.");
    } finally {
      setSearching(false);
    }
  }

  function pickCard(card) {
    if (!modal) return;
    updateSlot(modal.slotIdx, {
      type: "card",
      id: card.id,
      name: card.name,
      image: card.images?.small || card.images?.large,
      set: card.set?.name,
      number: card.number,
    });
    setModal(null);
  }

  async function handleFileUpload(e) {
    const file = e.target.files?.[0];
    if (!file || !modal) return;
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      updateSlot(modal.slotIdx, {
        type: "custom",
        image: dataUrl,
        name: file.name.replace(/\.[^.]+$/, ""),
      });
      setModal(null);
    } catch (e) {
      setSearchError("Bild konnte nicht geladen werden.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function addPage(rows, cols) {
    setBinders((prev) => {
      const next = prev.map((b) => ({ ...b, pages: [...b.pages] }));
      next[binderIndex].pages.push(emptyPage(rows, cols));
      return next;
    });
    setPageIndex(currentBinder.pages.length);
    setSheet(null);
  }

  function removeCurrentPage() {
    if (currentBinder.pages.length <= 1) return;
    setBinders((prev) => {
      const next = prev.map((b) => ({ ...b, pages: [...b.pages] }));
      next[binderIndex].pages = next[binderIndex].pages.filter((_, i) => i !== pageIndex);
      return next;
    });
    setPageIndex((i) => Math.max(0, i - 1));
    setSelected(null);
  }

  function addBinder(name) {
    setBinders((prev) => [...prev, emptyBinder(name || `Binder ${prev.length + 1}`)]);
    setBinderIndex(binders.length);
    setPageIndex(0);
    setSelected(null);
    setSheet(null);
  }

  function switchBinder(idx) {
    setBinderIndex(idx);
    setPageIndex(0);
    setSelected(null);
    setSheet(null);
  }

  function removeBinder(idx) {
    if (binders.length <= 1) return;
    setBinders((prev) => prev.filter((_, i) => i !== idx));
    setBinderIndex((i) => (idx <= i ? Math.max(0, i - 1) : i));
    setPageIndex(0);
    setSelected(null);
  }

  function saveRename() {
    if (!renameValue.trim()) {
      setSheet(null);
      return;
    }
    setBinders((prev) => {
      const next = [...prev];
      next[binderIndex] = { ...next[binderIndex], name: renameValue.trim() };
      return next;
    });
    setSheet(null);
  }

  if (!authChecked) {
    return <CenterMessage>Prüfe Login …</CenterMessage>;
  }

  if (!session) {
    return (
      <AuthScreen
        mode={authMode}
        setMode={setAuthMode}
        email={authEmail}
        setEmail={setAuthEmail}
        password={authPassword}
        setPassword={setAuthPassword}
        error={authError}
        busy={authBusy}
        onSubmit={handleAuthSubmit}
      />
    );
  }

  if (!loaded) {
    return <CenterMessage>Lade deine Binder …</CenterMessage>;
  }

  return (
    <div
      style={{
        background: COLORS.bg,
        minHeight: "100vh",
        color: COLORS.text,
        fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
        display: "flex",
        flexDirection: "column",
        maxWidth: 480,
        margin: "0 auto",
        position: "relative",
      }}
    >
      {/* Header */}
      <header
        style={{
          padding: "18px 16px 10px",
          borderBottom: `1px solid ${COLORS.cardBorder}`,
          background: COLORS.bgElevated,
          position: "sticky",
          top: 0,
          zIndex: 5,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontWeight: 800, fontSize: 22, letterSpacing: "-0.02em" }}>
            Karten<span style={{ color: COLORS.gold }}>Bindr</span>
          </span>
          <span style={{ fontSize: 11, color: COLORS.textDim, marginLeft: "auto" }}>
            {saving ? "speichert …" : "gespeichert"}
          </span>
          <button
            onClick={handleLogout}
            style={{
              background: "none",
              border: "none",
              color: COLORS.textDim,
              fontSize: 11,
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            abmelden
          </button>
        </div>

        {/* Binder switcher */}
        <button
          onClick={() => setSheet("binders")}
          style={{
            marginTop: 12,
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 12px",
            borderRadius: 8,
            border: `1px solid ${COLORS.cardBorder}`,
            background: COLORS.card,
            color: COLORS.text,
            cursor: "pointer",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>📁 {currentBinder.name}</span>
          <span style={{ fontSize: 12, color: COLORS.textDim }}>
            {binders.length} Binder ▾
          </span>
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
          <button
            onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
            disabled={pageIndex === 0}
            style={navBtnStyle(pageIndex === 0)}
          >
            ‹
          </button>
          <div style={{ flex: 1, textAlign: "center", fontSize: 13, color: COLORS.textDim }}>
            Seite {pageIndex + 1} / {currentBinder.pages.length}{" "}
            <span style={{ color: COLORS.textDim }}>
              ({currentPage.rows}×{currentPage.cols})
            </span>
          </div>
          <button
            onClick={() =>
              setPageIndex((i) => Math.min(currentBinder.pages.
