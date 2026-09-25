// Map layouts. A map is a list of oriented boxes. Everything in `half` is also mirrored by a 180° rotation about the
// Y axis ((x,z) -> (-x,-z)) so both teams get an identical arena. Team Alpha spawns at -Z, Bravo at +Z.
//
// box helpers:
//   B(x0,x1, y0,y1, z0,z1, opts)             axis-aligned box
//   R([x,y,z] low, [x,y,z] high, width, opts) ramp slab whose top surface runs from low edge-centre to high edge-centre
// opts: { color, pattern, paint (default true), solid (default true), tag }

export const PATTERN = { plain: 0, deck: 1, tiles: 2, concrete: 3, hazard: 4, container: 5, wood: 6, metal: 7, spawn: 8, planter: 9, asphalt: 10, metalpanel: 11, grate: 12, brick: 13, rubber: 14, glasstile: 15, pavers: 16 };

const C = {
  deck: '#d8d2c4', deckEdge: '#c9c1b0', tile: '#d9dfe0', cream: '#ece4d4', sand: '#e6d3b3', slate: '#a9b4bc',
  stone: '#c7c2b8', trim: '#8e98a0', teal: '#8fb3b1', rust: '#cf9c88', mustard: '#dcc48e', lav: '#b3abd0',
  spawn: '#eae6de', wood: '#c9a27c', planter: '#b9ad9a', white: '#f3f1ec',
};

function B(x0, x1, y0, y1, z0, z1, o = {}) {
  return { kind: 'box', min: [x0, y0, z0], max: [x1, y1, z1], ...o };
}
function R(low, high, width, o = {}) {
  return { kind: 'ramp', low, high, width, thickness: o.thickness ?? 0.6, ...o };
}

