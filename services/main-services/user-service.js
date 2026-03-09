import AlumniUser from "../../models/AlumniUser.js";

// ─── Alumni tree layout ───────────────────────────────────────────────────────
// Exact port of frontend Tree.jsx + layout.js so the output is identical.
// Node IDs are sequential integers (1, 2, 3…) — not MongoDB _ids.

function _createRng(initialSeed) {
  let seed = initialSeed | 0;
  return function rng() {
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    return Math.abs(seed) / 0xffffffff;
  };
}

const _MAX_DEPTH = 100;

function _levelCap(level) {
  if (level === 1) return 1;
  if (level === 2) return 8;
  if (level === 3) return 16;
  if (level === 4) return 32;
  if (level === 5) return 64;
  return Math.pow(2, level);
}

function _perNodeChildCapForLevel(level) {
  if (level === 1) return 8;
  if (level === 2) return 4;
  if (level === 3) return 3;
  if (level === 4) return 2;
  return 2;
}

function _countByLevel(root) {
  const counts = {};
  (function walk(n, depth) {
    const level = depth + 1;
    counts[level] = (counts[level] || 0) + 1;
    (n.children || []).forEach((c) => walk(c, depth + 1));
  })(root, 0);
  return counts;
}

function _addChild(parent, count, levelCounts, users, userIndexRef, nodeIdRef) {
  const pDepth = parent.depth ?? 0;
  const childDepth = pDepth + 1;
  if (childDepth > _MAX_DEPTH) return 0;
  const childLevelNum = childDepth + 1;
  const cap = _levelCap(childLevelNum);
  const currentAtLevel = levelCounts[childLevelNum] ?? 0;
  const canAddLevel = Math.max(0, cap - currentAtLevel);
  const parentLevelNum = pDepth + 1;
  const parentCap = _perNodeChildCapForLevel(parentLevelNum);
  const canAddParent = Math.max(0, parentCap - (parent.children?.length || 0));
  const toAdd = Math.min(
    count,
    canAddLevel,
    canAddParent,
    users.length - userIndexRef.current
  );

  for (let i = 0; i < toAdd; i++) {
    if (userIndexRef.current >= users.length) break;
    parent.children = parent.children || [];
    const user = users[userIndexRef.current++];
    parent.children.push({
      id: nodeIdRef.current++,
      name: user.name + " " + user.surname,
      avatarUrl: user.image,
      tier: user.tier,
      quote: user.quote || null,
      joinDate: user.joinDate,
      children: [],
      depth: childDepth,
      parentId: parent.id,
    });
    levelCounts[childLevelNum] = (levelCounts[childLevelNum] || 0) + 1;
  }
  return toAdd;
}

function _distributeChildren(parents, count, childDepth, users, userIndexRef, nodeIdRef) {
  let remaining = count;
  if (parents.length === 0 || remaining <= 0) return remaining;

  const parentLevelNum = childDepth;
  const capPerParent = _perNodeChildCapForLevel(parentLevelNum);
  const hasSlot = (p) => (p.children?.length || 0) < capPerParent;
  let eligible = parents.filter(hasSlot);
  let idx = 0;

  while (
    remaining > 0 &&
    eligible.length > 0 &&
    userIndexRef.current < users.length
  ) {
    const p = eligible[idx % eligible.length];
    const levelCounts = _countByLevel(parents[0]);
    remaining -= _addChild(p, 1, levelCounts, users, userIndexRef, nodeIdRef);
    if (!hasSlot(p)) eligible = eligible.filter((e) => e !== p);
    else idx++;
  }
  return remaining;
}

function _seedTree(root, users, nodeIdRef) {
  root.children = [];
  root.depth = 0;

  const userIndexRef = { current: 1 };
  let remaining = Math.max(0, users.length - 1);

  const wantL2 = Math.min(_levelCap(2), remaining);
  const remL2 = _distributeChildren([root], wantL2, 1, users, userIndexRef, nodeIdRef);
  remaining -= wantL2 - remL2;

  const L2nodes = root.children || [];
  const wantL3 = Math.min(_levelCap(3), remaining);
  const remL3 = _distributeChildren(L2nodes, wantL3, 2, users, userIndexRef, nodeIdRef);
  remaining -= wantL3 - remL3;

  const L3nodes = [];
  L2nodes.forEach((p) => (p.children || []).forEach((c) => L3nodes.push(c)));
  const wantL4 = Math.min(_levelCap(4), remaining);
  const remL4 = _distributeChildren(L3nodes, wantL4, 3, users, userIndexRef, nodeIdRef);
  remaining -= wantL4 - remL4;

  const L4nodes = [];
  L3nodes.forEach((p) => (p.children || []).forEach((c) => L4nodes.push(c)));
  const wantL5 = Math.min(_levelCap(5), remaining);
  const remL5 = _distributeChildren(L4nodes, wantL5, 4, users, userIndexRef, nodeIdRef);
  remaining -= wantL5 - remL5;

  if (remaining > 0) {
    const L5nodes = [];
    L4nodes.forEach((p) => (p.children || []).forEach((c) => L5nodes.push(c)));
    _distributeChildren(L5nodes, remaining, 5, users, userIndexRef, nodeIdRef);
  }
}

