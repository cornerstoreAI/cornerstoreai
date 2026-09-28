"""
CornerstoreAI – täglicher Preis-Abruf
=====================================

Läuft automatisch jeden Morgen über GitHub Actions (siehe .github/workflows/preise.yml).

Ablauf:
  1. Alle Konten mit Postleitzahl und ihre Produkte aus Supabase laden
  2. Pro Produkt die aktuellen Prospekt-Angebote in der Nähe suchen (marktguru)
  3. Passende Treffer herausfiltern (Name, Größe, Händler) und auf Stückpreis umrechnen
  4. Angebote speichern, abgelaufene löschen, Tages-Bestpreis in den Verlauf schreiben

Umgebungsvariablen (werden als GitHub "Secrets" hinterlegt):
  SUPABASE_URL          z. B. https://abcdefgh.supabase.co
  SUPABASE_SERVICE_KEY  der geheime Schlüssel (secret / service_role) – NIE in die App!

Zum Ausprobieren ohne Internet:  python collect.py --demo
"""
from __future__ import annotations

import datetime as dt
import difflib
import json
import os
import re
import sys
import time
import unicodedata
from dataclasses import dataclass, field

try:
    import requests
except ImportError:  # im Demo-Modus nicht nötig
    requests = None

MARKTGURU_API = "https://api.marktguru.de/api/v1/offers/search"
# Öffentliche Web-Schlüssel von marktguru.de. Werden bei jedem Lauf frisch von der
# Startseite gelesen; diese Werte dienen nur als Rückfall.
FALLBACK_KEYS = {
    "x-apikey": "8Kk+pmbf7TgJ9nVj2cXeA7P5zBGv8iuutVVMRfOfvNE=",
    "x-clientkey": "WU/RH+PMGDi+gkZer3WbMelt6zcYHSTytNB7VpTia90=",
}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
PAUSE_SEC = 0.8            # Pause zwischen Anfragen, um niemanden zu überlasten
SKIP_CATEGORIES = ("zigarett", "tabak")   # feste Preise per Steuerbanderole -> kein Vergleich nötig

# ---------------------------------------------------------------------------
# Text-Helfer
# ---------------------------------------------------------------------------
STOPWORDS = {
    "dose", "flasche", "fl", "packung", "pack", "beutel", "stueck", "stk", "glas",
    "tuete", "kasten", "kiste", "karton", "je", "l", "ml", "g", "kg", "cl", "liter",
    "x", "er", "und", "mit", "der", "die", "das",
}


def norm(s: str) -> str:
    """Kleinbuchstaben, Umlaute ausschreiben, Sonderzeichen zu Leerzeichen."""
    s = (s or "").lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9,.]+", " ", s).strip()


