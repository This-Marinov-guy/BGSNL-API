import { isDeepStrictEqual } from "node:util";
const archivedStatuses = new Set(["membership-migrated", "alumni-migrated"]);
const personalFields = ["birth", "phone", "region", "university", "course", "studentNumber", "profession", "graduationDate", "otherUniversityName", "quote"];
const arrays = ["tickets", "christmas", "documents", "internshipApplications", "campaignsSeen"];
const list = (value) => Array.isArray(value) ? value : [];
const merge = (old, current) => [...new Map([...list(old), ...list(current)].map((item) => [String(item?._id || JSON.stringify(item)), item])).values()];

export function planAccountStorage({ members, alumni, archives = [], identities = [], passkeys = [] }) {
  const current = [...members.map((doc) => ({ collection: "users", doc })), ...alumni.map((doc) => ({ collection: "alumniusers", doc }))].filter(({ doc }) => !archivedStatuses.has(doc.status));
  const historical = [...members, ...alumni].filter((doc) => archivedStatuses.has(doc.status));
  const changes = new Map(current.map(({ collection, doc }) => [`${collection}:${doc._id}`, { collection, original: doc, next: { ...doc } }]));
  function owner(ids) {
    const idsSet = new Set(ids.filter(Boolean).map(String));
    const owners = [...changes.values()].filter(({ next }) => [String(next._id), ...list(next.accountAliases)].some((id) => idsSet.has(id)));
    if (owners.length > 1) throw new Error("Conflicting current account aliases; resolve before migration");
    return owners[0];
  }
  function absorb(target, source) {
    if (!target) return;
    for (const key of personalFields) if (!target.next[key] && source[key]) target.next[key] = source[key];
    for (const key of arrays) target.next[key] = merge(source[key], target.next[key]);
    target.next.accountAliases = [...new Set([String(target.next._id), ...list(target.next.accountAliases), String(source._id), ...list(source.accountAliases)])];
  }
  for (const archive of archives) {
    if (!archive.originalMember && !archive.originalAlumni) throw new Error("Unknown account migration archive format");
    const originals = [archive.originalMember, archive.originalAlumni].filter(Boolean);
    const target = owner(originals.flatMap((doc) => [doc._id, ...list(doc.accountAliases)]));
    for (const source of originals) absorb(target, source);
  }
  for (const source of historical) {
    const paired = String(source._id).replace(/^(member|alumni)_/, (_, type) => type === "member" ? "alumni_" : "member_");
    absorb(owner([source._id, paired, ...list(source.accountAliases)]), source);
  }
  for (const [field, credentials] of [["identities", identities], ["passkeys", passkeys]]) {
    for (const credential of credentials) {
      const target = owner([credential.accountId]);
      if (!target) throw new Error(`A legacy ${field} record has no current account owner`);
      const { accountId: _accountId, ...data } = credential;
      data._id = String(data._id);
      if (field === "passkeys" && data.revision == null) data.revision = 0;
      const existing = list(target.next[field]);
      const same = existing.find((item) => String(item._id) === data._id);
      if (same && !isDeepStrictEqual(same, data)) throw new Error(`Conflicting embedded ${field}; migration will not overwrite it`);
      if (!same) target.next[field] = [...existing, data];
    }
  }
  for (const field of ["identities", "passkeys"]) {
    const seen = new Set();
    for (const { next } of changes.values()) {
      const providers = new Set();
      for (const credential of list(next[field])) {
        const key = field === "identities" ? `${credential.provider}:${credential.subject}` : String(credential._id);
        if (seen.has(key)) throw new Error(`Duplicate ${field} ownership`);
        seen.add(key);
        if (field === "identities" && providers.has(credential.provider)) throw new Error("Multiple Google identities on one account");
        providers.add(credential.provider);
      }
    }
  }
  return {
    changes: [...changes.values()].filter(({ original, next }) => !isDeepStrictEqual(original, next)),
    archived: historical.map((doc) => ({ collection: members.includes(doc) ? "users" : "alumniusers", doc })),
    identityCount: identities.length, passkeyCount: passkeys.length,
  };
}
