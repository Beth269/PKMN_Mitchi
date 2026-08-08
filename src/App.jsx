import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabaseClient";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
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
  markGreen: "#3FAE5C",
  markGrey: "#4A5670",
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
    cover: null, // { type: 'card'|'custom', image, name }
    pages: [emptyPage(3, 3)],
  };
}
// ---- Local (device-only) cache: sets list, name map, last search, last position ----
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
async function fetchAllSets() {
  const resp = await fetch("https://api.pokemontcg.io/v2/sets?orderBy=-releaseDate");
  if (!resp.ok) throw new Error("Sets konnten nicht geladen werden");
  const data = await resp.json();
  return (data.data || []).map((s) => ({ id: s.id, name: s.name, series: s.series }));
}
async function buildGermanNameMap(onProgress) {
  const listResp = await fetch("https://pokeapi.co/api/v2/pokemon-species?limit=1025");
  if (!listResp.ok) throw new Error("Artenliste konnte nicht geladen werden");
  const listData = await listResp.json();
  const species = listData.results || [];
  const map = {};
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
            map[deName.name.toLowerCase()] = { en: enName ? enName.name : s.name, dex: d.id };
          }
        } catch (e) {
          /* skip */
        } finally {
          completed += 1;
          if (onProgress) onProgress(completed, species.length);
        }
      })
    );
  }
  return map;
}
// Ensure loaded data has all current fields (migrations)
function normalizeLoadedData(parsed) {
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const looksLikeBinders = parsed[0] && Array.isArray(parsed[0].pages);
  let binders;
  if (looksLikeBinders) {
    binders = parsed;
  } else if (parsed[0] && Array.isArray(parsed[0].slots)) {
    binders = [{ id: uid(), name: "Mein Binder", pages: parsed }];
  } else {
    return null;
  }
  return binders.map((b) => ({
    id: b.id || uid(),
    name: b.name || "Mein Binder",
    cover: b.cover || null,
    pages: (b.pages || []).map((p) => ({
      id: p.id || uid(),
      rows: p.rows,
      cols: p.cols,
      slots: (p.slots || []).map((s) =>
        s && s.type
          ? { marked: false, spanNext: false, ...s }
          : s || null
      ),
    })),
  }));
}
function colsOf(page) {
  return page.cols;
}
// ================= Page grid subcomponent =================
function PageGrid({
  page,
  pageIdxGlobal,
  selected,
  mergeMode,
  mergeAnchor,
  onSlotTap,
  onSlotLongPress,
  onToggleMark,
  forExport,
  gridRef,
}) {
  const longPressTimer = useRef(null);
  const longPressFired = useRef(false);
function startPress(sIdx) {
    if (forExport) return;
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      onSlotLongPress(pageIdxGlobal, sIdx);
    }, 480);
  }
  function cancelPress() {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  }
  function handleClick(sIdx) {
    if (forExport) return;
    if (longPressFired.current) {
      longPressFired.current = false;
      return;
    }
    onSlotTap(pageIdxGlobal, sIdx);
  }
