#!/usr/bin/env python3
"""Stop-sequence optimization using simulated annealing on a distance matrix."""
import math
import random


def route_cost(order, dist_matrix):
    """Total road km for a stop order (WH -> stops -> WH optional). Outbound only."""
    wh = "WH"
    d = dist_matrix.get("|".join(sorted((wh, order[0]))), 99999.0) if order else 0.0
    for i in range(len(order) - 1):
        d += dist_matrix.get("|".join(sorted((order[i], order[i + 1]))), 99999.0)
    return d


def optimize_order(order, dist_matrix, iterations=3000, seed=42):
    """Return a better ordering of `order` (list of location ids) minimizing
    outbound road distance. Uses simulated annealing."""
    rng = random.Random(seed)
    if len(order) < 3:
        return order[:]
    best = order[:]
    best_cost = route_cost(best, dist_matrix)
    cur = best[:]
    cur_cost = best_cost
    n = len(cur)
    temp = max(1.0, best_cost * 0.05)
    for it in range(iterations):
        # pick a move
        r = rng.random()
        if r < 0.4 and n >= 4:
            # 2-opt
            i = rng.randrange(0, n - 1)
            j = rng.randrange(i + 2, n + 1) if i + 2 <= n else None
            if j is None:
                continue
            new = cur[:i] + cur[i:j][::-1] + cur[j:]
        elif r < 0.7:
            # swap
            i, j = rng.sample(range(n), 2)
            new = cur[:]
            new[i], new[j] = new[j], new[i]
        else:
            # insert (move one stop)
            i = rng.randrange(n)
            j = rng.randrange(n)
            if i == j:
                continue
            new = cur[:]
            x = new.pop(i)
            new.insert(j, x)
        new_cost = route_cost(new, dist_matrix)
        delta = new_cost - cur_cost
        if delta <= 0 or rng.random() < math.exp(-delta / max(temp, 1e-9)):
            cur = new
            cur_cost = new_cost
            if cur_cost < best_cost:
                best = cur[:]
                best_cost = cur_cost
        temp *= 0.999
    return best