function _computeOrganic(root, rng) {
  const depthGap = 180;
  const centerX = 700;

  root.depth = 0;
  root.x = centerX;
  root.y = 0;

  const L2 = root.children || [];
  L2.forEach((n) => (n.depth = 1));
  const n2 = L2.length;
  const span2 = (180 * Math.PI) / 180;
  const angles2 =
    n2 <= 1
      ? [0]
      : Array.from({ length: n2 }, (_, i) => -span2 / 2 + (span2 * i) / (n2 - 1));
  const r2 = depthGap;
  for (let i = 0; i < n2; i++) {
    const a = angles2[i];
    const node = L2[i];
    node.x = centerX + Math.sin(a) * r2;
    node.y = Math.cos(a) * r2;
    node.angle = a;
  }

  const r3 = depthGap * 2;
  L2.forEach((p, idx) => {
    const children = p.children || [];
    children.forEach((c) => (c.depth = 2));
    const count = children.length;
    if (!count) return;
    const aParent = p.angle ?? angles2[Math.min(idx, angles2.length - 1)];
    const localSpan = (count <= 4 ? 40 : Math.min(70, 25 + count * 8)) * (Math.PI / 180);
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const a = aParent - localSpan / 2 + localSpan * t;
      const child = children[i];
      child.x = centerX + Math.sin(a) * r3;
      child.y = Math.cos(a) * r3;
      child.angle = a;
    }
  });

  const r4 = depthGap * 3;
  const L3 = [];
  L2.forEach((p) => (p.children || []).forEach((c) => L3.push(c)));
  L3.forEach((p) => {
    const children = p.children || [];
    children.forEach((c) => (c.depth = 3));
    const count = children.length;
    if (!count) return;
    const aParent = p.angle ?? 0;
    const localSpan = (count <= 3 ? 30 : Math.min(50, 18 + count * 6)) * (Math.PI / 180);
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const a = aParent - localSpan / 2 + localSpan * t;
      const child = children[i];
      child.x = centerX + Math.sin(a) * r4;
      child.y = Math.cos(a) * r4;
      child.angle = a;
    }
  });

  const r5 = depthGap * 4;
  const L4 = [];
  L3.forEach((p) => (p.children || []).forEach((c) => L4.push(c)));
  L4.forEach((p) => {
    const children = p.children || [];
    children.forEach((c) => (c.depth = 4));
    const count = children.length;
    if (!count) return;
    const aParent = p.angle ?? 0;
    const localSpan = (count <= 2 ? 25 : Math.min(42, 15 + count * 5)) * (Math.PI / 180);
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const a = aParent - localSpan / 2 + localSpan * t;
      const child = children[i];
      child.x = centerX + Math.sin(a) * r5;
      child.y = Math.cos(a) * r5;
      child.angle = a;
    }
  });

  const r6 = depthGap * 5;
  const L5 = [];
  L4.forEach((p) => (p.children || []).forEach((c) => L5.push(c)));
  L5.forEach((p) => {
    const children = p.children || [];
    children.forEach((c) => (c.depth = 5));
    const count = children.length;
    if (!count) return;
    const aParent = p.angle ?? 0;
    const localSpan = (count <= 2 ? 20 : Math.min(35, 12 + count * 4)) * (Math.PI / 180);
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const a = aParent - localSpan / 2 + localSpan * t;
      const child = children[i];
      child.x = centerX + Math.sin(a) * r6;
      child.y = Math.cos(a) * r6;
      child.angle = a;
    }
  });

  // Collision separation
  let maxDepthGlobal = 0;
  (function detect(n) {
    maxDepthGlobal = Math.max(maxDepthGlobal, n.depth || 0);
    (n.children || []).forEach(detect);
  })(root);

  const all = [];
  (function collect(n) {
    all.push(n);
    (n.children || []).forEach(collect);
  })(root);

  const avatarR = 28;
  const keepOut = (n) => {
    const d = n.depth || 0;
    const gap = d === 0 ? 8 : d <= 2 ? 10 : 9;
    const leafLen = d === 0 ? 28 : d === 1 ? 24 : d <= 3 ? 30 : 28;
    return avatarR + gap + leafLen;
  };

  for (let it = 0; it < 12; it++) {
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      if (a === root) continue;
      for (let j = i + 1; j < all.length; j++) {
        const b = all[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        let d = Math.hypot(dx, dy);
        if (d === 0) {
          const eps = 0.8 + rng() * 0.4;
          a.x += 0.7071 * eps;
          a.y += 0.7071 * eps;
          b.x -= 0.7071 * eps;
          b.y -= 0.7071 * eps;
          continue;
        }
        const minPair = keepOut(a) + keepOut(b) + 3;
        if (d < minPair) {
          const push = (minPair - d) / 2;
          const ux = dx / d;
          const uy = dy / d;
          const aBias = 0.4 + ((a.depth || 0) / (maxDepthGlobal || 1)) * 0.6;
          const bBias = 0.4 + ((b.depth || 0) / (maxDepthGlobal || 1)) * 0.6;
          a.x += ux * push * aBias;
          a.y += uy * push * aBias;
          b.x -= ux * push * bBias;
          b.y -= uy * push * bBias;
        }
      }
    }
  }
}

