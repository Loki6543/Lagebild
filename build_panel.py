"""Build the replay panel from the raw connector downloads in data/raw.

Every series is stored with the date it became knowable, so the replay can slice
"everything published on or before this Friday" and nothing later:
  prices        bar date (close known that day)
  DGS10, DFII10 observation date + 1 day
  DTB3          observation date (only used to accrue cash, never as a signal)
  Fed funds     monthly average of DFF, known on the 1st of the next month
  CPI (NSA)     known on the 15th of the next month; the NSA series is never revised,
                so its current values equal what was published at the time

Prices are split-adjusted closes from Twelve Data. A separate total-return index adds
dividends (Alpha Vantage) on their ex-dates; the engine sees prices, the P&L uses total return.
IAUM did not exist before 2021-07-01, so its earlier history is GLD's daily returns.
"""
import csv
import datetime as dt
import hashlib
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'data', 'raw')
OUT = os.path.join(HERE, 'data', 'panel')

EQ = ['VOO', 'SMH', 'NVDA', 'MSFT', 'TSM', 'XLE', 'IAUM', 'GDX']
CX = ['BTC', 'ETH', 'SOL', 'LINK']
# dividends paid before a split are reported per pre-split share; the prices are split-adjusted
SPLIT_BEFORE = {'XLE': ('2025-12-01', 2.0), 'SMH': ('2023-05-05', 2.0)}
DIVS = ['VOO', 'SMH', 'MSFT', 'TSM', 'XLE', 'GDX']   # NVDA (about 0.03% a year) is left out


def read_td(sym):
    text = json.load(open(os.path.join(RAW, sym + '.json')))['result']
    rows = {}
    for ln in text.strip().split('\n')[1:]:
        f = ln.split(';')
        rows[f[0][:10]] = float(f[4])
    return dict(sorted(rows.items()))


def read_fred(name):
    out = []
    with open(os.path.join(RAW, 'FRED_' + name + '.csv')) as fh:
        for r in csv.reader(fh):
            if r[0].startswith('observation') or len(r) < 2 or r[1] in ('', '.'):
                continue
            out.append((r[0], float(r[1])))
    return out


def shift(iso, days):
    return (dt.date.fromisoformat(iso) + dt.timedelta(days=days)).isoformat()


def next_month(iso, day):
    d = dt.date.fromisoformat(iso)
    y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return dt.date(y, m, day).isoformat()


def splice_iaum(iaum, gld):
    first = min(iaum)
    out = dict(iaum)
    dates = sorted(d for d in gld if d <= first)
    level = iaum[first]
    for a, b in zip(reversed(dates[:-1]), reversed(dates[1:])):
        level = level * gld[a] / gld[b]
        out[a] = level
    return dict(sorted(out.items()))


def total_return(px, divs):
    dates = sorted(px)
    tr, level = {}, 1.0
    for i, d in enumerate(dates):
        if i:
            r = (px[d] + divs.get(d, 0.0)) / px[dates[i - 1]]
            level *= r
        tr[d] = level
    return tr


def load_divs(sym, px):
    out = {}
    with open(os.path.join(RAW, 'DIV_' + sym + '.csv')) as fh:
        for r in csv.DictReader(fh):
            d, a = r['ex_dividend_date'], float(r['amount'])
            if sym in SPLIT_BEFORE and d < SPLIT_BEFORE[sym][0]:
                a /= SPLIT_BEFORE[sym][1]
            # credit on the first trading day on or after the ex-date
            nxt = [x for x in px if x >= d]
            if nxt:
                out[nxt[0]] = out.get(nxt[0], 0.0) + a
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    px = {s: read_td(s) for s in EQ + CX + ['GLD']}
    px['IAUM'] = splice_iaum(px['IAUM'], px.pop('GLD'))
    tr = {}
    for s in EQ + CX:
        divs = load_divs(s, sorted(px[s])) if s in DIVS else {}
        tr[s] = total_return(px[s], divs)

    dff = read_fred('DFF')
    months = {}
    for d, v in dff:
        months.setdefault(d[:7], []).append(v)
    ff = [(next_month(m + '-01', 1), round(sum(v) / len(v), 4)) for m, v in sorted(months.items())]
    # the current month's average is not complete until it ends
    ff = [x for x in ff if x[0] <= shift(dff[-1][0], 1)]
    cpi = [(next_month(d, 15), v) for d, v in read_fred('CPIAUCNS')]
    panel = {
        'built': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'assets': EQ + CX,
        'px': {s: [[d, round(c, 6)] for d, c in px[s].items()] for s in EQ + CX},
        'tr': {s: [[d, round(c, 8)] for d, c in tr[s].items()] for s in EQ + CX},
        'macro': {
            'tsy10': [[shift(d, 1), v] for d, v in read_fred('DGS10') if d >= '2018-01-01'],
            'real': [[shift(d, 1), v] for d, v in read_fred('DFII10') if d >= '2018-01-01'],
            'ff': [[d, v] for d, v in ff if d >= '2018-01-01'],
            'cpi': [[d, v] for d, v in cpi],
        },
        'tbill': [[d, v] for d, v in read_fred('DTB3') if d >= '2019-01-01'],
    }
    with open(os.path.join(OUT, 'panel.json'), 'w') as fh:
        json.dump(panel, fh)
    manifest = {}
    for f in sorted(os.listdir(RAW)):
        manifest[f] = hashlib.sha256(open(os.path.join(RAW, f), 'rb').read()).hexdigest()
    with open(os.path.join(HERE, 'data', 'MANIFEST.json'), 'w') as fh:
        json.dump({'note': 'SHA-256 of each raw download; raw files are not committed (provider terms).', 'files': manifest}, fh, indent=1)
    for s in EQ + CX:
        p = px[s]
        first, last = min(p), max(p)
        yrs = (dt.date.fromisoformat(last) - dt.date.fromisoformat(first)).days / 365.25
        div_yield = (tr[s][last] / tr[s][first]) ** (1 / yrs) / (p[last] / p[first]) ** (1 / yrs) - 1
        print('%-5s %s..%s %5d bars  dividend yield %.2f%%/yr' % (s, first, last, len(p), div_yield * 100))


if __name__ == '__main__':
    main()
