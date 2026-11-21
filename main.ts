// Sokoban push-optimal solver, per-room decomposition.
//
// My own implementation. The level is a hallway (the player's row) with one to
// four rooms off it, each holding 3-4 boxes and as many goals, opening onto the
// hallway through a single door. Boxes never leave their room in an optimal
// solution, so a level's push-optimal count is the sum of its rooms' optima.
// I split the level into rooms, solve each room from its door with a
// push-optimal BFS over box-push states (dead-square and 2x2 deadlock pruning),
// and stitch the rooms together with player walks along the hallway.
// Deterministic: no clock, no randomness, no environment reads. Budget by work.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const CH = ['u', 'd', 'l', 'r'];
const OPP = [1, 0, 3, 2];

// Work budget: max BFS states expanded per room. Rooms here are small (3-4 boxes
// in a 6x6 slot); the cap only guards against a pathological room.
const MAX_STATES_PER_ROOM = 600_000;

interface Level {
  w: number;
  h: number;
  wall: boolean[];
  goals: boolean[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall: boolean[] = new Array(w * h).fill(false);
  const goals: boolean[] = new Array(w * h).fill(false);
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      wall[i] = ch === '#';
      if (ch === '.' || ch === '*' || ch === '+') goals[i] = true;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// Player walk from `from` to `to` over floor cells, avoiding walls and the cells
// in `blocked` (box positions). Returns the move string, or '' when from == to,
// or null when unreachable.
function walkPath(
  w: number,
  wall: boolean[],
  blocked: Set<number>,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const prev = new Map<number, number>();
  const prevCh = new Map<number, string>();
  const q: number[] = [from];
  prev.set(from, -1);
  let head = 0;
  while (head < q.length) {
    const c = q[head++]!;
    const cx = c % w;
    const cy = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d]!;
      const ny = cy + DY[d]!;
      if (nx < 0 || ny < 0 || nx >= w) continue;
      const ni = ny * w + nx;
      if (ni >= wall.length || wall[ni] || blocked.has(ni) || prev.has(ni)) continue;
      prev.set(ni, c);
      prevCh.set(ni, CH[d]!);
      if (ni === to) {
        // reconstruct
        let s = '';
        let cur = ni;
        while (cur !== from) {
          s = prevCh.get(cur)! + s;
          cur = prev.get(cur)!;
        }
        return s;
      }
      q.push(ni);
    }
  }
  return null;
}

interface Room {
  cells: number[]; // room floor cells (global indices)
  boxes: number[]; // initial boxes in this room
  goals: number[]; // goals in this room
  door: number; // the room cell adjacent to the hallway
  entry: number; // the hallway cell adjacent to the door
}

// Split the level into rooms: connected components of floor cells off the
// hallway row (the player's row). Each component is one room with one door.
function findRooms(lv: Level): Room[] {
  const { w, h, wall, boxes, goals } = lv;
  const hallwayRow = (lv.player / w) | 0;
  const seen = new Set<number>();
  const rooms: Room[] = [];
  for (let y = 0; y < h; y++) {
    if (y === hallwayRow) continue;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (wall[i] || seen.has(i)) continue;
      const comp: number[] = [];
      const q: number[] = [i];
      seen.add(i);
      while (q.length > 0) {
        const c = q.pop()!;
        comp.push(c);
        const cx = c % w;
        const cy = (c / w) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX[d]!;
          const ny = cy + DY[d]!;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (wall[ni] || ny === hallwayRow || seen.has(ni)) continue;
          seen.add(ni);
          q.push(ni);
        }
      }
      const rb = boxes.filter((b) => comp.includes(b));
      const rg = comp.filter((c) => goals[c]);
      // door: the room cell adjacent to a hallway cell
      let door = -1;
      let entry = -1;
      for (const c of comp) {
        const cx = c % w;
        const cy = (c / w) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX[d]!;
          const ny = cy + DY[d]!;
          if (ny === hallwayRow && nx >= 0 && nx < w && !wall[ny * w + nx]) {
            door = c;
            entry = ny * w + nx;
            break;
          }
        }
        if (door !== -1) break;
      }
      if (door === -1) continue; // no door: not a room (should not happen)
      rooms.push({ cells: comp, boxes: rb, goals: rg, door, entry });
    }
  }
  return rooms;
}