function _flattenTree(root) {
  const nodes = [];
  (function collect(n) {
    const { children, angle, ...rest } = n;
    nodes.push(rest);
    (children || []).forEach(collect);
  })(root);
  return nodes;
}

export const computeAlumniTreeLayout = async () => {
  const members = await AlumniUser.find()
    .select("name surname image tier quote joinDate")
    .sort({ name: 1, surname: 1 });

  if (!members.length) return [];

  const users = members.map((m) => {
    const obj = m.toObject({ getters: true });
    return {
      name: obj.name,
      surname: obj.surname,
      image: obj.image,
      tier: obj.tier,
      quote: obj.quote || null,
      joinDate: obj.joinDate,
    };
  });

  const nodeIdRef = { current: 1 };
  const root = {
    id: nodeIdRef.current++,
    name: users[0].name + " " + users[0].surname,
    avatarUrl: users[0].image,
    tier: users[0].tier,
    quote: users[0].quote || null,
    joinDate: users[0].joinDate,
    children: [],
    depth: 0,
    parentId: null,
  };

  const rng = _createRng(1);
  _seedTree(root, users, nodeIdRef);
  _computeOrganic(root, rng);

  return _flattenTree(root);
};
// ─────────────────────────────────────────────────────────────────────────────
import User from "../../models/User.js";
import { USER_STATUSES, MEMBERSHIP_ACTIVE } from "../../util/config/enums.js";
import { extractUserFromRequest } from "../../util/functions/security.js";

export const getFingerprintLite = (req) => {
  try {
    const { userId } = extractUserFromRequest(req);

    return {
      timestamp: new Date(),
      id: userId,
    };
  } catch (err) {
    console.log(err);
    return {};
  }
};

// we always prioritize alumnis
export const findUserByEmail = async (email) => {
  // Check if email is valid before running queries
  if (!email || typeof email !== 'string') {
    return null;
  }

  try {
    const excludeMembershipActive = { status: { $ne: USER_STATUSES[MEMBERSHIP_ACTIVE] } };
    const userQuery = User.findOne({ email, ...excludeMembershipActive });
    const alumniQuery = AlumniUser.findOne({ email, ...excludeMembershipActive });

    const [user, alumni] = await Promise.all([userQuery, alumniQuery]);

    return alumni || user;
  } catch (err) {
    console.error("Error in findUserByEmail:", err);
    return null;
  }
};

export const findUserById = async (id) => {  
  // Check if id is valid before running queries
  if (!id || typeof id !== 'string' && !id.toString) {
    return null;
  }

  try {
    const excludeMembershipActive = { status: { $ne: USER_STATUSES[MEMBERSHIP_ACTIVE] } };
    const userQuery = User.findOne({ _id: id, ...excludeMembershipActive });
    const alumniQuery = AlumniUser.findOne({ _id: id, ...excludeMembershipActive });

    const [user, alumni] = await Promise.all([userQuery, alumniQuery]);

    return (alumni || user);
  } catch (err) {
    console.error("Error in findUserById:", err);
    return null;
  }
};

export const findUserByName = async (name, surname) => {
  try {
    const excludeMembershipActive = { status: { $ne: USER_STATUSES[MEMBERSHIP_ACTIVE] } };
    const userQuery = User.findOne({ name, surname, ...excludeMembershipActive });
    const alumniQuery = AlumniUser.findOne({ name, surname, ...excludeMembershipActive });

    const [user, alumni] = await Promise.all([userQuery, alumniQuery]);

    return alumni || user;
  } catch (err) {
    console.error("Error in findUserById:", err);
    return null;
  }
};

// Generic function to find user by any query, prioritizing alumni users
export const findUserByQuery = async (query) => {
  // Check if query is valid
  if (!query || typeof query !== 'object') {
    return null;
  }

  try {
    const excludeMembershipActive = { status: { $ne: USER_STATUSES[MEMBERSHIP_ACTIVE] } };
    const userQuery = User.findOne({ ...query, ...excludeMembershipActive });
    const alumniQuery = AlumniUser.findOne({ ...query, ...excludeMembershipActive });

    const [user, alumni] = await Promise.all([userQuery, alumniQuery]);

    return alumni || user;
  } catch (err) {
    console.error("Error in findUserByQuery:", err);
    return null;
  }
};