export const TIDEWATER = {
  id: 'tidewater',
  bounds: { minX: -25, maxX: 25, minZ: -44, maxZ: 44 },
  spawnPads: [[0, 2.2, -39.2], [0, 2.2, 39.2]],
  spawnBarrier: 4.2,
  // Blocks that are their own mirror image (centered on the origin).
  single: [
    // Main deck slab
    B(-21, 21, -1.2, 0, -44, 44, { color: C.deck, pattern: PATTERN.deck }),
    // Central tower
    B(-5, 5, 0, 2.8, -5, 5, { color: C.tile, pattern: PATTERN.tiles }),
    B(-1.6, 1.6, 2.8, 3.8, -0.45, 0.45, { color: C.cream, pattern: PATTERN.plain }),
  ],
  half: [
    // ---- side deck strips (water notch between them) ----
    B(-25, -21, -1.2, 0, -44, 6, { color: C.deckEdge, pattern: PATTERN.wood }),
    B(-25, -21, -1.2, 0, 14, 44, { color: C.deckEdge, pattern: PATTERN.wood }),
    // sea railings along the long edges (low, jumpable)
    B(-25, -24.4, 0, 1.05, -43.4, 6, { color: C.slate, pattern: PATTERN.metal }),
    B(-25, -24.4, 0, 1.05, 14, 43.4, { color: C.slate, pattern: PATTERN.metal }),
    // back wall behind the Alpha spawn
    B(-25, 25, 0, 3.6, -44, -43.4, { color: C.cream, pattern: PATTERN.concrete, mural: [{ n: [0, 0, 1], id: 0 }] }),

    // ---- Alpha spawn deck ----
    B(-9, 9, 0, 2.2, -43.4, -35, { color: C.spawn, pattern: PATTERN.spawn }),
    R([-16, 0, -39.2], [-9, 2.2, -39.2], 4.2, { color: C.stone, pattern: PATTERN.hazard }),
    R([16, 0, -39.2], [9, 2.2, -39.2], 4.2, { color: C.stone, pattern: PATTERN.hazard }),
    // low parapets on the deck front corners (cover while leaving spawn)
    B(-9, -6.2, 2.2, 3.0, -35.6, -35, { color: C.cream, pattern: PATTERN.plain }),
    B(6.2, 9, 2.2, 3.0, -35.6, -35, { color: C.cream, pattern: PATTERN.plain }),

    // ---- base flanks ----
    // container stack (left)
    B(-22.2, -19.8, 0, 2.5, -33, -27, { color: C.teal, pattern: PATTERN.container, mural: [{ n: [1, 0, 0], id: 3 }, { n: [-1, 0, 0], id: 3 }] }),
    B(-22.2, -16.2, 2.5, 5.0, -30.6, -28.2, { color: C.rust, pattern: PATTERN.container, mural: [{ n: [0, 0, 1], id: 3 }, { n: [0, 0, -1], id: 3 }] }),
    // kiosk (right back)
    B(17.5, 22, 0, 3.2, -40, -35, { color: C.sand, pattern: PATTERN.concrete, mural: [{ n: [-1, 0, 0], id: 2 }, { n: [0, 0, 1], id: 2 }] }),
    // right base platform with ramp
    B(14, 21, 0, 1.3, -30, -22, { color: C.stone, pattern: PATTERN.tiles }),
    R([17.5, 0, -16.5], [17.5, 1.3, -22], 3.6, { color: C.stone, pattern: PATTERN.hazard }),
    // crates
    B(-7.2, -5.8, 0, 1.4, -27.8, -26.4, { color: C.wood, pattern: PATTERN.wood }),
    B(4.4, 5.8, 0, 1.4, -25.2, -23.8, { color: C.wood, pattern: PATTERN.wood }),
    B(5.8, 7.2, 0, 1.4, -25.2, -23.8, { color: C.wood, pattern: PATTERN.wood }),
    B(5.1, 6.5, 1.4, 2.8, -25.2, -23.8, { color: C.wood, pattern: PATTERN.wood }),

    // ---- mid-base ----
    // tall dividing wall (left-centre)
    B(-10.2, -9.2, 0, 3.0, -23, -13, { color: C.cream, pattern: PATTERN.concrete, mural: [{ n: [1, 0, 0], id: 1 }, { n: [-1, 0, 0], id: 1 }] }),
    // planter (right-centre)
    B(8, 12.5, 0, 0.9, -18.5, -15, { color: C.planter, pattern: PATTERN.planter, tag: 'planter' }),
    // low bench wall
    B(-17, -12.5, 0, 0.85, -20.2, -19.4, { color: C.stone, pattern: PATTERN.plain }),

    // ---- side-lane platform (left, ramp faces Alpha) ----
    B(-21, -14, 0, 1.6, -8, 8, { color: C.lav, pattern: PATTERN.tiles }),
    R([-17.5, 0, -13.5], [-17.5, 1.6, -8], 4.0, { color: C.stone, pattern: PATTERN.hazard }),
    B(-18.4, -17, 1.6, 2.8, 1, 2.4, { color: C.wood, pattern: PATTERN.wood }),

    // ---- mid cover ----
    R([2.2, 0, -12], [2.2, 2.8, -5], 3.6, { color: C.stone, pattern: PATTERN.hazard }),
    B(-10.4, -9, 0, 1.4, 3, 4.4, { color: C.wood, pattern: PATTERN.wood }),
    B(-10.4, -9, 1.4, 2.8, 3, 4.4, { color: C.wood, pattern: PATTERN.wood }),
    B(-10.4, -9, 0, 1.4, 4.4, 5.8, { color: C.wood, pattern: PATTERN.wood }),
    B(9.5, 13, 0, 2.4, -2.2, -1.2, { color: C.cream, pattern: PATTERN.concrete }),
  ],
  // non-colliding decoration anchors (built by level.js decor)
  decor: {
    lamps: [[-23.5, -42], [-23.5, -20], [-23.5, 22], [23.5, 2], [-12, -42], [12, -42]],
    palms: [[10.25, -16.75]],
    flags: [[-8.2, 2.2, -42.6], [8.2, 2.2, -42.6]],
  },
};

