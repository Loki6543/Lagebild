"""Score every replay configuration and test whether any edge over the base plan survives.

Reads results/runs/*.json (written by run_replay.js) and writes results/summary.json and
results/REPORT.md. Usage: .venv/bin/python analyze.py
"""
import datetime as dt
import glob
import json
import math
import os

import numpy as np

import stats as S

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, 'results', 'runs')
RISK_AVERSION = 1.5           # CE = annual mean excess return - 1.5 x annual variance
KEY = ['base', 'base_gate10', 'v3', 'v3_dd', 'v3_nocaps', 'v3_nogate']


def load():
    order = json.load(open(os.path.join(HERE, 'results', 'configs.json')))['configs']
    runs = {}
    for c in order:
        f = os.path.join(RUNS, c['id'] + '.json')
        if os.path.exists(f):
            runs[c['id']] = json.load(open(f))
    return runs


def weekly_excess(run):
    w = np.array([[x[1], x[2]] for x in run['weekly']], float)
    r = w[1:, 0] / w[:-1, 0] - 1
    rf = w[1:, 1] / w[:-1, 1] - 1
    return r, r - rf


def ce(excess):
    return float(excess.mean() * 52 - RISK_AVERSION * excess.var(ddof=1) * 52)


def max_drawdown(daily):
    nav = np.array([x[1] for x in daily], float)
    peak = np.maximum.accumulate(nav)
    dd = 1 - nav / peak
    i = int(dd.argmax())
    j = int(nav[:i + 1].argmax())
    under, longest = 0, 0
    for k in range(len(nav)):
        under = under + 1 if nav[k] < peak[k] else 0
        longest = max(longest, under)
    return float(dd.max()), daily[j][0], daily[i][0], longest


def calendar_returns(daily):
    out, prev = {}, None
    by_year = {}
    for d, v in daily:
        by_year[d[:4]] = v
    first = daily[0][1]
    for y in sorted(by_year):
        start = prev if prev is not None else first
        out[y] = by_year[y] / start - 1
        prev = by_year[y]
    return out


def metrics(run):
    r, ex = weekly_excess(run)
    nav_end = run['daily'][-1][1]
    mdd, peak_d, trough_d, under = max_drawdown(run['daily'])
    return {
        'cagr': nav_end ** (1 / run['years']) - 1,
        'vol': float(r.std(ddof=1) * math.sqrt(52)),
        'sharpe': float(S.sharpe(ex) * math.sqrt(52)),
        'ce': ce(ex),
        'maxdd': mdd, 'maxdd_from': peak_d, 'maxdd_to': trough_d, 'longest_underwater_days': under,
        'turnover': run['turnoverOneWayPerYear'],
        'years': calendar_returns(run['daily']),
        'blocked_weeks': run['blockedWeeks'],
    }


def main():
    runs = load()
    ids = list(runs)
    ex = {k: weekly_excess(runs[k])[1] for k in ids}
    M = np.column_stack([ex[k] for k in ids])
    res = {k: metrics(runs[k]) for k in ids}

    # paired stationary bootstrap: difference in CE and in Sharpe against the plain base plan
    for k in ids:
        if k == 'base':
            continue
        lo, hi, _ = S.stationary_bootstrap_ci(lambda a, b: ce(a) - ce(b), [ex[k], ex['base']])
        res[k]['ce_gain_vs_base'] = ce(ex[k]) - ce(ex['base'])
        res[k]['ce_gain_ci95'] = [lo, hi]
        lo2, hi2, _ = S.stationary_bootstrap_ci(lambda a, b: ce(a) - ce(b), [ex[k], ex['base_gate10']])
        res[k]['ce_gain_vs_gate'] = ce(ex[k]) - ce(ex['base_gate10'])
        res[k]['ce_gain_vs_gate_ci95'] = [lo2, hi2]

    # deflated Sharpe: total excess returns, and active returns over the base plan
    n = len(ids)
    n_eff, rho = S.effective_trials(M)
    srs = np.array([S.sharpe(ex[k]) for k in ids])
    active = {k: ex[k] - ex['base'] for k in ids if k != 'base'}
    act_srs = np.array([S.sharpe(v) for v in active.values()])
    for k in ids:
        res[k]['dsr_total'], sr_star = S.deflated_sharpe(ex[k], srs, n)
        res[k]['dsr_total_neff'], _ = S.deflated_sharpe(ex[k], srs, n_eff)
        if k in active:
            res[k]['psr_active'] = S.psr(active[k], 0.0)
            res[k]['dsr_active'], act_star = S.deflated_sharpe(active[k], act_srs, n - 1)

    pbo, logits = S.pbo_cscv(M, n_blocks=16)
    regime = S.trial_correlation_by_regime(M, ex['base'])
    # a simple walk-forward reading: pick the best CE in the first half, see where it lands in the second
    half = len(M) // 2
    first = {k: ce(ex[k][:half]) for k in ids}
    second = {k: ce(ex[k][half:]) for k in ids}
    pick = max(first, key=first.get)
    rank2 = sorted(second, key=second.get, reverse=True).index(pick) + 1
    split = runs['base']['weekly'][half][0]

    summary = {
        'generated': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'engine': runs['v3']['engine'], 'start': runs['v3']['start'], 'end': runs['v3']['end'],
        'weeks': int(len(M)), 'trials': n, 'avg_trial_correlation': rho, 'effective_trials': n_eff,
        'sr_star_weekly': sr_star, 'pbo': pbo, 'pbo_logit_median': float(np.median(logits)),
        'trial_correlation_by_regime': regime,
        'walk_forward': {'split': split, 'first_half_best': pick, 'its_second_half_rank': rank2, 'of': n},
        'configs': {k: dict(label=runs[k]['label'], **res[k]) for k in ids},
    }
    with open(os.path.join(HERE, 'results', 'summary.json'), 'w') as fh:
        json.dump(summary, fh, indent=1)
    write_report(summary, ids)
    print(open(os.path.join(HERE, 'results', 'REPORT.md')).read())