const cols = colsOf(page);
return (
    <div
      ref={gridRef}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gap: 8,
        background: forExport ? COLORS.bg : "transparent",
        padding: forExport ? 10 : 0,
        width: forExport ? 340 : "100%",
      }}
    >
      {page.slots.map((slot, sIdx) => {
        if (slot && slot.placeholder) return null; // swallowed by a merged neighbor
        const isSelected =
          !forExport && selected && selected.pageIdxGlobal === pageIdxGlobal && selected.slotIdx === sIdx;
        const isMergeAnchor =
          !forExport && mergeAnchor && mergeAnchor.pageIdxGlobal === pageIdxGlobal && mergeAnchor.slotIdx === sIdx;
        const span = slot && slot.spanNext ? 2 : 1;
return (
          <button
            key={sIdx}
            onPointerDown={() => startPress(sIdx)}
            onPointerUp={cancelPress}
            onPointerLeave={cancelPress}
            onPointerCancel={cancelPress}
            onClick={() => handleClick(sIdx)}
            style={{
              gridColumn: span === 2 ? "span 2" : "span 1",
              aspectRatio: span === 2 ? "5 / 3.5" : "2.5 / 3.5",
              borderRadius: 8,
              border: isSelected
                ? `2px solid ${COLORS.gold}`
                : isMergeAnchor
                ? `2px solid ${COLORS.markGreen}`
                : `1px solid ${COLORS.cardBorder}`,
              background: slot ? COLORS.card : COLORS.slotEmpty,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              overflow: "hidden",
              cursor: forExport ? "default" : "pointer",
              boxShadow: isSelected ? `0 0 0 3px rgba(232,184,75,0.25)` : "none",
              position: "relative",
            }}
          >
            {slot ? (
              <>
                <img
                  src={slot.image}
                  alt={slot.name}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
                {!forExport && (
                  <span
                    role="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleMark(pageIdxGlobal, sIdx);
                    }}
                    style={{
                      position: "absolute",
                      top: 5,
                      right: 5,
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      background: slot.marked ? COLORS.markGreen : "rgba(220,224,232,0.55)",
                      border: "1.5px solid rgba(0,0,0,0.35)",
                    }}
                  />
                )}
              </>
            ) : (
              <span style={{ color: COLORS.textDim, fontSize: 22, fontWeight: 300 }}>+</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
export default function App() {
  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
const [binders, setBinders] = useState([emptyBinder("Mein Binder")]);
  const [binderIndex, setBinderIndex] = useState(0);
  const [pageIndex, setPageIndex] = useState(0); // left page of the current spread (even)
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [positionRestored, setPositionRestored] = useState(false);
const [selected, setSelected] = useState(null); // {pageIdxGlobal, slotIdx}
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeAnchor, setMergeAnchor] = useState(null);
  const [enlarge, setEnlarge] = useState(null); // {image, name}
const [modal, setModal] = useState(null); // {kind:'slot', pageIdxGlobal, slotIdx} | {kind:'cover', binderIdx}
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [selectedResults, setSelectedResults] = useState({}); // id -> card
  const [sheet, setSheet] = useState(null); // "newpage" | "overview" | "renameBinder" | "newBinder"
  const [renameValue, setRenameValue] = useState("");
  const fileInputRef = useRef(null);
const [searchMode, setSearchMode] = useState("simple");
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [advName, setAdvName] = useState("");
  const [advSet, setAdvSet] = useState("");
  const [advArtist, setAdvArtist] = useState("");
  const [advNumber, setAdvNumber] = useState("");
  const [setsList, setSetsList] = useState(null);
  const [setsLoading, setSetsLoading] = useState(false);
  const [germanMap, setGermanMap] = useState(null);
  const [germanMapLoading, setGermanMapLoading] = useState(false);
  const [germanMapProgress, setGermanMapProgress] = useState(null);
const exportRefs = useRef({}); // pageId -> DOM node
  const spreadLeftRef = useRef(null);
  const [exporting, setExporting] = useState(false);
// ---- Auth ----
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthChecked(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_e, sess) => setSession(sess));
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
        const { error } = await supabase.auth.signUp({ email: authEmail.trim(), password: authPassword });
        if (error) throw error;
        setAuthError("Konto erstellt. Falls nötig E-Mail bestätigen, dann einloggen.");
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
    setPositionRestored(false);
  }
// ---- Load binders ----
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
          const initial = [emptyBinder("Mein Binder")];
          setBinders(initial);
          await supabase.from("user_binders").insert({ user_id: session.user.id, data: initial });
        }
      } catch (e) {
        console.error("Laden fehlgeschlagen", e);
      } finally {
        setLoaded(true);
      }
    })();
  }, [session]);
// ---- Restore last position once binders are loaded ----
  useEffect(() => {
    if (!loaded || !session || positionRestored) return;
    try {
      const res = localCache.get("last-position-" + session.user.id);
      if (res && res.value) {
        const pos = JSON.parse(res.value);
        const bIdx = binders.findIndex((b) => b.id === pos.binderId);
        if (bIdx >= 0) {
          setBinderIndex(bIdx);
          const maxPage = Math.max(0, binders[bIdx].pages.length - 1);
          setPageIndex(Math.min(pos.pageIndex || 0, maxPage));
        }
      }
    } catch (e) {
      /* ignore */
    }
    setPositionRestored(true);
  }, [loaded, session, binders, positionRestored]);
// ---- Persist last position on change ----
  useEffect(() => {
    if (!loaded || !session || !positionRestored) return;
    const b = binders[binderIndex];
    if (!b) return;
    localCache.set(
      "last-position-" + session.user.id,
      JSON.stringify({ binderId: b.id, pageIndex })
    );
  }, [binderIndex, pageIndex, loaded, session, positionRestored, binders]);
// ---- Persist to Supabase (debounced) ----
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
// ---- Local caches: sets / german map / last search ----
  useEffect(() => {
    try {
      const res = localCache.get("tcg-sets-cache");
      if (res && res.value) setSetsList(JSON.parse(res.value));
    } catch (e) {}
    try {
      const res = localCache.get("german-name-map");
      if (res && res.value) setGermanMap(JSON.parse(res.value));
    } catch (e) {}
  }, []);