def compact(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", norm(s))


def core_tokens(name: str) -> list[str]:
    """Die 'Wörter, auf die es ankommt' – ohne Größenangaben und Einheiten."""
    out = []
    for t in norm(name).split():
        t = t.strip(".,")
        if not t or t in STOPWORDS:
            continue
        if re.fullmatch(r"[\d.,]+(l|ml|g|kg|cl)?", t):
            continue
        out.append(t)
    return out


VOL_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*-?\s*(ml|cl|l|liter|kg|g)\b")


def volumes(text: str) -> list[float]:
    """Alle Mengenangaben in ml bzw. g (0,5 l -> 500)."""
    out = []
    for num, unit in VOL_RE.findall(norm(text).replace(" , ", ",")):
        v = float(num.replace(",", "."))
        v *= {"ml": 1, "cl": 10, "l": 1000, "liter": 1000, "g": 1, "kg": 1000}[unit]
        out.append(round(v, 1))
    return out


PACK_RES = [
    re.compile(r"(\d{1,2})\s*[x×]\s*\d"),                     # 20 x 0,5 l
    re.compile(r"(\d{1,2})\s*er[\s-]*(?:pack|packung|traeger|kasten|kiste)"),  # 6er-Pack
    re.compile(r"(\d{1,2})\s*(?:dosen|flaschen|fl\.)\b"),      # 24 Dosen
]


def pack_count(text: str) -> int:
    t = norm(text)
    for rx in PACK_RES:
        m = rx.search(t)
        if m:
            n = int(m.group(1))
            if 2 <= n <= 48:
                return n
    return 1


def search_term(product: dict) -> str:
    if (product.get("search_term") or "").strip():
        return product["search_term"].strip()
    toks = [t for t in re.split(r"\s+", product["name"]) if core_tokens(t)]
    return " ".join(toks[:3]) or product["name"]


def token_in(tok: str, words: list[str]) -> bool:
    if any(tok == w or (len(tok) >= 4 and w.startswith(tok)) for w in words):
        return True
    return any(difflib.SequenceMatcher(None, tok, w).ratio() >= 0.85 for w in words if len(w) >= 4)


def is_match(product: dict, offer: "Offer") -> bool:
    """Passt das Angebot zum Produkt? Alle Kernwörter müssen vorkommen, Größe muss passen."""
    words = norm(offer.full_text).split()
    toks = core_tokens(search_term(product))
    if not toks or not all(token_in(t, words) for t in toks):
        return False
    pv = volumes(product["name"])
    ov = volumes(offer.full_text)
    if pv and ov and not any(abs(p - o) <= max(1.0, p * 0.03) for p in pv for o in ov):
        return False
    return True


def retailer_for(advertiser_names: list[str], wanted: list[str]) -> str | None:
    """Ordnet 'Netto Marken-Discount' dem Eintrag 'Netto' des Nutzers zu usw."""
    for adv in advertiser_names:
        a = compact(adv)
        for w in wanted:
            c = compact(w)
            if c and (a.startswith(c) or c.startswith(a)):
                return w
    return None


# ---------------------------------------------------------------------------
# marktguru
# ---------------------------------------------------------------------------
@dataclass
class Offer:
    id: str
    advertisers: list[str]
    title: str
    description: str
    price: float
    old_price: float | None
    valid_from: str | None
    valid_to: str | None
    full_text: str = field(default="")

    @staticmethod
    def from_api(e: dict) -> "Offer | None":
        try:
            price = float(e.get("price") or 0)
        except (TypeError, ValueError):
            return None
        if price <= 0:
            return None
        brand = (e.get("brand") or {}).get("name") or ""
        if brand.lower() == "thisisnobrand123":
            brand = ""
        prod = (e.get("product") or {}).get("name") or ""
        desc = e.get("description") or ""
        title = prod if brand.lower() in prod.lower() else f"{brand} {prod}".strip()
        vd = (e.get("validityDates") or [{}])[0] or {}
        old = e.get("oldPrice")
        try:
            old = float(old) if old else None
        except (TypeError, ValueError):
            old = None
        o = Offer(
            id=str(e.get("id")),
            advertisers=[a.get("name") or a.get("uniqueName") or "" for a in (e.get("advertisers") or [])],
            title=title or desc[:80],
            description=desc,
            price=price,
            old_price=old if old and old > price else None,
            valid_from=(vd.get("from") or "")[:10] or None,
            valid_to=(vd.get("to") or "")[:10] or None,
        )
        o.full_text = f"{brand} {prod} {desc}"
        return o


class Marktguru:
    def __init__(self):
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept": "application/json"})
        self.s.headers.update(self._keys())
        self.cache: dict[tuple, list[Offer]] = {}

    def _keys(self) -> dict:
        try:
            html = self.s.get("https://www.marktguru.de/", timeout=20).text
            for m in re.finditer(r'<script[^>]*type="application/json"[^>]*>(.*?)</script>', html, re.S):
                try:
                    cfg = json.loads(m.group(1)).get("config") or {}
                except (ValueError, AttributeError):
                    continue
                if cfg.get("apiKey") and cfg.get("clientKey"):
                    return {"x-apikey": cfg["apiKey"], "x-clientkey": cfg["clientKey"]}
        except Exception as ex:  # noqa: BLE001
            print("  Hinweis: Schlüssel nicht von der Startseite lesbar:", ex)
        return dict(FALLBACK_KEYS)

    def search(self, q: str, zip_code: str) -> list[Offer]:
        key = (q.lower(), zip_code)
        if key in self.cache:
            return self.cache[key]
        time.sleep(PAUSE_SEC)
        r = self.s.get(MARKTGURU_API, params={"as": "web", "q": q, "zipCode": zip_code, "limit": 100, "offset": 0}, timeout=30)
        r.raise_for_status()
        offers = [o for o in (Offer.from_api(e) for e in r.json().get("results", [])) if o]
        self.cache[key] = offers
        return offers


class DemoMarktguru:
    """Liest Beispiel-Antworten aus demo_offers.json – zum Testen ohne Internet."""

    def __init__(self, path: str):
        with open(path, encoding="utf-8") as f:
            self.data = json.load(f)

    def search(self, q: str, zip_code: str) -> list[Offer]:
        return [o for o in (Offer.from_api(e) for e in self.data.get(q.lower(), [])) if o]


# ---------------------------------------------------------------------------
# Supabase (über die REST-Schnittstelle, kein Zusatzpaket nötig)
# ---------------------------------------------------------------------------
class Supabase:
    def __init__(self, url: str, key: str):
        self.base = url.rstrip("/") + "/rest/v1/"
        self.h = {"apikey": key, "Content-Type": "application/json"}
        if not key.startswith("sb_"):          # alter service_role-Schlüssel (JWT)
            self.h["Authorization"] = f"Bearer {key}"

    def get(self, table: str, params: dict | None = None) -> list[dict]:
        out, start = [], 0
        while True:
            h = dict(self.h, Range=f"{start}-{start + 999}")
            r = requests.get(self.base + table, headers=h, params=params or {}, timeout=30)
            r.raise_for_status()
            rows = r.json()
            out += rows
            if len(rows) < 1000:
                return out
            start += 1000

    def upsert(self, table: str, rows: list[dict], on_conflict: str) -> None:
        for i in range(0, len(rows), 500):
            r = requests.post(self.base + table, params={"on_conflict": on_conflict},
                              headers=dict(self.h, Prefer="resolution=merge-duplicates,return=minimal"),
                              data=json.dumps(rows[i:i + 500]), timeout=60)
            if r.status_code >= 300:
                raise RuntimeError(f"{table}: {r.status_code} {r.text[:300]}")

    def insert(self, table: str, row: dict) -> dict:
        r = requests.post(self.base + table, headers=dict(self.h, Prefer="return=representation"),
                          data=json.dumps(row), timeout=30)
        r.raise_for_status()
        return r.json()[0]

    def update(self, table: str, match: dict, row: dict) -> None:
        r = requests.patch(self.base + table, params={k: f"eq.{v}" for k, v in match.items()},
                           headers=self.h, data=json.dumps(row), timeout=30)
        r.raise_for_status()

    def delete(self, table: str, params: dict) -> None:
        r = requests.delete(self.base + table, headers=self.h, params=params, timeout=30)
        r.raise_for_status()


class MemoryDB:
    """Ersatz-Datenbank für den Demo-Modus."""

    def __init__(self, data: dict):
        self.t = {k: list(v) for k, v in data.items()}
        self.t.setdefault("retail_prices", [])
        self.t.setdefault("price_history", [])

    def get(self, table, params=None):
        return list(self.t.get(table, []))

    def upsert(self, table, rows, on_conflict):
        keys = on_conflict.split(",")
        for row in rows:
            for ex in self.t[table]:
                if all(ex.get(k) == row.get(k) for k in keys):
                    ex.update(row)
                    break
            else:
                self.t[table].append(dict(row))

    def insert(self, table, row):
        self.t.setdefault(table, []).append(dict(row, id=1))
        return dict(row, id=1)

    def update(self, table, match, row):
        pass

    def delete(self, table, params):
        pass


# ---------------------------------------------------------------------------
# Hauptprogramm
# ---------------------------------------------------------------------------
def best_offer_rows(product: dict, offers: list[Offer], retailers: list[str]) -> list[dict]:
    """Pro Händler und Gültigkeitszeitraum das günstigste passende Angebot (pro Stück)."""
    best: dict[tuple, dict] = {}
    for o in offers:
        ret = retailer_for(o.advertisers, retailers)
        if not ret or not is_match(product, o):
            continue
        n = pack_count(o.full_text)
        unit_price = round(o.price / n, 2)
        row = {
            "user_id": product["user_id"],
            "product_id": product["id"],
            "retailer": ret,
            "ext_key": f"mg:{o.id}",
            "price": unit_price,
            "regular_price": round(o.old_price / n, 2) if o.old_price else None,
            "is_offer": True,
            "valid_from": o.valid_from,
            "valid_to": o.valid_to,
            "source": "marktguru",
            "title": (o.title + (" – " + o.description if o.description else ""))[:300],
            "pack_count": n,
            "pack_price": o.price,
            "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
        k = (ret, o.valid_from)
        if k not in best or unit_price < best[k]["price"]:
            best[k] = row
    return list(best.values())


def run(db, mg, today: dt.date | None = None) -> dict:
    today = today or dt.date.today()
    profiles = [p for p in db.get("profiles", {"select": "id,zip,retailers"}) if (p.get("zip") or "").strip()]
    products = db.get("products", {"select": "id,user_id,name,category,search_term,vat_rate"})
    by_user: dict[str, list[dict]] = {}
    for p in products:
        by_user.setdefault(p["user_id"], []).append(p)

    stats = {"konten": len(profiles), "produkte": 0, "angebote": 0, "fehler": 0}
    offer_rows, regular_rows = [], []
    for prof in profiles:
        zip_code = prof["zip"].strip()
        retailers = prof.get("retailers") or []
        for prod in by_user.get(prof["id"], []):
            if any(s in (prod.get("category") or "").lower() for s in SKIP_CATEGORIES):
                continue
            stats["produkte"] += 1
            try:
                offers = mg.search(search_term(prod), zip_code)
            except Exception as ex:  # noqa: BLE001
                stats["fehler"] += 1
                print(f"  Fehler bei '{prod['name']}': {ex}")
                continue
            rows = best_offer_rows(prod, offers, retailers)
            offer_rows += rows
            for r in rows:
                if r["regular_price"]:
                    regular_rows.append({k: r[k] for k in ("user_id", "product_id", "retailer", "regular_price", "fetched_at")}
                                        | {"ext_key": "regular-mg", "price": r["regular_price"], "is_offer": False,
                                           "source": "marktguru", "title": r["title"], "pack_count": 1,
                                           "valid_from": None, "valid_to": None, "pack_price": None})
            print(f"  {prod['name']}: {len(rows)} passende Angebote")

    stats["angebote"] = len(offer_rows)
    if offer_rows:
        db.upsert("retail_prices", offer_rows, "product_id,retailer,ext_key")
    if regular_rows:
        # je Produkt+Händler nur den neuesten Normalpreis behalten
        dedup = {(r["product_id"], r["retailer"]): r for r in regular_rows}
        db.upsert("retail_prices", list(dedup.values()), "product_id,retailer,ext_key")

    # abgelaufene Prospekt-Angebote aufräumen (7 Tage Puffer für die Anzeige "letzte Woche")
    cutoff = (today - dt.timedelta(days=7)).isoformat()
    db.delete("retail_prices", {"source": "eq.marktguru", "is_offer": "eq.true", "valid_to": f"lt.{cutoff}"})

    write_history(db, today)
    return stats


def write_history(db, today: dt.date) -> None:
    """Tages-Bestpreis je Produkt (Supermarkt oder Großhändler, jeweils brutto)."""
    products = {p["id"]: p for p in db.get("products", {"select": "id,user_id,vat_rate"})}
    best: dict[int, tuple[float, str]] = {}

    def consider(pid, price, src):
        if pid in products and price and (pid not in best or price < best[pid][0]):
            best[pid] = (float(price), src)

    t = today.isoformat()
    for r in db.get("retail_prices", {"select": "product_id,retailer,price,is_offer,valid_from,valid_to,hidden"}):
        if r.get("hidden"):
            continue
        if r["is_offer"] and not ((r.get("valid_from") or t) <= t <= (r.get("valid_to") or t)):
            continue
        consider(r["product_id"], r["price"], r["retailer"])
    vendors = {v["id"]: v for v in db.get("vendors", {"select": "id,name,prices_net"})}
    for vp in db.get("vendor_prices", {"select": "vendor_id,product_id,price"}):
        v, p = vendors.get(vp["vendor_id"]), products.get(vp["product_id"])
        if not v or not p:
            continue
        gross = float(vp["price"]) * (1 + float(p.get("vat_rate") or 19) / 100) if v.get("prices_net") else float(vp["price"])
        consider(vp["product_id"], round(gross, 2), v["name"])

    rows = [{"product_id": pid, "user_id": products[pid]["user_id"], "day": t, "best_price": round(v[0], 2), "best_source": v[1]}
            for pid, v in best.items()]
    if rows:
        db.upsert("price_history", rows, "product_id,day")


def main() -> int:
    demo = "--demo" in sys.argv
    here = os.path.dirname(os.path.abspath(__file__))
    if demo:
        with open(os.path.join(here, "demo_db.json"), encoding="utf-8") as f:
            db = MemoryDB(json.load(f))
        mg = DemoMarktguru(os.path.join(here, "demo_offers.json"))
    else:
        url, key = os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_SERVICE_KEY", "")
        if not url or not key:
            print("FEHLER: SUPABASE_URL oder SUPABASE_SERVICE_KEY fehlt (GitHub → Settings → Secrets).")
            return 1
        db, mg = Supabase(url, key), Marktguru()

    run_row = db.insert("collector_runs", {"status": "läuft"})
    try:
        stats = run(db, mg)
        msg = f"{stats['konten']} Konten, {stats['produkte']} Produkte, {stats['angebote']} Angebote, {stats['fehler']} Fehler"
        print("FERTIG:", msg)
        db.update("collector_runs", {"id": run_row["id"]},
                  {"status": "ok" if not stats["fehler"] else "teilweise", "finished_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                   "offers_found": stats["angebote"], "message": msg})
        if demo:
            print(json.dumps(db.t["retail_prices"], ensure_ascii=False, indent=1))
            print(json.dumps(db.t["price_history"], ensure_ascii=False, indent=1))
        # Wenn ALLE Suchen scheitern, soll GitHub das als Fehler melden (E-Mail an dich)
        return 1 if stats["produkte"] and stats["fehler"] == stats["produkte"] else 0
    except Exception as ex:  # noqa: BLE001
        db.update("collector_runs", {"id": run_row["id"]},
                  {"status": "fehler", "finished_at": dt.datetime.now(dt.timezone.utc).isoformat(), "message": str(ex)[:500]})
        raise


if __name__ == "__main__":
    sys.exit(main())
