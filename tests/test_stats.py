"""Checks that the validation statistics behave as the papers describe. Run: .venv/bin/python -m pytest -q tests
(or plain: .venv/bin/python tests/test_stats.py)."""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import stats as S  # noqa: E402


def test_psr_against_zero_matches_normal_case():
    rng = np.random.default_rng(1)
    x = rng.normal(0.002, 0.02, 100_000)
    # with normal returns PSR(0) ~ Phi(SR * sqrt(T-1)); here SR = 0.1, so it is essentially 1
    assert S.psr(x, 0.0) > 0.999
    assert abs(S.psr(x, S.sharpe(x)) - 0.5) < 1e-9


def test_expected_max_sharpe_grows_with_trials():
    v = 0.01
    vals = [S.expected_max_sharpe(v, n) for n in (2, 10, 100, 1000)]
    assert all(a < b for a, b in zip(vals, vals[1:]))
    assert S.expected_max_sharpe(v, 1) == 0.0
    # paper's approximation: for many trials, SR* ~ sqrt(V) * sqrt(2 ln N)
    assert abs(S.expected_max_sharpe(1.0, 10_000) / math.sqrt(2 * math.log(10_000)) - 1) < 0.15


def test_dsr_falls_when_more_trials_are_counted():
    rng = np.random.default_rng(2)
    x = rng.normal(0.003, 0.02, 300)
    srs = rng.normal(0.05, 0.03, 50)
    d5, _ = S.deflated_sharpe(x, srs, 5)
    d50, _ = S.deflated_sharpe(x, srs, 50)
    assert d50 < d5


def test_pbo_is_near_half_for_pure_noise():
    rng = np.random.default_rng(3)
    m = rng.normal(0, 0.02, (320, 20))
    pbo, _ = S.pbo_cscv(m, n_blocks=10)
    assert 0.3 < pbo < 0.7


def test_pbo_is_near_zero_when_one_strategy_truly_dominates():
    rng = np.random.default_rng(4)
    m = rng.normal(0, 0.02, (320, 20))
    m[:, 7] += 0.01
    pbo, _ = S.pbo_cscv(m, n_blocks=10)
    assert pbo < 0.05


def test_effective_trials_collapse_for_identical_series():
    rng = np.random.default_rng(5)
    base = rng.normal(0, 0.02, 300)
    m = np.column_stack([base + rng.normal(0, 1e-6, 300) for _ in range(10)])
    n_eff, rho = S.effective_trials(m)
    assert rho > 0.999 and n_eff < 1.01


def test_bootstrap_interval_covers_true_mean():
    rng = np.random.default_rng(6)
    x = rng.normal(0.5, 1.0, 400)
    lo, hi, _ = S.stationary_bootstrap_ci(lambda a: a.mean(), [x], draws=1000)
    assert lo < 0.5 < hi


if __name__ == '__main__':
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_')]
    for f in fns:
        f()
        print('PASS', f.__name__)