def pct(x, d=1):
    return ('%.' + str(d) + 'f%%') % (x * 100)


def write_report(s, ids):
    c = s['configs']
    L = []
    L.append('# Zobiris Lagebild replay, %s to %s' % (s['start'], s['end']))
    L.append('')
    L.append('Generated %s by `analyze.py` from the shipped engine (%s). %d weekly decisions, %d configurations, every one kept.' % (s['generated'][:10], s['engine'], s['weeks'] + 1, s['trials']))
    L.append('')
    L.append('## All configurations')
    L.append('')
    L.append('| Configuration | CAGR | Vol | Max DD | CE | Sharpe | Turnover | CE gain vs base (95% CI) | DSR |')
    L.append('|---|---:|---:|---:|---:|---:|---:|---|---:|')
    for k in sorted(ids, key=lambda k: -c[k]['ce']):
        x = c[k]
        gain = '' if k == 'base' else '%+.1f (%+.1f to %+.1f)' % (x['ce_gain_vs_base'] * 100, x['ce_gain_ci95'][0] * 100, x['ce_gain_ci95'][1] * 100)
        L.append('| %s | %s | %s | %s | %s | %.2f | %s | %s | %.2f |' % (x['label'], pct(x['cagr']), pct(x['vol']), pct(x['maxdd']), pct(x['ce']), x['sharpe'], pct(x['turnover'], 0), gain, x['dsr_total']))
    L.append('')
    L.append('CE is the certainty-equivalent return: annual mean excess return over T-bills minus 1.5 times its annual variance. Turnover is one-way. DSR is the probability that the true Sharpe ratio beats what the best of %d unskilled configurations would show by luck; 0.95 or higher would count as significant. Against zero it is close to 1 for every row, because every configuration earned a high Sharpe ratio in a strong market; it says the period was good, not that any rule worked. The active test below is the one that matters.' % s['trials'])
    L.append('')
    L.append('## Does anything beat the plain base plan?')
    L.append('')
    L.append('| Configuration | Active PSR | Active DSR | CE gain vs base + gate (95% CI) |')
    L.append('|---|---:|---:|---|')
    for k in ids:
        if k in ('base', 'base_gate10'):
            continue
        x = c[k]
        L.append('| %s | %.2f | %.2f | %+.1f (%+.1f to %+.1f) |' % (x['label'], x['psr_active'], x['dsr_active'], x['ce_gain_vs_gate'] * 100, x['ce_gain_vs_gate_ci95'][0] * 100, x['ce_gain_vs_gate_ci95'][1] * 100))
    L.append('')
    L.append('Base + BTC gate (10 months) itself: active PSR %.2f, active DSR %.2f. It is the reference in the last column.' % (c['base_gate10']['psr_active'], c['base_gate10']['dsr_active']))
    L.append('')
    L.append('Active returns are each configuration minus the base plan, week by week. PSR asks whether that active Sharpe ratio is above zero; DSR also charges for the %d configurations tried.' % (s['trials'] - 1))
    L.append('')
    L.append('## Overfitting checks')
    L.append('')
    L.append('- Probability of backtest overfitting (CSCV, 16 blocks, 12,870 splits): **%s**. Above 50%% means the in-sample winner usually lands in the bottom half out of sample.' % pct(s['pbo'], 0))
    L.append('- The configurations move together (average weekly correlation %.2f), so the %d trials count as about %.1f independent ones.' % (s['avg_trial_correlation'], s['trials'], s['effective_trials']))
    rg = s.get('trial_correlation_by_regime') or {}
    if rg.get('stress_rho') is not None and rg.get('calm_rho') is not None:
        L.append('- In the worst 10%% of base-plan weeks (%d) the configurations correlate at %.2f (about %.1f independent trials); in the other %d weeks at %.2f (%.1f).' % (rg['stress_weeks'], rg['stress_rho'], rg['stress_n_eff'], rg['calm_weeks'], rg['calm_rho'], rg['calm_n_eff']))
    wf = s['walk_forward']
    L.append('- Walk forward: the best configuration before %s was **%s**; after that date it ranked %d of %d.' % (wf['split'], c[wf['first_half_best']]['label'], wf['its_second_half_rank'], wf['of']))
    L.append('')
    L.append('## Calendar years')
    L.append('')
    years = sorted(c['base']['years'])
    L.append('| Configuration | ' + ' | '.join(years) + ' |')
    L.append('|---|' + '---:|' * len(years))
    for k in KEY:
        if k in c:
            L.append('| %s | ' % c[k]['label'] + ' | '.join(pct(c[k]['years'][y], 0) for y in years) + ' |')
    L.append('')
    L.append('2021 starts on %s; 2026 ends on %s.' % (s['start'], s['end']))
    with open(os.path.join(HERE, 'results', 'REPORT.md'), 'w') as fh:
        fh.write('\n'.join(L) + '\n')


if __name__ == '__main__':
    main()
