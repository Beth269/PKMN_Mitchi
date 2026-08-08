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
              setPageIndex((i) => Math.min(currentBinder.pages.length - 1, i + 1))
            }
            disabled={pageIndex === currentBinder.pages.length - 1}
            style={navBtnStyle(pageIndex === currentBinder.pages.length - 1)}
          >
            ›
          </button>
        </div>
      </header>

      {/* Selected-slot action bar */}
      {selected && (
        <div
          style={{
            background: COLORS.gold,
            color: "#1B1400",
            padding: "8px 16px",
            fontSize: 13,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>Slot ausgewählt — tippe einen anderen Slot zum Tauschen.</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={clearSelectedSlot} style={miniBtnStyle}>
              Entfernen
            </button>
            <button onClick={() => setSelected(null)} style={miniBtnStyle}>
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {/* Binder Grid */}
      <main style={{ padding: 16, flex: 1 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${currentPage.cols}, 1fr)`,
            gap: 8,
          }}
        >
          {currentPage.slots.map((slot, sIdx) => {
            const isSelected = selected && selected.slotIdx === sIdx;
            return (
              <button
                key={sIdx}
                onClick={() => handleSlotTap(sIdx)}
                style={{
                  aspectRatio: "2.5 / 3.5",
                  borderRadius: 8,
                  border: isSelected
                    ? `2px solid ${COLORS.gold}`
                    : `1px solid ${COLORS.cardBorder}`,
                  background: slot ? COLORS.card : COLORS.slotEmpty,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  overflow: "hidden",
                  cursor: "pointer",
                  boxShadow: isSelected ? `0 0 0 3px rgba(232,184,75,0.25)` : "none",
                  transition: "box-shadow 120ms ease",
                }}
              >
                {slot ? (
                  <img
                    src={slot.image}
                    alt={slot.name}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : (
                  <span style={{ color: COLORS.textDim, fontSize: 22, fontWeight: 300 }}>+</span>
                )}
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: 20, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={() => setSheet("newpage")} style={secondaryBtnStyle}>
            + Neue Seite
          </button>
          {currentBinder.pages.length > 1 && (
            <button onClick={removeCurrentPage} style={dangerBtnStyle}>
              Seite löschen
            </button>
          )}
          <button
            onClick={() => {
              setRenameValue(currentBinder.name);
              setSheet("renameBinder");
            }}
            style={secondaryBtnStyle}
          >
            Binder umbenennen
          </button>
        </div>
      </main>

      {/* Binder list sheet */}
      {sheet === "binders" && (
        <Sheet onClose={() => setSheet(null)} title="Meine Binder">
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            {binders.map((b, idx) => (
              <div
                key={b.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  border: `1px solid ${idx === binderIndex ? COLORS.gold : COLORS.cardBorder}`,
                  borderRadius: 8,
                  padding: "10px 12px",
                  background: COLORS.card,
                }}
              >
                <button
                  onClick={() => switchBinder(idx)}
                  style={{
                    flex: 1,
                    background: "none",
                    border: "none",
                    color: COLORS.text,
                    fontSize: 14,
                    textAlign: "left",
                    cursor: "pointer",
                    fontWeight: idx === binderIndex ? 700 : 400,
                  }}
                >
                  📁 {b.name}{" "}
                  <span style={{ color: COLORS.textDim, fontSize: 12 }}>
                    ({b.pages.length} Seiten)
                  </span>
                </button>
                {binders.length > 1 && (
                  <button
                    onClick={() => removeBinder(idx)}
                    style={{
                      background: "none",
                      border: "none",
                      color: COLORS.crimson,
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    Löschen
                  </button>
                )}
              </div>
            ))}
          </div>
          <button
            onClick={() => {
              setRenameValue("");
              setSheet("newBinder");
            }}
            style={{ ...primaryBtnStyle, width: "100%" }}
          >
            + Neuer Binder
          </button>
        </Sheet>
      )}

      {/* New binder sheet */}
      {sheet === "newBinder" && (
        <Sheet onClose={() => setSheet(null)} title="Neuer Binder">
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addBinder(renameValue)}
            placeholder="Name, z. B. Glurak Sammlung"
            style={{ ...inputStyle, width: "100%", marginBottom: 12, boxSizing: "border-box" }}
          />
          <button onClick={() => addBinder(renameValue)} style={{ ...primaryBtnStyle, width: "100%" }}>
            Binder erstellen
          </button>
        </Sheet>
      )}

      {/* Rename binder sheet */}
      {sheet === "renameBinder" && (
        <Sheet onClose={() => setSheet(null)} title="Binder umbenennen">
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveRename()}
            style={{ ...inputStyle, width: "100%", marginBottom: 12, boxSizing: "border-box" }}
          />
          <button onClick={saveRename} style={{ ...primaryBtnStyle, width: "100%" }}>
            Speichern
          </button>
        </Sheet>
      )}

      {/* New page sheet */}
      {sheet === "newpage" && (
        <Sheet onClose={() => setSheet(null)} title="Neue Seite">
          <p style={{ color: COLORS.textDim, fontSize: 13, marginBottom: 14 }}>
            Wähle ein Slot-Raster für die neue Seite.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {PAGE_SIZE_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                onClick={() => addPage(opt.rows, opt.cols)}
                style={optionBtnStyle}
              >
                {opt.label} — {opt.rows * opt.cols} Slots
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {/* Add-to-slot modal */}
      {modal && (
        <Sheet onClose={() => setModal(null)} title="Karte hinzufügen">
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <button
              onClick={() => setSearchMode("simple")}
              style={pillBtnStyle(searchMode === "simple")}
            >
              Einfach
            </button>
            <button
              onClick={() => setSearchMode("advanced")}
              style={pillBtnStyle(searchMode === "advanced")}
            >
              Erweitert
            </button>
          </div>

          {searchMode === "simple" ? (
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runSearch(searchQuery)}
                placeholder="Kartenname, z. B. Pikachu"
                style={inputStyle}
              />
              <button onClick={() => runSearch(searchQuery)} style={primaryBtnStyle}>
                Suchen
              </button>
            </div>
          ) : (
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Pokémon-Name (Deutsch oder Englisch)</label>
              <input
                value={advName}
                onChange={(e) => setAdvName(e.target.value)}
                placeholder="z. B. Glurak oder Charizard"
                style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 4 }}
              />
              {!germanMap && (
                <button
                  onClick={loadGermanMap}
                  disabled={germanMapLoading}
                  style={{ ...linkBtnStyle, marginBottom: 8 }}
                >
                  {germanMapLoading
                    ? `Lade deutsche Namen … ${germanMapProgress?.done ?? 0}/${
                        germanMapProgress?.total ?? 1025
                      }`
                    : "Deutsche Namen aktivieren (einmalig laden)"}
                </button>
              )}
              {germanMap && (
                <p style={{ fontSize: 11, color: COLORS.textDim, margin: "0 0 8px" }}>
                  Deutsche Namen aktiv ✓
                </p>
              )}

              <label style={labelStyle}>Set</label>
              <input
                value={advSet}
                onChange={(e) => setAdvSet(e.target.value)}
                placeholder="z. B. Base Set, Obsidian Flames"
                list="set-options"
                style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 8 }}
              />
              {setsList && (
                <datalist id="set-options">
                  {setsList.map((s) => (
                    <option key={s.id} value={s.name} />
                  ))}
                </datalist>
              )}
              {setsLoading && (
                <p style={{ fontSize: 11, color: COLORS.textDim, margin: "0 0 8px" }}>
                  Lade Sets …
                </p>
              )}

              <label style={labelStyle}>Künstler</label>
              <input
                value={advArtist}
                onChange={(e) => setAdvArtist(e.target.value)}
                placeholder="z. B. Ken Sugimori"
                style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 8 }}
              />

              <label style={labelStyle}>Kartennummer</label>
              <input
                value={advNumber}
                onChange={(e) => setAdvNumber(e.target.value)}
                placeholder="z. B. 58"
                style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 10 }}
              />

              <button onClick={runAdvancedSearch} style={{ ...primaryBtnStyle, width: "100%" }}>
                Suchen
              </button>
            </div>
          )}

          <button
            onClick={() => fileInputRef.current?.click()}
            style={{ ...secondaryBtnStyle, width: "100%", marginBottom: 14 }}
          >
            Eigenes Bild hochladen
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileUpload}
            style={{ display: "none" }}
          />

          {searching && <p style={{ color: COLORS.textDim, fontSize: 13 }}>Suche läuft …</p>}
          {searchError && <p style={{ color: COLORS.crimson, fontSize: 13 }}>{searchError}</p>}

          {searchResults.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 8,
                maxHeight: 320,
                overflowY: "auto",
                paddingTop: 4,
              }}
            >
              {searchResults.map((c) => (
                <button
                  key={c.id}
                  onClick={() => pickCard(c)}
                  style={{
                    border: `1px solid ${COLORS.cardBorder}`,
                    borderRadius: 6,
                    padding: 0,
                    overflow: "hidden",
                    background: COLORS.card,
                    cursor: "pointer",
                  }}
                  title={c.name}
                >
                  <img src={c.images?.small} alt={c.name} style={{ width: "100%", display: "block" }} />
                </button>
              ))}
            </div>
          )}
        </Sheet>
      )}
    </div>
  );
}

function CenterMessage({ children }) {
  return (
    <div
      style={{
        background: COLORS.bg,
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: COLORS.textDim,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      {children}
    </div>
  );
}

function AuthScreen({ mode, setMode, email, setEmail, password, setPassword, error, busy, onSubmit }) {
  return (
    <div
      style={{
        background: COLORS.bg,
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
        padding: 20,
      }}
    >
      <div style={{ width: "100%", maxWidth: 360 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <span style={{ fontWeight: 800, fontSize: 26, color: COLORS.text }}>
            Karten<span style={{ color: COLORS.gold }}>Bindr</span>
          </span>
          <p style={{ color: COLORS.textDim, fontSize: 13, marginTop: 6 }}>
            {mode === "signup" ? "Konto erstellen" : "Anmelden"}, um deine Binder überall zu sehen.
          </p>
        </div>

        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="E-Mail"
          style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 10 }}
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmit()}
          placeholder="Passwort"
          style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 14 }}
        />

        {error && (
          <p style={{ color: COLORS.gold, fontSize: 12, marginBottom: 10 }}>{error}</p>
        )}

        <button
          onClick={onSubmit}
          disabled={busy}
          style={{ ...primaryBtnStyle, width: "100%", padding: "12px 16px", fontSize: 14 }}
        >
          {busy ? "Bitte warten …" : mode === "signup" ? "Konto erstellen" : "Anmelden"}
        </button>

        <button
          onClick={() => setMode(mode === "signup" ? "login" : "signup")}
          style={{ ...linkBtnStyle, textAlign: "center", width: "100%", marginTop: 14 }}
        >
          {mode === "signup"
            ? "Schon ein Konto? Hier anmelden"
            : "Noch kein Konto? Hier erstellen"}
        </button>
      </div>
    </div>
  );
}

function Sheet({ title, onClose, children }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        zIndex: 20,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLORS.bgElevated,
          width: "100%",
          maxWidth: 480,
          borderRadius: "16px 16px 0 0",
          padding: 18,
          maxHeight: "80vh",
          overflowY: "auto",
          border: `1px solid ${COLORS.cardBorder}`,
          borderBottom: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 10,
          }}
        >
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{title}</h2>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: COLORS.textDim,
              fontSize: 20,
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---- shared inline styles ----
const navBtnStyle = (disabled) => ({
  width: 32,
  height: 32,
  borderRadius: 8,
  border: `1px solid ${COLORS.cardBorder}`,
  background: COLORS.card,
  color: disabled ? COLORS.textDim : COLORS.text,
  fontSize: 16,
  cursor: disabled ? "default" : "pointer",
  opacity: disabled ? 0.4 : 1,
});

const secondaryBtnStyle = {
  padding: "10px 14px",
  borderRadius: 8,
  border: `1px solid ${COLORS.cardBorder}`,
  background: COLORS.card,
  color: COLORS.text,
  fontSize: 13,
  cursor: "pointer",
};

const primaryBtnStyle = {
  padding: "10px 16px",
  borderRadius: 8,
  border: "none",
  background: COLORS.gold,
  color: "#1B1400",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const dangerBtnStyle = {
  padding: "10px 14px",
  borderRadius: 8,
  border: `1px solid ${COLORS.crimson}`,
  background: "transparent",
  color: COLORS.crimson,
  fontSize: 13,
  cursor: "pointer",
};

const optionBtnStyle = {
  padding: "14px 16px",
  borderRadius: 10,
  border: `1px solid ${COLORS.cardBorder}`,
  background: COLORS.card,
  color: COLORS.text,
  fontSize: 14,
  textAlign: "left",
  cursor: "pointer",
};

const inputStyle = {
  flex: 1,
  padding: "10px 12px",
  borderRadius: 8,
  border: `1px solid ${COLORS.cardBorder}`,
  background: COLORS.card,
  color: COLORS.text,
  fontSize: 14,
  outline: "none",
};

const labelStyle = {
  display: "block",
  fontSize: 11,
  color: COLORS.textDim,
  marginBottom: 4,
  marginTop: 2,
};

const linkBtnStyle = {
  display: "block",
  background: "none",
  border: "none",
  color: COLORS.gold,
  fontSize: 12,
  cursor: "pointer",
  padding: 0,
  textAlign: "left",
};

const pillBtnStyle = (active) => ({
  padding: "6px 14px",
  borderRadius: 999,
  border: `1px solid ${active ? COLORS.gold : COLORS.cardBorder}`,
  background: active ? COLORS.gold : COLORS.card,
  color: active ? "#1B1400" : COLORS.textDim,
  fontSize: 12,
  fontWeight: active ? 700 : 400,
  cursor: "pointer",
});

const miniBtnStyle = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid rgba(0,0,0,0.3)",
  background: "rgba(0,0,0,0.15)",
  color: "#1B1400",
  fontSize: 12,
  cursor: "pointer",
};
