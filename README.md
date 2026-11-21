# Sokoban Solver — Push-Optimal BFS

A Sokoban solver for the make.fun `sokoban-solver-01-run-20261121` bounty.

## Approach

The levels are a hallway (the player's row) with one to four rooms off it,
each holding 3–4 boxes and as many goals, opening onto the hallway through a
single door. Boxes never leave their room in an optimal solution, so a level's
push-optimal count is the sum of its rooms' optima.

`main.ts` splits the level into rooms, solves each room from its door with a
push-optimal BFS over box-push states (dead-square and 2×2 deadlock pruning),
and stitches the rooms together with player walks along the hallway.

## Results (practice set)

| instance | boxes | pushes | P* |
|----------|-------|--------|----|
| i001 | 3 | 13 | 13 |
| i002 | 4 | 16 | 16 |
| i003 | 8 | 29 | 29 |
| i004 | 12 | 47 | 47 |
| i005 | 16 | 60 | 60 |

Practice score: **1,000,000** (all 5 instances solved in P* pushes).

## Run

```sh
node main.ts
```

Reads `/input/<id>/level.txt` and writes `/output/<id>/solution.txt` (moves in
`u`/`d`/`l`/`r`). Deterministic: two runs produce byte-identical outputs.
