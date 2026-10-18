"""Build the replay panel from the raw connector downloads in data/raw.

Every series is stored with the date it became knowable, so the replay can slice
"everything published on or before this Friday" and nothing later:
  prices        bar date (close known that day)
  DGS10, DFII10 observation date + 1 day
  DTB3          observation date (only used to accrue cash, never as a signal)
  Fed funds     monthly average of DFF, known on the 1st of the next month
  CPI (NSA)     known on its BLS release date (CPI_RELEASED, Jan 2017-Sep 2026), else on the
                25th of the next month, no earlier than any recorded release (latest: the 24th).
                October 2025 was never published. Each row keeps its
                observation month so year-on-year compares months, not release spacing.
                Unadjusted CPI-U is ordinarily final when published.

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


# BLS CPI release dates (bls.gov/bls/news-release/cpi.htm archive file names, read 2026-10-18).
# October 2025 was never published. A month missing here falls back to the conservative 25th.
CPI_RELEASED = {
    '2017-01': '2017-02-15', '2017-02': '2017-03-15', '2017-03': '2017-04-14', '2017-04': '2017-05-12',
    '2017-05': '2017-06-14', '2017-06': '2017-07-14', '2017-07': '2017-08-11', '2017-08': '2017-09-14',
    '2017-09': '2017-10-13', '2017-10': '2017-11-15', '2017-11': '2017-12-13', '2017-12': '2018-01-12',
    '2018-01': '2018-02-14', '2018-02': '2018-03-13', '2018-03': '2018-04-11', '2018-04': '2018-05-10',
    '2018-05': '2018-06-12', '2018-06': '2018-07-12', '2018-07': '2018-08-10', '2018-08': '2018-09-13',
    '2018-09': '2018-10-11', '2018-10': '2018-11-14', '2018-11': '2018-12-12', '2018-12': '2019-01-11',
    '2019-01': '2019-02-13', '2019-02': '2019-03-12', '2019-03': '2019-04-10', '2019-04': '2019-05-10',
    '2019-05': '2019-06-12', '2019-06': '2019-07-11', '2019-07': '2019-08-13', '2019-08': '2019-09-12',
    '2019-09': '2019-10-10', '2019-10': '2019-11-13', '2019-11': '2019-12-11', '2019-12': '2020-01-14',
    '2020-01': '2020-02-13', '2020-02': '2020-03-11', '2020-03': '2020-04-10', '2020-04': '2020-05-12',
    '2020-05': '2020-06-10', '2020-06': '2020-07-14', '2020-07': '2020-08-12', '2020-08': '2020-09-11',
    '2020-09': '2020-10-13', '2020-10': '2020-11-12', '2020-11': '2020-12-10', '2020-12': '2021-01-13',
    '2021-01': '2021-02-10', '2021-02': '2021-03-10', '2021-03': '2021-04-13', '2021-04': '2021-05-12',
    '2021-05': '2021-06-10', '2021-06': '2021-07-13', '2021-07': '2021-08-11', '2021-08': '2021-09-14',
    '2021-09': '2021-10-13', '2021-10': '2021-11-10', '2021-11': '2021-12-10', '2021-12': '2022-01-12',
    '2022-01': '2022-02-10', '2022-02': '2022-03-10', '2022-03': '2022-04-12', '2022-04': '2022-05-11',
    '2022-05': '2022-06-10', '2022-06': '2022-07-13', '2022-07': '2022-08-10', '2022-08': '2022-09-13',
    '2022-09': '2022-10-13', '2022-10': '2022-11-10', '2022-11': '2022-12-13', '2022-12': '2023-01-12',
    '2023-01': '2023-02-14', '2023-02': '2023-03-14', '2023-03': '2023-04-12', '2023-04': '2023-05-10',
    '2023-05': '2023-06-13', '2023-06': '2023-07-12', '2023-07': '2023-08-10', '2023-08': '2023-09-13',
    '2023-09': '2023-10-12', '2023-10': '2023-11-14', '2023-11': '2023-12-12', '2023-12': '2024-01-11',
    '2024-01': '2024-02-13', '2024-02': '2024-03-12', '2024-03': '2024-04-10', '2024-04': '2024-05-15',
    '2024-05': '2024-06-12', '2024-06': '2024-07-11', '2024-07': '2024-08-14', '2024-08': '2024-09-11',
    '2024-09': '2024-10-10', '2024-10': '2024-11-13', '2024-11': '2024-12-11', '2024-12': '2025-01-15',
    '2025-01': '2025-02-12', '2025-02': '2025-03-12', '2025-03': '2025-04-10', '2025-04': '2025-05-13',
    '2025-05': '2025-06-11', '2025-06': '2025-07-15', '2025-07': '2025-08-12', '2025-08': '2025-09-11',
    '2025-09': '2025-10-24', '2025-11': '2025-12-18', '2025-12': '2026-01-13', '2026-01': '2026-02-13',
    '2026-02': '2026-03-11', '2026-03': '2026-04-10', '2026-04': '2026-05-12', '2026-05': '2026-06-10',
    '2026-06': '2026-07-14', '2026-07': '2026-08-12', '2026-08': '2026-09-11', '2026-09': '2026-10-14',
}


def cpi_available(obs):
    return CPI_RELEASED.get(obs[:7], next_month(obs, 25))


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
    cpi = [(cpi_available(d), v, d[:7]) for d, v in read_fred('CPIAUCNS')]
    panel = {
        'built': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'assets': EQ + CX,
        'px': {s: [[d, round(c, 6)] for d, c in px[s].items()] for s in EQ + CX},
        'tr': {s: [[d, round(c, 8)] for d, c in tr[s].items()] for s in EQ + CX},
        'macro': {
            'tsy10': [[shift(d, 1), v] for d, v in read_fred('DGS10') if d >= '2018-01-01'],
            'real': [[shift(d, 1), v] for d, v in read_fred('DFII10') if d >= '2018-01-01'],
            'ff': [[d, v] for d, v in ff if d >= '2018-01-01'],
            'cpi': [[d, v, p] for d, v, p in cpi],
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