async function ensureSetsLoaded() {
    if (setsList || setsLoading) return;
    setSetsLoading(true);
    try {
      const sets = await fetchAllSets();
      setSetsList(sets);
      localCache.set("tcg-sets-cache", JSON.stringify(sets));
    } catch (e) {
      /* ignore */
    } finally {
      setSetsLoading(false);
    }
  }
async function loadGermanMap() {
    if (germanMap || germanMapLoading) return;
    setGermanMapLoading(true);
    setGermanMapProgress({ done: 0, total: 1025 });
    try {
      const map = await buildGermanNameMap((done, total) => setGermanMapProgress({ done, total }));
      setGermanMap(map);
      localCache.set("german-name-map", JSON.stringify(map));
    } catch (e) {
      setSearchError("Deutsche Namen konnten nicht geladen werden.");
    } finally {
      setGermanMapLoading(false);
    }
  }
const currentBinder = binders[binderIndex];
  const leftPage = currentBinder.pages[pageIndex];
  const rightPage = currentBinder.pages[pageIndex + 1] || null;
// ---- Slot data helpers ----
  const updateSlot = useCallback(
    (pageIdxGlobal, sIdx, value) => {
      setBinders((prev) => {
        const next = prev.map((b) => ({ ...b, pages: b.pages.map((p) => ({ ...p, slots: [...p.slots] })) }));
        next[binderIndex].pages[pageIdxGlobal].slots[sIdx] = value;
        return next;
      });
    },
    [binderIndex]
  );
function handleSlotTap(pageIdxGlobal, sIdx) {
    const page = currentBinder.pages[pageIdxGlobal];
    const slotVal = page.slots[sIdx];
if (mergeMode) {
      handleMergeTap(pageIdxGlobal, sIdx);
      return;
    }
if (selected) {
      if (selected.pageIdxGlobal === pageIdxGlobal && selected.slotIdx === sIdx) {
        setSelected(null);
        return;
      }
      setBinders((prev) => {
        const next = prev.map((b) => ({ ...b, pages: b.pages.map((p) => ({ ...p, slots: [...p.slots] })) }));
        const sa = next[binderIndex].pages[selected.pageIdxGlobal].slots;
        const sb = next[binderIndex].pages[pageIdxGlobal].slots;
        const a = sa[selected.slotIdx];
        const b = sb[sIdx];
        sa[selected.slotIdx] = b;
        sb[sIdx] = a;
        return next;
      });
      setSelected(null);
      return;
    }
if (slotVal) {
      setSelected({ pageIdxGlobal, slotIdx: sIdx });
    } else {
      setModal({ kind: "slot", pageIdxGlobal, slotIdx: sIdx });
      resetSearchState();
      ensureSetsLoaded();
    }
  }
function handleMergeTap(pageIdxGlobal, sIdx) {
    const page = currentBinder.pages[pageIdxGlobal];
    const slot = page.slots[sIdx];
    const cols = colsOf(page);
// tapping the primary of an existing merged pair -> unmerge
    if (slot && slot.spanNext) {
      setBinders((prev) => {
        const next = prev.map((b) => ({ ...b, pages: b.pages.map((p) => ({ ...p, slots: [...p.slots] })) }));
        const slots = next[binderIndex].pages[pageIdxGlobal].slots;
        slots[sIdx] = { ...slots[sIdx], spanNext: false };
        slots[sIdx + 1] = null;
        return next;
      });
      setMergeAnchor(null);
      return;
    }
    if (slot && slot.placeholder) return; // ignore the swallowed half
if (!mergeAnchor) {
      setMergeAnchor({ pageIdxGlobal, slotIdx: sIdx });
      return;
    }
    if (mergeAnchor.pageIdxGlobal !== pageIdxGlobal) {
      setMergeAnchor({ pageIdxGlobal, slotIdx: sIdx });
      return;
    }
    const primary = Math.min(mergeAnchor.slotIdx, sIdx);
    const secondary = Math.max(mergeAnchor.slotIdx, sIdx);
    const validAdjacent = secondary === primary + 1 && primary % cols !== cols - 1;
    if (!validAdjacent) {
      setMergeAnchor({ pageIdxGlobal, slotIdx: sIdx });
      return;
    }
    setBinders((prev) => {
      const next = prev.map((b) => ({ ...b, pages: b.pages.map((p) => ({ ...p, slots: [...p.slots] })) }));
      const slots = next[binderIndex].pages[pageIdxGlobal].slots;
      const primaryCard = slots[primary] || slots[secondary];
      slots[primary] = primaryCard ? { ...primaryCard, spanNext: true } : null;
      slots[secondary] = { placeholder: true };
      return next;
    });
    setMergeAnchor(null);
  }
