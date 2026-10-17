"""Validation statistics for the replay, written from the primary papers.

Deflated Sharpe Ratio: Bailey and Lopez de Prado (2014), "The Deflated Sharpe Ratio".
Probability of Backtest Overfitting via CSCV: Bailey, Borwein, Lopez de Prado and Zhu (2015),
"The Probability of Backtest Overfitting".
Stationary bootstrap: Politis and Romano (1994).
All Sharpe ratios here are per observation (weekly), never annualized, as the DSR formula requires.
"""
import itertools
import math

import numpy as np
from scipy import stats

EULER_GAMMA = 0.5772156649015329


def sharpe(x):
    x = np.asarray(x, float)
    s = x.std(ddof=1)
    return float(x.mean() / s) if s > 0 else 0.0


def psr(x, sr_star):
    """Probabilistic Sharpe Ratio: probability that the true per-period Sharpe exceeds sr_star."""
    x = np.asarray(x, float)
    t = len(x)
    sr = sharpe(x)
    g3 = float(stats.skew(x))
    g4 = float(stats.kurtosis(x, fisher=False))   # raw kurtosis, 3 for a normal distribution
    denom = 1 - g3 * sr + (g4 - 1) / 4 * sr * sr
    return float(stats.norm.cdf((sr - sr_star) * math.sqrt(t - 1) / math.sqrt(max(denom, 1e-12))))


def expected_max_sharpe(sr_variance, n_trials):
    """SR*: the Sharpe ratio the best of n_trials unskilled strategies is expected to reach."""
    if n_trials <= 1:
        return 0.0
    z = stats.norm.ppf
    return math.sqrt(sr_variance) * ((1 - EULER_GAMMA) * z(1 - 1 / n_trials) + EULER_GAMMA * z(1 - 1 / (n_trials * math.e)))


def effective_trials(returns_matrix):
    """N_eff = rho + (1 - rho) N, with rho the average pairwise correlation of the trials."""
    m = np.asarray(returns_matrix, float)
    n = m.shape[1]
    if n < 2:
        return 1.0, 1.0
    c = np.corrcoef(m.T)
    rho = (c.sum() - n) / (n * (n - 1))
    return float(rho + (1 - rho) * n), float(rho)


def deflated_sharpe(x, trial_srs, n_trials):
    sr_star = expected_max_sharpe(float(np.var(trial_srs, ddof=1)), n_trials)
    return psr(x, sr_star), sr_star


def cvar(returns, alpha=0.95):
    """Historical expected shortfall: the mean of the worst (1 - alpha) share of returns, as a positive loss.

    Uses the fractional weight on the boundary observation (Rockafellar and Uryasev 2002), so it is exact for
    any sample size rather than rounding the tail count."""
    x = np.sort(np.asarray(returns, float))
    if x.size == 0 or not np.isfinite(x).all() or not 0 < alpha < 1:
        raise ValueError('cvar needs finite returns and 0 < alpha < 1')
    k = (1 - alpha) * x.size
    n = int(math.floor(k))
    tail = x[:n].sum() + (k - n) * (x[n] if n < x.size else 0.0)
    return float(-tail / k)


def trial_correlation_by_regime(returns_matrix, proxy, stress_quantile=0.10, min_rows=10):
    """Average pairwise trial correlation in stress weeks (proxy at or below its stress_quantile) and in the rest.

    Returns None for a regime with fewer than min_rows weeks rather than assuming a value."""
    m = np.asarray(returns_matrix, float)
    p = np.asarray(proxy, float)
    stress = p <= np.quantile(p, stress_quantile)
    out = {'stress_weeks': int(stress.sum()), 'calm_weeks': int((~stress).sum())}
    for name, mask in (('stress', stress), ('calm', ~stress)):
        if mask.sum() < min_rows or m.shape[1] < 2:
            out[name + '_rho'], out[name + '_n_eff'] = None, None
        else:
            n_eff, rho = effective_trials(m[mask])
            out[name + '_rho'], out[name + '_n_eff'] = rho, n_eff
    return out


def pbo_cscv(returns_matrix, n_blocks=16, metric=sharpe):
    """Probability that the in-sample best configuration ranks below the out-of-sample median."""
    m = np.asarray(returns_matrix, float)
    t, n = m.shape
    if n < 2 or n_blocks < 2 or n_blocks % 2 or t < 2 * n_blocks:
        # Too few rows per block (or trials) leaves the split undefined; refuse instead of returning 1.0.
        raise ValueError('pbo_cscv needs >= 2 trials, an even n_blocks >= 2 and >= 2 rows per block '
                         '(got %d rows, %d trials, %d blocks)' % (t, n, n_blocks))
    t_use = t - t % n_blocks
    blocks = np.array_split(m[t - t_use:], n_blocks)
    logits = []
    for is_idx in itertools.combinations(range(n_blocks), n_blocks // 2):
        oos_idx = [b for b in range(n_blocks) if b not in is_idx]
        ins = np.vstack([blocks[b] for b in is_idx])
        oos = np.vstack([blocks[b] for b in oos_idx])
        perf_is = np.array([metric(ins[:, j]) for j in range(n)])
        perf_oos = np.array([metric(oos[:, j]) for j in range(n)])
        best = int(np.argmax(perf_is))
        rank = stats.rankdata(perf_oos)[best]           # 1 = worst, n = best
        w = rank / (n + 1)
        logits.append(math.log(w / (1 - w)))
    logits = np.array(logits)
    return float((logits <= 0).mean()), logits


def stationary_bootstrap_ci(stat_fn, arrays, mean_block=8, draws=5000, seed=20261017, alpha=0.05):
    """Percentile interval of stat_fn over paired stationary-bootstrap resamples of equal-length arrays."""
    rng = np.random.default_rng(seed)
    arrays = [np.asarray(a, float) for a in arrays]
    t = len(arrays[0])
    p = 1.0 / mean_block
    out = np.empty(draws)
    for k in range(draws):
        idx = np.empty(t, dtype=int)
        i = rng.integers(t)
        for j in range(t):
            if j and rng.random() < p:
                i = rng.integers(t)
            idx[j] = i
            i = (i + 1) % t
        out[k] = stat_fn(*[a[idx] for a in arrays])
    lo, hi = np.quantile(out, [alpha / 2, 1 - alpha / 2])
    return float(lo), float(hi), out
