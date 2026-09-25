// Navigation graph auto-generated from the level: 1 m grid of walkable samples on every floor/platform/ramp,
// connected by walk / jump-up / drop-down edges. A* with a binary heap.
import * as THREE from 'three';
import { PLAYER } from '../config.js';

const _p = new THREE.Vector3(), _d = new THREE.Vector3();

export class NavGraph {
  constructor(level, physics) {
    this.level = level; this.physics = physics;
    this.step = 1.0;
    this.nodes = [];
    this._build();
  }

  _build() {
    const L = this.level, B = L.bounds, st = this.step;
    this.x0 = B.minX + st / 2; this.z0 = B.minZ + st / 2;
    this.nx = Math.floor((B.maxX - B.minX) / st); this.nz = Math.floor((B.maxZ - B.minZ) / st);
    this.cells = new Array(this.nx * this.nz);
    const topBlocks = L.blocks.filter((b) => b.solid && b.axes[1].y > 0.6);
    const ids = [];
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const x = this.x0 + ix * st, z = this.z0 + iz * st;
        const heights = [];
        L.queryBlocks(x - 0.01, z - 0.01, x + 0.01, z + 0.01, ids);
        for (const id of ids) {
          const b = L.blocks[id];
          if (!b.solid || b.axes[1].y < 0.6) continue;
          const n = b.axes[1];
          const top = _p.copy(b.center).addScaledVector(n, b.half.y);
          const y = top.y - (n.x * (x - top.x) + n.z * (z - top.z)) / n.y;
          _d.set(x, y - 0.02, z);
          if (!L.pointInBlock(b, _d, 0.001)) continue;
          if (heights.some((h) => Math.abs(h - y) < 0.15)) continue;
          heights.push(y);
        }
        const list = [];
        for (const y of heights) {
          // headroom + clearance (not inside geometry, not hugging walls)
          if (!this._clear(x, y, z)) continue;
          const node = { id: this.nodes.length, x, y, z, ix, iz, nb: [], zone: -1 };
          for (let t = 0; t < 2; t++) {
            const pad = L.spawnPads[t];
            if (Math.hypot(x - pad.x, z - pad.z) < L.spawnBarrier + 0.6 && y > pad.y - 1) node.zone = t;
          }
          this.nodes.push(node);
          list.push(node.id);
        }
        this.cells[iz * this.nx + ix] = list;
      }
    }
    // edges
    for (const n of this.nodes) {
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const jx = n.ix + dx, jz = n.iz + dz;
        if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) continue;
        for (const mid of this.cells[jz * this.nx + jx]) {
          const m = this.nodes[mid];
          const dy = m.y - n.y;
          const flat = Math.hypot(dx, dz) * this.step;
          if (Math.abs(dy) <= 0.5) {
            if (dx && dz) { // diagonal: both orthogonal neighbours must exist at similar height
              if (!this._has(n.ix + dx, n.iz, n.y) || !this._has(n.ix, n.iz + dz, n.y)) continue;
            }
            n.nb.push({ to: mid, cost: flat, type: 'walk' });
          } else if (dy > 0.5 && dy <= 1.25 && !(dx && dz)) {
            n.nb.push({ to: mid, cost: flat + 2.5, type: 'jump' });
          } else if (dy < -0.5 && dy >= -3.4 && !(dx && dz)) {
            n.nb.push({ to: mid, cost: flat + 0.8, type: 'drop' });
          }
        }
      }
    }
    // keep only the largest connected component (walk edges, both directions)
    this._prune();
  }

  _has(ix, iz, y) {
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return false;
    return this.cells[iz * this.nx + ix].some((id) => Math.abs(this.nodes[id].y - y) <= 0.5);
  }

  _clear(x, y, z) {
    const L = this.level;
    const r = PLAYER.radius + 0.08;
    for (const h of [0.15, 0.8, 1.4]) {
      if (L.pointInside(_p.set(x, y + h, z), 0)) return false;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        if (L.pointInside(_p.set(x + Math.cos(a) * r, y + h, z + Math.sin(a) * r), 0)) return false;
      }
    }
    return true;
  }

  _prune() {
    // undirected reachability from a spawn-adjacent node using all edges both ways
    const N = this.nodes.length;
    const adj = Array.from({ length: N }, () => []);
    for (const n of this.nodes) for (const e of n.nb) { adj[n.id].push(e.to); adj[e.to].push(n.id); }
    const comp = new Int32Array(N).fill(-1);
    let best = -1, bestSize = 0, c = 0;
    for (let i = 0; i < N; i++) {
      if (comp[i] >= 0) continue;
      let size = 0; const stack = [i]; comp[i] = c;
      while (stack.length) { const k = stack.pop(); size++; for (const j of adj[k]) if (comp[j] < 0) { comp[j] = c; stack.push(j); } }
      if (size > bestSize) { bestSize = size; best = c; }
      c++;
    }
    this.valid = new Uint8Array(N);
    for (let i = 0; i < N; i++) this.valid[i] = comp[i] === best ? 1 : 0;
    this.validIds = this.nodes.filter((n) => this.valid[n.id]).map((n) => n.id);
  }

  nearest(pos, maxUp = 0.8) {
    const ix = Math.round((pos.x - this.x0) / this.step), iz = Math.round((pos.z - this.z0) / this.step);
    let best = -1, bd = Infinity;
    for (let r = 0; r <= 3; r++) {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const jx = ix + dx, jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) continue;
        for (const id of this.cells[jz * this.nx + jx]) {
          if (!this.valid[id]) continue;
          const n = this.nodes[id];
          if (n.y > pos.y + maxUp) continue;
          const d = (n.x - pos.x) ** 2 + (n.z - pos.z) ** 2 + ((n.y - pos.y) * 2.5) ** 2;
          if (d < bd) { bd = d; best = id; }
        }
      }
      if (best >= 0) return best;
    }
    return best;
  }

  // A* from node a to node b; `team` blocks the enemy spawn zone. Returns array of node ids (incl. a and b) or null.
  path(a, b, team, maxIter = 6000) {
    if (a < 0 || b < 0) return null;
    const N = this.nodes.length;
    if (!this._g || this._g.length !== N) { this._g = new Float32Array(N); this._from = new Int32Array(N); this._seen = new Uint32Array(N); this._closed = new Uint32Array(N); this._stamp = 0; }
    const g = this._g, from = this._from, seen = this._seen, closed = this._closed;
    const st = ++this._stamp;
    const nodes = this.nodes, goal = nodes[b];
    const h = (n) => Math.hypot(n.x - goal.x, n.z - goal.z) + Math.abs(n.y - goal.y) * 0.5;
    const heap = new Heap();
    g[a] = 0; from[a] = -1; seen[a] = st;
    heap.push(a, h(nodes[a]));
    let it = 0;
    while (heap.size && it++ < maxIter) {
      const cur = heap.pop();
      if (cur === b) break;
      if (closed[cur] === st) continue;
      closed[cur] = st;
      const n = nodes[cur];
      for (const e of n.nb) {
        const m = nodes[e.to];
        if (m.zone >= 0 && m.zone !== team) continue;
        const ng = g[cur] + e.cost;
        if (seen[e.to] !== st || ng < g[e.to]) {
          seen[e.to] = st; g[e.to] = ng; from[e.to] = cur;
          heap.push(e.to, ng + h(m));
        }
      }
    }
    if (seen[b] !== st) return null;
    const out = [];
    for (let k = b; k !== -1; k = from[k]) { out.push(k); if (out.length > 4000) break; }
    return out.reverse();
  }

  edgeType(a, b) {
    for (const e of this.nodes[a].nb) if (e.to === b) return e.type;
    return 'walk';
  }
}

class Heap {
  constructor() { this.ids = []; this.pr = []; }
  get size() { return this.ids.length; }
  push(id, p) {
    const ids = this.ids, pr = this.pr;
    let i = ids.length; ids.push(id); pr.push(p);
    while (i > 0) { const j = (i - 1) >> 1; if (pr[j] <= p) break; ids[i] = ids[j]; pr[i] = pr[j]; i = j; }
    ids[i] = id; pr[i] = p;
  }
  pop() {
    const ids = this.ids, pr = this.pr;
    const top = ids[0];
    const lid = ids.pop(), lp = pr.pop();
    if (ids.length) {
      let i = 0; const n = ids.length;
      while (true) {
        let l = i * 2 + 1, r = l + 1, m = i;
        let mp = lp;
        if (l < n && pr[l] < mp) { m = l; mp = pr[l]; }
        if (r < n && pr[r] < mp) { m = r; mp = pr[r]; }
        if (m === i) break;
        ids[i] = ids[m]; pr[i] = pr[m]; i = m;
      }
      ids[i] = lid; pr[i] = lp;
    }
    return top;
  }
}
