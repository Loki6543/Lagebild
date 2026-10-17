#!/usr/bin/env python3
"""Reproduce the whitepaper's reproducible math check (pp.29-30) verbatim."""
import math
import numpy as np
rng = np.random.default_rng(20261016)


def components(S, w):
    k = w.copy()
    k[:8] = 0
    n = w - k
    return k @ S @ k, k @ S @ n, n @ S @ n


def crypto_scale(S, w, q):
    A, B, C = components(S, w)
    if C <= 1e-18:
        raise ValueError('Degenerate non-crypto risk')
    aa, bb = (1-q)*A, (1-2*q)*B
    if aa <= 1e-18:
        return 1.0
    root = (-bb + math.sqrt(bb*bb+4*aa*q*C))/(2*aa)
    return min(1.0, root)


def crypto_share(S, w):
    A, B, C = components(S, w)
    variance = A + 2*B + C
    if variance <= 1e-18:
        raise ValueError('Degenerate total risk')
    return (A+B)/variance


failures = 0
worst = 0.0
for case in range(10000):
    w = rng.dirichlet(np.ones(12))
    q = 0.5 if case % 2 else 0.6
    models = []
    for _ in range(2):
        X = rng.normal(size=(12, 12))
        models.append(X @ X.T + np.eye(12)*0.05)
    a = min(crypto_scale(S, w, q) for S in models)
    target = w.copy()
    target[8:] *= a
    assert np.all(target <= w + 1e-12)
    for S in models:
        excess = crypto_share(S, target) - q
        worst = max(worst, excess)
        failures += int(excess > 1e-9)
        vol = math.sqrt(target @ S @ target)
        reduced = target * min(1.0, 0.24/vol)
        assert math.sqrt(reduced @ S @ reduced) <= 0.24+1e-10
assert failures == 0
print({'portfolios': 10000, 'model_checks': 20000,
       'failures': failures, 'max_excess': worst})
