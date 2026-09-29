"""
CornerstoreAI – täglicher Preis-Abruf
=====================================

Läuft automatisch jeden Morgen über GitHub Actions (siehe .github/workflows/preise.yml).

Ablauf:
  1. Alle Konten mit Postleitzahl und ihre Produkte aus Supabase laden
  2. Pro Produkt die aktuellen Prospekt-Angebote in der Nähe suchen (marktguru),
     die Regalpreise bei Aldi Süd und Aldi Nord von deren Websites lesen
     und – falls ein Barcode (EAN) hinterlegt ist – gemeldete Normalpreise aus Open Prices
     (Open Food Facts, offene Daten unter ODbL-Lizenz) holen
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
        if len(a) < 2:
            continue
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


OPENPRICES_API = "https://prices.openfoodfacts.org/api/v1/prices"
OP_MAX_AGE_DAYS = 180       # ältere Meldungen ignorieren
OP_UA = "CornerstoreAI/1.0 (Preisvergleich fuer Spaetis)"


class OpenPrices:
    """Normalpreise, die Nutzer bei Open Prices gemeldet haben – abgefragt per Barcode (EAN)."""

    def __init__(self):
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": OP_UA, "Accept": "application/json"})
        self.cache: dict[str, list[dict]] = {}

    def prices(self, ean: str, since: dt.date) -> list[dict]:
        if ean in self.cache:
            return self.cache[ean]
        time.sleep(0.5)
        r = self.s.get(OPENPRICES_API, params={
            "product_code": ean, "currency": "EUR", "date__gte": since.isoformat(),
            "order_by": "-date", "size": 100, "app_name": "CornerstoreAI"}, timeout=30)
        r.raise_for_status()
        items = r.json().get("items", [])
        self.cache[ean] = items
        return items


class DemoOpenPrices:
    def __init__(self, path: str):
        with open(path, encoding="utf-8") as f:
            self.data = json.load(f)

    def prices(self, ean: str, since: dt.date) -> list[dict]:
        return [i for i in self.data.get(ean, []) if (i.get("date") or "") >= since.isoformat()]


def op_regular_rows(product: dict, items: list[dict], retailers: list[str], zip_code: str) -> list[dict]:
    """Pro Händler die passendste Open-Prices-Meldung: gleiche PLZ-Region zuerst, dann die neueste."""
    best: dict[str, tuple] = {}
    for it in items:
        loc = it.get("location") or {}
        if (loc.get("osm_address_country_code") or "").upper() not in ("DE", ""):
            continue
        if (it.get("price_per") or "UNIT") != "UNIT":
            continue
        try:
            price = float(it.get("price"))
            if it.get("price_is_discounted"):
                price = float(it.get("price_without_discount") or 0)  # Angebote kommen aus den Prospekten
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        ret = retailer_for([loc.get("osm_brand") or "", loc.get("osm_name") or ""], retailers)
        if not ret:
            continue
        same_region = (loc.get("osm_address_postcode") or "")[:2] == zip_code[:2]
        key = (same_region, it.get("date") or "")
        if ret not in best or key > best[ret][0]:
            where = " ".join(x for x in [loc.get("osm_name") or ret, loc.get("osm_address_city") or ""] if x)
            best[ret] = (key, price, it.get("date"), where)
    rows = []
    for ret, (_, price, date, where) in best.items():
        rows.append({
            "user_id": product["user_id"], "product_id": product["id"], "retailer": ret,
            "ext_key": "regular-op", "price": round(price, 2), "regular_price": round(price, 2),
            "is_offer": False, "valid_from": date, "valid_to": None, "source": "openprices",
            "title": f"Open Prices: gemeldet am {date} in {where}"[:300], "pack_count": 1, "pack_price": None,
            "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        })
    return rows


# ---------------------------------------------------------------------------
# Aldi Süd – Regalpreise von der öffentlichen Website
# Aldi erlaubt Programmen laut robots.txt das Lesen der Produktseiten und der
# Produkt-Sitemap (nicht aber der Suche). Wir lesen daher die Sitemap, suchen den
# passenden Artikel über den Namen in der Adresse und holen dann nur diese Seite.
# ---------------------------------------------------------------------------
ALDI_SUED_SITEMAP = "https://www.aldi-sued.de/sitemap_products.xml"
ALDI_RETAILER_KEYS = ("aldisued", "aldisud")


def slug_text(url: str) -> str:
    """'.../produkt/red-bull-energy-drink-250-ml-000000000000444184' -> 'red bull energy drink 250 ml'"""
    slug = url.rstrip("/").rsplit("/", 1)[-1]
    slug = re.sub(r"-?\d{12,}$", "", slug)                       # Artikelnummer am Ende weg
    slug = re.sub(r"(\d+)-(\d+)-(l|ml|cl|kg|g)\b", r"\1,\2-\3", slug)   # 0-5-l -> 0,5-l
    return slug.replace("-", " ")


def parse_aldi_price(html: str) -> tuple[float | None, float | None]:
    """Gibt (aktueller Preis, Normalpreis falls Angebot) zurück. Mehrere Wege, falls Aldi das Layout ändert."""
    # 1) strukturierte Daten
    for m in re.finditer(r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>', html, re.S):
        try:
            data = json.loads(m.group(1))
        except ValueError:
            continue
        for d in (data if isinstance(data, list) else [data]):
            offers = d.get("offers") if isinstance(d, dict) else None
            if isinstance(offers, list):
                offers = offers[0] if offers else None
            if isinstance(offers, dict) and offers.get("price"):
                try:
                    return float(str(offers["price"]).replace(",", ".")), None
                except ValueError:
                    pass
    # 2) sichtbarer Text: "0,89 € inkl. MwSt."
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"&nbsp;|&#160;", " ", text)
    text = re.sub(r"\s+", " ", text)
    m = re.search(r"(\d{1,3},\d{2})\s*€\s*inkl\.?\s*MwSt", text)
    if not m:
        return None, None
    price = float(m.group(1).replace(",", "."))
    before = text[max(0, m.start() - 160):m.start()]
    old = re.search(r"(?:statt|UVP|vorher|bisher)\s*(\d{1,3},\d{2})\s*€", before, re.I)
    old_price = float(old.group(1).replace(",", ".")) if old else None
    return price, (old_price if old_price and old_price > price else None)


class AldiSued:
    LABEL = "Aldi-Süd-Website"

    def __init__(self):
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9"})
        self._index: list[tuple[str, str]] | None = None
        self.pages: dict[str, tuple] = {}

    def index(self) -> list[tuple[str, str]]:
        if self._index is None:
            xml = self.s.get(ALDI_SUED_SITEMAP, timeout=60).text
            urls = re.findall(r"<loc>\s*([^<\s]+/produkt/[^<\s]+)\s*</loc>", xml)
            self._index = [(u, slug_text(u)) for u in urls]
            print(f"  Aldi Süd: {len(self._index)} Produkte in der Sitemap")
        return self._index

    def price(self, url: str) -> tuple:
        if url not in self.pages:
            time.sleep(PAUSE_SEC)
            r = self.s.get(url, timeout=30)
            r.raise_for_status()
            self.pages[url] = parse_aldi_price(r.text)
        return self.pages[url]


class DemoAldi(AldiSued):
    def __init__(self, path: str):
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        self._index = [(u, slug_text(u)) for u in d["urls"]]
        self.html = d["pages"]
        self.pages = {}

    def price(self, url):
        return parse_aldi_price(self.html.get(url, ""))


# ---------------------------------------------------------------------------
# Aldi Nord – Regalpreise von der öffentlichen Website
# Die Seiten sind eine Next.js-App: Name, Marke, Packungsgröße und Preis stecken als
# JSON im Seitenquelltext (<script id="__NEXT_DATA__">). Die Adressen in der
# Produkt-Sitemap enthalten keine Marken – deshalb bauen wir uns einen Katalog
# (Tabelle aldi_nord_index) und frischen ihn jeden Tag stückweise auf.
# ---------------------------------------------------------------------------
ALDI_NORD_SITEMAP = "https://www.aldi-nord.de/sitemaps/.aldi-nord-sitemap-products.xml"
ALDI_NORD_KEYS = ("aldinord",)
ALDI_NORD_REFRESH_PER_RUN = 800        # max. Produktseiten pro Lauf (erster Lauf ca. 8 Min., danach nur veraltete)
ALDI_NORD_MAX_AGE_DAYS = 4             # danach wird ein Eintrag neu gelesen


def _walk(o):
    if isinstance(o, dict):
        yield o
        for v in o.values():
            yield from _walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from _walk(v)


def _num(v):
    try:
        return float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None


def parse_aldi_nord(html: str, url: str) -> dict | None:
    """Liest Marke, Name, Packungsgröße und Preis aus einer Aldi-Nord-Produktseite."""
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    items = []
    if m:
        try:
            data = json.loads(m.group(1))
            api = (data.get("props") or {}).get("pageProps", {}).get("apiData")
            roots = [data]
            if isinstance(api, str):
                try:
                    roots.append(json.loads(api))
                except ValueError:
                    pass
            for root in roots:
                for d in _walk(root):
                    cp = d.get("currentPrice")
                    if isinstance(cp, dict) and _num(cp.get("priceValue")) and (d.get("name") or d.get("productName")):
                        items.append(d)
        except ValueError:
            items = []
    if items:
        ids = set(re.findall(r"\d{3,}", url.rsplit("/", 1)[-1]))
        def score(d):   # der Artikel, dessen Nummer in der Adresse steht, ist der Hauptartikel der Seite
            vals = {str(v) for k, v in d.items() if isinstance(v, (str, int)) and re.search(r"id|number|sku|code", k, re.I)}
            return 1 if ids & {re.sub(r"\D", "", v) for v in vals} else 0
        d = sorted(items, key=score, reverse=True)[0]
        cp = d["currentPrice"]
        price = _num(cp.get("priceValue"))
        old = None
        for k, v in list(cp.items()) + list(d.items()):
            if re.search(r"strike|old|former|uvp|regular", str(k), re.I):
                n = _num(v.get("priceValue") if isinstance(v, dict) else v)
                if n and price and n > price:
                    old = n
        return {"brand": (d.get("brandName") or d.get("brand") or "").strip() if isinstance(d.get("brandName") or d.get("brand") or "", str) else "",
                "name": (d.get("name") or d.get("productName") or "").strip(),
                "sales_unit": (d.get("salesUnit") or d.get("packaging") or "").strip() if isinstance(d.get("salesUnit") or "", str) else "",
                "price": price, "old_price": old}
    # Rückfall: sichtbarer Text + Seitentitel
    price, old = parse_aldi_price(html)
    if not price:
        return None
    t = re.search(r'<meta[^>]+property="og:title"[^>]+content="([^"]+)"', html) or re.search(r"<title>(.*?)</title>", html, re.S)
    title = re.sub(r"\s*(\||–|-)\s*ALDI.*$", "", (t.group(1) if t else ""), flags=re.I).strip()
    unit = re.search(r"(\d+\s*x\s*)?\d+(?:,\d+)?\s*-?\s*(?:ml|l|g|kg)\b", re.sub(r"<[^>]+>", " ", html))
    return {"brand": "", "name": title, "sales_unit": unit.group(0) if unit else "", "price": price, "old_price": old}


class AldiNord:
    LABEL = "Aldi-Nord-Website"

    def __init__(self, db):
        self.db = db
        self.s = requests.Session() if requests else None
        if self.s:
            self.s.headers.update({"User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9"})
        self._index = None
        self.cat: dict[str, dict] = {}

    def fetch(self, url: str) -> str:
        time.sleep(0.6)
        r = self.s.get(url, timeout=30)
        r.raise_for_status()
        return r.text

    def sitemap_urls(self) -> list[str]:
        xml = self.fetch(ALDI_NORD_SITEMAP)
        return re.findall(r"<loc>\s*([^<\s]+/produkt/[^<\s]+)\s*</loc>", xml)

    def refresh(self) -> None:
        """Katalog laden und die ältesten / neuen Einträge nachlesen."""
        rows = self.db.get("aldi_nord_index", {"select": "url,brand,name,sales_unit,price,old_price,updated_at"})
        self.cat = {r["url"]: r for r in rows}
        try:
            urls = self.sitemap_urls()
        except Exception as ex:  # noqa: BLE001
            print("  Hinweis: Aldi-Nord-Sitemap nicht erreichbar:", ex)
            urls = list(self.cat)
        cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=ALDI_NORD_MAX_AGE_DAYS)).isoformat()
        todo = [u for u in urls if u not in self.cat] + sorted([u for u in urls if u in self.cat and (self.cat[u].get("updated_at") or "") < cutoff],
                                                                  key=lambda u: self.cat[u].get("updated_at") or "")
        fresh, failed = [], 0
        for u in todo[:ALDI_NORD_REFRESH_PER_RUN]:
            try:
                info = parse_aldi_nord(self.fetch(u), u)
            except Exception:  # noqa: BLE001
                failed += 1
                continue
            if info and info["price"]:
                row = {"url": u, **info, "updated_at": dt.datetime.now(dt.timezone.utc).isoformat()}
                self.cat[u] = row
                fresh.append(row)
        if fresh:
            self.db.upsert("aldi_nord_index", fresh, "url")
        gone = [u for u in self.cat if urls and u not in urls]
        for u in gone:
            self.cat.pop(u, None)
        print(f"  Aldi Nord: {len(self.cat)} Produkte im Katalog, {len(fresh)} aufgefrischt, {failed} Seiten nicht lesbar")

    def index(self) -> list[tuple[str, str]]:
        if self._index is None:
            self.refresh()
            self._index = [(u, f"{r.get('brand') or ''} {r.get('name') or ''} {r.get('sales_unit') or ''}".strip()) for u, r in self.cat.items()]
        return self._index

    def price(self, url: str) -> tuple:
        r = self.cat.get(url) or {}
        return _num(r.get("price")), _num(r.get("old_price"))


class DemoAldiNord(AldiNord):
    def __init__(self, db, path: str):
        super().__init__(db)
        with open(path, encoding="utf-8") as f:
            self.demo = json.load(f)

    def fetch(self, url):
        return self.demo[url]

    def sitemap_urls(self):
        return list(self.demo)


def aldi_match(product: dict, index: list[tuple[str, str]]) -> tuple[str, str] | None:
    """Bester Treffer: alle Kernwörter + passende Größe, dabei möglichst wenige Zusatzwörter."""
    toks = core_tokens(search_term(product))
    best, best_extra = None, 99
    for url, text in index:
        fake = Offer(id="", advertisers=[], title=text, description="", price=1, old_price=None, valid_from=None, valid_to=None, full_text=text)
        if not is_match(product, fake):
            continue
        extra = len([w for w in core_tokens(text) if not any(token_in(t, [w]) for t in toks)])
        if extra < best_extra:
            best, best_extra = (url, text), extra
    return best


def aldi_rows(product: dict, aldi, retailer_label: str) -> list[dict]:
    """Regalpreis bei Aldi Süd bzw. Aldi Nord (je nach übergebenem Abrufer)."""
    hit = aldi_match(product, aldi.index())
    if not hit:
        return []
    url, text = hit
    price, old = aldi.price(url)
    if not price:
        return []
    regular = old or price
    n = pack_count(text)
    return [{
        "user_id": product["user_id"], "product_id": product["id"], "retailer": retailer_label,
        "ext_key": "regular-aldi", "price": round(regular / n, 2), "regular_price": round(regular / n, 2),
        "is_offer": False, "valid_from": dt.date.today().isoformat(), "valid_to": None, "source": "aldi",
        "title": f"{aldi.LABEL}: {text.title()}"[:300], "pack_count": n, "pack_price": regular,
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }]


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
            for ex in self.t.setdefault(table, []):
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


def run(db, mg, today: dt.date | None = None, op=None, aldi=None, aldi_nord=None) -> dict:
    today = today or dt.date.today()
    profiles = [p for p in db.get("profiles", {"select": "id,zip,retailers"}) if (p.get("zip") or "").strip()]
    products = db.get("products", {"select": "id,user_id,name,category,search_term,vat_rate,ean"})
    by_user: dict[str, list[dict]] = {}
    for p in products:
        by_user.setdefault(p["user_id"], []).append(p)

    stats = {"konten": len(profiles), "produkte": 0, "angebote": 0, "normalpreise": 0, "aldi": 0, "fehler": 0}
    offer_rows, regular_rows, op_rows, aldi_out = [], [], [], []
    op_since = today - dt.timedelta(days=OP_MAX_AGE_DAYS)
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
            for src, keys in ((aldi, ALDI_RETAILER_KEYS), (aldi_nord, ALDI_NORD_KEYS)):
                label = next((r for r in retailers if compact(r) in keys), None)
                if src and label:
                    try:
                        aldi_out += aldi_rows(prod, src, label)
                    except Exception as ex:  # noqa: BLE001  – Aldi ist optional
                        print(f"  Hinweis: {label} für '{prod['name']}' nicht erreichbar: {ex}")
            ean = (prod.get("ean") or "").strip()
            if op and ean:
                try:
                    op_rows += op_regular_rows(prod, op.prices(ean, op_since), retailers, zip_code)
                except Exception as ex:  # noqa: BLE001  – Open Prices ist optional
                    print(f"  Hinweis: Open Prices für '{prod['name']}' nicht erreichbar: {ex}")
            print(f"  {prod['name']}: {len(rows)} passende Angebote")

    stats["angebote"] = len(offer_rows)
    if offer_rows:
        db.upsert("retail_prices", offer_rows, "product_id,retailer,ext_key")
    if regular_rows:
        # je Produkt+Händler nur den neuesten Normalpreis behalten
        dedup = {(r["product_id"], r["retailer"]): r for r in regular_rows}
        db.upsert("retail_prices", list(dedup.values()), "product_id,retailer,ext_key")

    stats["aldi"] = len(aldi_out)
    if aldi_out:
        db.upsert("retail_prices", aldi_out, "product_id,retailer,ext_key")
    stats["normalpreise"] = len(op_rows)
    if op_rows:
        db.upsert("retail_prices", op_rows, "product_id,retailer,ext_key")
    # zu alte Open-Prices-Meldungen entfernen
    db.delete("retail_prices", {"source": "eq.openprices", "valid_from": f"lt.{(today - dt.timedelta(days=OP_MAX_AGE_DAYS)).isoformat()}"})

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
        op = DemoOpenPrices(os.path.join(here, "demo_openprices.json"))
        aldi = DemoAldi(os.path.join(here, "demo_aldi.json"))
        aldi_nord = DemoAldiNord(db, os.path.join(here, "demo_aldinord.json"))
    else:
        url, key = os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_SERVICE_KEY", "")
        if not url or not key:
            print("FEHLER: SUPABASE_URL oder SUPABASE_SERVICE_KEY fehlt (GitHub → Settings → Secrets).")
            return 1
        db, mg, op, aldi = Supabase(url, key), Marktguru(), OpenPrices(), AldiSued()
        aldi_nord = AldiNord(db)

    run_row = db.insert("collector_runs", {"status": "läuft"})
    try:
        stats = run(db, mg, op=op, aldi=aldi, aldi_nord=aldi_nord)
        msg = f"{stats['konten']} Konten, {stats['produkte']} Produkte, {stats['angebote']} Angebote, {stats['normalpreise']} Normalpreise, {stats['aldi']} Aldi-Preise, {stats['fehler']} Fehler"
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
