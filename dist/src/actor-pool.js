export const ActorList = Object.freeze({
  hud: 0x8fb2, mounts: 0x8ffe, main: 0x904a, transient: 0x9096, scenery: 0x90e2,
});

export class ActorPool {
  constructor() {
    this.free = Array.from({ length: 159 }, (_, i) => 0x9f4c + (158 - i) * 0x4c);
    this.recordsByAddress = new Map();
    this.subpixels = new Map();
    this.headings = new Map();
    this.movementBudgets = new Map();
    this.hitBoxes = new Map();
    this.fireCounterLowBytes = new Map();
    this.fireCounterHighBytes = new Map();
    this.contactFlags = new Map();
  }

  allocate(lists, list, type, actor, after, keepFormation = false) {
    let address = this.free.pop();
    if (address === undefined) {
      const victim = this.reclaim(lists);
      if (!victim) return;
      address = victim.address;
      if (victim.actor) victim.actor.dead = true;
    }

    if (!lists.has(list)) lists.set(list, []);
    const records = lists.get(list);
    const record = { address, type, actor, list };
    // Unlinking a record leaves its fields intact until the address is reused.
    const previous = this.recordsByAddress.get(address);
    if (keepFormation) record.formationRoot = previous?.formationRoot;
    record.retainedContactBox = previous?.actor?.contactBox ?? previous?.actor?.box ?? previous?.retainedContactBox;
    this.recordsByAddress.set(address, record);
    records.splice(after === null ? records.length : after ? records.indexOf(after) + 1 : 0, 0, record);
    if (actor) actor.actorAddress = address;
    return record;
  }

  reclaim(lists) {
    const typeOf = (record) => record.actor?.dead ? 4 : record.type;
    const transient = lists.get(ActorList.transient) || [];
    const scenery = lists.get(ActorList.scenery) || [];
    const main = lists.get(ActorList.main) || [];
    // CS:1041 never searches the ship/HUD or mount lists, or the inactive seat.
    for (const [list, records, victim] of [
      [ActorList.transient, transient, transient.find((record) => [4, 0x0c, 0x10].includes(typeOf(record))) ?? transient[0]],
      [ActorList.scenery, scenery, scenery[0]],
      [ActorList.main, main, main.find((record) => typeOf(record) === 4 || (typeOf(record) << 16 >> 16) >= 0xc8) ?? main[0]],
    ]) {
      if (victim) {
        this.unlink(records, list, records.indexOf(victim));
        return victim;
      }
    }
  }

  nextAddress(lists, record) {
    if (!record) return;
    if (record.list === undefined) return record.unlinkedNext;
    const records = lists.get(record.list);
    const index = records?.indexOf(record) ?? -1;
    return index < 0 ? undefined : records[index + 1]?.address ?? record.list;
  }

  previousAddress(lists, record) {
    const records = lists.get(record.list);
    const index = records?.indexOf(record) ?? -1;
    return index < 0 ? undefined : records[index - 1]?.address ?? record.list;
  }

  unlink(records, list, index) {
    const record = records[index];
    // CS:7a0 leaves the forward link in the freed record.
    record.unlinkedNext = records[index + 1]?.address ?? list;
    record.list = undefined;
    records.splice(index, 1);
  }

  move(lists, from, to, actor) {
    const records = lists.get(from);
    const index = records?.findIndex((record) => record.actor === actor) ?? -1;
    if (index < 0) return;
    if (!lists.has(to)) lists.set(to, []);
    const [record] = records.splice(index, 1);
    record.list = to;
    lists.get(to).unshift(record);
  }

  *walk(lists, list, alternate) {
    let records = lists.get(list);
    for (let index = 0; index >= 0 && index < (records?.length ?? 0);) {
      // CS:36fc saves the successor address before the callback can reuse it.
      const nextAddress = records[index + 1]?.address;
      yield [list, records[index]];
      if (nextAddress === undefined) return;
      records = lists.get(list);
      if (records?.[index + 1]?.address === nextAddress) {
        index++;
        continue;
      }
      index = records?.findIndex(({ address }) => address === nextAddress) ?? -1;
      if (index < 0 && alternate !== undefined) {
        [list, alternate] = [alternate, list];
        records = lists.get(list);
        index = records?.findIndex(({ address }) => address === nextAddress) ?? -1;
      }
    }
  }

  release(lists, list, record) {
    const records = lists.get(list);
    const index = records?.indexOf(record) ?? -1;
    if (index >= 0) {
      this.unlink(records, list, index);
      this.free.push(record.address);
    }
  }

  collect(lists, list, expired = (actor) => actor?.dead) {
    const records = lists.get(list);
    if (!records?.length) return;
    const live = [];
    for (const [index, record] of records.entries()) {
      if (expired(record.actor, record.type)) {
        record.unlinkedNext = records[index + 1]?.address ?? list;
        record.list = undefined;
        this.free.push(record.address);
      } else live.push(record);
    }
    lists.set(list, live);
  }
}