function handleSlotLongPress(pageIdxGlobal, sIdx) {
    const slot = currentBinder.pages[pageIdxGlobal].slots[sIdx];
    if (slot && !slot.placeholder) {
      setEnlarge({ image: slot.image, name: slot.name });
    }
  }
function toggleMark(pageIdxGlobal, sIdx) {
    setBinders((prev) => {
      const next = prev.map((b) => ({ ...b, pages: b.pages.map((p) => ({ ...p, slots: [...p.slots] })) }));
      const slot = next[binderIndex].pages[pageIdxGlobal].slots[sIdx];
      if (slot) next[binderIndex].pages[pageIdxGlobal].slots[sIdx] = { ...slot, marked: !slot.marked };
      return next;
    });
  }
function clearSelectedSlot() {
    if (!selected) return;
    updateSlot(selected.pageIdxGlobal, selected.slotIdx, null);
    setSelected(null);
  }
function resetSearchState() {
    setSearchQuery("");
    setAdvName("");
    setAdvSet("");
    setAdvArtist("");
    setAdvNumber("");
    setSearchResults([]);
    setSearchError("");
    setSelectedResults({});
    setFiltersExpanded(false);
    try {
      const res = localCache.get("last-search");
      if (res && res.value) {
        const s = JSON.parse(res.value);
        setSearchMode(s.mode || "simple");
        setSearchQuery(s.query || "");
        setAdvName(s.advName || "");
        setAdvSet(s.advSet || "");
        setAdvArtist(s.advArtist || "");
        setAdvNumber(s.advNumber || "");
      }
    } catch (e) {}
  }
function saveLastSearch() {
    localCache.set(
      "last-search",
      JSON.stringify({
        mode: searchMode,
        query: searchQuery,
        advName,
        advSet,
        advArtist,
        advNumber,
      })
    );
  }