// ------------------------------------------------------------------------------------------------------------
// Kelpline Terminal — a working container terminal. Classic turf-war structure: elevated spawn decks with three
// exits, container yards on the flanks, a raised side deck + grate catwalk feeding the centre, a 2 m dry-dock
// trench across the middle crossed by grate bridges (squids drop through grates; kids can stand under them), and a central gantry deck with
// un-inkable steel sides so it can only be climbed from the front/back.
const K = {
  asphalt: '#9da3a9', concrete: '#ddd6c8', deck: '#b9c5d0', steel: '#5f7592', teal: '#5f9ea0', rust: '#c47a5e',
  navy: '#58668e', mustard: '#d6ae52', cream: '#e8dfcf', spawn: '#e9e6df', wood: '#c29a72', trench: '#8f969c', planter: '#b9ad9a',
  pavers: '#d6c7ad',
};
export const KELPLINE = {
  id: 'kelpline',
  bounds: { minX: -24, maxX: 24, minZ: -48, maxZ: 48 },
  spawnPads: [[0, 3.2, -44], [0, 3.2, 44]],
  spawnBarrier: 4.2,
  single: [
    // sunken service trench across the middle
    B(-24, 24, -3.0, -2.0, -3, 3, { color: K.trench, pattern: PATTERN.concrete }),
    // central gantry deck on four pillars (steel sides can't be inked → climb the front/back)
    B(-7, 7, 2.0, 2.8, -7, 7, { color: K.deck, pattern: PATTERN.metalpanel, noPaint: [[1, 0, 0], [-1, 0, 0]] }),
    B(-1.6, 1.6, 2.8, 4.4, -1.6, 1.6, { color: K.steel, pattern: PATTERN.metalpanel }),
  ],
  half: [
    // ground (the two halves either side of the trench)
    B(-24, 24, -1.2, 0, -48, -3, { color: K.asphalt, pattern: PATTERN.asphalt }),
    // trench retaining wall below the deck slab (closes the gap down to the trench floor)
    B(-24, 24, -3.0, -1.2, -3.8, -3, { color: K.asphalt, pattern: PATTERN.asphalt }),
    // pillars under the gantry
    B(5.4, 6.6, 0, 2.0, 5.4, 6.6, { color: K.steel, pattern: PATTERN.metalpanel }),
    B(-6.6, -5.4, 0, 2.0, 5.4, 6.6, { color: K.steel, pattern: PATTERN.metalpanel }),
    // grate bridges over the trench (flanks)
    B(12, 16, -0.15, 0, -3, 3, { color: K.steel, pattern: PATTERN.grate, grate: true }),
    // ramp out of the trench on your own side
    R([-9, -2.0, 2.2], [-9, 0, -3], 3, { color: K.concrete, pattern: PATTERN.hazard }),
    // sea railings (+ trench ends)
    B(-24, -23.4, 0, 1.05, -47.4, -3, { color: K.steel, pattern: PATTERN.metal }),
    B(-24, -23.4, 0, 1.05, 3, 47.4, { color: K.steel, pattern: PATTERN.metal }),
    B(-24, -23.4, -2.0, 0.2, -3, 3, { color: K.steel, pattern: PATTERN.metal }),
    // back wall
    B(-24, 24, 0, 4.2, -48, -47.4, { color: K.cream, pattern: PATTERN.concrete, mural: [{ n: [0, 0, 1], id: 0 }] }),

    // ---- spawn deck (front drop + two side ramps)
    B(-10, 10, 0, 3.2, -47.4, -40, { color: K.spawn, pattern: PATTERN.spawn }),
    R([-18, 0, -43.4], [-10, 3.2, -43.4], 4, { color: K.concrete, pattern: PATTERN.hazard }),
    R([18, 0, -43.4], [10, 3.2, -43.4], 4, { color: K.concrete, pattern: PATTERN.hazard }),
    B(-10, -7, 3.2, 4.0, -40.6, -40, { color: K.cream, pattern: PATTERN.concrete }),
    B(7, 10, 3.2, 4.0, -40.6, -40, { color: K.cream, pattern: PATTERN.concrete }),

    // ---- base yard
    B(-20, -17.6, 0, 2.6, -36, -30, { color: K.teal, pattern: PATTERN.container, mural: [{ n: [1, 0, 0], id: 3 }, { n: [-1, 0, 0], id: 3 }] }),
    B(12, 18.1, 0, 2.6, -33, -30.56, { color: K.rust, pattern: PATTERN.container, mural: [{ n: [0, 0, 1], id: 3 }] }),
    B(12.6, 18.7, 2.6, 5.2, -33, -30.56, { color: K.navy, pattern: PATTERN.container, mural: [{ n: [0, 0, 1], id: 3 }] }),
    B(-4, -2.6, 0, 1.4, -32, -30.6, { color: K.wood, pattern: PATTERN.wood }),
    B(2.6, 4, 0, 1.4, -29, -27.6, { color: K.wood, pattern: PATTERN.wood }),
    B(2.6, 4, 1.4, 2.8, -29, -27.6, { color: K.wood, pattern: PATTERN.wood }),

    // ---- left raised side deck + grate catwalk into the central ramp
    B(-24, -15, 0, 2.0, -22, -8.6, { color: K.pavers, pattern: PATTERN.pavers }),
    R([-19.5, 0, -29], [-19.5, 2.0, -22], 4, { color: K.concrete, pattern: PATTERN.hazard }),
    B(-24, -23.6, 2.0, 2.95, -22, -8.6, { color: K.steel, pattern: PATTERN.metal }),
    B(-15, -6, 1.85, 2.0, -10.6, -8.6, { color: K.steel, pattern: PATTERN.grate, grate: true }),
    B(-18.6, -17.2, 2.0, 3.2, -16, -14.6, { color: K.wood, pattern: PATTERN.wood }),

    // ---- mid-base cover
    B(-11, -6, 0, 1.0, -20, -19.4, { color: K.concrete, pattern: PATTERN.concrete }),
    B(4, 9, 0, 1.0, -13.6, -13, { color: K.concrete, pattern: PATTERN.concrete }),
    B(-3, 1, 0, 0.8, -23, -20.5, { color: K.planter, pattern: PATTERN.planter, tag: 'planter' }),
    B(15, 21.1, 0, 2.6, -20, -17.56, { color: K.mustard, pattern: PATTERN.container, mural: [{ n: [0, 0, 1], id: 3 }, { n: [0, 0, -1], id: 3 }] }),
    B(9, 11.44, 0, 2.6, -26, -19.9, { color: K.teal, pattern: PATTERN.container, mural: [{ n: [-1, 0, 0], id: 3 }] }),
    B(16, 19, 0, 2.2, -9, -8, { color: K.cream, pattern: PATTERN.concrete, mural: [{ n: [0, 0, 1], id: 1 }, { n: [0, 0, -1], id: 1 }] }),
    B(-14, -12.8, 0, 1.4, -8, -6.8, { color: K.wood, pattern: PATTERN.wood }),

    // ---- central ramp up to the gantry deck
    R([-4, 0, -16], [-4, 2.8, -7], 4, { color: K.concrete, pattern: PATTERN.hazard }),
  ],
  decor: {
    lamps: [[-23, -40], [-23, -25], [23, -12], [-8.5, -46.5], [8.5, -46.5]],
    palms: [[-1, -21.75]],
    flags: [[-9.2, 3.2, -46.6], [9.2, 3.2, -46.6]],
  },
};

export const MAP_LAYOUTS = { tidewater: TIDEWATER, kelpline: KELPLINE };
