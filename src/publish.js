// ---------------------------------------------------------------------------
// publish.js — what an upload is about to do to a map's identity
// ---------------------------------------------------------------------------
// A map has two names and only one of them is on the upload dialog.
//
// **The mod.io title** is the name of a listing in a shop. It can be changed at
// any time, it can be anything, and changing it changes nothing else.
//
// **The map's own name and guid** are its identity to the game. The file a
// headset writes is named `{name}_{guid}`, so those two together *are* the file
// name — and two maps that agree on both are one file as far as the headset is
// concerned. Download the second and it lands on top of the first.
//
// Nothing in the game or in mod.io connects the two. A person who wants "the
// same map but a bit different" renames it in the one name field they can see,
// which is the shop title, and publishes — and gets two library entries that
// are the same map file under different shop names. Both play; whichever was
// downloaded last is the only one on the headset. This has happened in the live
// library, twice: once as an author publishing their own map as a "separate
// map", and once as two different people publishing one downloaded map.
//
// So the rule this module exists to enforce:
//
//   **A publish that creates a new library entry must leave behind a map the
//   headset can tell apart from every entry already carrying that guid.**
//
// Which in practice means a new guid, because the guid is the half of the file
// name nobody can be asked to invent.
//
// It is deliberately not the rule that a guid may never be republished. Sending
// a new version of a map to the entry it already has is the *normal* thing and
// wants the guid kept exactly as it is — a new one would strand every player
// who already has the map. The distinction is not "same guid or not", it is
// "another entry, or this one".
//
// Pure decisions on plain values: what mod.io was asked, what it said, and what
// the dialog should therefore offer. No fetch, no DOM.
// ---------------------------------------------------------------------------

/**
 * What the upload dialog should offer, given what the library holds.
 *
 * `owned` is the entry mod.io has confirmed *this signed-in account* may edit,
 * or null — `modioMyMods` is what confirms it, and it is never inferred from
 * the editor's own notes, because a downloaded map records the entry it came
 * from too. `libraryHits` is every entry carrying this map's guid, or **null**
 * for "could not ask" — a failed lookup is not an all-clear and does not read
 * as one anywhere below.
 *
 * `kind` is the shape of the decision:
 *
 * - `new` — nothing in the library claims this guid. Publish as it stands.
 * - `update-or-new` — you own an entry for it. Update that, or start a separate
 *   map, and starting one takes a new identity.
 * - `clash` — the guid is spoken for and not by you. There is no update to
 *   offer, so there is no choice to offer either: it goes out under a new
 *   identity or it goes out on top of somebody's map.
 */
export function publishPlan({ owned = null, libraryHits = null } = {}) {
  const asked = Array.isArray(libraryHits);
  const clashes = asked
    ? libraryHits.filter((m) => !owned || m.id !== owned.id).map(describeEntry)
    : [];
  return {
    kind: owned ? 'update-or-new' : (clashes.length ? 'clash' : 'new'),
    update: owned ? describeEntry(owned) : null,
    clashes,
    // Whether the question was put at all. A publish is never blocked on the
    // answer — the library is a bonus and losing it must not stop a map going
    // out — but "we did not ask" and "we asked and it is clear" are different
    // enough that the dialog says which.
    checked: asked,
  };
}

/** One library entry, in the three fields anything here needs of it. */
function describeEntry(mod) {
  return {
    id: mod.id,
    name: mod.name,
    author: mod.submitted_by?.username || 'someone else',
    subscribers: mod.stats?.subscribers_total ?? 0,
  };
}

/**
 * Does this publish have to mint a new guid first?
 *
 * `creatingEntry` is whether a *new* library entry is about to be made rather
 * than an existing one updated — the one thing that decides it. Updating keeps
 * the guid always; creating keeps it only when nothing already carries it.
 *
 * A lookup that failed leaves `kind` at `new`, so a publish still goes out
 * under the guid it has. That is the right way round: the check exists to stop
 * a collision it can see, not to hold a map hostage to a request that timed
 * out. The pre-flight is a second line anyway — "publish as a separate map"
 * takes a new identity because that is what a separate map *is*, whether or not
 * mod.io was reachable to agree.
 */
export function needsNewIdentity(plan, creatingEntry) {
  return !!creatingEntry && plan.kind !== 'new';
}

/**
 * The sentence the dialog puts in front of somebody whose map's ID is already
 * spoken for, or null when nothing is.
 *
 * Written to be read by someone who has never thought about guids, so it leads
 * with the entry in the way, then the consequence — one map replacing another
 * on a headset — and leaves the mechanism to a clause anyone can skip.
 *
 * `takingNewId` decides whether it ends by saying the problem is handled. It is
 * not decoration: on "update this entry" the clash is a pre-existing one that
 * this upload neither causes nor fixes, and claiming it takes a new ID there
 * would be a straight lie about what the button is about to do. Said plainly
 * either way, because a duplicate somebody already has is worth knowing about
 * even on the press that does nothing about it.
 */
export function describeClash(plan, { takingNewId = false } = {}) {
  if (!plan.clashes.length) return null;
  const [first] = plan.clashes;
  const others = plan.clashes.length - 1;
  const also = others ? `, and ${others} other${others === 1 ? '' : 's'}` : '';
  return `The library already has this map as "${first.name}" by ${first.author}${also}. `
    + 'Two maps sharing an ID are one file on a headset, so downloading either replaces the '
    + 'other.'
    + (takingNewId ? ' This upload takes a new ID, so both can be kept.' : '');
}