async function runSearch(q) {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError("");
    try {
      const url = `https://api.pokemontcg.io/v2/cards?q=name:${encodeURIComponent(
        q.trim()
      )}*&pageSize=30&orderBy=-set.releaseDate`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("API antwortet nicht");
      const data = await resp.json();
      setSearchResults(data.data || []);
      if (!data.data || data.data.length === 0) setSearchError("Keine Karten gefunden.");
      saveLastSearch();
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
      if (germanMap && germanMap[lower]) englishName = germanMap[lower].en;
      clauses.push(`name:"${englishName}*"`);
    }
    if (advSet.trim()) clauses.push(`set.name:"${advSet.trim()}"`);
    if (advArtist.trim()) clauses.push(`artist:"${advArtist.trim()}*"`);
    if (advNumber.trim()) clauses.push(`number:${advNumber.trim()}`);
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
      )}&pageSize=40&orderBy=-set.releaseDate`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("API antwortet nicht");
      const data = await resp.json();
      setSearchResults(data.data || []);
      if (!data.data || data.data.length === 0) setSearchError("Keine Karten gefunden.");
      saveLastSearch();
    } catch (e) {
      setSearchError("Suche fehlgeschlagen. Prüfe deine Verbindung.");
    } finally {
      setSearching(false);
    }
  }
function toggleResultSelected(card) {
    setSelectedResults((prev) => {
      const next = { ...prev };
      if (next[card.id]) delete next[card.id];
      else next[card.id] = card;
      return next;
    });
  }
function cardToSlotData(card) {
    return {
      type: "card",
      id: card.id,
      name: card.name,
      image: card.images?.small || card.images?.large,
      set: card.set?.name,
      number: card.number,
      marked: false,
      spanNext: false,
    };
  }
function applyToTarget(slotDataList) {
    if (!modal) return;
    if (modal.kind === "cover") {
      const first = slotDataList[0];
      if (!first) return;
      setBinders((prev) => {
        const next = [...prev];
        next[modal.binderIdx] = {
          ...next[modal.binderIdx],
          cover: { type: first.type, image: first.image, name: first.name },
        };
        return next;
      });
      setModal(null);
      return;
    }
    // kind === "slot": place cards into consecutive empty (non-placeholder) slots starting at slotIdx
    const page = currentBinder.pages[modal.pageIdxGlobal];
    setBinders((prev) => {
      const next = prev.map((b) => ({ ...b, pages: b.pages.map((p) => ({ ...p, slots: [...p.slots] })) }));
      const slots = next[binderIndex].pages[modal.pageIdxGlobal].slots;
      let cursor = modal.slotIdx;
      let placed = 0;
      while (cursor < slots.length && placed < slotDataList.length) {
        const existing = slots[cursor];
        if (!existing) {
          slots[cursor] = slotDataList[placed];
          placed += 1;
        } else if (existing.placeholder) {
          // skip swallowed cell
        } else if (cursor === modal.slotIdx) {
          // clicked slot occupied (shouldn't normally happen) - overwrite it
          slots[cursor] = slotDataList[placed];
          placed += 1;
        }
        cursor += 1;
      }
      return next;
    });
    setModal(null);
  }
function pickCard(card) {
    applyToTarget([cardToSlotData(card)]);
  }
function addSelectedCards() {
    const list = Object.values(selectedResults).map(cardToSlotData);
    if (list.length === 0) return;
    applyToTarget(list);
  }
async function handleFileUpload(e) {
    const file = e.target.files?.[0];
    if (!file || !modal) return;
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      applyToTarget([{ type: "custom", image: dataUrl, name: file.name.replace(/\.[^.]+$/, ""), marked: false, spanNext: false }]);
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
    setSheet(null);
  }
function removeCurrentSpreadPage(which) {
    const idx = which === "right" ? pageIndex + 1 : pageIndex;
    if (currentBinder.pages.length <= 1) return;
    setBinders((prev) => {
      const next = prev.map((b) => ({ ...b, pages: [...b.pages] }));
      next[binderIndex].pages = next[binderIndex].pages.filter((_, i) => i !== idx);
      return next;
    });
    setPageIndex((i) => (i >= 2 ? i - 2 : 0));
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
function openCoverPicker(bIdx) {
    setModal({ kind: "cover", binderIdx: bIdx });
    resetSearchState();
    ensureSetsLoaded();
  }
// ---- PDF export ----
  async function exportPagePDF() {
    if (!spreadLeftRef.current) return;
    setExporting(true);
    try {
      const canvas = await html2canvas(spreadLeftRef.current, { backgroundColor: COLORS.bg, scale: 2 });
      const imgData = canvas.toDataURL("image/jpeg", 0.92);
      const pdf = new jsPDF({ orientation: "portrait", unit: "px", format: [canvas.width, canvas.height] });
      pdf.addImage(imgData, "JPEG", 0, 0, canvas.width, canvas.height);
      pdf.save(`${currentBinder.name}-Seite-${pageIndex + 1}.pdf`);
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(false);
    }
  }
async function exportBinderPDF() {
    setExporting(true);
    try {
      let pdf = null;
      for (const page of currentBinder.pages) {
        const node = exportRefs.current[page.id];
        if (!node) continue;
        const canvas = await html2canvas(node, { backgroundColor: COLORS.bg, scale: 2 });
        const imgData = canvas.toDataURL("image/jpeg", 0.92);
        if (!pdf) {
          pdf = new jsPDF({ orientation: "portrait", unit: "px", format: [canvas.width, canvas.height] });
        } else {
          pdf.addPage([canvas.width, canvas.height]);
        }
        pdf.addImage(imgData, "JPEG", 0, 0, canvas.width, canvas.height);
      }
      if (pdf) pdf.save(`${currentBinder.name}.pdf`);
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(false);
    }
  }
// ================= Render =================
  if (!authChecked) return <CenterMessage>Prüfe Login …</CenterMessage>;

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
if (!loaded) return <CenterMessage>Lade deine Binder …</CenterMessage>;

return (
    <div
      style={{
        background: COLORS.bg,
        minHeight: "100vh",
        color: COLORS.text,
        fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
        display: "flex",
        flexDirection: "column",
        maxWidth: 560,
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
          <button
            onClick={() => setSheet("overview")}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
          >
            <span style={{ fontWeight: 800, fontSize: 22, letterSpacing: "-0.02em", color: COLORS.text }}>
              PKMN<span style={{ color: COLORS.gold }}>_Michi</span>
            </span>
          </button>
          <span style={{ fontSize: 11, color: COLORS.textDim, marginLeft: "auto" }}>
            {saving ? "speichert …" : "gespeichert"}
          </span>
          <button
            onClick={handleLogout}
            style={{ background: "none", border: "none", color: COLORS.textDim, fontSize: 11, cursor: "pointer", textDecoration: "underline" }}
          >
            abmelden
          </button>
        </div>

<button
          onClick={() => setSheet("overview")}
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
          <span style={{ fontSize: 12, color: COLORS.textDim }}>{binders.length} Binder ▾</span>
        </button>
<div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
          <button onClick={() => setPageIndex((i) => Math.max(0, i - 2))} disabled={pageIndex === 0} style={navBtnStyle(pageIndex === 0)}>
            ‹
          </button>
          <div style={{ flex: 1, textAlign: "center", fontSize: 13, color: COLORS.textDim }}>
            Seite {pageIndex + 1}
            {rightPage ? `–${pageIndex + 2}` : ""} / {currentBinder.pages.length}
          </div>
          <button
            onClick={() => setPageIndex((i) => (i + 2 < currentBinder.pages.length ? i + 2 : i))}
            disabled={pageIndex + 2 >= currentBinder.pages.length}
            style={navBtnStyle(pageIndex + 2 >= currentBinder.pages.length)}
          >
            ›
          </button>
        </div>

<div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button
            onClick={() => {
              setMergeMode((v) => !v);
              setMergeAnchor(null);
              setSelected(null);
            }}
            style={mergeMode ? pillBtnStyle(true) : secondaryBtnStyle}
          >
            {mergeMode ? "Verbinden: An ✓" : "Slots verbinden"}
          </button>
          <button onClick={exportPagePDF} disabled={exporting} style={secondaryBtnStyle}>
            Seite als PDF
          </button>
          <button onClick={exportBinderPDF} disabled={exporting} style={secondaryBtnStyle}>
            Ordner als PDF
          </button>
        </div>
      </header>
{mergeMode && (
        <div style={{ background: COLORS.markGreen, color: "#06210C", padding: "8px 16px", fontSize: 13 }}>
          Tippe zwei nebeneinanderliegende Slots an, um sie zu verbinden. Tippe einen verbundenen Slot erneut an, um ihn zu trennen.
        </div>
      )}
{selected && !mergeMode && (
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
            <button onClick={clearSelectedSlot} style={miniBtnStyle}>Entfernen</button>
            <button onClick={() => setSelected(null)} style={miniBtnStyle}>Abbrechen</button>
          </div>
        </div>
      )}

{/* Spread: two pages side by side */}
      <main style={{ padding: 16, flex: 1 }}>
        <div style={{ display: "flex", gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }} ref={spreadLeftRef}>
            <PageGrid
              page={leftPage}
              pageIdxGlobal={pageIndex}
              selected={selected}
              mergeMode={mergeMode}
              mergeAnchor={mergeAnchor}
              onSlotTap={handleSlotTap}
              onSlotLongPress={handleSlotLongPress}
              onToggleMark={toggleMark}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {rightPage ? (
              <PageGrid
                page={rightPage}
                pageIdxGlobal={pageIndex + 1}
                selected={selected}
                mergeMode={mergeMode}
                mergeAnchor={mergeAnchor}
                onSlotTap={handleSlotTap}
                onSlotLongPress={handleSlotLongPress}
                onToggleMark={toggleMark}
              />
            ) : (
              <button
                onClick={() => setSheet("newpage")}
                style={{
                  width: "100%",
                  height: "100%",
                  minHeight: 200,
                  borderRadius: 8,
                  border: `1px dashed ${COLORS.cardBorder}`,
                  background: "transparent",
                  color: COLORS.textDim,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                + Seite hinzufügen
              </button>
            )}
          </div>
        </div>
<div style={{ marginTop: 20, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={() => setSheet("newpage")} style={secondaryBtnStyle}>+ Neue Seite</button>
          {currentBinder.pages.length > 1 && (
            <button onClick={() => removeCurrentSpreadPage("left")} style={dangerBtnStyle}>
              Linke Seite löschen
            </button>
          )}
          {rightPage && currentBinder.pages.length > 1 && (
            <button onClick={() => removeCurrentSpreadPage("right")} style={dangerBtnStyle}>
              Rechte Seite löschen
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
{/* Hidden off-screen render of ALL pages for whole-binder PDF export */}
      <div style={{ position: "fixed", top: -10000, left: -10000, pointerEvents: "none" }}>
        {currentBinder.pages.map((p) => (
          <div key={p.id} ref={(el) => (exportRefs.current[p.id] = el)} style={{ marginBottom: 20 }}>
            <PageGrid page={p} pageIdxGlobal={0} forExport />
          </div>
        ))}
      </div>
{/* Enlarge overlay */}
      {enlarge && (
        <div
          onClick={() => setEnlarge(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 40,
            padding: 24,
          }}
        >
          <div style={{ position: "relative", maxWidth: 340, width: "100%" }} onClick={(e) => e.stopPropagation()}>
            <img src={enlarge.image} alt={enlarge.name} style={{ width: "100%", borderRadius: 10, display: "block" }} />
            <button
              onClick={() => setEnlarge(null)}
              style={{
                position: "absolute",
                top: -14,
                right: -14,
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: COLORS.gold,
                border: "none",
                color: "#1B1400",
                fontSize: 18,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              ×
            </button>
            {enlarge.name && (
              <p style={{ textAlign: "center", color: COLORS.text, fontSize: 13, marginTop: 10 }}>{enlarge.name}</p>
            )}
          </div>
        </div>
      )}
{/* Binder overview sheet */}
      {sheet === "overview" && (
        <Sheet onClose={() => setSheet(null)} title="Meine Binder">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: 12,
              marginBottom: 16,
            }}
          >
            {binders.map((b, idx) => (
              <div
                key={b.id}
                style={{
                  border: `1px solid ${idx === binderIndex ? COLORS.gold : COLORS.cardBorder}`,
                  borderRadius: 10,
                  overflow: "hidden",
                  background: COLORS.card,
                }}
              >
                <button
                  onClick={() => switchBinder(idx)}
                  style={{
                    width: "100%",
                    aspectRatio: "3 / 4",
                    background: COLORS.slotEmpty,
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {b.cover ? (
                    <img src={b.cover.image} alt={b.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <span style={{ fontSize: 30 }}>📁</span>
                  )}
                </button>
                <div style={{ padding: "8px 10px" }}>
                  <p style={{ fontSize: 13, fontWeight: 700, margin: "0 0 4px", color: COLORS.text }}>{b.name}</p>
                  <p style={{ fontSize: 11, color: COLORS.textDim, margin: "0 0 8px" }}>{b.pages.length} Seiten</p>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button onClick={() => openCoverPicker(idx)} style={miniLinkStyle}>Cover</button>
                    {binders.length > 1 && (
                      <button onClick={() => removeBinder(idx)} style={{ ...miniLinkStyle, color: COLORS.crimson }}>
                        Löschen
                      </button>
                    )}
                  </div>
                </div>
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
{sheet === "newpage" && (
        <Sheet onClose={() => setSheet(null)} title="Neue Seite">
          <p style={{ color: COLORS.textDim, fontSize: 13, marginBottom: 14 }}>Wähle ein Slot-Raster.</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {PAGE_SIZE_OPTIONS.map((opt) => (
              <button key={opt.label} onClick={() => addPage(opt.rows, opt.cols)} style={optionBtnStyle}>
                {opt.label} — {opt.rows * opt.cols} Slots
              </button>
            ))}
          </div>
        </Sheet>
      )}

{/* Add-card / cover modal — bigger sheet */}
      {modal && (
        <Sheet
          onClose={() => setModal(null)}
          title={modal.kind === "cover" ? "Cover auswählen" : "Karte hinzufügen"}
          big
        >
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <button onClick={() => setSearchMode("simple")} style={pillBtnStyle(searchMode === "simple")}>
              Einfach
            </button>
            <button onClick={() => setSearchMode("advanced")} style={pillBtnStyle(searchMode === "advanced")}>
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
              <button onClick={() => runSearch(searchQuery)} style={primaryBtnStyle}>Suchen</button>
            </div>
          ) : (
            <div style={{ marginBottom: 12 }}>
              <button
                onClick={() => setFiltersExpanded((v) => !v)}
                style={{ ...secondaryBtnStyle, width: "100%", marginBottom: filtersExpanded ? 10 : 0, textAlign: "left" }}
              >
                Filter {filtersExpanded ? "▲ einklappen" : "▾ ausklappen"}
              </button>
              {filtersExpanded && (
                <div>
                  <label style={labelStyle}>Pokémon-Name (Deutsch oder Englisch)</label>
                  <input
                    value={advName}
                    onChange={(e) => setAdvName(e.target.value)}
                    placeholder="z. B. Glurak oder Charizard"
                    style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 4 }}
                  />
                  {!germanMap && (
                    <button onClick={loadGermanMap} disabled={germanMapLoading} style={{ ...linkBtnStyle, marginBottom: 8 }}>
                      {germanMapLoading
                        ? `Lade deutsche Namen … ${germanMapProgress?.done ?? 0}/${germanMapProgress?.total ?? 1025}`
                        : "Deutsche Namen aktivieren (einmalig laden)"}
                    </button>
                  )}
                  {germanMap && <p style={{ fontSize: 11, color: COLORS.textDim, margin: "0 0 8px" }}>Deutsche Namen aktiv ✓</p>}
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
                  {setsLoading && <p style={{ fontSize: 11, color: COLORS.textDim, margin: "0 0 8px" }}>Lade Sets …</p>}

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
                </div>
              )}
              <button onClick={runAdvancedSearch} style={{ ...primaryBtnStyle, width: "100%", marginTop: 10 }}>
                Suchen
              </button>
            </div>
          )}
<button onClick={() => fileInputRef.current?.click()} style={{ ...secondaryBtnStyle, width: "100%", marginBottom: 14 }}>
            Eigenes Bild hochladen
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileUpload} style={{ display: "none" }} />
{searching && <p style={{ color: COLORS.textDim, fontSize: 13 }}>Suche läuft …</p>}
          {searchError && <p style={{ color: COLORS.crimson, fontSize: 13 }}>{searchError}</p>}

{searchResults.length > 0 && (
            <>
              {modal.kind === "slot" && Object.keys(selectedResults).length > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 0" }}>
                  <span style={{ fontSize: 12, color: COLORS.textDim }}>
                    {Object.keys(selectedResults).length} ausgewählt
                  </span>
                  <button onClick={addSelectedCards} style={primaryBtnStyle}>
                    {Object.keys(selectedResults).length} Karte(n) hinzufügen
                  </button>
                </div>
              )}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 1fr)",
                  gap: 10,
                  maxHeight: 460,
                  overflowY: "auto",
                  paddingTop: 4,
                }}
              >
                {searchResults.map((c) => {
                  const isChecked = !!selectedResults[c.id];
                  return (
                    <div key={c.id} style={{ position: "relative" }}>
                      <button
                        onClick={() => (modal.kind === "slot" ? toggleResultSelected(c) : pickCard(c))}
                        style={{
                          border: `1px solid ${isChecked ? COLORS.gold : COLORS.cardBorder}`,
                          borderRadius: 6,
                          padding: 0,
                          overflow: "hidden",
                          background: COLORS.card,
                          cursor: "pointer",
                          width: "100%",
                          display: "block",
                        }}
                        title={c.name}
                      >
                        <img src={c.images?.small} alt={c.name} style={{ width: "100%", display: "block" }} />
                      </button>
                      {modal.kind === "slot" && (
                        <span
                          style={{
                            position: "absolute",
                            top: 3,
                            right: 3,
                            width: 16,
                            height: 16,
                            borderRadius: "50%",
                            background: isChecked ? COLORS.gold : "rgba(255,255,255,0.6)",
                            border: "1px solid rgba(0,0,0,0.3)",
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Sheet>
      )}
    </div>
  );
}
function CenterMessage({ children }) {
  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: COLORS.textDim, fontFamily: "system-ui, sans-serif" }}>
      {children}
    </div>
  );
}
function AuthScreen({ mode, setMode, email, setEmail, password, setPassword, error, busy, onSubmit }) {
  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 360 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <span style={{ fontWeight: 800, fontSize: 26, color: COLORS.text }}>
            PKMN<span style={{ color: COLORS.gold }}>_Michi</span>
          </span>
          <p style={{ color: COLORS.textDim, fontSize: 13, marginTop: 6 }}>
            {mode === "signup" ? "Konto erstellen" : "Anmelden"}, um deine Binder überall zu sehen.
          </p>
        </div>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-Mail" style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 10 }} />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onSubmit()} placeholder="Passwort" style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 14 }} />
        {error && <p style={{ color: COLORS.gold, fontSize: 12, marginBottom: 10 }}>{error}</p>}
        <button onClick={onSubmit} disabled={busy} style={{ ...primaryBtnStyle, width: "100%", padding: "12px 16px", fontSize: 14 }}>
          {busy ? "Bitte warten …" : mode === "signup" ? "Konto erstellen" : "Anmelden"}
        </button>
        <button onClick={() => setMode(mode === "signup" ? "login" : "signup")} style={{ ...linkBtnStyle, textAlign: "center", width: "100%", marginTop: 14 }}>
          {mode === "signup" ? "Schon ein Konto? Hier anmelden" : "Noch kein Konto? Hier erstellen"}
        </button>
      </div>
    </div>
  );
}

function Sheet({ title, onClose, children, big }) {
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 20 }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLORS.bgElevated,
          width: "100%",
          maxWidth: 560,
          borderRadius: "16px 16px 0 0",
          padding: 18,
          maxHeight: big ? "94vh" : "80vh",
          overflowY: "auto",
          border: `1px solid ${COLORS.cardBorder}`,
          borderBottom: "none",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.textDim, fontSize: 20, cursor: "pointer", lineHeight: 1 }}>
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
const labelStyle = { display: "block", fontSize: 11, color: COLORS.textDim, marginBottom: 4, marginTop: 2 };
const linkBtnStyle = { display: "block", background: "none", border: "none", color: COLORS.gold, fontSize: 12, cursor: "pointer", padding: 0, textAlign: "left" };
const miniLinkStyle = { background: "none", border: "none", color: COLORS.gold, fontSize: 11, cursor: "pointer", padding: 0 };
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