// Dead squares for a room, by reverse pulls from its goals: a cell is live when
// a box could be pulled onto it from a goal. A box on a non-live cell can never
// reach a goal, so states holding one are pruned. This ignores where the player
// stands, so it only ever marks cells that are truly dead.
function deadSquares(
  nbr: number[][],
  isGoal: boolean[],
  m: number,
): boolean[] {
  const live: boolean[] = new Array(m).fill(false);
  const q: number[] = [];
  for (let c = 0; c < m; c++) {
    if (isGoal[c]) {
      live[c] = true;
      q.push(c);
    }
  }
  let head = 0;
  while (head < q.length) {
    const t = q[head++]!;
    for (let d = 0; d < 4; d++) {
      const s = nbr[t]![d]!;
      if (s === -1 || live[s]) continue;
      // box at s could be pushed to t if the player could stand at nbr[s][d]
      if (nbr[s]![d]! !== -1) {
        live[s] = true;
        q.push(s);
      }
    }
  }
  const dead: boolean[] = new Array(m).fill(false);
  for (let c = 0; c < m; c++) dead[c] = !live[c];
  return dead;
}

// Solve one room push-optimally from its door. The player starts at `entry`
// (the hallway cell by the door). Returns the moves and the player's final
// global cell, or null when the state cap is hit without a solution.
function solveRoom(
  lv: Level,
  room: Room,
): { moves: string; endPlayer: number } | null {
  const { w, wall, goals } = lv;
  const locals: number[] = [...room.cells, room.entry];
  const m = locals.length;
  const locOf = new Map<number, number>();
  locals.forEach((g, i) => locOf.set(g, i));
  const nRoom = room.cells.length;
  const entryLocal = m - 1;
  // neighbors, as local indices (-1 = wall / outside this room + entry)
  const nbr: number[][] = [];
  for (let i = 0; i < m; i++) {
    const g = locals[i]!;
    const gx = g % w;
    const gy = (g / w) | 0;
    const row: number[] = [];
    for (let d = 0; d < 4; d++) {
      const nx = gx + DX[d]!;
      const ny = gy + DY[d]!;
      if (nx < 0 || ny < 0 || nx >= w || ny >= lv.h) {
        row.push(-1);
        continue;
      }
      const ng = ny * w + nx;
      if (wall[ng]) {
        row.push(-1);
        continue;
      }
      const li = locOf.get(ng);
      row.push(li === undefined ? -1 : li);
    }
    nbr.push(row);
  }
  const isGoal: boolean[] = locals.map((g) => goals[g]!);
  const dead = deadSquares(nbr, isGoal, m);
  const nBoxes = room.boxes.length;
  if (nBoxes === 0) return { moves: '', endPlayer: room.entry };
  const boxes0 = room.boxes.map((g) => locOf.get(g)!).sort((a, b) => a - b);
  const pack = (bs: number[], p: number): number => {
    let k = 0;
    for (const b of bs) k = k * m + b;
    return k * m + p;
  };
  const unpack = (key: number): { bs: number[]; p: number } => {
    const bs: number[] = new Array(nBoxes);
    let k = key;
    const p = k % m;
    k = Math.floor(k / m);
    for (let j = nBoxes - 1; j >= 0; j--) {
      bs[j] = k % m;
      k = Math.floor(k / m);
    }
    return { bs, p };
  };
  const isGoalState = (bs: number[]): boolean => bs.every((b) => isGoal[b]);
  const boxSet = new Set<number>();
  const formsDead2x2 = (bs: number[], movedTo: number): boolean => {
    // only 2x2 blocks containing the moved box can have formed newly
    boxSet.clear();
    for (const b of bs) boxSet.add(locals[b]!);
    const g = locals[movedTo]!;
    const gx = g % w;
    const gy = (g / w) | 0;
    const corners: [number, number][] = [
      [gx, gy],
      [gx - 1, gy],
      [gx, gy - 1],
      [gx - 1, gy - 1],
    ];
    for (const [cx, cy] of corners) {
      if (cx < 0 || cy < 0 || cx + 1 >= w || cy + 1 >= lv.h) continue;
      const cells = [
        cy * w + cx,
        cy * w + cx + 1,
        (cy + 1) * w + cx,
        (cy + 1) * w + cx + 1,
      ];
      if (cells.every((c) => boxSet.has(c))) {
        if (!cells.every((c) => goals[c])) return true;
      }
    }
    return false;
  };

  const startKey = pack(boxes0, entryLocal);
  const keys: number[] = [startKey];
  const parent: number[] = [-1];
  const seg: string[] = [''];
  const seen = new Map<number, number>([[startKey, 0]]);
  const queue: number[] = [0];
  let head = 0;
  let goalId = -1;
  if (isGoalState(boxes0)) goalId = 0;
  // scratch arrays reused per expansion
  const reachPrev = new Int32Array(m);
  const reachCh: string[] = new Array(m);
  const boxAt = new Int32Array(m);
  while (head < queue.length && goalId === -1) {
    const sid = queue[head++]!;
    if (sid >= MAX_STATES_PER_ROOM) break;
    const { bs, p } = unpack(keys[sid]!);
    // player reachability in this box configuration
    reachPrev.fill(-2);
    boxAt.fill(-1);
    for (const b of bs) boxAt[b] = 1;
    const rq: number[] = [p];
    reachPrev[p] = -1;
    let rh = 0;
    while (rh < rq.length) {
      const c = rq[rh++]!;
      for (let d = 0; d < 4; d++) {
        const n = nbr[c]![d]!;
        if (n === -1 || reachPrev[n] !== -2 || boxAt[n] === 1) continue;
        reachPrev[n] = c;
        reachCh[n] = CH[d]!;
        rq.push(n);
      }
    }
    const walkTo = (target: number): string | null => {
      if (target === p) return '';
      if (reachPrev[target] === -2) return null;
      let s = '';
      let cur = target;
      while (cur !== p) {
        s = reachCh[cur]! + s;
        cur = reachPrev[cur]!;
      }
      return s;
    };
    for (let j = 0; j < nBoxes; j++) {
      const b = bs[j]!;
      for (let d = 0; d < 4; d++) {
        const to = nbr[b]![d]!;
        if (to === -1 || to >= nRoom) continue; // stays inside the room
        if (boxAt[to] === 1) continue;
        if (dead[to]) continue;
        const from = nbr[b]![OPP[d]!]!;
        if (from === -1) continue;
        const walk = walkTo(from);
        if (walk === null) continue;
        const nbs = [...bs];
        nbs[j] = to;
        nbs.sort((a, b2) => a - b2);
        if (formsDead2x2(nbs, to)) continue;
        const nk = pack(nbs, b);
        if (seen.has(nk)) continue;
        const nid = keys.length;
        seen.set(nk, nid);
        keys.push(nk);
        parent.push(sid);
        seg.push(walk + CH[d]!);
        if (isGoalState(nbs)) {
          goalId = nid;
          break;
        }
        queue.push(nid);
      }
      if (goalId !== -1) break;
    }
  }
  if (goalId === -1) return null;
  // reconstruct moves
  const parts: string[] = [];
  let cur = goalId;
  while (cur > 0) {
    parts.push(seg[cur]!);
    cur = parent[cur]!;
  }
  parts.reverse();
  const { p } = unpack(keys[goalId]!);
  return { moves: parts.join(''), endPlayer: locals[p]! };
}

function solveLevel(text: string): string {
  const lv = parseLevel(text);
  const rooms = findRooms(lv);
  // rooms with no boxes need no solving; order by door column
  rooms.sort((a, b) => (a.door % lv.w) - (b.door % lv.w));
  let moves = '';
  let player = lv.player;
  const curBoxes = new Set<number>(lv.boxes);
  for (const room of rooms) {
    if (room.boxes.length === 0) continue;
    const walk = walkPath(lv.w, lv.wall, curBoxes, player, room.entry);
    if (walk === null) return moves; // cannot reach: give up on this level
    moves += walk;
    player = room.entry;
    const res = solveRoom(lv, room);
    if (res === null) return moves; // unsolved room: keep what we have
    moves += res.moves;
    player = res.endPlayer;
    // this room's boxes now sit on its goals
    for (const b of room.boxes) curBoxes.delete(b);
    for (const g of room.goals) curBoxes.add(g);
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
