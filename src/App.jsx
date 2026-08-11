import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabaseClient";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

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
  return { id: uid(), rows, cols, slots: Array.from({ length: rows * cols }, () => null) };
}
function emptyBlankPage() {
  return { id: uid(), blank: true, rows: 0, cols: 0, slots: [] };
}
function emptyBinder(name) {
  return { id: uid(), name: name || "Mein Binder", cover: null, pages: [emptyPage(3, 3)] };
}

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

// Cache remote card images as data-URLs so PDF export (html2canvas) can
// draw them reliably regardless of the source server's CORS headers.
const imageDataCache = new Map();
async function toDataUrlCached(url, attempt = 1) {
  if (!url || url.startsWith("data:")) return url;
  if (imageDataCache.has(url)) return imageDataCache.get(url);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(url, { mode: "cors", signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const blob = await resp.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    imageDataCache.set(url, dataUrl);
    return dataUrl;
  } catch (e) {
    if (attempt < 2) return toDataUrlCached(url, attempt + 1);
    return url; // fall back to original src; may not render in the PDF
  }
}

async function fetchWithRetry(url, retries = 2, delayMs = 700) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return resp;
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// ---- TCGdex (free, open, api.tcgdex.net) card database helpers ----
function tcgdexImg(baseUrl, quality) {
  if (!baseUrl) return null;
  return `${baseUrl}/${quality}.png`;
}

async function fetchAllRarities() {
  const resp = await fetchWithRetry("https://api.tcgdex.net/v2/en/rarities");
  const data = await resp.json();
  return data || [];
}

// Search across English and German card names in one go - TCGdex has
// native per-language card names, so no separate translation step is needed.
async function searchCardsMultiLang(paramsString) {
  const [enResp, deResp] = await Promise.all([
    fetchWithRetry(`https://api.tcgdex.net/v2/en/cards?${paramsString}`).catch(() => null),
    fetchWithRetry(`https://api.tcgdex.net/v2/de/cards?${paramsString}`).catch(() => null),
  ]);
  const enData = enResp ? await enResp.json() : [];
  const deData = deResp ? await deResp.json() : [];
  const seen = new Set();
  const merged = [];
  for (const c of [...(enData || []), ...(deData || [])]) {
    if (!c || !c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    merged.push(c);
  }
  return merged;
}

// Fetch full card details (rarity, set, illustrator, pricing) for a CardBrief result.
async function fetchFullCard(id) {
  const resp = await fetchWithRetry(`https://api.tcgdex.net/v2/en/cards/${id}`);
  return resp.json();
}

function normalizeLoadedData(parsed) {
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const looksLikeBinders = parsed[0] && Array.isArray(parsed[0].pages);
  let binders;
  if (looksLikeBinders) binders = parsed;
  else if (parsed[0] && Array.isArray(parsed[0].slots)) binders = [{ id: uid(), name: "Mein Binder", pages: parsed }];
  else return null;
  return binders.map((b) => ({
    id: b.id || uid(),
    name: b.name || "Mein Binder",
    cover: b.cover || null,
    pages: (b.pages || []).map((p) => ({
      id: p.id || uid(),
      blank: !!p.blank,
      rows: p.rows,
      cols: p.cols,
      slots: (p.slots || []).map((s) => (s && s.type ? { marked: false, spanNext: false, spanDown: false, ...s } : s || null)),
    })),
  }));
}

// TCGdex pricing shape: pricing.tcgplayer.<variant>.marketPrice (USD),
// pricing.cardmarket.avg30 (EUR). See https://tcgdex.dev/markets-prices
function extractPrice(card) {
  const p = card.pricing;
  if (!p) return null;
  if (p.tcgplayer) {
    const variant =
      p.tcgplayer.holofoil || p.tcgplayer.holo || p.tcgplayer.reverse || p.tcgplayer.normal || Object.values(p.tcgplayer).find((v) => v && typeof v === "object");
    if (variant && typeof variant.marketPrice === "number") {
      return { amount: variant.marketPrice, currency: "USD" };
    }
  }
  if (p.cardmarket && typeof p.cardmarket.avg30 === "number") {
    return { amount: p.cardmarket.avg30, currency: "EUR" };
  }
  return null;
}

function formatPrice(price) {
  if (!price) return null;
  const symbol = price.currency === "EUR" ? "€" : "$";
  return `${symbol}${price.amount.toFixed(2)}`;
}

// ================= Page grid subcomponent =================
function PageGrid({ page, pageIdxGlobal, selected, mergeMode, mergeAnchor, onSlotTap, onSlotDoubleTap, onToggleMark, forExport, gridRef, big, highlightSlot }) {
  const lastTapRef = useRef({ sIdx: null, time: 0 });
  const singleTapTimerRef = useRef(null);

  function handleClick(sIdx) {
    if (forExport) return;
    const now = Date.now();
    const last = lastTapRef.current;
    if (last.sIdx === sIdx && now - last.time < 320) {
      if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
      lastTapRef.current = { sIdx: null, time: 0 };
      onSlotDoubleTap(pageIdxGlobal, sIdx);
      return;
    }
    lastTapRef.current = { sIdx, time: now };
    if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
    singleTapTimerRef.current = setTimeout(() => {
      onSlotTap(pageIdxGlobal, sIdx);
    }, 320);
  }

  if (page.blank) {
    return (
      <div
        ref={gridRef}
        style={{
          width: "100%",
          aspectRatio: "2.5 / 3.5",
          background: COLORS.bg,
          borderRadius: 8,
          border: `1px solid ${COLORS.cardBorder}`,
        }}
      />
    );
  }

  const cols = page.cols;
  const cellFont = big ? 30 : 22;
  const gap = big ? 3 : 2;

  return (
    <div
      ref={gridRef}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gap,
        background: forExport ? COLORS.bg : "transparent",
        padding: forExport ? 10 : 0,
        width: forExport ? 340 : "100%",
      }}
    >
      {page.slots.map((slot, sIdx) => {
        if (slot && slot.placeholder) return null;
        const isSelected = !forExport && selected && selected.pageIdxGlobal === pageIdxGlobal && selected.slotIdx === sIdx;
        const isMergeAnchor = !forExport && mergeAnchor && mergeAnchor.pageIdxGlobal === pageIdxGlobal && mergeAnchor.slotIdx === sIdx;
        const isHighlighted = !forExport && highlightSlot && highlightSlot.pageIdxGlobal === pageIdxGlobal && highlightSlot.slotIdx === sIdx;
        const spanCols = slot && slot.spanNext ? 2 : 1;
        const spanRows = slot && slot.spanDown ? 2 : 1;
        const isSpanned = spanCols === 2 || spanRows === 2;
        const markSize = big ? 14 : 10;

        return (
          <button
            key={sIdx}
            onClick={() => handleClick(sIdx)}
            style={{
              gridColumn: spanCols === 2 ? "span 2" : "span 1",
              gridRow: spanRows === 2 ? "span 2" : "span 1",
              aspectRatio: isSpanned ? undefined : "2.5 / 3.5",
              minHeight: isSpanned ? 0 : undefined,
              borderRadius: 8,
              border: isSelected
                ? `2px solid ${COLORS.gold}`
                : isMergeAnchor
                ? `2px solid ${COLORS.markGreen}`
                : isHighlighted
                ? `3px solid ${COLORS.crimson}`
                : `1px solid ${COLORS.cardBorder}`,
              background: slot ? COLORS.card : COLORS.slotEmpty,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              overflow: "hidden",
              cursor: forExport ? "default" : "pointer",
              boxShadow: isSelected
                ? `0 0 0 3px rgba(232,184,75,0.25)`
                : isHighlighted
                ? `0 0 0 4px rgba(214,69,69,0.35)`
                : "none",
              position: "relative",
            }}
          >
            {slot ? (
              <>
                <img src={slot.image} alt={slot.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                {!forExport && (
                  <span
                    role="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleMark(pageIdxGlobal, sIdx);
                    }}
                    style={{
                      position: "absolute",
                      top: 4,
                      right: 4,
                      width: markSize,
                      height: markSize,
                      borderRadius: "50%",
                      background: slot.marked ? COLORS.markGreen : "rgba(220,224,232,0.55)",
                      border: "1px solid rgba(0,0,0,0.35)",
                    }}
                  />
                )}
              </>
            ) : (
              <span style={{ color: COLORS.textDim, fontSize: cellFont, fontWeight: 300 }}>+</span>
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
  const [pageIndex, setPageIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [positionRestored, setPositionRestored] = useState(false);

  const [selected, setSelected] = useState(null);
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeAnchor, setMergeAnchor] = useState(null);
  const mergeAnchorRef = useRef(null);
  function setAnchor(val) {
    mergeAnchorRef.current = val;
    setMergeAnchor(val);
  }
  const [mergeError, setMergeError] = useState("");
  const [selectedError, setSelectedError] = useState("");
  const [enlarge, setEnlarge] = useState(null);
  const [zoomedPageIdx, setZoomedPageIdx] = useState(null); // global page index or null
  const [highlightSlot, setHighlightSlot] = useState(null); // {pageIdxGlobal, slotIdx}
  const [findQuery, setFindQuery] = useState("");
  const [findError, setFindError] = useState("");
  const [dragIdx, setDragIdx] = useState(null);
  const [exportSelection, setExportSelection] = useState([]);
  const dragIdxRef = useRef(null);
  const dragStartYRef = useRef(0);

  const [modal, setModal] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [selectedResults, setSelectedResults] = useState({});
  const [sheet, setSheet] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameTargetIdx, setRenameTargetIdx] = useState(null);
  const fileInputRef = useRef(null);

  const [searchMode, setSearchMode] = useState("simple");
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [advName, setAdvName] = useState("");
  const [advRarity, setAdvRarity] = useState("");
  const [advArtist, setAdvArtist] = useState("");
  const [advNumber, setAdvNumber] = useState("");
  const [raritiesList, setRaritiesList] = useState(null);
  const [raritiesLoading, setRaritiesLoading] = useState(false);

  const exportRefs = useRef({});
  const spreadLeftRef = useRef(null);
  const [exporting, setExporting] = useState(false);

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
        const { error } = await supabase.auth.signInWithPassword({ email: authEmail.trim(), password: authPassword });
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

  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const { data, error } = await supabase.from("user_binders").select("data").eq("user_id", session.user.id).maybeSingle();
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
    } catch (e) {}
    setPositionRestored(true);
  }, [loaded, session, binders, positionRestored]);

  useEffect(() => {
    if (!loaded || !session || !positionRestored) return;
    const b = binders[binderIndex];
    if (!b) return;
    localCache.set("last-position-" + session.user.id, JSON.stringify({ binderId: b.id, pageIndex }));
  }, [binderIndex, pageIndex, loaded, session, positionRestored, binders]);

  useEffect(() => {
    if (!loaded || !session) return;
    setSaving(true);
    const t = setTimeout(async () => {
      try {
        await supabase.from("user_binders").update({ data: binders, updated_at: new Date().toISOString() }).eq("user_id", session.user.id);
      } catch (e) {
        console.error("Speichern fehlgeschlagen", e);
      } finally {
        setSaving(false);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [binders, loaded, session]);

  useEffect(() => {
    try {
      const res = localCache.get("tcg-rarities-cache");
      if (res && res.value) setRaritiesList(JSON.parse(res.value));
    } catch (e) {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ensureRaritiesLoaded() {
    if (raritiesList || raritiesLoading) return;
    setRaritiesLoading(true);
    try {
      const rarities = await fetchAllRarities();
      setRaritiesList(rarities);
      localCache.set("tcg-rarities-cache", JSON.stringify(rarities));
    } catch (e) {
    } finally {
      setRaritiesLoading(false);
    }
  }

  const currentBinder = binders[binderIndex];
  const leftPage = currentBinder.pages[pageIndex];
  const rightPage = currentBinder.pages[pageIndex + 1] || null;

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
        setSelectedError("");
        return;
      }
      const selectedSlot = currentBinder.pages[selected.pageIdxGlobal].slots[selected.slotIdx];
      if (selectedSlot && (selectedSlot.spanNext || selectedSlot.spanDown)) {
        setSelectedError("Lösche das Bild erst wenn der Slot entkoppelt ist.");
        return;
      }
      if (slotVal && (slotVal.spanNext || slotVal.spanDown)) {
        setSelectedError("Lösche das Bild erst wenn der Slot entkoppelt ist.");
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
      setSelectedError("");
      return;
    }

    if (slotVal) {
      setSelected({ pageIdxGlobal, slotIdx: sIdx });
      setSelectedError("");
    } else {
      setModal({ kind: "slot", pageIdxGlobal, slotIdx: sIdx });
      resetSearchState();
      ensureRaritiesLoaded();
    }
  }

  function handleMergeTap(pageIdxGlobal, sIdx) {
    const page = currentBinder.pages[pageIdxGlobal];
    if (page.blank) return;
    const slot = page.slots[sIdx];
    const cols = page.cols;

    if (slot && (slot.spanNext || slot.spanDown)) {
      setBinders((prev) => {
        const next = prev.map((b) => ({ ...b, pages: b.pages.map((p) => ({ ...p, slots: [...p.slots] })) }));
        const slots = next[binderIndex].pages[pageIdxGlobal].slots;
        const wasHorizontal = slots[sIdx].spanNext;
        slots[sIdx] = { ...slots[sIdx], spanNext: false, spanDown: false };
        slots[sIdx + (wasHorizontal ? 1 : cols)] = null;
        return next;
      });
      setAnchor(null);
      return;
    }
    if (slot && slot.placeholder) return;

    const anchor = mergeAnchorRef.current;
    if (!anchor) {
      setAnchor({ pageIdxGlobal, slotIdx: sIdx });
      return;
    }
    if (anchor.pageIdxGlobal !== pageIdxGlobal || anchor.slotIdx === sIdx) {
      setAnchor({ pageIdxGlobal, slotIdx: sIdx });
      setMergeError("");
      return;
    }

    const r1 = Math.floor(anchor.slotIdx / cols);
    const c1 = anchor.slotIdx % cols;
    const r2 = Math.floor(sIdx / cols);
    const c2 = sIdx % cols;
    let direction = null;
    if (r1 === r2 && Math.abs(c1 - c2) === 1) direction = "horizontal";
    else if (c1 === c2 && Math.abs(r1 - r2) === 1) direction = "vertical";

    if (!direction) {
      setAnchor({ pageIdxGlobal, slotIdx: sIdx });
      setMergeError("");
      return;
    }

    const primary = Math.min(anchor.slotIdx, sIdx);
    const secondary = Math.max(anchor.slotIdx, sIdx);
    const primarySlot = page.slots[primary];
    const secondarySlot = page.slots[secondary];
    const hasPhoto = !!(primarySlot && primarySlot.image) || !!(secondarySlot && secondarySlot.image);
    if (!hasPhoto) {
      setMergeError("Füge ein Foto hinzu um ein Slot zu verbinden.");
      setAnchor(null);
      return;
    }
    setMergeError("");
    setBinders((prev) => {
      const next = prev.map((b) => ({ ...b, pages: b.pages.map((p) => ({ ...p, slots: [...p.slots] })) }));
      const slots = next[binderIndex].pages[pageIdxGlobal].slots;
      const primaryCard = slots[primary] || slots[secondary];
      slots[primary] = primaryCard
        ? { ...primaryCard, spanNext: direction === "horizontal", spanDown: direction === "vertical" }
        : null;
      slots[secondary] = { placeholder: true };
      return next;
    });
    setAnchor(null);
  }

  function handleSlotDoubleTap(pageIdxGlobal, sIdx) {
    const slot = currentBinder.pages[pageIdxGlobal].slots[sIdx];
    if (!slot || slot.placeholder) return;
    setEnlarge({
      image: slot.image,
      name: slot.name,
      set: slot.set,
      number: slot.number,
      price: slot.price,
      priceLoading: false,
      pageIdxGlobal,
      slotIdx: sIdx,
    });
    const oneDayMs = 24 * 60 * 60 * 1000;
    const isStale = !slot.priceUpdated || Date.now() - slot.priceUpdated > oneDayMs;
    if (slot.type === "card" && slot.id && isStale) {
      refreshCardPrice(pageIdxGlobal, sIdx, slot.id);
    }
  }

  async function refreshCardPrice(pageIdxGlobal, sIdx, cardId) {
    setEnlarge((prev) => (prev && prev.pageIdxGlobal === pageIdxGlobal && prev.slotIdx === sIdx ? { ...prev, priceLoading: true } : prev));
    try {
      const full = await fetchFullCard(cardId);
      const price = extractPrice(full || {});
      setBinders((prev) => {
        const next = prev.map((b) => ({ ...b, pages: b.pages.map((p) => ({ ...p, slots: [...p.slots] })) }));
        const s = next[binderIndex].pages[pageIdxGlobal].slots[sIdx];
        if (s) next[binderIndex].pages[pageIdxGlobal].slots[sIdx] = { ...s, price, priceUpdated: Date.now() };
        return next;
      });
      setEnlarge((prev) =>
        prev && prev.pageIdxGlobal === pageIdxGlobal && prev.slotIdx === sIdx ? { ...prev, price, priceLoading: false } : prev
      );
    } catch (e) {
      setEnlarge((prev) => (prev && prev.pageIdxGlobal === pageIdxGlobal && prev.slotIdx === sIdx ? { ...prev, priceLoading: false } : prev));
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
    const slot = currentBinder.pages[selected.pageIdxGlobal].slots[selected.slotIdx];
    if (slot && (slot.spanNext || slot.spanDown)) {
      setSelectedError("Lösche das Bild erst wenn der Slot entkoppelt ist.");
      return;
    }
    setSelectedError("");
    setBinders((prev) => {
      const next = prev.map((b) => ({ ...b, pages: b.pages.map((p) => ({ ...p, slots: [...p.slots] })) }));
      next[binderIndex].pages[selected.pageIdxGlobal].slots[selected.slotIdx] = null;
      return next;
    });
    setSelected(null);
  }

  function resetSearchState() {
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
        setAdvRarity(s.advRarity || "");
        setAdvArtist(s.advArtist || "");
        setAdvNumber(s.advNumber || "");
      } else {
        setSearchQuery("");
        setAdvName("");
        setAdvSet("");
        setAdvArtist("");
        setAdvNumber("");
      }
    } catch (e) {}
  }

  function saveLastSearch() {
    localCache.set("last-search", JSON.stringify({ mode: searchMode, query: searchQuery, advName, advRarity, advArtist, advNumber }));
  }

  async function runSearch(q) {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError("");
    try {
      const params = `name=${encodeURIComponent(q.trim())}&pagination:itemsPerPage=60`;
      const results = await searchCardsMultiLang(params);
      setSearchResults(results);
      if (results.length === 0) setSearchError("Keine Karten gefunden.");
      saveLastSearch();
    } catch (e) {
      setSearchError("Suche fehlgeschlagen. Prüfe deine Verbindung.");
    } finally {
      setSearching(false);
    }
  }

  async function runAdvancedSearch() {
    if (!advName.trim() && !advRarity.trim() && !advArtist.trim() && !advNumber.trim()) {
      setSearchError("Bitte mindestens ein Feld ausfüllen.");
      return;
    }
    setSearching(true);
    setSearchError("");
    try {
      const params = [];
      if (advName.trim()) params.push(`name=${encodeURIComponent(advName.trim())}`);
      if (advRarity.trim()) params.push(`rarity=eq:${encodeURIComponent(advRarity.trim())}`);
      if (advArtist.trim()) params.push(`illustrator=${encodeURIComponent(advArtist.trim())}`);
      if (advNumber.trim()) params.push(`localId=eq:${encodeURIComponent(advNumber.trim())}`);
      params.push("pagination:itemsPerPage=100");
      const results = await searchCardsMultiLang(params.join("&"));
      setSearchResults(results);
      if (results.length === 0) setSearchError("Keine Karten gefunden.");
      saveLastSearch();
    } catch (e) {
      setSearchError("Suche fehlgeschlagen: " + (e && e.message ? e.message : "Prüfe deine Verbindung."));
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

  async function cardToSlotData(cardBrief) {
    let full = cardBrief;
    try {
      full = await fetchFullCard(cardBrief.id);
    } catch (e) {
      // fall back to the brief data (image + name only) if the detail fetch fails
    }
    return {
      type: "card",
      id: full.id,
      name: full.name,
      image: tcgdexImg(full.image, "high"),
      thumb: tcgdexImg(full.image, "low"),
      set: full.set?.name,
      number: full.localId,
      rarity: full.rarity || "",
      price: extractPrice(full),
      priceUpdated: Date.now(),
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
        next[modal.binderIdx] = { ...next[modal.binderIdx], cover: { type: first.type, image: first.image, name: first.name } };
        return next;
      });
      setModal(null);
      return;
    }
    setBinders((prev) => {
      const next = prev.map((b) => ({ ...b, pages: b.pages.map((p) => ({ ...p, slots: [...p.slots] })) }));
      const slots = next[binderIndex].pages[modal.pageIdxGlobal].slots;
      let cursor = modal.slotIdx;
      let placed = 0;
      while (cursor < slots.length && placed < slotDataList.length) {
        const existing = slots[cursor];
        if (!existing || cursor === modal.slotIdx) {
          slots[cursor] = slotDataList[placed];
          placed += 1;
        }
        cursor += 1;
      }
      return next;
    });
    setModal(null);
  }

  async function pickCard(cardBrief) {
    setSearching(true);
    try {
      const slotData = await cardToSlotData(cardBrief);
      applyToTarget([slotData]);
    } finally {
      setSearching(false);
    }
  }

  async function addSelectedCards() {
    const briefs = Object.values(selectedResults);
    if (briefs.length === 0) return;
    setSearching(true);
    try {
      const list = await Promise.all(briefs.map(cardToSlotData));
      applyToTarget(list);
    } finally {
      setSearching(false);
    }
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

  function addPageAtStart(rows, cols) {
    setBinders((prev) => {
      const next = prev.map((b) => ({ ...b, pages: [...b.pages] }));
      next[binderIndex].pages.unshift(emptyPage(rows, cols));
      return next;
    });
    setPageIndex(0);
    setSelected(null);
    setSheet(null);
  }

  function addBlankPage() {
    setBinders((prev) => {
      const next = prev.map((b) => ({ ...b, pages: [...b.pages] }));
      next[binderIndex].pages.push(emptyBlankPage());
      return next;
    });
    setSheet(null);
  }

  function addBlankPageAtStart() {
    setBinders((prev) => {
      const next = prev.map((b) => ({ ...b, pages: [...b.pages] }));
      next[binderIndex].pages.unshift(emptyBlankPage());
      return next;
    });
    setPageIndex(0);
    setSelected(null);
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

  function openRename(idx) {
    setRenameTargetIdx(idx);
    setRenameValue(binders[idx].name);
    setSheet("renameBinder");
  }

  function saveRename() {
    const target = renameTargetIdx !== null ? renameTargetIdx : binderIndex;
    if (!renameValue.trim()) {
      setSheet(null);
      return;
    }
    setBinders((prev) => {
      const next = [...prev];
      next[target] = { ...next[target], name: renameValue.trim() };
      return next;
    });
    setRenameTargetIdx(null);
    setSheet(null);
  }

  function openCoverPicker(bIdx) {
    setModal({ kind: "cover", binderIdx: bIdx });
    resetSearchState();
    ensureRaritiesLoaded();
  }

  const PAGE_ROW_HEIGHT = 100;
  const reorderContainerRef = useRef(null);
  const dragStartXRef = useRef(0);

  function movePage(fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    setBinders((prev) => {
      const next = prev.map((b) => ({ ...b, pages: [...b.pages] }));
      const pages = next[binderIndex].pages;
      const [moved] = pages.splice(fromIdx, 1);
      pages.splice(toIdx, 0, moved);
      return next;
    });
  }

  function handlePageDragStart(idx, clientX, clientY) {
    setDragIdx(idx);
    dragIdxRef.current = idx;
    dragStartYRef.current = clientY;
    dragStartXRef.current = clientX;
  }

  function handlePageDragMove(clientX, clientY) {
    if (dragIdxRef.current === null) return;
    const container = reorderContainerRef.current;
    const rect = container ? container.getBoundingClientRect() : null;
    const rowDelta = Math.round((clientY - dragStartYRef.current) / PAGE_ROW_HEIGHT);
    let colTarget = dragIdxRef.current % 2;
    if (rect) {
      const relX = clientX - rect.left;
      colTarget = relX < rect.width / 2 ? 0 : 1;
    }
    if (rowDelta === 0 && colTarget === dragIdxRef.current % 2) return;
    const from = dragIdxRef.current;
    const currentRow = Math.floor(from / 2);
    const targetRow = Math.max(0, currentRow + rowDelta);
    let to = targetRow * 2 + colTarget;
    to = Math.max(0, Math.min(currentBinder.pages.length - 1, to));
    if (to !== from) {
      movePage(from, to);
      dragIdxRef.current = to;
      setDragIdx(to);
      dragStartYRef.current = clientY;
      dragStartXRef.current = clientX;
    }
  }

  function handlePageDragEnd() {
    dragIdxRef.current = null;
    setDragIdx(null);
  }

  function getMissingCards() {
    const result = [];
    currentBinder.pages.forEach((page, pIdx) => {
      if (page.blank) return;
      page.slots.forEach((slot, sIdx) => {
        if (slot && !slot.placeholder && slot.image && !slot.marked) {
          result.push({ pageIdx: pIdx, slotIdx: sIdx, slot });
        }
      });
    });
    return result;
  }

  function findCardInBinder() {
    const q = findQuery.trim().toLowerCase();
    if (!q) return;
    setFindError("");
    for (let pIdx = 0; pIdx < currentBinder.pages.length; pIdx++) {
      const page = currentBinder.pages[pIdx];
      for (let sIdx = 0; sIdx < page.slots.length; sIdx++) {
        const slot = page.slots[sIdx];
        if (!slot || slot.placeholder) continue;
        const nameMatch = slot.name && slot.name.toLowerCase().includes(q);
        const numberMatch = slot.number && String(slot.number).toLowerCase() === q;
        if (nameMatch || numberMatch) {
          setZoomedPageIdx(pIdx);
          setHighlightSlot({ pageIdxGlobal: pIdx, slotIdx: sIdx });
          setSheet(null);
          setFindQuery("");
          setTimeout(() => setHighlightSlot(null), 3000);
          return;
        }
      }
    }
    setFindError("Keine Karte mit diesem Namen oder dieser Nummer in diesem Binder gefunden.");
  }

  async function captureNode(node) {
    // Swap every remote <img src> for a locally-cached data-URL first, so
    // html2canvas never has to deal with cross-origin card images at all.
    // Done sequentially (not Promise.all) - firing many parallel fetches on
    // a mobile connection is what caused later images to time out and stay blank.
    const imgs = Array.from(node.querySelectorAll("img"));
    for (const img of imgs) {
      const orig = img.getAttribute("src");
      if (orig && !orig.startsWith("data:")) {
        const dataUrl = await toDataUrlCached(orig);
        if (dataUrl !== orig) img.src = dataUrl;
      }
      if (!img.complete) {
        await new Promise((res) => {
          img.onload = res;
          img.onerror = res;
          setTimeout(res, 4000);
        });
      }
    }
    return html2canvas(node, { backgroundColor: COLORS.bg, scale: 2, useCORS: true, allowTaint: true });
  }

  async function exportPagePDF() {
    if (!spreadLeftRef.current) return;
    setExporting(true);
    try {
      const canvas = await captureNode(spreadLeftRef.current);
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

  async function exportSelectedPagesPDF(pageIds) {
    setExporting(true);
    try {
      let pdf = null;
      const pagesToExport = currentBinder.pages.filter((p) => pageIds.includes(p.id));
      for (const page of pagesToExport) {
        const node = exportRefs.current[page.id];
        if (!node) continue;
        const canvas = await captureNode(node);
        const imgData = canvas.toDataURL("image/jpeg", 0.92);
        if (!pdf) pdf = new jsPDF({ orientation: "portrait", unit: "px", format: [canvas.width, canvas.height] });
        else pdf.addPage([canvas.width, canvas.height]);
        pdf.addImage(imgData, "JPEG", 0, 0, canvas.width, canvas.height);
      }
      if (pdf) pdf.save(`${currentBinder.name}.pdf`);
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(false);
    }
  }

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

  // ---- Zoomed single-page editor ----
  if (zoomedPageIdx !== null) {
    const zPage = currentBinder.pages[zoomedPageIdx];
    return (
      <div style={{ background: COLORS.bg, minHeight: "100vh", color: COLORS.text, fontFamily: "'Segoe UI', system-ui, sans-serif", maxWidth: 560, margin: "0 auto" }}>
        <header style={{ padding: "14px 16px", borderBottom: `1px solid ${COLORS.cardBorder}`, background: COLORS.bgElevated }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <button onClick={() => setZoomedPageIdx(null)} style={secondaryBtnStyle}>← Zurück</button>
            <button
              onClick={() => { setFindError(""); setSheet("findCard"); }}
              style={{ marginLeft: "auto", background: "none", border: "none", color: COLORS.textDim, fontSize: 13, cursor: "pointer" }}
            >
              🔍
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={() => setZoomedPageIdx((i) => Math.max(0, i - 1))}
              disabled={zoomedPageIdx === 0}
              style={navBtnStyle(zoomedPageIdx === 0)}
            >
              ‹
            </button>
            <span style={{ flex: 1, textAlign: "center", fontWeight: 700, fontSize: 15 }}>
              Seite {zoomedPageIdx + 1} / {currentBinder.pages.length}
            </span>
            <button
              onClick={() => setZoomedPageIdx((i) => Math.min(currentBinder.pages.length - 1, i + 1))}
              disabled={zoomedPageIdx >= currentBinder.pages.length - 1}
              style={navBtnStyle(zoomedPageIdx >= currentBinder.pages.length - 1)}
            >
              ›
            </button>
          </div>
          {!zPage.blank && (
            <button
              onClick={() => {
                setMergeMode((v) => !v);
                setAnchor(null);
                setSelected(null);
                setMergeError("");
              }}
              style={{ ...(mergeMode ? pillBtnStyle(true) : secondaryBtnStyle), marginTop: 10 }}
            >
              {mergeMode ? "Verbinden: An ✓" : "Slots verbinden"}
            </button>
          )}
        </header>
        {mergeMode && !zPage.blank && (
          <div style={{ background: COLORS.markGreen, color: "#06210C", padding: "8px 16px", fontSize: 13 }}>
            Zwei benachbarte Slots (auch untereinander) antippen zum Verbinden. Verbundenen Slot erneut antippen zum Trennen.
          </div>
        )}
        {mergeMode && mergeError && (
          <div style={{ background: COLORS.crimson, color: "#fff", padding: "8px 16px", fontSize: 13 }}>{mergeError}</div>
        )}
        {selected && !mergeMode && (
          <div style={{ background: COLORS.gold, color: "#1B1400", padding: "8px 16px", fontSize: 13, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Slot ausgewählt — anderen Slot zum Tauschen tippen.</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={clearSelectedSlot} style={miniBtnStyle}>Entfernen</button>
              <button onClick={() => { setSelected(null); setSelectedError(""); }} style={miniBtnStyle}>Abbrechen</button>
            </div>
          </div>
        )}
        {selected && !mergeMode && selectedError && (
          <div style={{ background: COLORS.crimson, color: "#fff", padding: "8px 16px", fontSize: 13 }}>{selectedError}</div>
        )}
        <main style={{ padding: 6 }}>
          <PageGrid
            page={zPage}
            pageIdxGlobal={zoomedPageIdx}
            selected={selected}
            mergeMode={mergeMode}
            mergeAnchor={mergeAnchor}
            onSlotTap={handleSlotTap}
            onSlotDoubleTap={handleSlotDoubleTap}
            onToggleMark={toggleMark}
            highlightSlot={highlightSlot}
            big
          />
        </main>
        {enlarge && <EnlargeOverlay enlarge={enlarge} onClose={() => setEnlarge(null)} />}
      {exporting && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div style={{ background: COLORS.bgElevated, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 10, padding: "16px 22px", color: COLORS.text, fontSize: 13 }}>
            PDF wird erstellt … (kann bei vielen Karten etwas dauern)
          </div>
        </div>
      )}
        {modal && (
          <SearchModal
            modal={modal}
            searchMode={searchMode}
            setSearchMode={setSearchMode}
            filtersExpanded={filtersExpanded}
            setFiltersExpanded={setFiltersExpanded}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            advName={advName}
            setAdvName={setAdvName}
            advRarity={advRarity}
            setAdvRarity={setAdvRarity}
            raritiesList={raritiesList}
            raritiesLoading={raritiesLoading}
            setAdvSet={setAdvSet}
            advArtist={advArtist}
            setAdvArtist={setAdvArtist}
            advNumber={advNumber}
            setAdvNumber={setAdvNumber}
            runSearch={runSearch}
            runAdvancedSearch={runAdvancedSearch}
            searching={searching}
            searchError={searchError}
            searchResults={searchResults}
            selectedResults={selectedResults}
            toggleResultSelected={toggleResultSelected}
            pickCard={pickCard}
            addSelectedCards={addSelectedCards}
            fileInputRef={fileInputRef}
            handleFileUpload={handleFileUpload}
            onClose={() => setModal(null)}
          />
        )}
        {sheet === "findCard" && (
          <Sheet onClose={() => setSheet(null)} title="Karte finden">
            <p style={{ color: COLORS.textDim, fontSize: 13, marginBottom: 12 }}>
              Sucht nur innerhalb von "{currentBinder.name}" nach Name oder Kartennummer und springt zur passenden Seite.
            </p>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input
                autoFocus
                value={findQuery}
                onChange={(e) => setFindQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && findCardInBinder()}
                placeholder="z. B. Pikachu oder 58"
                style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
              />
              <button onClick={findCardInBinder} style={primaryBtnStyle}>Finden</button>
            </div>
            {findError && <p style={{ color: COLORS.crimson, fontSize: 13 }}>{findError}</p>}
          </Sheet>
        )}
      </div>
    );
  }

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", color: COLORS.text, fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif", display: "flex", flexDirection: "column", maxWidth: 560, margin: "0 auto", position: "relative" }}>
      <header style={{ padding: "18px 16px 10px", borderBottom: `1px solid ${COLORS.cardBorder}`, background: COLORS.bgElevated, position: "sticky", top: 0, zIndex: 5 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <button onClick={() => setSheet("overview")} style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}>
            <span style={{ fontWeight: 800, fontSize: 22, letterSpacing: "-0.02em", color: COLORS.text }}>
              PKMN<span style={{ color: COLORS.gold }}>_Michi</span>
            </span>
          </button>
          <span style={{ fontSize: 11, color: COLORS.textDim, marginLeft: "auto" }}>{saving ? "speichert …" : "gespeichert"}</span>
          <button onClick={handleLogout} style={{ background: "none", border: "none", color: COLORS.textDim, fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>
            abmelden
          </button>
        </div>

        <button
          onClick={() => setSheet("overview")}
          style={{ marginTop: 12, width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, background: COLORS.card, color: COLORS.text, cursor: "pointer" }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>📁 {currentBinder.name}</span>
          <span style={{ fontSize: 12, color: COLORS.textDim }}>{binders.length} Binder ▾</span>
        </button>

        <button
          onClick={() => { setFindError(""); setSheet("findCard"); }}
          style={{ marginTop: 8, width: "100%", padding: "9px 12px", borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, background: "transparent", color: COLORS.textDim, fontSize: 13, cursor: "pointer", textAlign: "left" }}
        >
          🔍 Karte in diesem Binder finden …
        </button>
        <button
          onClick={() => setSheet("reorderPages")}
          style={{ marginTop: 6, width: "100%", padding: "9px 12px", borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, background: "transparent", color: COLORS.textDim, fontSize: 13, cursor: "pointer", textAlign: "left" }}
        >
          ⇅ Seiten anordnen
        </button>
        <button
          onClick={() => setSheet("missingCards")}
          style={{ marginTop: 6, width: "100%", padding: "9px 12px", borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, background: "transparent", color: COLORS.textDim, fontSize: 13, cursor: "pointer", textAlign: "left" }}
        >
          ⚪ Noch benötigte Karten ({getMissingCards().length})
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
          <button onClick={() => setPageIndex((i) => Math.max(0, i - 2))} disabled={pageIndex === 0} style={navBtnStyle(pageIndex === 0)}>‹</button>
          <div style={{ flex: 1, textAlign: "center", fontSize: 13, color: COLORS.textDim }}>
            Seite {pageIndex + 1}{rightPage ? `–${pageIndex + 2}` : ""} / {currentBinder.pages.length}
          </div>
          <button onClick={() => setPageIndex((i) => (i + 2 < currentBinder.pages.length ? i + 2 : i))} disabled={pageIndex + 2 >= currentBinder.pages.length} style={navBtnStyle(pageIndex + 2 >= currentBinder.pages.length)}>›</button>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button
            onClick={() => {
              setMergeMode((v) => !v);
              setAnchor(null);
              setSelected(null);
              setMergeError("");
            }}
            style={mergeMode ? pillBtnStyle(true) : secondaryBtnStyle}
          >
            {mergeMode ? "Verbinden: An ✓" : "Slots verbinden"}
          </button>
          <button onClick={() => { setExportSelection(currentBinder.pages.map((p) => p.id)); setSheet("exportPdf"); }} disabled={exporting} style={secondaryBtnStyle}>PDF exportieren …</button>
        </div>
      </header>

      {mergeMode && (
        <div style={{ background: COLORS.markGreen, color: "#06210C", padding: "8px 16px", fontSize: 13 }}>
          Tippe zwei nebeneinanderliegende Slots an, um sie zu verbinden. Verbundenen Slot erneut antippen zum Trennen.
        </div>
      )}
      {mergeMode && mergeError && (
        <div style={{ background: COLORS.crimson, color: "#fff", padding: "8px 16px", fontSize: 13 }}>{mergeError}</div>
      )}
      {selected && !mergeMode && (
        <div style={{ background: COLORS.gold, color: "#1B1400", padding: "8px 16px", fontSize: 13, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Slot ausgewählt — anderen Slot zum Tauschen tippen.</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={clearSelectedSlot} style={miniBtnStyle}>Entfernen</button>
            <button onClick={() => { setSelected(null); setSelectedError(""); }} style={miniBtnStyle}>Abbrechen</button>
          </div>
        </div>
      )}
      {selected && !mergeMode && selectedError && (
        <div style={{ background: COLORS.crimson, color: "#fff", padding: "8px 16px", fontSize: 13 }}>{selectedError}</div>
      )}

      <main style={{ padding: 6, flex: 1 }}>
        <div style={{ display: "flex", gap: 4 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
              <button onClick={() => setZoomedPageIdx(pageIndex)} style={miniLinkStyle}>🔍 vergrößern</button>
            </div>
            <div ref={spreadLeftRef}>
              <PageGrid page={leftPage} pageIdxGlobal={pageIndex} selected={selected} mergeMode={mergeMode} mergeAnchor={mergeAnchor} onSlotTap={handleSlotTap} onSlotDoubleTap={handleSlotDoubleTap} onToggleMark={toggleMark} highlightSlot={highlightSlot} />
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {rightPage ? (
              <>
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
                  <button onClick={() => setZoomedPageIdx(pageIndex + 1)} style={miniLinkStyle}>🔍 vergrößern</button>
                </div>
                <PageGrid page={rightPage} pageIdxGlobal={pageIndex + 1} selected={selected} mergeMode={mergeMode} mergeAnchor={mergeAnchor} onSlotTap={handleSlotTap} onSlotDoubleTap={handleSlotDoubleTap} onToggleMark={toggleMark} highlightSlot={highlightSlot} />
              </>
            ) : (
              <button onClick={() => setSheet("newpage")} style={{ width: "100%", height: "100%", minHeight: 200, borderRadius: 8, border: `1px dashed ${COLORS.cardBorder}`, background: "transparent", color: COLORS.textDim, fontSize: 13, cursor: "pointer" }}>
                + Seite hinzufügen
              </button>
            )}
          </div>
        </div>

        <div style={{ marginTop: 20, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={() => setSheet("newpage")} style={secondaryBtnStyle}>+ Neue Seite</button>
          {currentBinder.pages.length > 1 && (
            <button onClick={() => removeCurrentSpreadPage("left")} style={dangerBtnStyle}>Linke Seite löschen</button>
          )}
          {rightPage && currentBinder.pages.length > 1 && (
            <button onClick={() => removeCurrentSpreadPage("right")} style={dangerBtnStyle}>Rechte Seite löschen</button>
          )}
        </div>
      </main>

      <div style={{ position: "fixed", top: -10000, left: -10000, pointerEvents: "none" }}>
        {currentBinder.pages.map((p) => (
          <div key={p.id} ref={(el) => (exportRefs.current[p.id] = el)} style={{ marginBottom: 20 }}>
            <PageGrid page={p} pageIdxGlobal={0} forExport />
          </div>
        ))}
      </div>

      {enlarge && <EnlargeOverlay enlarge={enlarge} onClose={() => setEnlarge(null)} />}
      {exporting && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div style={{ background: COLORS.bgElevated, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 10, padding: "16px 22px", color: COLORS.text, fontSize: 13 }}>
            PDF wird erstellt … (kann bei vielen Karten etwas dauern)
          </div>
        </div>
      )}

      {sheet === "overview" && (
        <Sheet onClose={() => setSheet(null)} title="Meine Binder">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginBottom: 16 }}>
            {binders.map((b, idx) => (
              <div key={b.id} style={{ border: `1px solid ${idx === binderIndex ? COLORS.gold : COLORS.cardBorder}`, borderRadius: 10, overflow: "hidden", background: COLORS.card }}>
                <button onClick={() => switchBinder(idx)} style={{ width: "100%", aspectRatio: "3 / 4", background: COLORS.slotEmpty, border: "none", padding: 0, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {b.cover ? <img src={b.cover.image} alt={b.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontSize: 30 }}>📁</span>}
                </button>
                <div style={{ padding: "8px 10px" }}>
                  <p style={{ fontSize: 13, fontWeight: 700, margin: "0 0 4px", color: COLORS.text }}>{b.name}</p>
                  <p style={{ fontSize: 11, color: COLORS.textDim, margin: "0 0 8px" }}>{b.pages.length} Seiten</p>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button onClick={() => openCoverPicker(idx)} style={miniLinkStyle}>Cover</button>
                    <button onClick={() => openRename(idx)} style={miniLinkStyle}>Umbenennen</button>
                    {binders.length > 1 && (
                      <button onClick={() => removeBinder(idx)} style={{ ...miniLinkStyle, color: COLORS.crimson }}>Löschen</button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <button onClick={() => { setRenameValue(""); setSheet("newBinder"); }} style={{ ...primaryBtnStyle, width: "100%" }}>+ Neuer Binder</button>
        </Sheet>
      )}

      {sheet === "newBinder" && (
        <Sheet onClose={() => setSheet(null)} title="Neuer Binder">
          <input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addBinder(renameValue)} placeholder="Name, z. B. Glurak Sammlung" style={{ ...inputStyle, width: "100%", marginBottom: 12, boxSizing: "border-box" }} />
          <button onClick={() => addBinder(renameValue)} style={{ ...primaryBtnStyle, width: "100%" }}>Binder erstellen</button>
        </Sheet>
      )}

      {sheet === "renameBinder" && (
        <Sheet onClose={() => { setSheet(null); setRenameTargetIdx(null); }} title="Binder umbenennen">
          <input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveRename()} style={{ ...inputStyle, width: "100%", marginBottom: 12, boxSizing: "border-box" }} />
          <button onClick={saveRename} style={{ ...primaryBtnStyle, width: "100%" }}>Speichern</button>
        </Sheet>
      )}

      {sheet === "findCard" && (
        <Sheet onClose={() => setSheet(null)} title="Karte finden">
          <p style={{ color: COLORS.textDim, fontSize: 13, marginBottom: 12 }}>
            Sucht nur innerhalb von "{currentBinder.name}" nach Name oder Kartennummer und springt zur passenden Seite.
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input
              autoFocus
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && findCardInBinder()}
              placeholder="z. B. Pikachu oder 58"
              style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
            />
            <button onClick={findCardInBinder} style={primaryBtnStyle}>Finden</button>
          </div>
          {findError && <p style={{ color: COLORS.crimson, fontSize: 13 }}>{findError}</p>}
        </Sheet>
      )}

      {sheet === "missingCards" && (
        <Sheet onClose={() => setSheet(null)} title="Noch benötigte Karten">
          <p style={{ color: COLORS.textDim, fontSize: 13, marginBottom: 12 }}>
            Alle Karten in "{currentBinder.name}", deren Kreis noch nicht grün markiert ist. Antippen springt zur Karte.
          </p>
          {getMissingCards().length === 0 ? (
            <p style={{ color: COLORS.textDim, fontSize: 13 }}>Alle Karten in diesem Binder sind markiert 🎉</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, maxHeight: "70vh", overflowY: "auto" }}>
              {getMissingCards().map(({ pageIdx, slotIdx, slot }) => (
                <button
                  key={`${pageIdx}-${slotIdx}`}
                  onClick={() => {
                    setZoomedPageIdx(pageIdx);
                    setHighlightSlot({ pageIdxGlobal: pageIdx, slotIdx });
                    setSheet(null);
                    setTimeout(() => setHighlightSlot(null), 3000);
                  }}
                  style={{ border: `1px solid ${COLORS.cardBorder}`, borderRadius: 6, padding: 0, overflow: "hidden", background: COLORS.card, cursor: "pointer" }}
                  title={slot.name}
                >
                  <img src={slot.thumb || slot.image} alt={slot.name} style={{ width: "100%", display: "block" }} />
                  <p style={{ fontSize: 9, color: COLORS.textDim, margin: "2px 4px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    S{pageIdx + 1}
                  </p>
                </button>
              ))}
            </div>
          )}
        </Sheet>
      )}

      {sheet === "exportPdf" && (
        <Sheet onClose={() => setSheet(null)} title="PDF exportieren">
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button onClick={() => setExportSelection(currentBinder.pages.map((p) => p.id))} style={secondaryBtnStyle}>Alle auswählen</button>
            <button onClick={() => setExportSelection([])} style={secondaryBtnStyle}>Keine</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16, maxHeight: "50vh", overflowY: "auto" }}>
            {currentBinder.pages.map((p, idx) => {
              const checked = exportSelection.includes(p.id);
              return (
                <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, background: COLORS.card, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setExportSelection((prev) => (checked ? prev.filter((id) => id !== p.id) : [...prev, p.id]))
                    }
                  />
                  Seite {idx + 1} {p.blank ? "(leer)" : `(${p.rows}×${p.cols})`}
                </label>
              );
            })}
          </div>
          <button
            onClick={() => {
              setSheet(null);
              exportSelectedPagesPDF(exportSelection);
            }}
            disabled={exportSelection.length === 0 || exporting}
            style={{ ...primaryBtnStyle, width: "100%" }}
          >
            {exportSelection.length} Seite(n) als PDF herunterladen
          </button>
        </Sheet>
      )}

      {sheet === "reorderPages" && (
        <Sheet onClose={() => { setSheet(null); handlePageDragEnd(); }} title="Seiten anordnen" big>
          <p style={{ color: COLORS.textDim, fontSize: 13, marginBottom: 12 }}>
            Am Griff ⠿ halten und ziehen, um die Reihenfolge zu ändern. Seiten stehen als Doppelseiten (Spreads) untereinander, genau wie im Ordner.
          </p>
          <div
            ref={reorderContainerRef}
            onPointerMove={(e) => handlePageDragMove(e.clientX, e.clientY)}
            onPointerUp={handlePageDragEnd}
            onPointerLeave={handlePageDragEnd}
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
          >
            {currentBinder.pages.map((p, idx) => {
              const firstCard = p.slots && p.slots.find((s) => s && s.image);
              return (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 6,
                    padding: "10px 8px",
                    borderRadius: 8,
                    border: `1px solid ${dragIdx === idx ? COLORS.gold : COLORS.cardBorder}`,
                    background: COLORS.card,
                  }}
                >
                  <div
                    style={{
                      width: "100%",
                      aspectRatio: "2.5 / 3.5",
                      borderRadius: 6,
                      background: p.blank ? COLORS.bg : COLORS.slotEmpty,
                      overflow: "hidden",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {firstCard && <img src={firstCard.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                  </div>
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 600 }}>Seite {idx + 1}</p>
                  <p style={{ margin: 0, fontSize: 10, color: COLORS.textDim }}>
                    {p.blank ? "Leer" : `${p.rows}×${p.cols}`}
                  </p>
                  <span
                    onPointerDown={(e) => {
                      e.currentTarget.setPointerCapture?.(e.pointerId);
                      handlePageDragStart(idx, e.clientX, e.clientY);
                    }}
                    style={{ cursor: "grab", fontSize: 20, color: COLORS.textDim, padding: "2px 10px", touchAction: "none" }}
                  >
                    ⠿
                  </span>
                </div>
              );
            })}
          </div>
        </Sheet>
      )}

      {sheet === "newpage" && (
        <Sheet onClose={() => setSheet(null)} title="Neue Seite">
          <p style={{ color: COLORS.textDim, fontSize: 13, marginBottom: 14 }}>Wähle ein Slot-Raster (wird ans Ende angefügt).</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
            {PAGE_SIZE_OPTIONS.map((opt) => (
              <button key={opt.label} onClick={() => addPage(opt.rows, opt.cols)} style={optionBtnStyle}>
                {opt.label} — {opt.rows * opt.cols} Slots
              </button>
            ))}
          </div>
          <p style={{ color: COLORS.textDim, fontSize: 13, marginBottom: 10 }}>Leere schwarze Seite (kein Raster, z. B. als Titelseite):</p>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={addBlankPage} style={{ ...optionBtnStyle, flex: 1 }}>Ans Ende</button>
            <button onClick={addBlankPageAtStart} style={{ ...optionBtnStyle, flex: 1 }}>Als erste Seite</button>
          </div>
        </Sheet>
      )}

      {modal && (
        <SearchModal
          modal={modal}
          searchMode={searchMode}
          setSearchMode={setSearchMode}
          filtersExpanded={filtersExpanded}
          setFiltersExpanded={setFiltersExpanded}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          advName={advName}
          setAdvName={setAdvName}
            advRarity={advRarity}
            setAdvRarity={setAdvRarity}
            raritiesList={raritiesList}
            raritiesLoading={raritiesLoading}
          setAdvSet={setAdvSet}
          advArtist={advArtist}
          setAdvArtist={setAdvArtist}
          advNumber={advNumber}
          setAdvNumber={setAdvNumber}
          runSearch={runSearch}
          runAdvancedSearch={runAdvancedSearch}
          searching={searching}
          searchError={searchError}
          searchResults={searchResults}
          selectedResults={selectedResults}
          toggleResultSelected={toggleResultSelected}
          pickCard={pickCard}
          addSelectedCards={addSelectedCards}
          fileInputRef={fileInputRef}
          handleFileUpload={handleFileUpload}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function EnlargeOverlay({ enlarge, onClose }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 40, padding: 24 }}>
      <div style={{ position: "relative", maxWidth: 340, width: "100%" }} onClick={(e) => e.stopPropagation()}>
        <img src={enlarge.image} alt={enlarge.name} style={{ width: "100%", borderRadius: 10, display: "block" }} />
        <button onClick={onClose} style={{ position: "absolute", top: -14, right: -14, width: 32, height: 32, borderRadius: "50%", background: COLORS.gold, border: "none", color: "#1B1400", fontSize: 18, fontWeight: 700, cursor: "pointer" }}>×</button>
        {enlarge.name && <p style={{ textAlign: "center", color: COLORS.text, fontSize: 13, marginTop: 10, marginBottom: 2 }}>{enlarge.name}</p>}
        {(enlarge.set || enlarge.number) && (
          <p style={{ textAlign: "center", color: COLORS.textDim, fontSize: 12, margin: 0 }}>
            {enlarge.set}
            {enlarge.set && enlarge.number ? " · " : ""}
            {enlarge.number ? `Nr. ${enlarge.number}` : ""}
          </p>
        )}
        {(enlarge.price || enlarge.priceLoading) && (
          <p style={{ textAlign: "center", color: COLORS.gold, fontSize: 13, fontWeight: 700, marginTop: 6, marginBottom: 0 }}>
            {enlarge.priceLoading && !enlarge.price
              ? "Preis wird geladen …"
              : formatPrice(enlarge.price) + (enlarge.priceLoading ? " (aktualisiert …)" : "")}
          </p>
        )}
      </div>
    </div>
  );
}

// ================= Full-screen search "window" =================
function SearchModal(props) {
  const {
    modal, searchMode, setSearchMode, filtersExpanded, setFiltersExpanded,
    searchQuery, setSearchQuery, advName, setAdvName, advRarity, setAdvRarity, raritiesList, raritiesLoading,
    advArtist, setAdvArtist, advNumber, setAdvNumber,
    runSearch, runAdvancedSearch, searching, searchError, searchResults,
    selectedResults, toggleResultSelected, pickCard, addSelectedCards,
    fileInputRef, handleFileUpload, onClose,
  } = props;

  return (
    <div style={{ position: "fixed", inset: 0, background: COLORS.bg, zIndex: 30, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 16px 10px", borderBottom: `1px solid ${COLORS.cardBorder}`, background: COLORS.bgElevated, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{modal.kind === "cover" ? "Cover auswählen" : "Karte hinzufügen"}</h2>
        <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.textDim, fontSize: 24, cursor: "pointer", lineHeight: 1 }}>×</button>
      </div>

      <div style={{ padding: 16, overflowY: "auto", flex: 1 }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <button onClick={() => setSearchMode("simple")} style={pillBtnStyle(searchMode === "simple")}>Einfach</button>
          <button onClick={() => setSearchMode("advanced")} style={pillBtnStyle(searchMode === "advanced")}>Erweitert</button>
        </div>

        {searchMode === "simple" ? (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runSearch(searchQuery)}
                placeholder="Kartenname, Deutsch oder Englisch"
                style={inputStyle}
              />
              <button onClick={() => runSearch(searchQuery)} style={primaryBtnStyle}>Suchen</button>
            </div>
            <p style={{ fontSize: 11, color: COLORS.textDim, margin: "4px 0 0" }}>Findet auch deutsche Namen automatisch.</p>
          </div>
        ) : (
          <div style={{ marginBottom: 12 }}>
            <button onClick={() => setFiltersExpanded((v) => !v)} style={{ ...secondaryBtnStyle, width: "100%", marginBottom: filtersExpanded ? 10 : 0, textAlign: "left" }}>
              Filter {filtersExpanded ? "▲ einklappen" : "▾ ausklappen"}
            </button>
            {filtersExpanded && (
              <div>
                <label style={labelStyle}>Pokémon-Name (Deutsch oder Englisch)</label>
                <input value={advName} onChange={(e) => setAdvName(e.target.value)} placeholder="z. B. Glurak oder Charizard" style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 4 }} />

                <label style={labelStyle}>Seltenheit</label>
                <select
                  value={advRarity}
                  onChange={(e) => setAdvRarity(e.target.value)}
                  style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 8, appearance: "auto" }}
                >
                  <option value="">Alle Seltenheiten</option>
                  {raritiesList &&
                    raritiesList.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                </select>
                {raritiesLoading && <p style={{ fontSize: 11, color: COLORS.textDim, margin: "0 0 8px" }}>Lade Seltenheiten …</p>}

                <label style={labelStyle}>Künstler</label>
                <input value={advArtist} onChange={(e) => setAdvArtist(e.target.value)} placeholder="z. B. Ken Sugimori" style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 8 }} />

                <label style={labelStyle}>Kartennummer</label>
                <input value={advNumber} onChange={(e) => setAdvNumber(e.target.value)} placeholder="z. B. 58" style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 10 }} />
              </div>
            )}
            <button onClick={runAdvancedSearch} style={{ ...primaryBtnStyle, width: "100%", marginTop: 10 }}>Suchen</button>
          </div>
        )}

        <button onClick={() => fileInputRef.current?.click()} style={{ ...secondaryBtnStyle, width: "100%", marginBottom: 14 }}>Eigenes Bild hochladen</button>
        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileUpload} style={{ display: "none" }} />

        {searching && <p style={{ color: COLORS.textDim, fontSize: 13 }}>Suche läuft …</p>}
        {searchError && <p style={{ color: COLORS.crimson, fontSize: 13 }}>{searchError}</p>}
        {searchResults.length > 0 && !searching && (
          <p style={{ color: COLORS.textDim, fontSize: 12, margin: "0 0 8px" }}>{searchResults.length} Ergebnisse</p>
        )}

        {searchResults.length > 0 && (
          <>
            {modal.kind === "slot" && Object.keys(selectedResults).length > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 0", position: "sticky", top: 0, background: COLORS.bg, paddingTop: 4, paddingBottom: 4 }}>
                <span style={{ fontSize: 12, color: COLORS.textDim }}>{Object.keys(selectedResults).length} ausgewählt</span>
                <button onClick={addSelectedCards} style={primaryBtnStyle}>{Object.keys(selectedResults).length} Karte(n) hinzufügen</button>
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
              {searchResults.map((c) => {
                const isChecked = !!selectedResults[c.id];
                const hasImage = !!c.image;
                return (
                  <div key={c.id} style={{ position: "relative" }}>
                    <button
                      onClick={() => hasImage && (modal.kind === "slot" ? toggleResultSelected(c) : pickCard(c))}
                      disabled={!hasImage}
                      style={{
                        border: `1px solid ${isChecked ? COLORS.gold : COLORS.cardBorder}`,
                        borderRadius: 6,
                        padding: 0,
                        overflow: "hidden",
                        background: COLORS.card,
                        cursor: hasImage ? "pointer" : "default",
                        width: "100%",
                        display: "block",
                        opacity: hasImage ? 1 : 0.5,
                      }}
                      title={hasImage ? c.name : `${c.name} — kein Bild verfügbar`}
                    >
                      {hasImage ? (
                        <img src={tcgdexImg(c.image, "low")} alt={c.name} style={{ width: "100%", display: "block" }} />
                      ) : (
                        <div
                          style={{
                            aspectRatio: "2.5 / 3.5",
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            justifyContent: "center",
                            padding: 6,
                            textAlign: "center",
                          }}
                        >
                          <span style={{ fontSize: 10, color: COLORS.textDim, lineHeight: 1.3 }}>{c.name}</span>
                          <span style={{ fontSize: 9, color: COLORS.textDim, marginTop: 4 }}>kein Bild verfügbar</span>
                        </div>
                      )}
                    </button>
                    {modal.kind === "slot" && hasImage && (
                      <span style={{ position: "absolute", top: 3, right: 3, width: 14, height: 14, borderRadius: "50%", background: isChecked ? COLORS.gold : "rgba(255,255,255,0.6)", border: "1px solid rgba(0,0,0,0.3)" }} />
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
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
          <p style={{ color: COLORS.textDim, fontSize: 13, marginTop: 6 }}>{mode === "signup" ? "Konto erstellen" : "Anmelden"}, um deine Binder überall zu sehen.</p>
        </div>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-Mail" style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 10 }} />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onSubmit()} placeholder="Passwort" style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 14 }} />
        {error && <p style={{ color: COLORS.gold, fontSize: 12, marginBottom: 10 }}>{error}</p>}
        <button onClick={onSubmit} disabled={busy} style={{ ...primaryBtnStyle, width: "100%", padding: "12px 16px", fontSize: 14 }}>{busy ? "Bitte warten …" : mode === "signup" ? "Konto erstellen" : "Anmelden"}</button>
        <button onClick={() => setMode(mode === "signup" ? "login" : "signup")} style={{ ...linkBtnStyle, textAlign: "center", width: "100%", marginTop: 14 }}>
          {mode === "signup" ? "Schon ein Konto? Hier anmelden" : "Noch kein Konto? Hier erstellen"}
        </button>
      </div>
    </div>
  );
}

function Sheet({ title, onClose, children, big }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 20 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: COLORS.bgElevated, width: "100%", maxWidth: 560, borderRadius: "16px 16px 0 0", padding: 18, maxHeight: big ? "94vh" : "80vh", overflowY: "auto", border: `1px solid ${COLORS.cardBorder}`, borderBottom: "none" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.textDim, fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const navBtnStyle = (disabled) => ({ width: 32, height: 32, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, background: COLORS.card, color: disabled ? COLORS.textDim : COLORS.text, fontSize: 16, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.4 : 1 });
const secondaryBtnStyle = { padding: "10px 14px", borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, background: COLORS.card, color: COLORS.text, fontSize: 13, cursor: "pointer" };
const primaryBtnStyle = { padding: "10px 16px", borderRadius: 8, border: "none", background: COLORS.gold, color: "#1B1400", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" };
const dangerBtnStyle = { padding: "10px 14px", borderRadius: 8, border: `1px solid ${COLORS.crimson}`, background: "transparent", color: COLORS.crimson, fontSize: 13, cursor: "pointer" };
const optionBtnStyle = { padding: "14px 16px", borderRadius: 10, border: `1px solid ${COLORS.cardBorder}`, background: COLORS.card, color: COLORS.text, fontSize: 14, textAlign: "left", cursor: "pointer" };
const inputStyle = { flex: 1, padding: "10px 12px", borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, background: COLORS.card, color: COLORS.text, fontSize: 14, outline: "none" };
const labelStyle = { display: "block", fontSize: 11, color: COLORS.textDim, marginBottom: 4, marginTop: 2 };
const linkBtnStyle = { display: "block", background: "none", border: "none", color: COLORS.gold, fontSize: 12, cursor: "pointer", padding: 0, textAlign: "left" };
const miniLinkStyle = { background: "none", border: "none", color: COLORS.gold, fontSize: 11, cursor: "pointer", padding: 0 };
const pillBtnStyle = (active) => ({ padding: "6px 14px", borderRadius: 999, border: `1px solid ${active ? COLORS.gold : COLORS.cardBorder}`, background: active ? COLORS.gold : COLORS.card, color: active ? "#1B1400" : COLORS.textDim, fontSize: 12, fontWeight: active ? 700 : 400, cursor: "pointer" });
const miniBtnStyle = { padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(0,0,0,0.3)", background: "rgba(0,0,0,0.15)", color: "#1B1400", fontSize: 12, cursor: "pointer" };
